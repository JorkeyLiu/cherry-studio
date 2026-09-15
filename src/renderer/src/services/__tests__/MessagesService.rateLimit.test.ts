import { beforeEach, describe, expect, it, vi } from 'vitest'

const { activityMock, providerMock, getTopicMock, snapshotMock, windowMock } = vi.hoisted(() => ({
  activityMock: vi.fn(),
  providerMock: vi.fn(),
  getTopicMock: vi.fn(),
  snapshotMock: vi.fn(),
  windowMock: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@renderer/components/Popups/SearchPopup', () => ({ default: { hide: vi.fn() } }))
vi.mock('@renderer/hooks/useTopic', () => ({ TopicManager: { getTopic: getTopicMock } }))
vi.mock('@renderer/utils/topicSnapshot', () => ({ loadWholeTopicSnapshot: snapshotMock }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ loadTopicMessagesThunk: windowMock }))
vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: vi.fn() }))
vi.mock('@renderer/services/db', () => ({ dbService: { fetchTopicActivity: activityMock } }))
vi.mock('@renderer/store', () => ({
  default: { getState: vi.fn(() => ({ runtime: { generating: false } })), dispatch: vi.fn() }
}))
vi.mock('@renderer/store/messageBlock', () => ({ messageBlocksSelectors: {}, removeManyBlocks: vi.fn() }))
vi.mock('@renderer/store/newMessage', () => ({}))
vi.mock('@renderer/utils', () => ({ uuid: () => 'uuid-1' }))
vi.mock('@renderer/utils/export', () => ({ getTitleFromString: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/create', () => ({
  createAssistantMessage: vi.fn(),
  createFileBlock: vi.fn(),
  createImageBlock: vi.fn(),
  createMainTextBlock: vi.fn(),
  createMessage: vi.fn(),
  resetMessage: vi.fn()
}))
vi.mock('@renderer/utils/messageUtils/find', () => ({ getMainTextContent: vi.fn() }))
vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantById: vi.fn(),
  getAssistantProvider: providerMock,
  getDefaultModel: vi.fn()
}))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))
vi.mock('@renderer/services/FileManager', () => ({ default: { deleteFiles: vi.fn() } }))

import { __testSetPendingNavigate, checkRateLimit, getPendingNavigate, locateToMessageTarget } from '../MessagesService'

const assistant: any = { id: 'a1' }

describe('checkRateLimit — bounded topic activity authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).toast = { warning: vi.fn() }
  })

  it('passes the current topic ID to the activity read (never assistant.topics[0] or loaded selector)', async () => {
    providerMock.mockReturnValue({ rateLimit: 60 })
    activityMock.mockResolvedValue({
      messageCount: 5,
      latestMessageId: 'm5',
      latestMessageCreatedAt: new Date(Date.now() - 120_000).toISOString(),
      activity: { completeness: 'topic-activity', topicId: 'current-topic' }
    })
    const blocked = await checkRateLimit(assistant, 'current-topic')
    expect(activityMock).toHaveBeenCalledExactlyOnceWith('current-topic')
    expect(blocked).toBe(false)
  })

  it('bypasses when messageCount <= 1', async () => {
    providerMock.mockReturnValue({ rateLimit: 60 })
    activityMock.mockResolvedValue({
      messageCount: 1,
      latestMessageId: 'm1',
      latestMessageCreatedAt: new Date().toISOString(),
      activity: { completeness: 'topic-activity', topicId: 't1' }
    })
    expect(await checkRateLimit(assistant, 't1')).toBe(false)
    expect((window as any).toast.warning).not.toHaveBeenCalled()
  })

  it('blocks on recent authority timestamp and toasts wait seconds', async () => {
    providerMock.mockReturnValue({ rateLimit: 60 })
    activityMock.mockResolvedValue({
      messageCount: 4,
      latestMessageId: 'm4',
      latestMessageCreatedAt: new Date(Date.now() - 10_000).toISOString(),
      activity: { completeness: 'topic-activity', topicId: 't1' }
    })
    expect(await checkRateLimit(assistant, 't1')).toBe(true)
    expect((window as any).toast.warning).toHaveBeenCalledOnce()
  })

  it('allows send when interval expired', async () => {
    providerMock.mockReturnValue({ rateLimit: 60 })
    activityMock.mockResolvedValue({
      messageCount: 4,
      latestMessageId: 'm4',
      latestMessageCreatedAt: new Date(Date.now() - 120_000).toISOString(),
      activity: { completeness: 'topic-activity', topicId: 't1' }
    })
    expect(await checkRateLimit(assistant, 't1')).toBe(false)
  })

  it('allows send on NOT_FOUND/transport failure without toast', async () => {
    providerMock.mockReturnValue({ rateLimit: 60 })
    const notFound: any = new Error('missing')
    notFound.code = 'NOT_FOUND'
    activityMock.mockRejectedValueOnce(notFound)
    expect(await checkRateLimit(assistant, 'missing')).toBe(false)
    activityMock.mockRejectedValueOnce(new Error('transport fail'))
    expect(await checkRateLimit(assistant, 't1')).toBe(false)
    expect((window as any).toast.warning).not.toHaveBeenCalled()
  })

  it('returns false without provider rate limit and without activity read', async () => {
    providerMock.mockReturnValue(undefined)
    expect(await checkRateLimit(assistant, 't1')).toBe(false)
    expect(activityMock).not.toHaveBeenCalled()
  })
})

describe('locateToMessageTarget — metadata-only navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __testSetPendingNavigate(null)
    ;(window as any).toast = { warning: vi.fn(), error: vi.fn() }
  })

  it('resolves topic via metadata-only lookup without snapshot or window load', async () => {
    const { getAssistantById } = await import('@renderer/services/AssistantService')
    vi.mocked(getAssistantById).mockReturnValue({ id: 'a1' } as any)
    getTopicMock.mockResolvedValue({ id: 'topic-1', assistantId: 'a1', name: 'T1' })
    const navigate = vi.fn()

    await locateToMessageTarget(navigate as any, { topicId: 'topic-1', messageId: 'msg-1' })

    expect(getTopicMock).toHaveBeenCalledWith('topic-1')
    expect(snapshotMock).not.toHaveBeenCalled()
    expect(windowMock).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalled()
    expect(getPendingNavigate()).toEqual({ messageId: 'msg-1', topicId: 'topic-1' })
  })

  it('fail-closed on missing topic with no navigation or pending', async () => {
    getTopicMock.mockResolvedValue(undefined)
    const navigate = vi.fn()

    await locateToMessageTarget(navigate as any, { topicId: 'missing', messageId: 'msg-x' })

    expect(getTopicMock).toHaveBeenCalledWith('missing')
    expect(snapshotMock).not.toHaveBeenCalled()
    expect(windowMock).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(getPendingNavigate()).toBeNull()
    expect((window as any).toast.error).toHaveBeenCalled()
  })
})
