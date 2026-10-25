import type * as SnapshotBlocksModule from '@renderer/utils/messageUtils/snapshotBlocks'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dbServiceMocks, persistAutoMock, summaryMock, settingMock, dispatchMock, getStateMock, updateTopicMock } =
  vi.hoisted(() => ({
    dbServiceMocks: { fetchTopicNamingContext: vi.fn() },
    persistAutoMock: vi.fn(
      async (
        _topicId: string,
        name: string,
        _expected: { expectedName?: string | null; expectedIsNameManuallyEdited?: boolean | null }
      ) => ({ name })
    ),
    summaryMock: vi.fn(),
    settingMock: vi.fn(),
    dispatchMock: vi.fn(),
    getStateMock: vi.fn(),
    updateTopicMock: vi.fn((p: any) => ({ type: 'assistants/updateTopic', payload: p }))
  }))

vi.mock('@renderer/services/db', () => ({ dbService: dbServiceMocks }))
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistAutomaticTopicName: persistAutoMock }))
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

import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
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
    // Clear once-queues so a prior delayed test never leaks a pending
    // implementation into the next test (which would hang it).
    persistAutoMock.mockReset()
    persistAutoMock.mockImplementation(
      async (
        _topicId: string,
        name: string,
        _expected: { expectedName?: string | null; expectedIsNameManuallyEdited?: boolean | null }
      ) => ({ name })
    )
    summaryMock.mockReset()
    summaryMock.mockResolvedValue({ text: 'Summarized Name' })
    seedStore()
    settingMock.mockReturnValue(true)
    ;(window as any).toast = { error: vi.fn() }
  })

  it('uses naming context (not TopicManager message load) and summarizes latest ≤5', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())

    await autoRenameTopic(assistant, 'topic-1')

    expect(dbServiceMocks.fetchTopicNamingContext).toHaveBeenCalledExactlyOnceWith('topic-1', null)
    // Misleading whole-topic helper is removed; naming never loads windows.
    expect(TopicManager).not.toHaveProperty('getTopicMessages')
    expect(loadTopicMessagesThunk).not.toHaveBeenCalled()
    expect(summaryMock).toHaveBeenCalledOnce()
    const args = summaryMock.mock.calls[0][0]
    expect(args.messages.map((m: any) => m.id)).toEqual(['m1', 'm2'])
    expect(args.blocksById.get('b1').content).toContain('First message')
    expect(persistAutoMock).toHaveBeenCalledOnce()
    expect(persistAutoMock.mock.calls[0][0]).toBe('topic-1')
    expect(persistAutoMock.mock.calls[0][1]).toBe('Summarized Name')
    expect(persistAutoMock.mock.calls[0][2]).toEqual({
      expectedName: 'New Topic',
      expectedIsNameManuallyEdited: false
    })
    expect(dispatchMock).toHaveBeenCalled()
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
    expect(persistAutoMock).toHaveBeenCalledOnce()
    const persistedName = persistAutoMock.mock.calls[0][1]
    expect(persistedName).toContain('First message')
    expect((window as any).toast.error).toHaveBeenCalled()
  })

  it('uses first-message fallback when topic naming is disabled', async () => {
    settingMock.mockReturnValue(false)
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistAutoMock).toHaveBeenCalledOnce()
  })

  it('manual-name guard skips rename without summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: 'Custom', isNameManuallyEdited: true } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistAutoMock).not.toHaveBeenCalled()
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
    expect(persistAutoMock).not.toHaveBeenCalled()
  })

  it('null authority name (legacy/lazy Main row) with Redux default proceeds to summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: null, isNameManuallyEdited: false } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).toHaveBeenCalledOnce()
    expect(persistAutoMock).toHaveBeenCalledOnce()
    expect(persistAutoMock.mock.calls[0][2]).toEqual({
      expectedName: null,
      expectedIsNameManuallyEdited: false
    })
  })

  it('empty authority name (legacy/lazy Main row) with Redux default proceeds to summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: '', isNameManuallyEdited: false } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).toHaveBeenCalledOnce()
    expect(persistAutoMock).toHaveBeenCalledOnce()
  })

  it('manually edited legacy row still skips even with empty authority name', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: '', isNameManuallyEdited: true } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistAutoMock).not.toHaveBeenCalled()
  })

  it('null authority with non-default Redux fallback is preserved (no summary, no persist)', async () => {
    seedStore({ id: 'topic-1', assistantId: 'assistant-1', name: 'My Manual Title' })
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: null, isNameManuallyEdited: false } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistAutoMock).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('empty authority with non-default Redux fallback is preserved', async () => {
    seedStore({ id: 'topic-1', assistantId: 'assistant-1', name: 'Branch Inherited Title' })
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: '', isNameManuallyEdited: false } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistAutoMock).not.toHaveBeenCalled()
  })

  it('Redux manual flag blocks even when authority flag is false', async () => {
    seedStore({ id: 'topic-1', assistantId: 'assistant-1', name: 'New Topic', isNameManuallyEdited: true })
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistAutoMock).not.toHaveBeenCalled()
  })

  it('non-default authority name is preserved without summary', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(
      namingContext({ topic: { id: 'topic-1', name: 'Already Named', isNameManuallyEdited: false } })
    )
    await autoRenameTopic(assistant, 'topic-1')
    expect(summaryMock).not.toHaveBeenCalled()
    expect(persistAutoMock).not.toHaveBeenCalled()
  })

  it('delayed summary + intervening manual rename: manual name and flag survive (guarded no-op)', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    let resolveSummary!: (v: any) => void
    summaryMock.mockImplementationOnce(() => new Promise((resolve) => (resolveSummary = resolve as any)))
    const run = autoRenameTopic(assistant, 'topic-1')
    // Wait until the summary request is actually in flight (initial authority
    // read already captured), then intervene before resolving.
    await vi.waitFor(() => expect(summaryMock).toHaveBeenCalledTimes(1))
    persistAutoMock.mockImplementationOnce(async () => ({ name: 'My Manual Title' }))
    seedStore({ id: 'topic-1', assistantId: 'assistant-1', name: 'My Manual Title', isNameManuallyEdited: true })
    resolveSummary({ text: 'Stale Summary' })
    await run
    expect(persistAutoMock).toHaveBeenCalledOnce()
    // Guarded no-op: the topic update is never dispatched (renaming indicator
    // dispatches still run); Redux keeps the manual title/flag.
    expect(updateTopicMock).not.toHaveBeenCalled()
  })

  it('intervening successful auto name discards stale result (changed preimage no-op)', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    summaryMock.mockResolvedValue({ text: 'Stale Summary' })
    persistAutoMock.mockResolvedValueOnce({ name: 'Fresh Auto Name' })
    seedStore({ id: 'topic-1', assistantId: 'assistant-1', name: 'Fresh Auto Name' })
    await autoRenameTopic(assistant, 'topic-1')
    expect(persistAutoMock).toHaveBeenCalledOnce()
    expect(updateTopicMock).not.toHaveBeenCalled()
  })

  it('conditional write NOT_FOUND (topic deleted mid-flight) is a graceful no-op', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    summaryMock.mockResolvedValue({ text: 'Late Summary' })
    const err: any = new Error('gone')
    err.code = 'NOT_FOUND'
    persistAutoMock.mockRejectedValueOnce(err)
    await autoRenameTopic(assistant, 'topic-1')
    expect(persistAutoMock).toHaveBeenCalledOnce()
    expect(updateTopicMock).not.toHaveBeenCalled()
  })

  it('missing Redux topic at commit time never reintroduces the topic', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    summaryMock.mockResolvedValue({ text: 'Late Summary' })
    persistAutoMock.mockResolvedValueOnce({ name: 'Late Summary' })
    getStateMock.mockReturnValue({
      assistants: { assistants: [{ id: 'assistant-1', topics: [] }] },
      runtime: { chat: { renamingTopics: [], newlyRenamedTopics: [] } }
    })
    await autoRenameTopic(assistant, 'topic-1')
    expect(updateTopicMock).not.toHaveBeenCalled()
  })

  it('successful conditional write updates only the intended name from latest Redux (no stale flag revert)', async () => {
    seedStore({
      id: 'topic-1',
      assistantId: 'assistant-1',
      name: 'New Topic',
      pinned: true,
      prompt: 'keep-me',
      isNameManuallyEdited: false
    })
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    summaryMock.mockResolvedValue({ text: 'Fresh Name' })
    persistAutoMock.mockResolvedValueOnce({ name: 'Fresh Name' })
    await autoRenameTopic(assistant, 'topic-1')
    expect(updateTopicMock).toHaveBeenCalledOnce()
    const payload = updateTopicMock.mock.calls[0][0]
    expect(payload.topic.name).toBe('Fresh Name')
    expect(payload.topic.pinned).toBe(true)
    expect(payload.topic.prompt).toBe('keep-me')
    expect(payload.topic.isNameManuallyEdited).toBe(false)
  })

  it('passes the captured branch route through (true-branch send preserves logical name contract)', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    await autoRenameTopic(assistant, 'topic-1', 'branch-1')
    expect(dbServiceMocks.fetchTopicNamingContext).toHaveBeenCalledExactlyOnceWith('topic-1', 'branch-1')
    expect(persistAutoMock).toHaveBeenCalledOnce()
  })

  it('branch-row names stay separate: logical topic write never targets a branch row', async () => {
    dbServiceMocks.fetchTopicNamingContext.mockResolvedValue(namingContext())
    await autoRenameTopic(assistant, 'topic-1', 'branch-1')
    // Conditional write addresses the logical topic only (topicId, never branchId).
    expect(persistAutoMock.mock.calls[0][0]).toBe('topic-1')
    expect(persistAutoMock.mock.calls[0][1]).toBe('Summarized Name')
  })
})
