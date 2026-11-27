/**
 * Session-path integration tests for `usePromptTokenEstimate`.
 *
 * Covers only what the legacy suite does not: the bounded per-identity
 * history session (stable per-message reuse, identity reset, unmount
 * cleanup) while the 200ms debounce + request-id guards keep working on the
 * session path. No timing assertions; async order is fully deferred-driven.
 */
import type { EstimateHistoryMessageFn } from '@renderer/services/historyTokenEstimateSession'
import type { LocalTokenEstimate } from '@renderer/services/LocalTokenEstimator'
import type { Assistant, FileMetadata } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Deterministic prompt tokenizer: 1 char ≈ 1 token. History/draft
// estimators are injected mocks in this suite, so tokenx only observes
// prompt strings; the unprompted base assistant still contributes 0.
vi.mock('tokenx', () => ({
  estimateTokenCount: (text: string) => text.length
}))

import { type EstimateDraftFn, type PromptTokenRouteIdentity, usePromptTokenEstimate } from '../usePromptTokenEstimate'

// ---------------------------------------------------------------------------
// Deferred harness (mirrors the legacy suite: real timers, manual resolve)
// ---------------------------------------------------------------------------
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const baseAssistant = { id: 'a1' } as unknown as Assistant

let messageDeferred: Deferred<number>[]
let draftDeferred: Deferred<LocalTokenEstimate>[]

// Module-level so the hook's dependency array stays referentially stable.
const messageMock = vi.fn((_message: Message, _options: { includeMedia?: boolean }) => {
  const d = deferred<number>()
  messageDeferred.push(d)
  return d.promise
}) as unknown as Mock<EstimateHistoryMessageFn>

const draftMock = vi.fn((_params: { content?: string; files?: FileMetadata[] }) => {
  const d = deferred<LocalTokenEstimate>()
  draftDeferred.push(d)
  return d.promise
}) as unknown as Mock<EstimateDraftFn>

const msg = (id: string): Message => ({ id, blocks: [] }) as unknown as Message
const idA: PromptTokenRouteIdentity = { topicId: 't1', branchId: null, anchorGroupKey: 'g1' }
const idB: PromptTokenRouteIdentity = { topicId: 't1', branchId: null, anchorGroupKey: 'g2' }

const draftTotal = (totalTokens: number): LocalTokenEstimate => ({
  textTokens: 0,
  imageTokens: 0,
  fileTokens: 0,
  totalTokens
})

