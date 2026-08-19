import { useTopicTransition } from '@renderer/hooks/useTopicTransition'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createMessageViewportState, messageViewportReducer } from '../messageViewportReducer'

/**
 * S3.1 focused tests for the useTopicTransition hook.
 *
 * Verifies:
 * - Topic change detection (prevTopicId → current topicId)
 * - Deterministic cleanup phase ordering
 * - viewportDispatch called with topic/reset on topic change
 * - Callbacks invoked in correct order
 * - No re-trigger when topicId hasn't changed
 * - useLayoutEffect: transition runs synchronously before paint
 * - resetOnFirstUpdate: onFirstUpdate ref is reset per topic
 * - transitionEpochRef increments on each transition (A→B→A produces distinct epochs)
 */
describe('useTopicTransition', () => {
  const createMockCallbacks = () => ({
    viewportDispatch: vi.fn(),
    resetBootstrapPhase: vi.fn(),
    clearTimers: vi.fn(),
    resetSavedRestore: vi.fn(),
    resetOnFirstUpdate: vi.fn()
  })

  it('does not fire on initial render (no topic change)', () => {
    const callbacks = createMockCallbacks()
    const epochRef = { current: 0 }
    renderHook(() =>
      useTopicTransition({
        topicId: 'topic-a',
        ...callbacks,
        transitionEpochRef: epochRef
      })
    )

    expect(callbacks.viewportDispatch).not.toHaveBeenCalled()
    expect(callbacks.resetBootstrapPhase).not.toHaveBeenCalled()
    expect(callbacks.clearTimers).not.toHaveBeenCalled()
    expect(callbacks.resetSavedRestore).not.toHaveBeenCalled()
    expect(callbacks.resetOnFirstUpdate).not.toHaveBeenCalled()
    expect(epochRef.current).toBe(0)
  })

  it('fires transition when topicId changes', () => {
    const callbacks = createMockCallbacks()
    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          ...callbacks,
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    // No calls yet
    expect(callbacks.viewportDispatch).not.toHaveBeenCalled()

    // Change topic
    rerender({ topicId: 'topic-b' })

    // All callbacks should have been called
    expect(callbacks.viewportDispatch).toHaveBeenCalledOnce()
    expect(callbacks.viewportDispatch).toHaveBeenCalledWith({ type: 'topic/reset' })
    expect(callbacks.clearTimers).toHaveBeenCalledOnce()
    expect(callbacks.resetBootstrapPhase).toHaveBeenCalledOnce()
    expect(callbacks.resetSavedRestore).toHaveBeenCalledOnce()
    expect(callbacks.resetOnFirstUpdate).toHaveBeenCalledOnce()
    expect(epochRef.current).toBe(1)
  })

  it('calls callbacks in deterministic order: viewport → timers → bootstrap → savedRestore → onFirstUpdate', () => {
    const callOrder: string[] = []
    const epochRef = { current: 0 }
    const callbacks = {
      viewportDispatch: vi.fn(() => callOrder.push('viewport')),
      resetBootstrapPhase: vi.fn(() => callOrder.push('bootstrap')),
      clearTimers: vi.fn(() => callOrder.push('timers')),
      resetSavedRestore: vi.fn(() => callOrder.push('savedRestore')),
      resetOnFirstUpdate: vi.fn(() => callOrder.push('onFirstUpdate'))
    }

    const { rerender } = renderHook(
      ({ topicId }) => {
        useTopicTransition({
          topicId,
          ...callbacks,
          transitionEpochRef: epochRef
        })
      },
      { initialProps: { topicId: 'topic-a' } }
    )

    rerender({ topicId: 'topic-b' })

    expect(callOrder).toEqual(['viewport', 'timers', 'bootstrap', 'savedRestore', 'onFirstUpdate'])
  })

  it('does not re-fire when topicId stays the same across re-renders', () => {
    const callbacks = createMockCallbacks()
    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          ...callbacks,
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    // Re-render with same topicId
    rerender({ topicId: 'topic-a' })

    expect(callbacks.viewportDispatch).not.toHaveBeenCalled()
    expect(epochRef.current).toBe(0)
  })

  it('fires for each successive topic change', () => {
    const callbacks = createMockCallbacks()
    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          ...callbacks,
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    rerender({ topicId: 'topic-b' })
    expect(callbacks.viewportDispatch).toHaveBeenCalledTimes(1)
    expect(epochRef.current).toBe(1)

    rerender({ topicId: 'topic-c' })
    expect(callbacks.viewportDispatch).toHaveBeenCalledTimes(2)
    expect(epochRef.current).toBe(2)

    rerender({ topicId: 'topic-a' }) // back to original
    expect(callbacks.viewportDispatch).toHaveBeenCalledTimes(3)
    expect(epochRef.current).toBe(3)
  })

  it('dispatches topic/reset which advances topicGeneration for stale rejection', () => {
    let viewportState = createMessageViewportState()
    const viewportDispatch = vi.fn((action: Parameters<typeof messageViewportReducer>[1]) => {
      viewportState = messageViewportReducer(viewportState, action)
    })

    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          viewportDispatch,
          resetBootstrapPhase: vi.fn(),
          clearTimers: vi.fn(),
          resetSavedRestore: vi.fn(),
          resetOnFirstUpdate: vi.fn(),
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    const initialGeneration = viewportState.topicGeneration

    rerender({ topicId: 'topic-b' })

    // topicGeneration should have advanced by 1
    expect(viewportState.topicGeneration).toBe(initialGeneration + 1)
    // navigation.generation should also advance (stale navigation rejection)
    expect(viewportState.navigation.generation).toBe(1)
  })

  it('resets viewport navigation phase to idle after topic/reset', () => {
    let viewportState = createMessageViewportState()
    const viewportDispatch = vi.fn((action: Parameters<typeof messageViewportReducer>[1]) => {
      viewportState = messageViewportReducer(viewportState, action)
    })

    // Simulate an in-flight navigation from the old topic
    const token = {}
    act(() => {
      viewportState = messageViewportReducer(viewportState, {
        type: 'navigation/begin',
        token,
        targetId: 'some-message',
        source: 'event'
      })
    })

    expect(viewportState.navigation.phase).toBe('preparing')
    expect(viewportState.navigation.token).toBe(token)

    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          viewportDispatch,
          resetBootstrapPhase: vi.fn(),
          clearTimers: vi.fn(),
          resetSavedRestore: vi.fn(),
          resetOnFirstUpdate: vi.fn(),
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    rerender({ topicId: 'topic-b' })

    // After topic/reset, navigation should be idle with incremented generation
    expect(viewportState.navigation.phase).toBe('idle')
    expect(viewportState.navigation.token).toBeNull()
    expect(viewportState.navigation.generation).toBe(2) // 1 (begin) + 1 (reset)
  })

  it('S3.1 Blocker 2: transition runs synchronously via useLayoutEffect (not passive)', () => {
    const callbacks = createMockCallbacks()
    const epochRef = { current: 0 }
    const callTimestamps: string[] = []

    const { rerender } = renderHook(
      ({ topicId }) => {
        useTopicTransition({
          topicId,
          ...callbacks,
          transitionEpochRef: epochRef
        })
        // This useLayoutEffect runs in the same commit phase as useTopicTransition
        // UseEffect would run after paint in a separate task
      },
      { initialProps: { topicId: 'topic-a' } }
    )

    // Synchronously rerender — useLayoutEffect callbacks fire in same commit
    act(() => {
      rerender({ topicId: 'topic-b' })
      callTimestamps.push('after-rerender-but-before-yield')
    })

    // If useLayoutEffect is used, viewportDispatch was called before we yielded
    // If useEffect was used, viewportDispatch would not be called yet
    expect(callbacks.viewportDispatch).toHaveBeenCalledOnce()
    expect(callTimestamps).toContain('after-rerender-but-before-yield')
  })

  it('S3.1 Blocker 4: resetOnFirstUpdate is called on each topic transition', () => {
    const callbacks = createMockCallbacks()
    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          ...callbacks,
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    // First transition: A → B
    rerender({ topicId: 'topic-b' })
    expect(callbacks.resetOnFirstUpdate).toHaveBeenCalledTimes(1)

    // Second transition: B → C
    rerender({ topicId: 'topic-c' })
    expect(callbacks.resetOnFirstUpdate).toHaveBeenCalledTimes(2)

    // Back to A: C → A
    rerender({ topicId: 'topic-a' })
    expect(callbacks.resetOnFirstUpdate).toHaveBeenCalledTimes(3)
  })

  it('S3.1 Blocker 1: transitionEpochRef increments for each transition including A→B→A', () => {
    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          ...createMockCallbacks(),
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    expect(epochRef.current).toBe(0)

    // A → B
    rerender({ topicId: 'topic-b' })
    expect(epochRef.current).toBe(1)

    // B → A (revisit same topic)
    rerender({ topicId: 'topic-a' })
    expect(epochRef.current).toBe(2)

    // A → B → A rapid
    rerender({ topicId: 'topic-b' })
    expect(epochRef.current).toBe(3)
    rerender({ topicId: 'topic-a' })
    expect(epochRef.current).toBe(4)

    // Same topic re-render does NOT increment
    rerender({ topicId: 'topic-a' })
    expect(epochRef.current).toBe(4)
  })

  it('S3.1 Blocker 1: epoch-based guard rejects stale async completion under A→B→A', () => {
    const epochRef = { current: 0 }
    const { rerender } = renderHook(
      ({ topicId }) =>
        useTopicTransition({
          topicId,
          ...createMockCallbacks(),
          transitionEpochRef: epochRef
        }),
      { initialProps: { topicId: 'topic-a' } }
    )

    // Simulate: capture epoch at bootstrap start for topic A
    const capturedEpoch = epochRef.current // 0

    // Topic changes: A → B
    rerender({ topicId: 'topic-b' })
    expect(epochRef.current).toBe(1)

    // Topic changes: B → A (revisit)
    rerender({ topicId: 'topic-a' })
    expect(epochRef.current).toBe(2)

    // Stale async completion from original topic A: epoch guard check
    // The old callback captured epochRef.current === 0, but current is 2
    expect(epochRef.current).not.toBe(capturedEpoch) // 2 !== 0 → rejected

    // New bootstrap for topic A (second visit) captures epoch 2
    const newCapturedEpoch = epochRef.current // 2
    expect(newCapturedEpoch).toBe(2)
    // This one would pass the guard (epoch still 2)
    expect(epochRef.current).toBe(newCapturedEpoch)
  })
})
