import type { Topic } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const topicRows = new Map<string, { id: string; messages: unknown[]; deletedAt?: string } & Partial<Topic>>()

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('@renderer/databases', () => ({
  default: {
    topics: {
      get: vi.fn((id: string) => Promise.resolve(topicRows.get(id))),
      put: vi.fn((topic: { id: string; messages: unknown[]; deletedAt?: string } & Partial<Topic>) => {
        topicRows.set(topic.id, topic)
        return Promise.resolve(topic.id)
      }),
      update: vi.fn((id: string, changes: Partial<Topic>) => {
        const topic = topicRows.get(id)
        if (topic) {
          topicRows.set(id, { ...topic, ...changes })
        }
        return Promise.resolve(topic ? 1 : 0)
      }),
      toArray: vi.fn(() => Promise.resolve(Array.from(topicRows.values()))),
      delete: vi.fn((id: string) => {
        topicRows.delete(id)
        return Promise.resolve()
      }),
      filter: vi.fn((predicate: (t: unknown) => boolean) => ({
        toArray: () => Promise.resolve(Array.from(topicRows.values()).filter(predicate))
      }))
    },
    message_blocks: {}
  }
}))

vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistTopicMetadata: vi.fn() }))
vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:')
}))

vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: vi.fn() }))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))
vi.mock('@renderer/services/MessagesService', () => ({ safeDeleteFiles: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: vi.fn(), getState: vi.fn() } }))
vi.mock('@renderer/store/assistants', () => ({ updateTopic: vi.fn() }))
vi.mock('@renderer/store/runtime', () => ({ setNewlyRenamedTopics: vi.fn(), setRenamingTopics: vi.fn() }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ loadTopicMessagesThunk: vi.fn() }))
vi.mock('../useAssistant', () => ({ useAssistant: vi.fn() }))
vi.mock('../useSettings', () => ({ getStoreSetting: vi.fn() }))

import { TopicManager } from '../useTopic'

describe('TopicManager trash handling', () => {
  beforeEach(() => {
    topicRows.clear()
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
    topicRows.set(topic.id, { id: topic.id, messages: storedMessages })

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
      topicRows.set('agent-session:s-1', { id: 'agent-session:s-1', messages: [], deletedAt: expiredAt })
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
      topicRows.set('agent-session:s-recent', { id: 'agent-session:s-recent', messages: [], deletedAt: recentAt })

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
})
