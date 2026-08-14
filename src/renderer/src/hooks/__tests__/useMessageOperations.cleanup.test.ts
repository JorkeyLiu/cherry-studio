import type { Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getState: vi.fn(),
  updateMessageAndBlocksThunk: vi.fn(),
  selectAnswerMessageThunk: vi.fn(),
  consumeFileCleanupResult: vi.fn(),
  estimateMessageBlocksUsage: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: mocks.getState },
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: () => 0
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/utils/messageUtils/usage', () => ({
  estimateMessageBlocksUsage: mocks.estimateMessageBlocksUsage
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  updateMessageAndBlocksThunk: mocks.updateMessageAndBlocksThunk,
  selectAnswerMessageThunk: mocks.selectAnswerMessageThunk,
  deleteSingleMessageThunk: vi.fn(),
  appendAssistantResponseThunk: vi.fn(),
  cloneMessagesToNewTopicThunk: vi.fn(),
  initiateTranslationThunk: vi.fn(),
  regenerateAssistantResponseThunk: vi.fn(),
  resendMessageThunk: vi.fn(),
  resendUserMessageWithEditThunk: vi.fn(),
  updateTranslationBlockThunk: vi.fn()
}))

vi.mock('@renderer/store/messageBlock', () => ({ updateOneBlock: vi.fn() }))
vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: { setTopicLoading: vi.fn() },
  selectMessagesForTopic: vi.fn()
}))
vi.mock('@renderer/services/ClipboardService', () => ({ deleteSingleMessage: vi.fn() }))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))
vi.mock('@renderer/services/SpanManagerService', () => ({
  appendMessageTrace: vi.fn(),
  pauseTrace: vi.fn(),
  restartTrace: vi.fn()
}))
vi.mock('@renderer/services/TokenService', () => ({ estimateUserPromptUsage: vi.fn() }))
const cleanup = { affectedFileIds: ['file-1'], remainingReferenceCounts: { 'file-1': 0 } }
const message = {
  id: 'message-1',
  topicId: 'topic-1',
  role: 'user',
  blocks: ['block-1', 'block-2']
} as Message

const makeBlock = (id: string) => ({
  id,
  messageId: message.id,
  type: MessageBlockType.MAIN_TEXT,
  content: id,
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-01-01T00:00:00.000Z'
})

describe('useMessageOperations atomic cleanup callers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({
      messages: { entities: { [message.id]: message } },
      messageBlocks: { entities: { 'block-1': makeBlock('block-1'), 'block-2': makeBlock('block-2') } }
    })
    mocks.updateMessageAndBlocksThunk.mockReturnValue({ type: 'atomic-update' })
    mocks.dispatch.mockResolvedValue(cleanup)
  })

  it('removeMessageBlock passes the removed block ID atomically and consumes cleanup once', async () => {
    const { useMessageOperations } = await import('../useMessageOperations')
    const { result } = renderHook(() => useMessageOperations({ id: 'topic-1' } as any))

    await result.current.removeMessageBlock(message.id, 'block-2')

    expect(mocks.updateMessageAndBlocksThunk).toHaveBeenCalledWith(
      'topic-1',
      expect.objectContaining({ id: message.id, blocks: ['block-1'] }),
      [],
      ['block-2']
    )
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(cleanup)
  })

  it('editMessageBlocks passes removed IDs and consumes the returned cleanup once', async () => {
    const { useMessageOperations } = await import('../useMessageOperations')
    const { result } = renderHook(() => useMessageOperations({ id: 'topic-1' } as any))
    const editedBlocks = [makeBlock('block-1')] as any

    await result.current.editMessageBlocks(message.id, editedBlocks)

    expect(mocks.updateMessageAndBlocksThunk).toHaveBeenCalledWith(
      'topic-1',
      expect.objectContaining({ id: message.id, blocks: ['block-1'] }),
      [expect.objectContaining({ id: 'block-1' })],
      ['block-2']
    )
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(cleanup)
  })

  it('notifies the caller immediately after the atomic edit commit', async () => {
    const { useMessageOperations } = await import('../useMessageOperations')
    const { result } = renderHook(() => useMessageOperations({ id: 'topic-1' } as any))
    const onCommit = vi.fn()
    const editedBlocks = [makeBlock('block-1')] as any

    await result.current.editMessageBlocks(message.id, editedBlocks, undefined, onCommit)

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(['block-1'])
    expect(onCommit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumeFileCleanupResult.mock.invocationCallOrder[0]
    )
  })

  it('runs post-commit cleanup even when commit notification throws', async () => {
    const { useMessageOperations } = await import('../useMessageOperations')
    const { result } = renderHook(() => useMessageOperations({ id: 'topic-1' } as any))
    const onCommit = vi.fn(() => {
      throw new Error('editor notification failed')
    })
    const editedBlocks = [makeBlock('block-1')] as any

    await expect(result.current.editMessageBlocks(message.id, editedBlocks, undefined, onCommit)).rejects.toThrow(
      'editor notification failed'
    )

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(['block-1'])
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(cleanup)
  })

  it('selectAnswerMessage dispatches ONE atomic selection thunk with the full group (PERF-100 navigation path)', async () => {
    mocks.selectAnswerMessageThunk.mockReturnValue({ type: 'select-answer-message' })
    mocks.dispatch.mockResolvedValue({ type: 'select-answer-message' })

    const { useMessageOperations } = await import('../useMessageOperations')
    const { result } = renderHook(() => useMessageOperations({ id: 'topic-1' } as any))

    await result.current.selectAnswerMessage('a-2', ['a-1', 'a-2', 'a-3'])

    // The caller-facing wrapper forwards the target + the FULL answer group
    // to the DB-first thunk — never two per-message editMessage writes.
    expect(mocks.selectAnswerMessageThunk).toHaveBeenCalledTimes(1)
    expect(mocks.selectAnswerMessageThunk).toHaveBeenCalledWith('topic-1', 'a-2', ['a-1', 'a-2', 'a-3'])
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'select-answer-message' })
  })

  it('notifies the caller before a later resend trace failure', async () => {
    const { restartTrace } = await import('@renderer/services/SpanManagerService')
    const { useMessageOperations } = await import('../useMessageOperations')
    const { result } = renderHook(() => useMessageOperations({ id: 'topic-1' } as any))
    const onCommit = vi.fn()
    const editedBlocks = [makeBlock('block-1')] as any
    mocks.estimateMessageBlocksUsage.mockResolvedValue({ inputTokens: 1 })
    vi.mocked(restartTrace).mockRejectedValueOnce(new Error('restart trace failed'))

    await expect(
      result.current.resendUserMessageWithEdit(
        message,
        editedBlocks,
        { id: 'assistant-1', model: { id: 'model-1' } } as any,
        onCommit
      )
    ).rejects.toThrow('restart trace failed')

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(['block-1'])
  })
})
