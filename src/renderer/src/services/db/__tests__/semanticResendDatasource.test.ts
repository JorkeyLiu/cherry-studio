import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SqliteMessageDataSource } from '../SqliteMessageDataSource'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({
  default: { dispatch: mockDispatch }
}))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((payload: { topicId: string }) => ({ type: 'assistants/updateTopicUpdatedAt', payload }))
}))

const success = <T>(value: T) => ({ ok: true as const, value })

describe('SqliteMessageDataSource semantic resend', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>
  let ds: SqliteMessageDataSource

  beforeEach(() => {
    vi.clearAllMocks()
    api = { resendUserMessages: vi.fn(), regenerateAssistantMessage: vi.fn() }
    ds = new SqliteMessageDataSource(api as never)
  })

  it('resendUserMessages calls exactly one bridge method and dispatches topicUpdatedAt once', async () => {
    const response = {
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      askId: 'u-1',
      userMessage: { id: 'u-1' },
      userBlocks: [],
      executionMessages: [{ message: { id: 'a-1' }, blocks: [] }],
      removedBlockIds: [],
      createdMessageIds: [],
      attempts: [{ messageId: 'a-1', attemptId: 'x' }]
    }
    api.resendUserMessages.mockResolvedValue(success(response))
    const out = await ds.resendUserMessages({
      topicId: 't-1',
      userMessageId: 'u-1',
      assistantId: 'as-1',
      currentModel: { id: 'm-1', provider: 'p', name: 'n', group: 'g' }
    })
    expect(api.resendUserMessages).toHaveBeenCalledTimes(1)
    expect(api.resendUserMessages).toHaveBeenCalledWith({
      topicId: 't-1',
      userMessageId: 'u-1',
      assistantId: 'as-1',
      currentModel: { id: 'm-1', provider: 'p', name: 'n', group: 'g' }
    })
    expect(out.askId).toBe('u-1')
    expect(mockDispatch).toHaveBeenCalledTimes(1)
  })

  it('regenerateAssistantMessage omits absent currentModel (self-model path) without forging', async () => {
    api.regenerateAssistantMessage.mockResolvedValue(
      success({
        affectedFileIds: [],
        remainingReferenceCounts: {},
        topicId: 't-1',
        askId: 'u-1',
        userMessage: { id: 'u-1' },
        userBlocks: [],
        executionMessages: [{ message: { id: 'a-1' }, blocks: [] }],
        removedBlockIds: [],
        createdMessageIds: [],
        attempts: [{ messageId: 'a-1', attemptId: 'x' }]
      })
    )
    await ds.regenerateAssistantMessage({ topicId: 't-1', assistantMessageId: 'a-1', assistantId: 'as-1' })
    expect(api.regenerateAssistantMessage).toHaveBeenCalledTimes(1)
    const sent = api.regenerateAssistantMessage.mock.calls[0][0] as Record<string, unknown>
    expect('currentModel' in sent).toBe(false)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
  })

  it('regenerateAssistantMessage calls exactly one bridge method and dispatches once', async () => {
    api.regenerateAssistantMessage.mockResolvedValue(
      success({
        affectedFileIds: [],
        remainingReferenceCounts: {},
        topicId: 't-1',
        askId: 'u-1',
        userMessage: { id: 'u-1' },
        userBlocks: [],
        executionMessages: [{ message: { id: 'a-1' }, blocks: [] }],
        removedBlockIds: [],
        createdMessageIds: [],
        attempts: [{ messageId: 'a-1', attemptId: 'x' }]
      })
    )
    await ds.regenerateAssistantMessage({
      topicId: 't-1',
      assistantMessageId: 'a-1',
      assistantId: 'as-1',
      currentModel: { id: 'm-1', provider: 'p', name: 'n', group: 'g' }
    })
    expect(api.regenerateAssistantMessage).toHaveBeenCalledTimes(1)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
  })
})
