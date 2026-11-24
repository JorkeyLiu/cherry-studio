/**
 * Execution overlay registry (route B): per-execution monotonic sequence,
 * route isolation, no-subscriber no-capture, Main-ordered terminal handoff,
 * supersession without wallclock, bounded retention, and cleanup.
 *
 * Pure registry unit test: generation readers are stubbed through the test
 * seam so no closure cache or store is involved.
 */
import {
  getComposedOverlayBlocks,
  getExecutionOverlayDiagnostics,
  getExecutionOverlayVersion,
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  setExecutionOverlayGenerationReadersForTests,
  subscribeExecutionOverlay,
  tryHandoffAfterClosure
} from '@renderer/services/executionOverlayRegistry'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOPIC = 't-overlay'
const routeKey = (route: string | null) => routeKeyForExecutionOverlay(TOPIC, route)

function block(id: string, content: string, messageId = 'a1'): any {
  return { id, messageId, type: 'main_text', content, status: 'streaming' }
}

let loadGen = 5
let cachedGen: number | undefined = 5

describe('executionOverlayRegistry', () => {
  beforeEach(() => {
    resetExecutionOverlayForTests()
    loadGen = 5
    cachedGen = 5
    setExecutionOverlayGenerationReadersForTests({
      getCachedGeneration: () => cachedGen,
      getLoadGeneration: () => loadGen
    })
  })

  it('advances a per-execution monotonic sequence and notifies subscribers on the existing cadence', () => {
    const key = routeKey(null)
    const v0 = getExecutionOverlayVersion(key)
    const listener = vi.fn()
    const unsubscribe = subscribeExecutionOverlay(key, listener)
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'one')] })
      })
      expect(handle.notifyDelta()).toBe(1)
      expect(handle.notifyDelta()).toBe(2)
      expect(listener).toHaveBeenCalledTimes(2)
      expect(getExecutionOverlayVersion(key)).toBe(v0 + 2)
      // Composition covers accepted members only.
      const composed = getComposedOverlayBlocks(key, ['a1-block', 'other-block'])
      expect((composed.get('a1-block') as { content?: unknown })?.content).toBe('one')
      expect(composed.has('other-block')).toBe(false)
      handle.dispose()
    } finally {
      unsubscribe()
    }
  })

  it('isolates routes: an execution never leaks into another route', () => {
    const keyA = routeKey(null)
    const keyB = routeKey('branch-b')
    const unsubA = subscribeExecutionOverlay(keyA, () => {})
    const unsubB = subscribeExecutionOverlay(keyB, () => {})
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC,
        route: 'branch-b',
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'branch-body')] })
      })
      handle.notifyDelta()
      expect(getComposedOverlayBlocks(keyA, ['a1-block']).size).toBe(0)
      expect((getComposedOverlayBlocks(keyB, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'branch-body'
      )
      handle.dispose()
    } finally {
      unsubA()
      unsubB()
    }
  })

  it('captures no snapshot without a subscriber, then composes current state after subscribe', () => {
    const key = routeKey(null)
    let content = 'early'
    const handle = registerExecutionOverlay({
      topicId: TOPIC,
      route: null,
      messageId: 'a1',
      snapshot: () => ({ blocks: [block('a1-block', content)] })
    })
    // No consumer: sequence still advances (local ticket), version bumps, but
    // nothing is captured — composition stays empty.
    expect(handle.notifyDelta()).toBe(1)
    expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)

    const listener = vi.fn()
    const unsubscribe = subscribeExecutionOverlay(key, listener)
    try {
      content = 'current'
      handle.notifyDelta()
      expect(listener).toHaveBeenCalledTimes(1)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'current'
      )
      handle.dispose()
    } finally {
      unsubscribe()
    }
  })

  it('retires a terminal overlay only when a newer accepted closure carries the terminal member', () => {
    const key = routeKey(null)
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
      })
      handle.notifyDelta()
      loadGen = 7
      handle.recordTerminalPersisted('success')
      handle.dispose()

      // Same-generation read (started before/at the ack): retained.
      cachedGen = 7
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] })).toBe(false)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )

      // Closure without the terminal member: retained.
      cachedGen = 8
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'other' }] })).toBe(false)

      // Newer accepted closure carrying the terminal member: retired.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] })).toBe(true)
      expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('prefers active executions over retained terminals; last registered wins without wallclock', () => {
    const key = routeKey(null)
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      const terminal = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
      })
      terminal.notifyDelta()
      terminal.recordTerminalPersisted('success')
      terminal.dispose()

      const first = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'first-active')] })
      })
      const second = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'second-active')] })
      })
      first.notifyDelta()
      second.notifyDelta()
      // Active class wins over the retained terminal; within the class the
      // last registered execution wins — registration order, never wallclock.
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'second-active'
      )
      first.dispose()
      second.dispose()
      // Terminal retained underneath returns once no active execution holds the member.
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )
    } finally {
      unsubscribe()
    }
  })

  it('bounds retained terminals and releases them when the route loses its consumer', () => {
    const key = routeKey(null)
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    const handles = [0, 1, 2].map(() =>
      registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'body')] })
      })
    )
    for (const h of handles) {
      h.notifyDelta()
      h.recordTerminalPersisted('success')
      h.dispose()
    }
    const diag = getExecutionOverlayDiagnostics()
    expect(diag.retainedTerminalCount).toBeLessThanOrEqual(diag.maxRetainedTerminalsPerRoute)
    expect(diag.retainedTerminalCount).toBe(2)
    // Route leave releases the UI-held snapshot: the next read restores
    // directly from the Main authoritative closure.
    unsubscribe()
    expect(getExecutionOverlayDiagnostics().retainedTerminalCount).toBe(0)
    expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
  })

  it('retains the overlay when the terminal checkpoint is unknown (readers missing at the ack)', () => {
    const key = routeKey(null)
    // Explicitly simulate generation readers never becoming ready — this test
    // must NOT inherit the valid stub readers from beforeEach, otherwise the
    // gap this regression covers would be masked by the mock.
    setExecutionOverlayGenerationReadersForTests({})
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
      })
      handle.notifyDelta()
      handle.recordTerminalPersisted('success') // checkpoint unknown: no reader
      handle.dispose()
      // A later accepted closure carrying the terminal member is NOT ordering
      // evidence on its own: the checkpoint is unknown, so no early handoff.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] })).toBe(false)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )
      // A reader becoming ready later does not backfill the unknown
      // checkpoint: still no handoff. Only a later ack carrying a valid
      // checkpoint can hand off (covered by the newer-generation test above).
      setExecutionOverlayGenerationReadersForTests({
        getCachedGeneration: () => 99,
        getLoadGeneration: () => 99
      })
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] })).toBe(false)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )
    } finally {
      unsubscribe()
    }
    // Cleanup still follows the existing rules: route leave releases the body.
    expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
  })

  it('treats invalid generations as unknown: no handoff without ordering evidence', () => {
    const key = routeKey(null)
    // Ack-time read returns an invalid generation: checkpoint unknown.
    setExecutionOverlayGenerationReadersForTests({
      getCachedGeneration: () => 8,
      getLoadGeneration: () => Number.NaN
    })
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
      })
      handle.notifyDelta()
      handle.recordTerminalPersisted('success')
      handle.dispose()
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] })).toBe(false)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )
    } finally {
      unsubscribe()
    }
    // An unreadable cached generation is likewise no proof: a valid-checkpoint
    // entry is still retained when the closure read cannot be ordered.
    setExecutionOverlayGenerationReadersForTests({
      getCachedGeneration: () => undefined,
      getLoadGeneration: () => 7
    })
    const unsubscribe2 = subscribeExecutionOverlay(key, () => {})
    try {
      const handle = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
      })
      handle.notifyDelta()
      handle.recordTerminalPersisted('success') // checkpoint 7, valid
      handle.dispose()
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] })).toBe(false)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )
    } finally {
      unsubscribe2()
    }
  })

  it('dispose ends a live execution and unsubscribing an active route keeps it notifying', () => {
    const key = routeKey(null)
    const listener = vi.fn()
    const unsubscribe = subscribeExecutionOverlay(key, listener)
    const live = getExecutionOverlayDiagnostics().liveCount
    const handle = registerExecutionOverlay({
      topicId: TOPIC,
      route: null,
      messageId: 'a1',
      snapshot: () => ({ blocks: [block('a1-block', 'live')] })
    })
    handle.notifyDelta()
    expect(getExecutionOverlayDiagnostics().liveCount).toBe(live + 1)
    expect(listener).toHaveBeenCalledTimes(1)
    handle.dispose()
    expect(getExecutionOverlayDiagnostics().liveCount).toBe(live)
    // Disposal itself notifies once (snapshot released); further deltas on a
    // disposed execution are no-ops even while subscribed.
    expect(listener).toHaveBeenCalledTimes(2)
    handle.notifyDelta()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
    unsubscribe()
  })
})
