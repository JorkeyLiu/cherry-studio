import type { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { topicRows, agentDb, messageBlocks, safeDeleteFilesMock } = vi.hoisted(() => {
  const topicRows = new Map<string, { id: string; assistantId?: string; messages: unknown[]; deletedAt?: string }>()
  const messageBlocks = new Map<string, { id: string; type: string; file?: unknown }>()

  // Dexie transaction mock: db.transaction('rw', table1, table2, async () => {...})
  // The last argument is always the callback; tables are spread as separate args.
  const transactionFn = vi.fn(async (...args: unknown[]) => {
    const fn = args[args.length - 1] as () => Promise<void>
    await fn()
  })

  const agentDb = {
    topics: {
      get: vi.fn(async (id: string) => topicRows.get(id)),
      put: vi.fn(async (topic: any) => {
        topicRows.set(topic.id, topic)
      }),
      update: vi.fn(async (id: string, updates: Record<string, unknown>) => {
        const topic = topicRows.get(id)
        if (topic) topicRows.set(id, { ...topic, ...updates })
      }),
      delete: vi.fn(async (id: string) => {
        topicRows.delete(id)
      }),
      toArray: vi.fn(async () => Array.from(topicRows.values()))
    },
    message_blocks: {
      bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => messageBlocks.get(id) ?? undefined)),
      bulkDelete: vi.fn(async (ids: string[]) => {
        for (const id of ids) messageBlocks.delete(id)
      })
    },
    transaction: transactionFn
  }

  const safeDeleteFilesMock = vi.fn().mockResolvedValue(undefined)

  return { topicRows, agentDb, messageBlocks, safeDeleteFilesMock, transactionFn }
})

vi.mock('@renderer/databases', () => ({ default: agentDb }))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistTopicMetadata: vi.fn() }))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    softDeleteTopic: vi.fn(async (id: string) => {
      const topic = topicRows.get(id)
      if (topic) topicRows.set(id, { ...topic, deletedAt: new Date().toISOString() })
    }),
    listTrashTopics: vi.fn(async (assistantId: string) => ({
      items: Array.from(topicRows.values())
        .filter((topic) => topic.deletedAt && topic.assistantId === assistantId)
        .map((topic) => ({ ...topic }))
    }))
  },
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:')
}))
vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:')
}))

vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: vi.fn() }))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))
vi.mock('@renderer/services/MessagesService', () => ({ safeDeleteFiles: safeDeleteFilesMock }))
const { mocks: fmMocks } = vi.hoisted(() => ({
  mocks: { deleteFile: vi.fn().mockResolvedValue(undefined) }
}))
vi.mock('@renderer/services/FileManager', () => ({
  default: { deleteFile: fmMocks.deleteFile }
}))
vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: vi.fn(() => ({
      assistants: {
        assistants: [{ id: 'assistant-1', topics: Array.from(topicRows.values()) }]
      }
    }))
  }
}))
vi.mock('@renderer/store/assistants', () => ({ updateTopic: vi.fn() }))
vi.mock('@renderer/store/runtime', () => ({ setNewlyRenamedTopics: vi.fn(), setRenamingTopics: vi.fn() }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ loadTopicMessagesThunk: vi.fn() }))
vi.mock('../useAssistant', () => ({ useAssistant: vi.fn() }))
vi.mock('../useSettings', () => ({ getStoreSetting: vi.fn() }))

import type { Topic } from '@renderer/types'

import { TopicManager } from '../useTopic'

/** Valid Message fixture fields required by the Message type. */
const msgFixture = {
  role: 'assistant' as const,
  assistantId: 'assistant-1',
  topicId: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'success' as AssistantMessageStatus | UserMessageStatus
}

