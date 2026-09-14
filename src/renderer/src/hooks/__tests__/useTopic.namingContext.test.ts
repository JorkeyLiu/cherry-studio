import type * as SnapshotBlocksModule from '@renderer/utils/messageUtils/snapshotBlocks'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dbServiceMocks, persistMock, summaryMock, settingMock, dispatchMock, getStateMock, updateTopicMock } =
  vi.hoisted(() => ({
    dbServiceMocks: { fetchTopicNamingContext: vi.fn() },
    persistMock: vi.fn().mockResolvedValue(undefined),
    summaryMock: vi.fn(),
    settingMock: vi.fn(),
    dispatchMock: vi.fn(),
    getStateMock: vi.fn(),
    updateTopicMock: vi.fn((p: any) => ({ type: 'assistants/updateTopic', payload: p }))
  }))

vi.mock('@renderer/services/db', () => ({ dbService: dbServiceMocks }))
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistTopicMetadata: persistMock }))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: summaryMock }))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))
vi.mock('@renderer/store', () => ({ default: { dispatch: dispatchMock, getState: getStateMock } }))
vi.mock('@renderer/store/assistants', () => ({ updateTopic: updateTopicMock }))
vi.mock('@renderer/store/runtime', () => ({ setNewlyRenamedTopics: vi.fn(), setRenamingTopics: vi.fn() }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ loadTopicMessagesThunk: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/snapshotBlocks', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotBlocksModule>()
  return actual
})
vi.mock('../useAssistant', () => ({ useAssistant: vi.fn() }))
vi.mock('../useSettings', () => ({ getStoreSetting: settingMock }))
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => (key === 'chat.default.topic.name' ? 'New Topic' : key) }
}))

import { MessageBlockType } from '@renderer/types/newMessage'

import { autoRenameTopic, TopicManager } from '../useTopic'

const assistant: any = { id: 'assistant-1' }

function namingContext(overrides: Record<string, any> = {}) {
  const firstMessage: any = {
    id: 'm1',
    topicId: 'topic-1',
    role: 'user',
    blocks: ['b1']
  }
  const latestMessages: any[] = [
    { id: 'm1', topicId: 'topic-1', role: 'user', blocks: ['b1'] },
    { id: 'm2', topicId: 'topic-1', role: 'assistant', blocks: ['b2'] }
  ]
  return {
    topic: { id: 'topic-1', name: 'New Topic', isNameManuallyEdited: false },
    messageCount: 2,
    firstMessage,
    latestMessages,
    blocks: [
      { id: 'b1', messageId: 'm1', type: MessageBlockType.MAIN_TEXT, content: 'First message text content here' },
      { id: 'b2', messageId: 'm2', type: MessageBlockType.MAIN_TEXT, content: 'Second message text' }
    ],
    naming: {
      completeness: 'naming-context',
      topicId: 'topic-1',
      firstMessageId: 'm1',
      lastMessageId: 'm2',
      returnedLatestCount: 2
    },
    ...overrides
  }
}

function seedStore(reduxTopic: any = { id: 'topic-1', assistantId: 'assistant-1', name: 'New Topic' }) {
  getStateMock.mockReturnValue({
    assistants: { assistants: [{ id: 'assistant-1', topics: [reduxTopic] }] },
    runtime: { chat: { renamingTopics: [], newlyRenamedTopics: [] } }
  })
}

describe('autoRenameTopic — bounded naming authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedStore()
    settingMock.mockReturnValue(true)
    summaryMock.mockResolvedValue({ text: 'Summarized Name' })
    ;(window as any).toast = { error: vi.fn() }
  })

  it('uses naming context (not TopicManager message load) and summarizes latest ≤5', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    const loadSpy = vi.spyOn(TopicManager, 'getTopicMessages')

    await autoRenameTopic(assistant, 'topic-1')

    expect(dbServiceMocks.fetchTopicNamingContext).toHaveBeenCalledExactlyOnceWith('topic-1')
    expect(loadSpy).not.toHaveBeenCalled()
    expect(summaryMock).toHaveBeenCalledOnce()
    const args = summaryMock.mock.calls[0][0]
    expect(args.messages.map((m: any) => m.id)).toEqual(['m1', 'm2'])
    expect(args.blocksById.get('b1').content).toContain('First message')
    expect(persistMock).toHaveBeenCalledOnce()
    expect(dispatchMock).toHaveBeenCalled()
    loadSpy.mockRestore()
  })

  it('window-size-independent: authority count gates summary even when latest is 5 of many', async () => {
    const latest = [3, 4, 5, 6, 7].map((i) => ({ id: `m${i}`, topicId: 'topic-1', role: 'user', blocks: [] }))
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({
        messageCount: 35,
        latestMessages: latest,
        naming: {
          completeness: 'naming-context',
          topicId: 'topic-1',
          firstMessageId: 'm1',
          lastMessageId: 'm7',
          returnedLatestCount: 5
        }
      })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).toHaveBeenCalledOnce()
    expect(summaryMock.mock.calls[0][0].messages).toHaveLength(5)
  })

  it('falls back to first-message truncation when summary fails', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    summaryMock.mockResolvedValue({ text: null, error: 'boom' })
    await autoRenameTopic(assistant, 'topic-1')
    expect(persistMock).toHaveBeenCalledOnce()
    const persisted = persistMock.mock.calls[0][0]
    expect(persisted.name).toContain('First message')
    expect((window as any).toast.error).toHaveBeenCalled()
  })

  it('uses first-message fallback when topic naming is disabled', async () => {
    settingMock.mockReturnValue(false)
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistMock).toHaveBeenCalledOnce()
  })

  it('manual-name guard skips rename without summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: 'Custom', isNameManuallyEdited: true } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistMock).not.toHaveBeenCalled()
  })

  it('count <2 and empty topic skip summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({
        messageCount: 1,
        latestMessages: [{ id: 'm1', topicId: 'topic-1', role: 'user', blocks: ['b1'] }],
        naming: {
          completeness: 'naming-context',
          topicId: 'topic-1',
          firstMessageId: 'm1',
          lastMessageId: 'm1',
          returnedLatestCount: 1
        }
      })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()

    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue({
      topic: { id: 'topic-1', name: 'New Topic', isNameManuallyEdited: false },
      messageCount: 0,
      firstMessage: null,
      latestMessages: [],
      blocks: [],
      naming: {
        completeness: 'naming-context',
        topicId: 'topic-1',
        firstMessageId: null,
        lastMessageId: null,
        returnedLatestCount: 0
      }
    })
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
  })

  it('missing topic (NOT_FOUND) returns silently without summary or persist', async () => {
    const err: any = new Error('missing')
    err.code = 'NOT_FOUND'
    dbServiceMocks.fetchTopicNamingContext.mockRejectedValue(err)
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistMock).not.toHaveBeenCalled()
  })

  it('null authority name (legacy/lazy Main row) with Redux default proceeds to summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: null, isNameManuallyEdited: false } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).toHaveBeenCalledOnce()
    expect(persistMock).toHaveBeenCalledOnce()
  })

  it('empty authority name (legacy/lazy Main row) with Redux default proceeds to summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: '', isNameManuallyEdited: false } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).toHaveBeenCalledOnce()
    expect(persistMock).toHaveBeenCalledOnce()
  })

  it('manually edited legacy row still skips even with empty authority name', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: '', isNameManuallyEdited: true } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistMock).not.toHaveBeenCalled()
  })
})
