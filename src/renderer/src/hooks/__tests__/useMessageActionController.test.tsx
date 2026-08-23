import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeGetState: vi.fn(),
  dispatch: vi.fn(),
  restartTrace: vi.fn().mockResolvedValue(undefined),
  consumeFileCleanupResult: vi.fn().mockResolvedValue(undefined),
  estimateUsage: vi.fn().mockResolvedValue(undefined),
  resolveRegenerate: vi.fn(),
  resolveResend: vi.fn(),
  resolveAnswerGroup: vi.fn(),
  fetchAuthoritativeAnswerGroup: vi.fn(),
  resolveEditTarget: vi.fn(),
  resolveAssistantSnapshot: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/SpanManagerService', () => ({
  restartTrace: mocks.restartTrace
}))

vi.mock('@renderer/services/messageActionController', () => ({
  messageActionController: {
    resolveRegenerateForAssistant: mocks.resolveRegenerate,
    resolveResendForUser: mocks.resolveResend,
    resolveAnswerGroup: mocks.resolveAnswerGroup,
    fetchAuthoritativeAnswerGroup: mocks.fetchAuthoritativeAnswerGroup,
    resolveEditTarget: mocks.resolveEditTarget,
    resolveAssistantSnapshot: mocks.resolveAssistantSnapshot
  }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: mocks.storeGetState, dispatch: mocks.dispatch },
  useAppDispatch: () => mocks.dispatch
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  regenerateAssistantResponseThunk: vi.fn((...args: any[]) => ({ type: 'regen', args })),
  resendMessageThunk: vi.fn((...args: any[]) => ({ type: 'resend', args })),
  selectAnswerMessageThunk: vi.fn((...args: any[]) => ({ type: 'select', args })),
  updateMessageAndBlocksThunk: vi.fn((...args: any[]) => ({ type: 'update', args })),
  resendUserMessageWithEditThunk: vi.fn((...args: any[]) => ({ type: 'resendEdit', args }))
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/utils/messageUtils/usage', () => ({
  estimateMessageBlocksUsage: mocks.estimateUsage
}))

import { useMessageActionController } from '../useMessageActionController'

