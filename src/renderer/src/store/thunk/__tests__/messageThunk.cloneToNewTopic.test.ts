/**
 * cloneMessagesToNewTopicThunk — O(M+B) entry assembly regression tests.
 *
 * The thunk must group cloned blocks by message ID once (a Map pass over the
 * block list) instead of filtering the whole block list per message
 * (O(M·B)). This file verifies the produced `entries` array groups blocks
 * correctly per message with order preserved, that askId is remapped to the
 * new cloned message IDs, and that file counts are updated exactly once per
 * unique file.
 */

import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    cloneMessagesToTopic: vi.fn(),
    updateFileCount: vi.fn(),
    selectMessagesForTopic: vi.fn(),
    dispatch: vi.fn(),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessage/messagesReceived', payload: p }))
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    cloneMessagesToTopic: mocks.cloneMessagesToTopic,
    updateFileCount: mocks.updateFileCount
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn()
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  addAbortController: vi.fn()
}))

vi.mock('swr', () => ({
  mutate: vi.fn()
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

let storeState: {
  messages: { entities: Record<string, Message>; messageIdsByTopic: Record<string, string[]> }
  messageBlocks: { entities: Record<string, MessageBlock> }
}

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  }
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    messagesReceived: mocks.messagesReceived,
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    setTopicLoading: vi.fn(),
    setTopicFulfilled: vi.fn()
  },
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertManyBlocks: mocks.upsertManyBlocks,
  upsertOneBlock: vi.fn()
}))

// --- Helpers --------------------------------------------------------------

const createSourceMessage = (overrides: Partial<Message>): Message =>
  ({
    id: 'src-msg',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks: [],
    ...overrides
  }) as unknown as Message

const createBlock = (id: string, messageId: string, overrides: Partial<MessageBlock> = {}): MessageBlock =>
  ({
    id,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content: `content-${id}`,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }) as unknown as MessageBlock

const newTopic = { id: 'new-topic', assistantId: 'assistant-1' } as any

// --- Tests ----------------------------------------------------------------

describe('cloneMessagesToNewTopicThunk — O(M+B) entry assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cloneMessagesToTopic.mockResolvedValue(undefined)
    mocks.updateFileCount.mockResolvedValue(undefined)
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} }
    }
  })

  it('groups cloned blocks per message in order with correct ownership', async () => {
    const srcUser = createSourceMessage({ id: 'src-user', blocks: ['blk-u1'] })
    const srcAsst = createSourceMessage({
      id: 'src-asst',
      role: 'assistant',
      askId: 'src-user',
      blocks: ['blk-a1', 'blk-a2']
    })
    storeState.messageBlocks.entities = {
      'blk-u1': createBlock('blk-u1', 'src-user'),
      'blk-a1': createBlock('blk-a1', 'src-asst'),
      'blk-a2': createBlock('blk-a2', 'src-asst')
    }
    mocks.selectMessagesForTopic.mockReturnValue([srcUser, srcAsst])

    const { cloneMessagesToNewTopicThunk } = await import('../messageThunk')
    const ok = await cloneMessagesToNewTopicThunk('topic-1', 2, newTopic)(mocks.dispatch, () => storeState as any)

    expect(ok).toBe(true)
    expect(mocks.cloneMessagesToTopic).toHaveBeenCalledOnce()
    const [targetTopicId, entries, assistantId] = mocks.cloneMessagesToTopic.mock.calls[0]
    expect(targetTopicId).toBe('new-topic')
    expect(assistantId).toBe('assistant-1')
    expect(entries).toHaveLength(2)

    // New IDs everywhere; askId remapped to the cloned user message ID.
    const [userEntry, asstEntry] = entries as Array<{ message: Message; blocks: MessageBlock[] }>
    expect(userEntry.message.id).not.toBe('src-user')
    expect(userEntry.message.topicId).toBe('new-topic')
    expect(userEntry.message.blocks).toEqual([userEntry.blocks[0].id])
    expect(asstEntry.message.id).not.toBe('src-asst')
    expect(asstEntry.message.askId).toBe(userEntry.message.id)

    // Block grouping correctness: each entry's blocks belong to that message,
    // with original block order preserved (the O(M+B) map grouping).
    expect(userEntry.blocks).toHaveLength(1)
    expect(userEntry.blocks[0].messageId).toBe(userEntry.message.id)
    expect(asstEntry.blocks).toHaveLength(2)
    expect(asstEntry.blocks.map((b) => b.messageId)).toEqual([asstEntry.message.id, asstEntry.message.id])
    expect(asstEntry.blocks[0].id).not.toBe('blk-a1')
    expect(asstEntry.blocks[1].id).not.toBe('blk-a2')
    // Order preserved: first cloned block corresponds to source blk-a1.
    expect(asstEntry.blocks.map((b) => (b as { content?: string }).content)).toEqual([
      'content-blk-a1',
      'content-blk-a2'
    ])

    // All 3 cloned blocks are distinct and accounted for.
    const allBlockIds = entries.flatMap((e: any) => e.blocks.map((b: MessageBlock) => b.id))
    expect(new Set(allBlockIds).size).toBe(3)

    // Redux receives the cloned messages and blocks.
    expect(mocks.messagesReceived).toHaveBeenCalledOnce()
    expect(mocks.upsertManyBlocks).toHaveBeenCalledOnce()
  })

  it('updates file count once per unique cloned file block', async () => {
    const srcUser = createSourceMessage({ id: 'src-user', blocks: ['blk-file'] })
    storeState.messageBlocks.entities = {
      'blk-file': createBlock('blk-file', 'src-user', {
        type: MessageBlockType.FILE,
        file: {
          id: 'file-1',
          name: 'a.pdf',
          origin_name: 'a.pdf',
          path: '/a.pdf',
          size: 10,
          ext: '.pdf',
          type: 'application/pdf',
          created_at: '2026-01-01T00:00:00.000Z',
          count: 1
        }
      })
    }
    mocks.selectMessagesForTopic.mockReturnValue([srcUser])

    const { cloneMessagesToNewTopicThunk } = await import('../messageThunk')
    const ok = await cloneMessagesToNewTopicThunk('topic-1', 1, newTopic)(mocks.dispatch, () => storeState as any)

    expect(ok).toBe(true)
    expect(mocks.cloneMessagesToTopic).toHaveBeenCalledOnce()
    expect(mocks.updateFileCount).toHaveBeenCalledExactlyOnceWith('file-1', 1, false)
  })

  it('maps askId to undefined when the referenced user message is outside the branch', async () => {
    const srcUser = createSourceMessage({ id: 'src-user', blocks: [] })
    const srcAsst = createSourceMessage({
      id: 'src-asst',
      role: 'assistant',
      askId: 'outside-user',
      blocks: []
    })
    mocks.selectMessagesForTopic.mockReturnValue([srcUser, srcAsst])

    const { cloneMessagesToNewTopicThunk } = await import('../messageThunk')
    const ok = await cloneMessagesToNewTopicThunk('topic-1', 2, newTopic)(mocks.dispatch, () => storeState as any)

    expect(ok).toBe(true)
    const [, entries] = mocks.cloneMessagesToTopic.mock.calls[0]
    const asstEntry = (entries as Array<{ message: Message }>)[1]
    expect(asstEntry.message.askId).toBeUndefined()
  })
})
