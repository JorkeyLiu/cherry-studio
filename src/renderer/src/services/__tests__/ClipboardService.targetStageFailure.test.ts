/**
 * Paste post-commit bookkeeping: target segment stage fails AFTER the Main
 * insert commit. The persisted copies must still retain an undo entry; a cut
 * source must remain un-deleted with the clipboard retained.
 *
 * Real rootReducer store + real ClipboardService; Main IPC mocked only.
 */
import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessageGroups: vi.fn(),
    upsertSegment: vi.fn(),
    listSegments: vi.fn(),
    updateFileCount: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    transferAnchors: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    insertMessageGroups: mocks.insertMessageGroups,
    upsertSegment: mocks.upsertSegment,
    listSegments: mocks.listSegments,
    updateFileCount: mocks.updateFileCount,
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents,
    fetchClipboardGroups: vi.fn()
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/services/anchorService', () => ({
  transferAnchorsWithAuthorityGroupKeys: mocks.transferAnchors,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

import { rootReducer } from '@renderer/store'
import { setClipboard } from '@renderer/store/clipboard'
import { newMessagesActions } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import type { Message } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'

function windowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({
      id,
      topicId,
      role: 'user',
      blocks: []
    })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    mutableMessageIds: [...ids],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 20 },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

function establish(store: ReturnType<typeof configureStore>, topicId: string, ids: string[]) {
  store.dispatch(bumpGeneration(topicId))
  const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
  store.dispatch(
    publishResidentComplete({ topicId, generation: gen, windowResponse: windowResponse(topicId, ids), segments: [] })
  )
  store.dispatch(newMessagesActions.mergeRouteMutability({ topicId, route: null, mutableMessageIds: [...ids] }) as any)
}

function ackFor(topicId: string, groups: Array<{ entries: Array<{ message: { id: string } }>; intent: unknown }>) {
  const flat = groups.flatMap((g) => g.entries.map((e) => e.message.id))
  return {
    topicId,
    branchId: null,
    insertedMessages: flat.map((id) => ({ id, topicId, role: 'user', blocks: [] })),
    insertedBlocks: [],
    insertedMessageIds: flat,
    mutableMessageIds: [...flat],
    groups: groups.map((g) => ({
      insertedMessageIds: g.entries.map((e) => e.message.id),
      beforeMessageId: null,
      nextMessageId: null
    }))
  }
}

describe('ClipboardService target stage failure bookkeeping', () => {
  let store: ReturnType<typeof configureStore>
  beforeEach(() => {
    vi.clearAllMocks()
    store = configureStore({ reducer: rootReducer })
  })

  it('copy paste: insert committed + segment list fails => undo still tracks copies', async () => {
    const topicId = 't-paste-fail'
    establish(store, topicId, ['m0'])
    const orig: Message = {
      id: 'orig-a',
      role: 'user',
      assistantId: 'assistant-1',
      topicId,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: UserMessageStatus.SUCCESS,
      blocks: []
    }
    store.dispatch(
      setClipboard({
        mode: 'copy',
        items: [{ originalAskId: 'orig-a', messages: [orig], blocks: [], positionIndex: 0 }],
        sourceTopicId: topicId,
        sourceBranchId: null,
        segmentSnapshots: [{ originalSegmentId: 'seg-orig', name: 'Seg', color: 'c', originalMessageIds: ['orig-a'] }]
      })
    )
    mocks.insertMessageGroups.mockImplementation(async (tid: string, groups: any[]) => ackFor(tid, groups))
    mocks.upsertSegment.mockImplementation(async (id: string, tid: string, name: string, mids: string[]) => ({
      id,
      topicId: tid,
      name,
      messageIds: [...mids],
      color: 'c',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: mids[0] ?? null,
      lastMessageId: mids[mids.length - 1] ?? null,
      messageCount: mids.length
    }))
    mocks.listSegments.mockRejectedValue(new Error('target list failed'))

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(store.dispatch as any, store.getState as any, topicId, '')).rejects.toThrow(
      /Target segment convergence failed.*target list failed/
    )
    const undo = (store.getState() as any).undoStack.undoStack
    expect(undo.length).toBe(1)
    expect(undo[0].type).toBe('paste')
    expect(undo[0].pastedMessagesSnapshot.length).toBeGreaterThan(0)
    expect(undo[0].insertedMessageIds.length).toBe(undo[0].pastedMessagesSnapshot.length)
    // Committed wire snapshots retained for undo even though convergence failed.
    expect(undo[0].targetSegmentSnapshots.length).toBe(1)
  })

  it('cut paste: target stage fails => source remains un-deleted, clipboard retained, copies tracked', async () => {
    const src = 't-cut-src'
    const tgt = 't-cut-tgt'
    establish(store, src, ['s1'])
    establish(store, tgt, ['m0'])
    const orig: Message = {
      id: 'orig-a',
      role: 'user',
      assistantId: 'assistant-1',
      topicId: src,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: UserMessageStatus.SUCCESS,
      blocks: []
    }
    store.dispatch(
      setClipboard({
        mode: 'cut',
        items: [{ originalAskId: 'orig-a', messages: [orig], blocks: [], positionIndex: 0 }],
        sourceTopicId: src,
        sourceBranchId: null,
        sourceProjection: { sourceTopicId: src, sourceBranchId: null, loadedMessageIds: ['s1'] },
        segmentSnapshots: [{ originalSegmentId: 'seg-orig', name: 'Seg', color: 'c', originalMessageIds: ['orig-a'] }]
      })
    )
    mocks.insertMessageGroups.mockImplementation(async (tid: string, groups: any[]) => ackFor(tid, groups))
    mocks.upsertSegment.mockImplementation(async (id: string, tid: string, name: string, mids: string[]) => ({
      id,
      topicId: tid,
      name,
      messageIds: [...mids],
      color: 'c',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: mids[0] ?? null,
      lastMessageId: mids[mids.length - 1] ?? null,
      messageCount: mids.length
    }))
    mocks.listSegments.mockRejectedValue(new Error('target list failed'))

    const { pasteMessages } = await import('../ClipboardService')
    await expect(pasteMessages(store.dispatch as any, store.getState as any, tgt, '')).rejects.toThrow(
      /Target segment convergence failed/
    )
    // Source untouched: no staged source delete attempted.
    expect(mocks.deleteMessagesWithDependents).not.toHaveBeenCalled()
    // Clipboard retained for retry (not cleared).
    expect((store.getState() as any).clipboard.mode).toBe('cut')
    // Single undo entry tracks the persisted copies (no double-push).
    const undo = (store.getState() as any).undoStack.undoStack
    expect(undo.length).toBe(1)
    expect(undo[0].insertedMessageIds.length).toBeGreaterThan(0)
    expect(undo[0].pastedMessagesSnapshot.length).toBe(undo[0].insertedMessageIds.length)
  })
})
