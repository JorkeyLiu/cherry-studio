import { describe, expect, it } from 'vitest'

import { createMessageViewportState, messageViewportReducer } from '../messageViewportReducer'
import { createLatestMessageWindow } from '../messageWindow'

/**
 * S3.1 focused integration tests for stable-host topic transition behavior.
 *
 * These tests verify that the viewport reducer correctly handles the
 * transition lifecycle as orchestrated by useTopicTransition, specifically:
 * - topicGeneration advances on each topic/reset (stale load rejection)
 * - navigation.generation advances on each topic/reset (stale nav rejection)
 * - window is cleared after topic/reset (first-load scenario)
 * - old-topic pending loads are rejected by generation mismatch
 * - old-topic navigation tokens are invalidated by generation mismatch
 */
describe('S3.1 stable-host topic transition', () => {
  const emptyWindow = createLatestMessageWindow([], 20)

  it('advances topicGeneration on each topic/reset for stale load rejection', () => {
    let state = createMessageViewportState()

    // Simulate first topic
    state = messageViewportReducer(state, { type: 'topic/reset', window: emptyWindow })
    expect(state.topicGeneration).toBe(1)

    // Simulate second topic
    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.topicGeneration).toBe(2)

    // Simulate third topic
    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.topicGeneration).toBe(3)
  })

  it('advances navigation.generation on each topic/reset for stale nav rejection', () => {
    let state = createMessageViewportState()

    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.navigation.generation).toBe(1)

    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.navigation.generation).toBe(2)
  })

  it('rejects old-topic load finish after topic/reset (stale load)', () => {
    const loadToken = {}
    let state = createMessageViewportState()

    // Start a load on topic A
    state = messageViewportReducer(state, {
      type: 'load/start',
      direction: 'older',
      token: loadToken
    })
    expect(state.loading.older).toBe(true)

    // Topic B resets viewport
    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.topicGeneration).toBe(1)

    // Old load finishes with stale generation — should be rejected
    state = messageViewportReducer(state, {
      type: 'load/finish',
      direction: 'older',
      token: loadToken,
      topicGeneration: 0, // old generation
      window: emptyWindow
    })

    // Window should remain null (stale load rejected)
    expect(state.window).toBeNull()
    expect(state.loading.older).toBe(false)
  })

  it('rejects old-topic navigation after topic/reset (stale navigation)', () => {
    const navToken = {}
    let state = createMessageViewportState()

    // Start navigation on topic A
    state = messageViewportReducer(state, {
      type: 'navigation/begin',
      token: navToken,
      targetId: 'message-1',
      source: 'event'
    })
    expect(state.navigation.phase).toBe('preparing')
    expect(state.navigation.token).toBe(navToken)

    // Topic B resets viewport
    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.navigation.phase).toBe('idle')
    expect(state.navigation.token).toBeNull()

    // Old navigation finish with stale token — should be rejected
    state = messageViewportReducer(state, {
      type: 'navigation/finish',
      token: navToken
    })

    // Navigation should remain idle (stale token rejected)
    expect(state.navigation.phase).toBe('idle')
  })

  it('clears window after topic/reset for first-load scenario', () => {
    const window = createLatestMessageWindow([], 20)
    let state = createMessageViewportState(window)
    expect(state.window).toBe(window)

    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.window).toBeNull()
  })

  it('resets scroll mode to user after topic/reset', () => {
    let state = createMessageViewportState()
    state = messageViewportReducer(state, {
      type: 'scroll/begin',
      mode: 'programmatic',
      token: {}
    })
    expect(state.scrollMode).toBe('programmatic')

    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.scrollMode).toBe('user')
    expect(state.scrollToken).toBeNull()
  })

  it('cancels all active loads on topic/reset', () => {
    const olderToken = {}
    const newerToken = {}
    let state = createMessageViewportState()

    state = messageViewportReducer(state, { type: 'load/start', direction: 'older', token: olderToken })
    state = messageViewportReducer(state, { type: 'load/start', direction: 'newer', token: newerToken })
    expect(state.loading).toEqual({ older: true, newer: true })

    state = messageViewportReducer(state, { type: 'topic/reset' })
    expect(state.loading).toEqual({ older: false, newer: false })
    expect(state.loads.older.active).toBe(false)
    expect(state.loads.newer.active).toBe(false)
  })

  it('consecutive topic switches accumulate generation correctly', () => {
    let state = createMessageViewportState()

    // 5 topic switches
    for (let i = 0; i < 5; i++) {
      state = messageViewportReducer(state, { type: 'topic/reset' })
    }

    expect(state.topicGeneration).toBe(5)
    expect(state.navigation.generation).toBe(5)
  })
})
