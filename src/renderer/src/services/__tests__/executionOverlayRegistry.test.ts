/**
 * Execution overlay registry (route B): per-execution monotonic sequence,
 * route isolation, no-subscriber no-capture, witness-gated terminal handoff,
 * supersession without wallclock, bounded retention, and cleanup.
 *
 * Pure registry unit test: handoff is driven only by explicit terminal-read
 * witnesses captured via `captureTerminalReadWitness` — no closure cache or
 * store is involved. Unknown/no-witness reads always retain (fail-closed).
 */
import {
  captureTerminalReadWitness,
  getComposedOverlayBlocks,
  getExecutionOverlayDiagnostics,
  getExecutionOverlayVersion,
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay,
  type TerminalReadWitness,
  tryHandoffAfterClosure
} from '@renderer/services/executionOverlayRegistry'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOPIC = 't-overlay'
const routeKey = (route: string | null) => routeKeyForExecutionOverlay(TOPIC, route)

function block(id: string, content: string, messageId = 'a1'): any {
  return { id, messageId, type: 'main_text', content, status: 'streaming' }
}

function witnessFor(route: string | null): TerminalReadWitness {
  return captureTerminalReadWitness(routeKey(route))
}

describe('executionOverlayRegistry', () => {
  beforeEach(() => {
    resetExecutionOverlayForTests()
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

  it('retires a terminal overlay only when the read witness proves the read started after the ack', () => {
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
      // Read issued before the terminal ack: the witness is empty, so even a
      // closure carrying the terminal member must retain.
      const readBeforeAck = witnessFor(null)
      expect(readBeforeAck.terminals).toEqual([])
      handle.recordTerminalPersisted('success')
      handle.dispose()
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, readBeforeAck)).toBe(false)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )

      // Closure without the terminal member: retained even with a valid witness.
      const validRead = witnessFor(null)
      expect(validRead.terminals).toHaveLength(1)
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'other' }] }, validRead)).toBe(false)

      // New read (issued after the ack) carrying the terminal member: retired.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, validRead)).toBe(true)
      expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('excludes terminals acked while the read is in flight', () => {
    const key = routeKey(null)
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      const first = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({ blocks: [block('a1-block', 'first-terminal')] })
      })
      first.notifyDelta()
      first.recordTerminalPersisted('success')
      first.dispose()
      // Read issued now only knows the first terminal.
      const midRead = witnessFor(null)
      expect(midRead.terminals).toHaveLength(1)

      const second = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a2',
        snapshot: () => ({ blocks: [block('a2-block', 'second-terminal')] })
      })
      second.notifyDelta()
      second.recordTerminalPersisted('error')
      second.dispose()

      // The mid-flight ack is not in this read's witness: a closure carrying
      // both members retires only the first entry.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }, { id: 'a2' }] }, midRead)).toBe(true)
      expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
      expect((getComposedOverlayBlocks(key, ['a2-block']).get('a2-block') as { content?: unknown })?.content).toBe(
        'second-terminal'
      )

      // A later read covering both retires the remainder.
      const lateRead = witnessFor(null)
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }, { id: 'a2' }] }, lateRead)).toBe(true)
      expect(getComposedOverlayBlocks(key, ['a2-block']).size).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('retires one terminal per matching token when several terminals share a route', () => {
    const key = routeKey(null)
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      for (const messageId of ['a1', 'a2']) {
        const handle = registerExecutionOverlay({
          topicId: TOPIC,
          route: null,
          messageId,
          snapshot: () => ({ blocks: [block(`${messageId}-block`, `terminal-${messageId}`, messageId)] })
        })
        handle.notifyDelta()
        handle.recordTerminalPersisted('success')
        handle.dispose()
      }
      const read = witnessFor(null)
      expect(read.terminals).toHaveLength(2)
      // Closure carrying only one member retires only that entry.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, read)).toBe(true)
      expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
      expect((getComposedOverlayBlocks(key, ['a2-block']).get('a2-block') as { content?: unknown })?.content).toBe(
        'terminal-a2'
      )
      // The same witness still applies to the remainder (tokens are per entry).
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a2' }] }, read)).toBe(true)
      expect(getComposedOverlayBlocks(key, ['a2-block']).size).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('never lets an old receipt retire a newer attempt with the same message id', () => {
    const key = routeKey(null)
    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      const first = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        resendAttemptId: 'attempt-1',
        snapshot: () => ({ blocks: [block('a1-block', 'first-body')] })
      })
      first.notifyDelta()
      first.recordTerminalPersisted('success')
      first.dispose()
      const oldReceipt = witnessFor(null)

      const second = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        resendAttemptId: 'attempt-2',
        snapshot: () => ({ blocks: [block('a1-block', 'second-body')] })
      })
      second.notifyDelta()
      second.recordTerminalPersisted('success')
      second.dispose()

      // The old receipt names the first execution only: the second attempt stays.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, oldReceipt)).toBe(true)
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'second-body'
      )
      // A fresh read retires the newer attempt.
      const newReceipt = witnessFor(null)
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, newReceipt)).toBe(true)
      expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('retains on missing, foreign-route, and stale witnesses (fail-closed)', () => {
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
      handle.recordTerminalPersisted('success')
      handle.dispose()

      // No witness at all (cold read, never bound): retain.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] })).toBe(false)
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, null)).toBe(false)
      // Witness for another route: retain.
      const foreign = witnessFor('branch-b')
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, foreign)).toBe(false)
      expect(tryHandoffAfterClosure(TOPIC, 'branch-b', { messages: [{ id: 'a1' }] }, foreign)).toBe(false)
      // The terminal is still retained throughout.
      expect((getComposedOverlayBlocks(key, ['a1-block']).get('a1-block') as { content?: unknown })?.content).toBe(
        'terminal-body'
      )
      // The exact-route witness still retires it.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, witnessFor(null))).toBe(true)
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

  it('keeps an unsubscribed terminal checkpoint minimal and still retires it on a witnessed read', () => {
    const key = routeKey(null)
    const handle = registerExecutionOverlay({
      topicId: TOPIC,
      route: null,
      messageId: 'a1',
      snapshot: () => ({ blocks: [block('a1-block', 'terminal-body')] })
    })
    // No consumer: no body is captured, but the terminal token is recorded.
    handle.notifyDelta()
    handle.recordTerminalPersisted('success')
    expect(getComposedOverlayBlocks(key, ['a1-block']).size).toBe(0)

    const unsubscribe = subscribeExecutionOverlay(key, () => {})
    try {
      // No body to compose while unsubscribed; a witnessed read still retires
      // the checkpoint itself.
      expect(tryHandoffAfterClosure(TOPIC, null, { messages: [{ id: 'a1' }] }, witnessFor(null))).toBe(true)
      expect(getExecutionOverlayDiagnostics().retainedTerminalCount).toBe(0)
    } finally {
      handle.dispose()
      unsubscribe()
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