describe('usePromptTokenEstimate session path', () => {
  beforeEach(() => {
    messageDeferred = []
    draftDeferred = []
    messageMock.mockClear()
    draftMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces, then estimates per-message history plus draft as one scalar', async () => {
    const m1 = msg('m1')
    const { result } = renderHook(() =>
      usePromptTokenEstimate({
        assistant: baseAssistant,
        tokenEstimationMessages: [m1],
        blockSnapshot: new Map() as never,
        text: 'hello',
        files: [],
        routeIdentity: idA,
        estimateHistoryMessage: messageMock,
        estimateDraft: draftMock
      })
    )

    // Debounced — no estimation yet.
    expect(result.current).toBe(0)
    expect(messageMock).not.toHaveBeenCalled()

    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1))
    act(() => {
      messageDeferred[0].resolve(120)
      draftDeferred[0].resolve(draftTotal(5))
    })
    await waitFor(() => expect(result.current).toBe(125))
  })

  it('text-only rerun reuses stable history estimates (no repeated tokenization)', async () => {
    const m1 = msg('m1')
    const { result, rerender } = renderHook(
      (props: { text: string }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: [m1],
          blockSnapshot: new Map() as never,
          text: props.text,
          files: [],
          routeIdentity: idA,
          estimateHistoryMessage: messageMock,
          estimateDraft: draftMock
        }),
      { initialProps: { text: 'a' } }
    )

    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1))
    act(() => {
      messageDeferred[0].resolve(100)
      draftDeferred[0].resolve(draftTotal(1))
    })
    await waitFor(() => expect(result.current).toBe(101))

    // Draft-only change: history entries are reused, draft re-estimates.
    rerender({ text: 'b' })
    await waitFor(() => expect(draftMock).toHaveBeenCalledTimes(2))
    expect(messageMock).toHaveBeenCalledTimes(1)
    act(() => {
      draftDeferred[1].resolve(draftTotal(7))
    })
    await waitFor(() => expect(result.current).toBe(107))
  })

  it('only the changed message object is re-estimated', async () => {
    const m1 = msg('m1')
    const m2 = msg('m2')
    const { result, rerender } = renderHook(
      (props: { messages: Message[] }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: props.messages,
          blockSnapshot: new Map() as never,
          text: 't',
          files: [],
          routeIdentity: idA,
          estimateHistoryMessage: messageMock,
          estimateDraft: draftMock
        }),
      { initialProps: { messages: [m1, m2] } }
    )

    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(2))
    act(() => {
      messageDeferred[0].resolve(10)
      messageDeferred[1].resolve(20)
      draftDeferred[0].resolve(draftTotal(0))
    })
    await waitFor(() => expect(result.current).toBe(30))

    // m2 replaced (same content, new object): only m2 re-estimates.
    const m2Next = msg('m2')
    rerender({ messages: [m1, m2Next] })
    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(3))
    expect(messageMock.mock.calls[2][0]).toBe(m2Next)
    act(() => {
      messageDeferred[2].resolve(25)
      draftDeferred[1].resolve(draftTotal(0))
    })
    await waitFor(() => expect(result.current).toBe(35))
  })

  it('route/anchor identity change resets the session (full re-estimate, no leak)', async () => {
    const m1 = msg('m1')
    const { result, rerender } = renderHook(
      (props: { identity: PromptTokenRouteIdentity }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: [m1],
          blockSnapshot: new Map() as never,
          text: 't',
          files: [],
          routeIdentity: props.identity,
          estimateHistoryMessage: messageMock,
          estimateDraft: draftMock
        }),
      { initialProps: { identity: idA } }
    )

    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1))
    act(() => {
      messageDeferred[0].resolve(10)
      draftDeferred[0].resolve(draftTotal(0))
    })
    await waitFor(() => expect(result.current).toBe(10))

    // Same message, new anchor: previous route entries are dropped.
    rerender({ identity: idB })
    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(2))
    act(() => {
      messageDeferred[1].resolve(40)
      draftDeferred[1].resolve(draftTotal(0))
    })
    await waitFor(() => expect(result.current).toBe(40))
  })

  it('unmount clears the session: remount with the same identity re-estimates', async () => {
    const m1 = msg('m1')
    const first = renderHook(() =>
      usePromptTokenEstimate({
        assistant: baseAssistant,
        tokenEstimationMessages: [m1],
        blockSnapshot: new Map() as never,
        text: 't',
        files: [],
        routeIdentity: idA,
        estimateHistoryMessage: messageMock,
        estimateDraft: draftMock
      })
    )
    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1))
    act(() => {
      messageDeferred[0].resolve(10)
      draftDeferred[0].resolve(draftTotal(0))
    })
    await waitFor(() => expect(first.result.current).toBe(10))
    first.unmount()

    renderHook(() =>
      usePromptTokenEstimate({
        assistant: baseAssistant,
        tokenEstimationMessages: [m1],
        blockSnapshot: new Map() as never,
        text: 't',
        files: [],
        routeIdentity: idA,
        estimateHistoryMessage: messageMock,
        estimateDraft: draftMock
      })
    )
    // No cross-mount reuse: the cleared session estimates from scratch.
    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(2))
  })

  it('stale A after B on the session path cannot overwrite the newer scalar', async () => {
    const m1 = msg('m1')
    const { result, rerender } = renderHook(
      (props: { text: string }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: [m1],
          blockSnapshot: new Map() as never,
          text: props.text,
          files: [],
          routeIdentity: idA,
          estimateHistoryMessage: messageMock,
          estimateDraft: draftMock
        }),
      { initialProps: { text: 'A' } }
    )

    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1))
    rerender({ text: 'B' })
    // History reused (same message), draft re-runs: one draft per pass.
    await waitFor(() => expect(draftMock).toHaveBeenCalledTimes(2))
    expect(messageMock).toHaveBeenCalledTimes(1)

    act(() => {
      messageDeferred[0].resolve(99)
      draftDeferred[1].resolve(draftTotal(1))
    })
    await waitFor(() => expect(result.current).toBe(100))

    // The stale first pass resolves last: guarded, must not overwrite.
    act(() => {
      draftDeferred[0].resolve(draftTotal(1234))
    })
    await waitFor(() => expect(result.current).toBe(100))
  })

  it('includeMedia toggle invalidates history entries and passes the flag through', async () => {
    const m1 = msg('m1')
    const { rerender } = renderHook(
      (props: { includeMedia: boolean }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: [m1],
          blockSnapshot: new Map() as never,
          text: 't',
          files: [],
          routeIdentity: idA,
          includeMedia: props.includeMedia,
          estimateHistoryMessage: messageMock,
          estimateDraft: draftMock
        }),
      { initialProps: { includeMedia: true } }
    )

    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1))
    expect(messageMock.mock.calls[0][1]).toEqual({ includeMedia: true, snapshotBlocks: expect.any(Map) })

    rerender({ includeMedia: false })
    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(2))
    expect(messageMock.mock.calls[1][1]).toEqual({ includeMedia: false, snapshotBlocks: expect.any(Map) })
  })

  it('prompt change updates the scalar without re-estimating history', async () => {
    const m1 = msg('m1')
    const assistantA = { ...baseAssistant, prompt: '' }
    const assistantB = { ...baseAssistant, prompt: 'hello' }
    const { result, rerender } = renderHook(
      (props: { assistant: Assistant }) =>
        usePromptTokenEstimate({
          assistant: props.assistant,
          tokenEstimationMessages: [m1],
          blockSnapshot: new Map() as never,
          text: 't',
          files: [],
          routeIdentity: idA,
          estimateHistoryMessage: messageMock,
          estimateDraft: draftMock
        }),
      { initialProps: { assistant: assistantA } }
    )

    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1))
    act(() => {
      messageDeferred[0].resolve(100)
      draftDeferred[0].resolve(draftTotal(1))
    })
    await waitFor(() => expect(result.current).toBe(101))

    rerender({ assistant: assistantB })
    // History reused (same message), draft re-runs: one draft per pass.
    await waitFor(() => expect(draftMock).toHaveBeenCalledTimes(2))
    expect(messageMock).toHaveBeenCalledTimes(1)
    act(() => {
      draftDeferred[1].resolve(draftTotal(1))
    })
    await waitFor(() => expect(result.current).toBe(106))
  })
})
