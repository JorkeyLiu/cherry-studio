import { describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'assistants/updateTopicUpdatedAt', payload: p }))
}))

import { ValidationError } from '@shared/chatDb'
import { validateChatDbResult } from '@shared/chatDb'

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource — windowed reads', () => {
  it('fetchMessagesWindow unwraps success and returns messages/blocks/window', async () => {
    const windowMeta = {
      kind: 'latest' as const,
      completeness: 'window' as const,
      topicId: 't1',
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: 'm1',
      lastMessageId: 'm2',
      returnedCount: 2,
      hasMoreBefore: true,
      hasMoreAfter: false
    }
    const api = {
      fetchMessagesWindow: vi.fn(async () => ({
        ok: true,
        value: { messages: [{ id: 'm1' }, { id: 'm2' }], blocks: [{ id: 'b1', messageId: 'm1' }], window: windowMeta }
      })),
      fetchMessages: vi.fn(),
      getRawTopic: vi.fn(),
      topicExists: vi.fn(),
      ensureTopic: vi.fn(),
      appendMessage: vi.fn(),
      updateMessage: vi.fn(),
      updateMessageAndBlocks: vi.fn(),
      selectAnswerMessage: vi.fn(),
      deleteMessage: vi.fn(),
      deleteMessages: vi.fn(),
      updateBlocks: vi.fn(),
      updateSingleBlock: vi.fn(),
      bulkAddBlocks: vi.fn(),
      deleteBlocks: vi.fn(),
      listSegments: vi.fn(),
      upsertSegment: vi.fn(),
      updateSegmentMetadata: vi.fn(),
      deleteSegment: vi.fn(),
      replaceSegmentMembership: vi.fn(),
      reorderMessages: vi.fn(),
      listFileRefsByFile: vi.fn(),
      countFileRefsByFile: vi.fn(),
      listBlocksByFile: vi.fn(),
      updateTopicMetadata: vi.fn(),
      softDeleteTopic: vi.fn(),
      restoreTopic: vi.fn(),
      listTrashTopics: vi.fn(),
      hardDeleteTopic: vi.fn(),
      purgeExpiredTopics: vi.fn(),
      emptyTrashTopics: vi.fn(),
      cloneMessagesToTopic: vi.fn(),
      resetMessagesForResend: vi.fn(),
      deleteMessagesWithSegments: vi.fn(),
      pasteMessagesToTopic: vi.fn(),
      searchMessages: vi.fn()
    } as any
    const ds = new SqliteMessageDataSource(api)
    const res = await ds.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 })
    expect(api.fetchMessagesWindow).toHaveBeenCalledOnce()
    expect(res.messages).toHaveLength(2)
    expect(res.blocks).toHaveLength(1)
    expect(res.window.completeness).toBe('window')
    expect(res.window.hasMoreBefore).toBe(true)
  })

  it('fetchMessagesWindow throws ChatDbResultError on structured failure', async () => {
    const api = {
      fetchMessagesWindow: vi.fn(async () => ({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Topic does not exist', retryable: false }
      })),
      fetchMessages: vi.fn()
    } as any
    const ds = new SqliteMessageDataSource(api)
    await expect(ds.fetchMessagesWindow({ kind: 'latest', topicId: 'nope', limit: 10 })).rejects.toBeInstanceOf(
      ChatDbResultError
    )
    await expect(ds.fetchMessagesWindow({ kind: 'latest', topicId: 'nope', limit: 10 })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('fetchMessagesWindow propagates transport rejection unchanged', async () => {
    const api = {
      fetchMessagesWindow: vi.fn(async () => {
        throw new Error('transport fail')
      })
    } as any
    const ds = new SqliteMessageDataSource(api)
    await expect(ds.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 })).rejects.toThrow('transport fail')
  })

  it('fetchMessagesWindow rejects via shared validator when latest result has empty requested', () => {
    const malformed = {
      ok: true as const,
      value: {
        messages: [],
        blocks: [],
        window: {
          kind: 'latest' as const,
          completeness: 'window' as const,
          topicId: 't1',
          anchorMessageId: null,
          requested: {} as any,
          firstMessageId: null,
          lastMessageId: null,
          returnedCount: 0,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
    }
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', malformed)).toThrow(ValidationError)
  })

  it('fetchMessagesWindow rejects via shared validator when latest result carries before/after instead of limit', () => {
    const malformed = {
      ok: true as const,
      value: {
        messages: [{ id: 'm1' }],
        blocks: [],
        window: {
          kind: 'latest' as const,
          completeness: 'window' as const,
          topicId: 't1',
          anchorMessageId: null,
          requested: { before: 5, after: 5 } as any,
          firstMessageId: 'm1',
          lastMessageId: 'm1',
          returnedCount: 1,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
    }
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', malformed)).toThrow(ValidationError)
  })

  it('fetchMessagesWindow rejects via shared validator when around result has limit instead of before/after', () => {
    const malformed = {
      ok: true as const,
      value: {
        messages: [{ id: 'm1' }],
        blocks: [],
        window: {
          kind: 'around' as const,
          completeness: 'window' as const,
          topicId: 't1',
          anchorMessageId: 'm1',
          requested: { limit: 10 } as any,
          firstMessageId: 'm1',
          lastMessageId: 'm1',
          returnedCount: 1,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
    }
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', malformed)).toThrow(ValidationError)
  })

  it('fetchMessagesWindow rejects via shared validator when around result missing before', () => {
    const malformed = {
      ok: true as const,
      value: {
        messages: [{ id: 'm1' }],
        blocks: [],
        window: {
          kind: 'around' as const,
          completeness: 'window' as const,
          topicId: 't1',
          anchorMessageId: 'm1',
          requested: { after: 5 } as any,
          firstMessageId: 'm1',
          lastMessageId: 'm1',
          returnedCount: 1,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
    }
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', malformed)).toThrow(ValidationError)
  })

  it('fetchMessagesWindow around success unwraps correctly', async () => {
    const windowMeta = {
      kind: 'around' as const,
      completeness: 'window' as const,
      topicId: 't1',
      anchorMessageId: 'm2',
      requested: { before: 5, after: 5 },
      firstMessageId: 'm1',
      lastMessageId: 'm3',
      returnedCount: 3,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
    const api = {
      fetchMessagesWindow: vi.fn(async () => ({
        ok: true,
        value: { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], blocks: [], window: windowMeta }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    const res = await ds.fetchMessagesWindow({
      kind: 'around',
      topicId: 't1',
      anchorMessageId: 'm2',
      before: 5,
      after: 5
    })
    expect(res.window.kind).toBe('around')
    expect(res.window.anchorMessageId).toBe('m2')
    expect(res.messages).toHaveLength(3)
  })
})
