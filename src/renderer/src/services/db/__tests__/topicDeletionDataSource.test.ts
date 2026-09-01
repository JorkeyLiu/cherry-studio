import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'updateTopicUpdatedAt', payload: p }))
}))

import {
  clearAllLatestWindowCompleteness,
  getLatestWindowCompleteness,
  setLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import {
  clearAllContextClosureCache,
  getCachedContextClosure,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import {
  getDeletionGeneration,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import type { FetchContextClosureResponse } from '@shared/chatDb'

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

function makeClosure(topicId: string): FetchContextClosureResponse {
  return {
    messages: [{ id: 'u1', role: 'user' } as any, { id: 'a1', role: 'assistant', askId: 'u1' } as any],
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId,
      anchorGroupKey: 'u1',
      firstMessageId: 'u1',
      lastMessageId: 'a1',
      returnedCount: 2,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      boundaryMessageId: null
    }
  }
}

function successResult<T>(value: T) {
  return { ok: true as const, value }
}
function failResult(code = 'STORAGE_ERROR') {
  return { ok: false as const, error: { code, message: 'fail', retryable: false } }
}

describe('SqliteMessageDataSource deletion invalidation integration', () => {
  let api: any
  let ds: SqliteMessageDataSource

  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    clearAllLatestWindowCompleteness()
    resetAllClosureStateForTests()
    clearAllContextClosureCache()
    api = {
      hardDeleteTopic: vi.fn(),
      purgeExpiredTopics: vi.fn(),
      emptyTrashTopics: vi.fn(),
      resetAssistantTopics: vi.fn(),
      softDeleteTopic: vi.fn()
    }
    ds = new SqliteMessageDataSource(api)
  })

  it('single hardDelete with authoritative IDs invalidates only that topic after success', async () => {
    const topicId = 't-single'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(topicId, makeClosure(topicId), 'fp')
    api.hardDeleteTopic.mockResolvedValue(
      successResult({ affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [topicId] })
    )
    const result = await ds.hardDeleteTopic(topicId)
    expect(result.deletedTopicIds).toEqual([topicId])
    expect(getLatestWindowCompleteness(topicId)).toBeUndefined()
    expect(getCachedContextClosure(topicId)).toBeNull()
    expect(getDeletionGeneration(topicId)).toBe(1)
  })

  it('does not invalidate when hardDelete returns empty deletedTopicIds (absent topic)', async () => {
    const topicId = 't-absent'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    api.hardDeleteTopic.mockResolvedValue(
      successResult({ affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [] })
    )
    await ds.hardDeleteTopic(topicId)
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getDeletionGeneration(topicId)).toBe(0)
  })

  it('bulk purge invalidates all authoritative IDs', async () => {
    const ids = ['t-purge-1', 't-purge-2']
    for (const id of ids) setLatestWindowCompleteness(id, { hasMoreBefore: true, hasMoreAfter: true })
    api.purgeExpiredTopics.mockResolvedValue(
      successResult({ affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: ids })
    )
    await ds.purgeExpiredTopics(new Date().toISOString())
    for (const id of ids) {
      expect(getLatestWindowCompleteness(id)).toBeUndefined()
      expect(getDeletionGeneration(id)).toBe(1)
    }
  })

  it('emptyTrash bulk invalidates all', async () => {
    const ids = ['t-empty-1', 't-empty-2', 't-empty-3']
    for (const id of ids) setLatestWindowCompleteness(id, { hasMoreBefore: false, hasMoreAfter: false })
    api.emptyTrashTopics.mockResolvedValue(
      successResult({ affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: ids })
    )
    await ds.emptyTrashTopics('assistant-1')
    for (const id of ids) expect(getLatestWindowCompleteness(id)).toBeUndefined()
  })

  it('resetAssistant invalidates deleted IDs but not replacement', async () => {
    const deleted = ['t-del-1', 't-del-2']
    const replacement = 't-repl'
    for (const id of [...deleted, replacement])
      setLatestWindowCompleteness(id, { hasMoreBefore: true, hasMoreAfter: true })
    api.resetAssistantTopics.mockResolvedValue(
      successResult({
        cleanup: { affectedFileIds: [], remainingReferenceCounts: {} },
        replacementTopic: { id: replacement, name: 'new' },
        deletedTopicIds: deleted
      })
    )
    await ds.resetAssistantTopics('asst-1', replacement)
    for (const id of deleted) expect(getLatestWindowCompleteness(id)).toBeUndefined()
    expect(getLatestWindowCompleteness(replacement)).toBeDefined()
  })

  it('failure retention: hardDelete failure does not invalidate', async () => {
    const topicId = 't-fail-retention'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    api.hardDeleteTopic.mockResolvedValue(failResult())
    await expect(ds.hardDeleteTopic(topicId)).rejects.toBeInstanceOf(ChatDbResultError)
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getDeletionGeneration(topicId)).toBe(0)
  })

  it('soft-delete preservation: softDelete does not invalidate', async () => {
    const topicId = 't-soft'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(topicId, makeClosure(topicId), 'fp')
    api.softDeleteTopic.mockResolvedValue(successResult(null))
    // Call via ds.softDeleteTopic if exists, otherwise directly check helper not called
    // SqliteMessageDataSource softDeleteTopic exists
    await ds.softDeleteTopic(topicId)
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getCachedContextClosure(topicId)).not.toBeNull()
    expect(getDeletionGeneration(topicId)).toBe(0)
  })

  it('purge failure retention: no invalidation on failure', async () => {
    const topicId = 't-purge-fail'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    api.purgeExpiredTopics.mockResolvedValue(failResult())
    await expect(ds.purgeExpiredTopics(new Date().toISOString())).rejects.toBeInstanceOf(ChatDbResultError)
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
  })
})
