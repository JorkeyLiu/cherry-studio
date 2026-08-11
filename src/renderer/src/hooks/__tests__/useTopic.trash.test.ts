import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dbServiceMocks, consumeCleanupMock } = vi.hoisted(() => ({
  dbServiceMocks: {
    softDeleteTopic: vi.fn(),
    hardDeleteTopic: vi.fn(),
    restoreTopic: vi.fn()
  },
  consumeCleanupMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/services/db', () => ({
  dbService: dbServiceMocks
}))

vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistTopicMetadata: vi.fn() }))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: consumeCleanupMock }))
vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: vi.fn() }))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: vi.fn(() => ({
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            topics: [
              { id: 'topic-1', assistantId: 'assistant-1', name: 'Topic 1', messages: [] },
              { id: 'topic-2', assistantId: 'assistant-1', name: 'Topic 2', messages: [] }
            ]
          }
        ]
      },
      runtime: { chat: { renamingTopics: [], newlyRenamedTopics: [] } }
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

describe('TopicManager ordinary lifecycle (SQLite only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consumeCleanupMock.mockResolvedValue(undefined)
  })

  it('soft-deletes an ordinary topic through SQLite', async () => {
    const topic = {
      id: 'topic-1',
      assistantId: 'assistant-1',
      name: 'Restorable topic',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messages: []
    } satisfies Topic
    dbServiceMocks.softDeleteTopic.mockResolvedValue(undefined)

    await TopicManager.softRemoveTopic(topic)

    expect(dbServiceMocks.softDeleteTopic).toHaveBeenCalledExactlyOnceWith('topic-1', 'Restorable topic')
  })

  it('hard-deletes an ordinary topic through SQLite then consumes cleanup (LOCK-525)', async () => {
    dbServiceMocks.hardDeleteTopic.mockResolvedValue({
      affectedFileIds: ['file-a'],
      remainingReferenceCounts: { 'file-a': 0 }
    })

    await TopicManager.removeTopic('topic-1')

    expect(dbServiceMocks.hardDeleteTopic).toHaveBeenCalledExactlyOnceWith('topic-1')
    expect(consumeCleanupMock).toHaveBeenCalledExactlyOnceWith({
      affectedFileIds: ['file-a'],
      remainingReferenceCounts: { 'file-a': 0 }
    })
  })

  it('performs NO cleanup when the SQLite hard delete fails (LOCK-526)', async () => {
    const err = new Error('SQLITE_FAILURE')
    dbServiceMocks.hardDeleteTopic.mockRejectedValue(err)

    await expect(TopicManager.removeTopic('topic-1')).rejects.toBe(err)
    expect(consumeCleanupMock).not.toHaveBeenCalled()
  })

  it('restores an ordinary topic through the single SQLite command', async () => {
    dbServiceMocks.restoreTopic.mockResolvedValue({
      id: 'topic-1',
      assistantId: 'assistant-1',
      name: 'Restored',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    const restored = await TopicManager.restoreTopic('topic-1')

    expect(dbServiceMocks.restoreTopic).toHaveBeenCalledExactlyOnceWith('topic-1')
    expect(restored).toMatchObject({ id: 'topic-1', name: 'Restored' })
  })

  it('returns undefined when SQLite restored no row', async () => {
    dbServiceMocks.restoreTopic.mockResolvedValue(null)

    const restored = await TopicManager.restoreTopic('topic-x')

    expect(dbServiceMocks.restoreTopic).toHaveBeenCalledExactlyOnceWith('topic-x')
    expect(restored).toBeUndefined()
  })

  it('propagates restore failure so callers skip Redux (LOCK-528)', async () => {
    const err = new Error('SQLITE_FAILURE')
    dbServiceMocks.restoreTopic.mockRejectedValue(err)

    await expect(TopicManager.restoreTopic('topic-1')).rejects.toBe(err)
  })

  it('loads a topic from the Redux store via getTopic', async () => {
    const topic = await TopicManager.getTopic('topic-1')

    expect(topic).toMatchObject({ id: 'topic-1', name: 'Topic 1' })
  })
})
