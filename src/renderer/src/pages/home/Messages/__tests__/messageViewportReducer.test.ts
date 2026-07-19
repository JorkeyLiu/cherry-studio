import { describe, expect, it } from 'vitest'

import { createMessageViewportState, messageViewportReducer } from '../messageViewportReducer'
import { createLatestMessageWindow } from '../messageWindow'

const emptyWindow = createLatestMessageWindow([], 20)

describe('messageViewportReducer', () => {
  it('commits a complete message window atomically', () => {
    const state = messageViewportReducer(createMessageViewportState(), { type: 'window/apply', window: emptyWindow })

    expect(state.window).toBe(emptyWindow)
    expect(messageViewportReducer(state, { type: 'window/reset', window: null }).window).toBeNull()
  })

  it('starts, finishes, and cancels directional loads', () => {
    const olderToken = {}
    const newerToken = {}
    let state = messageViewportReducer(createMessageViewportState(), {
      type: 'load/start',
      direction: 'older',
      token: olderToken
    })
    expect(state.loading).toEqual({ older: true, newer: false })

    state = messageViewportReducer(state, {
      type: 'load/finish',
      direction: 'older',
      token: olderToken,
      topicGeneration: 0,
      window: emptyWindow
    })
    expect(state.window).toBe(emptyWindow)
    expect(state.loading.older).toBe(false)

    state = messageViewportReducer(state, { type: 'load/start', direction: 'newer', token: newerToken })
    state = messageViewportReducer(state, {
      type: 'load/cancel',
      direction: 'newer',
      token: newerToken,
      topicGeneration: 0
    })
    expect(state.loading).toEqual({ older: false, newer: false })
  })

  it('rejects stale load completion after a topic reset', () => {
    const token = {}
    let state = messageViewportReducer(createMessageViewportState(), { type: 'load/start', direction: 'older', token })
    state = messageViewportReducer(state, { type: 'topic/reset' })
    state = messageViewportReducer(state, {
      type: 'load/finish',
      direction: 'older',
      token,
      topicGeneration: 0,
      window: emptyWindow
    })

    expect(state.window).toBeNull()
    expect(state.topicGeneration).toBe(1)
  })

  it('does not let an old load cancel or finish a newer load', () => {
    const oldToken = {}
    const newToken = {}
    let state = messageViewportReducer(createMessageViewportState(), {
      type: 'load/start',
      direction: 'newer',
      token: oldToken
    })
    state = messageViewportReducer(state, { type: 'load/start', direction: 'newer', token: newToken })
    state = messageViewportReducer(state, {
      type: 'load/cancel',
      direction: 'newer',
      token: oldToken,
      topicGeneration: 0
    })
    state = messageViewportReducer(state, {
      type: 'load/finish',
      direction: 'newer',
      token: oldToken,
      topicGeneration: 0,
      window: emptyWindow
    })

    expect(state.loading.newer).toBe(true)
    expect(state.loads.newer).toMatchObject({ active: true, token: newToken })
    expect(state.window).toBeNull()
  })

  it('enforces last-navigation-wins generation and cancellation', () => {
    const firstToken = {}
    const secondToken = {}
    let state = messageViewportReducer(createMessageViewportState(), {
      type: 'navigation/begin',
      token: firstToken,
      targetId: 'first',
      source: 'event'
    })
    state = messageViewportReducer(state, {
      type: 'navigation/begin',
      token: secondToken,
      targetId: 'second',
      source: 'pending'
    })
    state = messageViewportReducer(state, { type: 'navigation/finish', token: firstToken })
    expect(state.navigation).toMatchObject({ generation: 2, targetId: 'second', phase: 'preparing' })

    state = messageViewportReducer(state, { type: 'navigation/cancel', token: secondToken })
    expect(state.navigation).toEqual({
      generation: 3,
      token: null,
      targetId: null,
      source: null,
      alignment: 'start',
      phase: 'idle'
    })
  })

  it('tracks programmatic and anchoring scroll transitions', () => {
    const firstToken = {}
    const secondToken = {}
    let state = messageViewportReducer(createMessageViewportState(), {
      type: 'scroll/begin',
      mode: 'programmatic',
      token: firstToken
    })
    state = messageViewportReducer(state, { type: 'scroll/begin', mode: 'anchoring', token: secondToken })
    state = messageViewportReducer(state, { type: 'scroll/end', token: firstToken })
    expect(state.scrollMode).toBe('anchoring')

    state = messageViewportReducer(state, { type: 'scroll/end', token: secondToken })
    expect(state.scrollMode).toBe('user')
  })

  it('resets all topic-scoped state and invalidates navigation', () => {
    let state = createMessageViewportState(emptyWindow)
    state = messageViewportReducer(state, {
      type: 'navigation/begin',
      token: {},
      targetId: 'target',
      source: 'restore'
    })
    state = messageViewportReducer(state, { type: 'load/start', direction: 'newer', token: {} })
    state = messageViewportReducer(state, { type: 'scroll/begin', mode: 'anchoring', token: {} })

    state = messageViewportReducer(state, { type: 'topic/reset' })

    expect(state).toEqual({
      window: null,
      loading: { older: false, newer: false },
      loads: {
        older: { active: false, token: null, topicGeneration: 0 },
        newer: { active: false, token: null, topicGeneration: 0 }
      },
      topicGeneration: 1,
      navigation: {
        generation: 2,
        token: null,
        targetId: null,
        source: null,
        alignment: 'start',
        phase: 'idle'
      },
      scrollGeneration: 0,
      scrollMode: 'user',
      scrollToken: null
    })
  })
})