describe('TopicManager trash handling', () => {
  beforeEach(() => {
    topicRows.clear()
    messageBlocks.clear()
    vi.clearAllMocks()
    fmMocks.deleteFile.mockResolvedValue(undefined)
    safeDeleteFilesMock.mockReset()
    safeDeleteFilesMock.mockResolvedValue(undefined)
    agentDb.message_blocks.bulkDelete.mockReset()
    agentDb.message_blocks.bulkDelete.mockImplementation(async (ids: string[]) => {
      for (const id of ids) messageBlocks.delete(id)
    })
    agentDb.topics.delete.mockReset()
    agentDb.transaction.mockReset()
    agentDb.transaction.mockImplementation(async (...args: unknown[]) => {
      const fn = args[args.length - 1] as () => Promise<void>
      await fn()
    })
  })

  it('soft-deletes a topic with full metadata while preserving stored messages', async () => {
    const topic = {
      id: 'topic-1',
      assistantId: 'assistant-1',
      name: 'Restorable topic',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messages: [],
      pinned: true,
      isNameManuallyEdited: true
    } satisfies Topic
    const storedMessages = [{ id: 'message-1', blocks: ['block-1'] }] as unknown as Topic['messages']
    topicRows.set(topic.id, { ...topic, id: topic.id, messages: storedMessages })

    await TopicManager.softRemoveTopic(topic)

    const trashedTopics = await TopicManager.getTrashTopics(topic.assistantId)
    expect(trashedTopics).toHaveLength(1)
    expect(trashedTopics[0]).toMatchObject({
      id: topic.id,
      assistantId: topic.assistantId,
      name: topic.name,
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
      pinned: true,
      isNameManuallyEdited: true
    })
    expect(trashedTopics[0].deletedAt).toEqual(expect.any(String))
    expect(trashedTopics[0].messages).toBe(storedMessages)
  })

  describe('purgeExpiredTopics (Phase 5.2B, agent-session only)', () => {
    const expiredAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()

    it('purges only expired AGENT-SESSION rows and never touches ordinary Dexie rows (LOCK-521)', async () => {
      topicRows.set('agent-session:s-1', {
        id: 'agent-session:s-1',
        assistantId: 'assistant-1',
        messages: [],
        deletedAt: expiredAt
      })
      topicRows.set('ordinary-expired', { id: 'ordinary-expired', messages: [], deletedAt: expiredAt })

      const removeTopicSpy = vi.spyOn(TopicManager, 'removeTopic').mockResolvedValue(undefined)
      try {
        const count = await TopicManager.purgeExpiredTopics()

        expect(count).toBe(1)
        expect(removeTopicSpy).toHaveBeenCalledExactlyOnceWith('agent-session:s-1')
        expect(removeTopicSpy).not.toHaveBeenCalledWith('ordinary-expired')
      } finally {
        removeTopicSpy.mockRestore()
      }
    })

    it('does not purge agent-session rows inside the retention window', async () => {
      const recentAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
      topicRows.set('agent-session:s-recent', {
        id: 'agent-session:s-recent',
        assistantId: 'assistant-1',
        messages: [],
        deletedAt: recentAt
      })

      const removeTopicSpy = vi.spyOn(TopicManager, 'removeTopic').mockResolvedValue(undefined)
      try {
        const count = await TopicManager.purgeExpiredTopics()

        expect(count).toBe(0)
        expect(removeTopicSpy).not.toHaveBeenCalled()
      } finally {
        removeTopicSpy.mockRestore()
      }
    })
  })

  describe('agent clearTopicMessages (LOCK-P5.3-2)', () => {
    it('clears Dexie message_blocks and messages atomically, then applies safe file cleanup', async () => {
      // Set up agent topic with messages referencing file blocks
      topicRows.set('agent-session:s-clear', {
        id: 'agent-session:s-clear',
        assistantId: 'assistant-1',
        messages: [
          { id: 'msg-1', ...msgFixture, topicId: 'agent-session:s-clear', blocks: ['blk-1', 'blk-2'] },
          { id: 'msg-2', ...msgFixture, topicId: 'agent-session:s-clear', blocks: ['blk-3'] }
        ]
      })
      messageBlocks.set('blk-1', { id: 'blk-1', type: MessageBlockType.FILE, file: { id: 'file-a', name: 'a.pdf' } })
      messageBlocks.set('blk-2', { id: 'blk-2', type: MessageBlockType.MAIN_TEXT })
      messageBlocks.set('blk-3', { id: 'blk-3', type: MessageBlockType.IMAGE, file: { id: 'file-b', name: 'b.png' } })

      // Track call order: Dexie operations happen inside transaction, then cleanup after
      const callOrder: string[] = []
      agentDb.transaction.mockImplementation(async (...args: unknown[]) => {
        callOrder.push('transaction:start')
        const fn = args[args.length - 1] as () => Promise<void>
        await fn()
        callOrder.push('transaction:commit')
      })
      safeDeleteFilesMock.mockImplementation(async () => {
        callOrder.push('cleanup')
      })

      await TopicManager.clearTopicMessages('agent-session:s-clear')

      // Verify atomic Dexie transaction was used (LOCK-001)
      expect(agentDb.transaction).toHaveBeenCalledOnce()

      // message_blocks for the topic should be deleted
      expect(agentDb.message_blocks.bulkDelete).toHaveBeenCalledWith(['blk-1', 'blk-2', 'blk-3'])
      // Topic messages array should be cleared
      expect(agentDb.topics.update).toHaveBeenCalledWith('agent-session:s-clear', { messages: [] })

      // safeDeleteFiles called with extracted file metadata (post-commit)
      expect(safeDeleteFilesMock).toHaveBeenCalledOnce()
      const deletedFiles = safeDeleteFilesMock.mock.calls[0][0]
      expect(deletedFiles).toHaveLength(2)
      expect(deletedFiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'file-a' }), expect.objectContaining({ id: 'file-b' })])
      )

      // Verify ordering: transaction completed before cleanup
      expect(callOrder).toEqual(['transaction:start', 'transaction:commit', 'cleanup'])
    })

    it('is a no-op when the agent topic has no messages', async () => {
      topicRows.set('agent-session:s-empty', {
        id: 'agent-session:s-empty',
        assistantId: 'assistant-1',
        messages: []
      })

      await TopicManager.clearTopicMessages('agent-session:s-empty')

      expect(agentDb.message_blocks.bulkDelete).not.toHaveBeenCalled()
      expect(safeDeleteFilesMock).not.toHaveBeenCalled()
    })

    it('does not clean up files when Dexie transaction fails', async () => {
      topicRows.set('agent-session:s-fail', {
        id: 'agent-session:s-fail',
        assistantId: 'assistant-1',
        messages: [{ id: 'msg-1', ...msgFixture, topicId: 'agent-session:s-fail', blocks: ['blk-1'] }]
      })
      messageBlocks.set('blk-1', { id: 'blk-1', type: MessageBlockType.FILE, file: { id: 'file-a', name: 'a.pdf' } })

      // Make the transaction fail
      agentDb.transaction.mockRejectedValueOnce(new Error('Dexie tx failed'))

      await expect(TopicManager.clearTopicMessages('agent-session:s-fail')).rejects.toThrow('Dexie tx failed')

      // No file cleanup should occur after transaction failure
      expect(safeDeleteFilesMock).not.toHaveBeenCalled()
    })
  })

  describe('agent removeTopic (LOCK-P5.3-3)', () => {
    it('atomically deletes blocks+topic then applies file cleanup after commit', async () => {
      topicRows.set('agent-session:s-del', {
        id: 'agent-session:s-del',
        assistantId: 'assistant-1',
        messages: [{ id: 'msg-1', ...msgFixture, topicId: 'agent-session:s-del', blocks: ['blk-1'] }]
      })
      messageBlocks.set('blk-1', { id: 'blk-1', type: MessageBlockType.IMAGE, file: { id: 'file-c', name: 'c.jpg' } })

      const callOrder: string[] = []
      agentDb.transaction.mockImplementation(async (...args: unknown[]) => {
        callOrder.push('transaction:start')
        const fn = args[args.length - 1] as () => Promise<void>
        await fn()
        callOrder.push('transaction:commit')
      })
      fmMocks.deleteFile.mockImplementation(async () => {
        callOrder.push('cleanup')
      })

      await TopicManager.removeTopic('agent-session:s-del')

      // Verify atomic Dexie transaction (LOCK-001)
      expect(agentDb.transaction).toHaveBeenCalledOnce()

      // Blocks and topic deleted from Dexie
      expect(agentDb.message_blocks.bulkDelete).toHaveBeenCalledWith(['blk-1'])
      expect(agentDb.topics.delete).toHaveBeenCalledWith('agent-session:s-del')

      // FileManager cleanup applied AFTER transaction commit (LOCK-001)
      expect(fmMocks.deleteFile).toHaveBeenCalledExactlyOnceWith('file-c')

      // Verify ordering: transaction committed before cleanup
      expect(callOrder).toEqual(['transaction:start', 'transaction:commit', 'cleanup'])
    })

    it('deletes topic even when no file blocks exist', async () => {
      topicRows.set('agent-session:s-notext', {
        id: 'agent-session:s-notext',
        assistantId: 'assistant-1',
        messages: [{ id: 'msg-1', ...msgFixture, topicId: 'agent-session:s-notext', blocks: ['blk-t'] }]
      })
      messageBlocks.set('blk-t', { id: 'blk-t', type: MessageBlockType.MAIN_TEXT })

      await TopicManager.removeTopic('agent-session:s-notext')

      expect(fmMocks.deleteFile).not.toHaveBeenCalled()
      expect(agentDb.message_blocks.bulkDelete).toHaveBeenCalledWith(['blk-t'])
      expect(agentDb.topics.delete).toHaveBeenCalledWith('agent-session:s-notext')
    })

    it('does not clean up files when Dexie transaction fails', async () => {
      topicRows.set('agent-session:s-txfail', {
        id: 'agent-session:s-txfail',
        assistantId: 'assistant-1',
        messages: [{ id: 'msg-1', ...msgFixture, topicId: 'agent-session:s-txfail', blocks: ['blk-1'] }]
      })
      messageBlocks.set('blk-1', { id: 'blk-1', type: MessageBlockType.FILE, file: { id: 'file-a', name: 'a.pdf' } })

      agentDb.transaction.mockRejectedValueOnce(new Error('Dexie tx failed'))

      await expect(TopicManager.removeTopic('agent-session:s-txfail')).rejects.toThrow('Dexie tx failed')

      // No file cleanup should occur after transaction failure
      expect(fmMocks.deleteFile).not.toHaveBeenCalled()
    })
  })
})
