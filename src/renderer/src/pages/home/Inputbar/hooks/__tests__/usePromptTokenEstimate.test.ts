import type { LocalTokenEstimate } from '@renderer/services/LocalTokenEstimator'
import type { Assistant, FileMetadata } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type EstimateDraftFn, type EstimateHistoryFn, usePromptTokenEstimate } from '../usePromptTokenEstimate'

// ---------------------------------------------------------------------------
// Helper: a deferred promise we resolve manually, so async order is deterministic.
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

// ---------------------------------------------------------------------------
// Stable injectable estimator mocks (kept module-level so the hook's dependency
// array stays referentially stable across renders — only inputs change).
// ---------------------------------------------------------------------------
const baseAssistant = { id: 'a1' } as unknown as Assistant
const baseMessages: Message[] = []

let historyDeferred: Deferred<number>[]
let draftDeferred: Deferred<LocalTokenEstimate>[]

const historyMock = vi.fn((_assistant: Assistant, _messages: Message[]) => {
  const d = deferred<number>()
  historyDeferred.push(d)
  return d.promise
}) as unknown as Mock<EstimateHistoryFn>

const draftMock = vi.fn((_params: { content?: string; files?: FileMetadata[] }) => {
  const d = deferred<LocalTokenEstimate>()
  draftDeferred.push(d)
  return d.promise
}) as unknown as Mock<EstimateDraftFn>

const file = (id: string): FileMetadata => ({ id, type: 'document' }) as FileMetadata

// Debounce in the hook is 200ms; under real timers the test files take a little
// longer but remain deterministic. We avoid fake timers to keep @testing-library
// `act` microtask flushing reliable across the suite.
describe('usePromptTokenEstimate', () => {
  beforeEach(() => {
    historyDeferred = []
    draftDeferred = []
    historyMock.mockClear()
    draftMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('text-only: estimates history and draft concurrently after debounce', async () => {
    const { result } = renderHook(() =>
      usePromptTokenEstimate({
        assistant: baseAssistant,
        tokenEstimationMessages: baseMessages,
        text: 'hello',
        files: [],
        estimateHistory: historyMock,
        estimateDraft: draftMock
      })
    )

    // Debounced — no estimation yet.
    expect(result.current).toBe(0)
    expect(historyMock).not.toHaveBeenCalled()

    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(1))

    act(() => {
      historyDeferred[0].resolve(120)
      draftDeferred[0].resolve({ textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 5 })
    })

    await waitFor(() => expect(result.current).toBe(125)) // 120 + 5
  })

  it('attachment addition: files participate in the concurrent draft estimate', async () => {
    const { result, rerender } = renderHook(
      (props: { text: string; files: FileMetadata[] }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: baseMessages,
          text: props.text,
          files: props.files,
          estimateHistory: historyMock,
          estimateDraft: draftMock
        }),
      { initialProps: { text: 'hi', files: [] as FileMetadata[] } }
    )

    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(1))
    act(() => {
      historyDeferred[0].resolve(10)
      draftDeferred[0].resolve({ textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 2 })
    })
    await waitFor(() => expect(result.current).toBe(12))

    // Add an attachment → re-estimate.
    rerender({ text: 'hi', files: [file('f1')] as FileMetadata[] })
    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(2))
    // The draft estimator received the file so the attachment is counted.
    expect(draftMock.mock.calls[1][0]).toEqual({ content: 'hi', files: [file('f1')] })

    act(() => {
      historyDeferred[1].resolve(10)
      draftDeferred[1].resolve({ textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 42 })
    })
    await waitFor(() => expect(result.current).toBe(52)) // attachment tokens now included
  })

  it('stale A after B: a late-resolving older request cannot overwrite the newer result', async () => {
    const { result, rerender } = renderHook(
      (props: { text: string }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: baseMessages,
          text: props.text,
          files: [],
          estimateHistory: historyMock,
          estimateDraft: draftMock
        }),
      { initialProps: { text: 'A' } }
    )

    // Fire request A.
    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(1))
    expect(historyDeferred).toHaveLength(1)

    // Dependency change → cleanup A (cancelled), schedule B.
    rerender({ text: 'B' })
    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(2))
    expect(historyDeferred).toHaveLength(2)

    // Resolve B first, then A last (stale).
    act(() => {
      historyDeferred[1].resolve(99)
      draftDeferred[1].resolve({ textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 1 })
    })
    await waitFor(() => expect(result.current).toBe(100)) // B committed

    act(() => {
      historyDeferred[0].resolve(1234)
      draftDeferred[0].resolve({ textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 1 })
    })
    // A is stale — must NOT overwrite.
    await waitFor(() => expect(result.current).toBe(100))
  })

  it('failure path: rejecting the estimation pair keeps the previous value', async () => {
    const { result, rerender } = renderHook(
      (props: { text: string }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: baseMessages,
          text: props.text,
          files: [],
          estimateHistory: historyMock,
          estimateDraft: draftMock
        }),
      { initialProps: { text: 'first' } }
    )

    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(1))
    act(() => {
      historyDeferred[0].resolve(50)
      draftDeferred[0].resolve({ textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 7 })
    })
    await waitFor(() => expect(result.current).toBe(57))

    // New request that fails entirely.
    rerender({ text: 'second' })
    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(2))

    act(() => {
      historyDeferred[1].reject(new Error('boom'))
    })
    // Last valid value preserved; not reset to 0. The rejected pass must not throw.
    await waitFor(() => expect(result.current).toBe(57))
  })

  it('unmount cleanup: resolving after unmount does not write or throw', async () => {
    const { unmount } = renderHook(() =>
      usePromptTokenEstimate({
        assistant: baseAssistant,
        tokenEstimationMessages: baseMessages,
        text: 'x',
        files: [],
        estimateHistory: historyMock,
        estimateDraft: draftMock
      })
    )

    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(1))
    expect(historyDeferred).toHaveLength(1)

    unmount()

    // The in-flight promise resolves after unmount — must be a no-op, no throw.
    expect(() => {
      act(() => {
        historyDeferred[0].resolve(10)
        draftDeferred[0].resolve({ textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 1 })
      })
    }).not.toThrow()
  })

  it('dependency changes re-estimate with the new inputs', async () => {
    const { rerender } = renderHook(
      (props: { messages: Message[]; text: string }) =>
        usePromptTokenEstimate({
          assistant: baseAssistant,
          tokenEstimationMessages: props.messages,
          text: props.text,
          files: [],
          estimateHistory: historyMock,
          estimateDraft: draftMock
        }),
      { initialProps: { messages: baseMessages, text: 't1' } }
    )

    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(1))

    const newMessages = [{ id: 'm1' }] as unknown as Message[]
    rerender({ messages: newMessages, text: 't2' })
    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(2))
    // A new estimation pass ran with the updated message set.
    expect(historyMock.mock.calls[1][1]).toBe(newMessages)
    expect(draftMock.mock.calls[1][0]).toEqual({ content: 't2', files: [] })
  })
})