describe('useMessageActionController — S3.4 hook event-time + error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeGetState.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {} },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
  })

  it('null resolver => no dispatch for regenerate/resend/select', async () => {
    mocks.resolveRegenerate.mockReturnValue(null)
    mocks.resolveResend.mockReturnValue(null)
    mocks.fetchAuthoritativeAnswerGroup.mockResolvedValue(null)
    const { result } = renderHook(() => useMessageActionController())
    await act(async () => {
      await result.current.regenerateAssistant({ topicId: 't1', messageId: 'm1' })
    })
    await act(async () => {
      await result.current.resendUser({ topicId: 't1', messageId: 'm1' })
    })
    await act(async () => {
      await result.current.selectAnswer({ topicId: 't1', messageId: 'm1' })
    })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('null/missing/cross-topic edit target returns false and does not dispatch', async () => {
    mocks.resolveEditTarget.mockReturnValue(null)
    const { result } = renderHook(() => useMessageActionController())
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.editSave({ topicId: 't1', messageId: 'missing' }, [])
    })
    expect(ok).toBe(false)
    expect(mocks.dispatch).not.toHaveBeenCalled()
    let ok2: boolean | undefined
    await act(async () => {
      ok2 = await result.current.resendWithEdit({ topicId: 't1', messageId: 'missing' }, [])
    })
    expect(ok2).toBe(false)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('thrown persistence errors propagate from editSave', async () => {
    const msg = { id: 'm1', topicId: 't1', assistantId: 'a1', blocks: [], role: 'user' } as any
    mocks.resolveEditTarget.mockReturnValue(msg)
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { m1: msg }, messageIdsByTopic: { t1: ['m1'] } },
      assistants: { assistants: [{ id: 'a1', model: { id: 'm' } }] },
      messageBlocks: { entities: {} }
    })
    mocks.dispatch.mockRejectedValueOnce(new Error('DB failure'))
    const { result } = renderHook(() => useMessageActionController())
    let error: any
    await act(async () => {
      try {
        await result.current.editSave({ topicId: 't1', messageId: 'm1' }, [{ id: 'b1', type: 'main_text' } as any])
      } catch (e) {
        error = e
      }
    })
    expect(error).toBeDefined()
    expect((error as Error).message).toContain('DB failure')
  })

  it('thrown persistence errors propagate from resendWithEdit', async () => {
    const msg = { id: 'm1', topicId: 't1', assistantId: 'a1', blocks: [], role: 'user' } as any
    mocks.resolveEditTarget.mockReturnValue(msg)
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { m1: msg }, messageIdsByTopic: { t1: ['m1'] } },
      assistants: { assistants: [{ id: 'a1', model: { id: 'm' } }] },
      messageBlocks: { entities: {} }
    })
    // editSave will dispatch and fail
    mocks.dispatch.mockRejectedValueOnce(new Error('cleanup fail'))
    const { result } = renderHook(() => useMessageActionController())
    let error: any
    await act(async () => {
      try {
        await result.current.resendWithEdit({ topicId: 't1', messageId: 'm1' }, [
          { id: 'b1', type: 'main_text' } as any
        ])
      } catch (e) {
        error = e
      }
    })
    expect(error).toBeDefined()
  })

  it('action errors propagate for regenerate', async () => {
    const resolved = {
      message: { id: 'm1', role: 'assistant' } as any,
      assistant: { snapshot: { id: 'a1' } }
    }
    mocks.resolveRegenerate.mockReturnValue(resolved)
    mocks.dispatch.mockRejectedValueOnce(new Error('regen fail'))
    const { result } = renderHook(() => useMessageActionController())
    let error: any
    await act(async () => {
      try {
        await result.current.regenerateAssistant({ topicId: 't1', messageId: 'm1' })
      } catch (e) {
        error = e
      }
    })
    expect(error).toBeDefined()
    expect((error as Error).message).toContain('regen fail')
  })

  it('successful editSave returns true and dispatches', async () => {
    const msg = { id: 'm1', topicId: 't1', assistantId: 'a1', blocks: ['b1'], role: 'user' } as any
    mocks.resolveEditTarget.mockReturnValue(msg)
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { m1: msg }, messageIdsByTopic: { t1: ['m1'] } },
      assistants: { assistants: [] },
      messageBlocks: { entities: { b1: { id: 'b1', type: 'main_text', content: 'hi' } as any } }
    })
    mocks.dispatch.mockResolvedValueOnce({ affectedFileIds: [] })
    const { result } = renderHook(() => useMessageActionController())
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.editSave({ topicId: 't1', messageId: 'm1' }, [
        { id: 'b1', type: 'main_text', content: 'edited' } as any
      ])
    })
    expect(ok).toBe(true)
    expect(mocks.dispatch).toHaveBeenCalled()
  })

  it('successful editSave with no persist needed still returns true', async () => {
    const msg = { id: 'm1', topicId: 't1', assistantId: 'a1', blocks: [], role: 'user' } as any
    mocks.resolveEditTarget.mockReturnValue(msg)
    mocks.storeGetState.mockReturnValue({
      messages: { entities: { m1: msg }, messageIdsByTopic: { t1: ['m1'] } },
      assistants: { assistants: [] },
      messageBlocks: { entities: {} }
    })
    mocks.estimateUsage.mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useMessageActionController())
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.editSave({ topicId: 't1', messageId: 'm1' }, [])
    })
    expect(ok).toBe(true)
  })

  it('selectAnswer uses authoritative Main READ group and dispatches exactly once (S6.2b R-05)', async () => {
    mocks.fetchAuthoritativeAnswerGroup.mockResolvedValue({
      targetMessage: { id: 'a-2', topicId: 't1', askId: 'ask-1', role: 'assistant' } as any,
      groupIds: ['a-1', 'a-2', 'a-3']
    })
    const { result } = renderHook(() => useMessageActionController())
    await act(async () => {
      await result.current.selectAnswer({ topicId: 't1', messageId: 'a-2' })
    })
    expect(mocks.fetchAuthoritativeAnswerGroup).toHaveBeenCalledWith({ topicId: 't1', messageId: 'a-2' })
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    // Verify fetch was awaited before dispatch (dispatch called once after fetch)
    expect(mocks.fetchAuthoritativeAnswerGroup).toHaveBeenCalledBefore(mocks.dispatch as any)
  })

  it('selectAnswer does not dispatch when authoritative READ fails (no mutation, no fallback)', async () => {
    mocks.fetchAuthoritativeAnswerGroup.mockResolvedValue(null)
    const { result } = renderHook(() => useMessageActionController())
    await act(async () => {
      await result.current.selectAnswer({ topicId: 't1', messageId: 'missing' })
    })
    expect(mocks.fetchAuthoritativeAnswerGroup).toHaveBeenCalledWith({ topicId: 't1', messageId: 'missing' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('selectAnswer propagates dispatch error after successful authoritative READ', async () => {
    mocks.fetchAuthoritativeAnswerGroup.mockResolvedValue({
      targetMessage: { id: 'a-2', topicId: 't1', askId: 'ask-1', role: 'assistant' } as any,
      groupIds: ['a-1', 'a-2']
    })
    mocks.dispatch.mockRejectedValueOnce(new Error('select fail'))
    const { result } = renderHook(() => useMessageActionController())
    let error: any
    await act(async () => {
      try {
        await result.current.selectAnswer({ topicId: 't1', messageId: 'a-2' })
      } catch (e) {
        error = e
      }
    })
    expect(error).toBeDefined()
    expect((error as Error).message).toContain('select fail')
  })

  it('overlapping selects A then B with B resolving first dispatches B only (stale A discarded, S6.2b R-05)', async () => {
    let resolveA!: (v: any) => void
    let resolveB!: (v: any) => void
    const promiseA = new Promise<any>((res) => {
      resolveA = res
    })
    const promiseB = new Promise<any>((res) => {
      resolveB = res
    })
    mocks.fetchAuthoritativeAnswerGroup.mockImplementation(({ messageId }: any) => {
      if (messageId === 'a-1') return promiseA
      if (messageId === 'a-2') return promiseB
      return Promise.resolve(null)
    })
    const { result } = renderHook(() => useMessageActionController())
    const pA = result.current.selectAnswer({ topicId: 't1', messageId: 'a-1' })
    const pB = result.current.selectAnswer({ topicId: 't1', messageId: 'a-2' })
    // B resolves before A (out-of-order completion)
    await act(async () => {
      resolveB({
        targetMessage: { id: 'a-2', topicId: 't1', askId: 'ask-1', role: 'assistant' } as any,
        groupIds: ['a-1', 'a-2', 'a-3']
      })
      // let microtasks flush for B's continuation
      await Promise.resolve()
    })
    await act(async () => {
      resolveA({
        targetMessage: { id: 'a-1', topicId: 't1', askId: 'ask-1', role: 'assistant' } as any,
        groupIds: ['a-1', 'a-2', 'a-3']
      })
      await Promise.all([pA, pB])
    })
    expect(mocks.fetchAuthoritativeAnswerGroup).toHaveBeenCalledTimes(2)
    expect(mocks.fetchAuthoritativeAnswerGroup).toHaveBeenCalledWith({ topicId: 't1', messageId: 'a-1' })
    expect(mocks.fetchAuthoritativeAnswerGroup).toHaveBeenCalledWith({ topicId: 't1', messageId: 'a-2' })
    // Only the latest intent (B) should dispatch; stale A must be discarded
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    // Verify dispatched args correspond to B (messageId a-2), proving no stale dispatch of A
    const dispatched = (mocks.dispatch as any).mock.calls[0][0]
    expect(dispatched.args[1]).toBe('a-2')
  })
})
