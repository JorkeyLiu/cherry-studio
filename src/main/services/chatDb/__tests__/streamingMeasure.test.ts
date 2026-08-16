import { afterEach, describe, expect, it, vi } from 'vitest'

import { STREAM_ATTR_MAIN_STATE_KEY } from '../streamingMeasure'

// The Main collector gate is a build-time define inlined by vitest.config.ts
// `define` (from `PERF_STREAM_ATTR` at vitest start). This test is
// deterministic in BOTH invocations: the default `pnpm test` gate exercises
// the disabled/inert path, and `PERF_STREAM_ATTR=1 pnpm test:main:core` (or
// the E2E) exercises the enabled path. The enabled path is the primary
// production-build evidence surface.
const testEnabled = typeof __PERF_STREAM_ATTR__ !== 'undefined' && __PERF_STREAM_ATTR__ === 'true'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[STREAM_ATTR_MAIN_STATE_KEY]
  vi.resetModules()
})

describe('streamingMeasure — gate resolution', () => {
  it('reflects the baked build-time define (this invocation: enabled=false)', async () => {
    const mod = await import('../streamingMeasure')
    expect(mod.isStreamAttrMeasureEnabled()).toBe(testEnabled)
  })
})

describe('streamingMeasure — disabled (inert by default)', () => {
  it('is disabled, records are no-ops, reset is a no-op, and the state reports disabled', async () => {
    const mod = await import('../streamingMeasure')
    mod.recordStreamAttrRecord({
      channel: 'chatdb:update-single-block',
      stage: 'main.handler',
      correlationId: 'stm-e2e-1-abc',
      ordinal: 1,
      durationMs: 1.5,
      ok: true
    })
    const state = mod.readStreamAttrMainState()
    expect(state.enabled).toBe(testEnabled)
    expect(state.records).toHaveLength(0)
    mod.resetStreamAttrMainState()
    expect(mod.readStreamAttrMainState().records).toHaveLength(0)
  })
})

describe('streamingMeasure — enabled', () => {
  it('captures closed-field records and reset clears them', async () => {
    const mod = await import('../streamingMeasure')
    if (!testEnabled) {
      // In the default (disabled) gate the enabled-path behavior is not
      // reachable; it is exercised under PERF_STREAM_ATTR=1 and the E2E.
      expect(mod.isStreamAttrMeasureEnabled()).toBe(false)
      return
    }
    expect(mod.isStreamAttrMeasureEnabled()).toBe(true)
    mod.resetStreamAttrMainState()
    mod.recordStreamAttrRecord({
      channel: 'chatdb:update-single-block',
      stage: 'main.handler',
      correlationId: 'stm-e2e-1-abc',
      ordinal: 1,
      durationMs: 1.5,
      ok: true,
      contentLength: 42,
      changed: true
    })
    const state = mod.readStreamAttrMainState()
    expect(state.enabled).toBe(true)
    expect(state.records).toHaveLength(1)
    expect(state.records[0]).toMatchObject({
      channel: 'chatdb:update-single-block',
      stage: 'main.handler',
      correlationId: 'stm-e2e-1-abc',
      ordinal: 1,
      ok: true,
      contentLength: 42,
      changed: true
    })
    mod.resetStreamAttrMainState()
    expect(mod.readStreamAttrMainState().records).toHaveLength(0)
  })
})
