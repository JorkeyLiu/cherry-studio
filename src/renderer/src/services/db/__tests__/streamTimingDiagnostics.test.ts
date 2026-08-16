import { afterEach, describe, expect, it } from 'vitest'

import {
  createStreamWriteDiagnosticsContext,
  currentStreamAttrSessionId,
  isStreamAttrRendererMeasureEnabled,
  readStreamAttrRendererState,
  resolveStreamWriteDiagnostics,
  STREAM_ATTR_RENDERER_SESSION_KEY,
  STREAM_ATTR_RENDERER_STATE_KEY
} from '../streamTimingDiagnostics'

const globalAny = globalThis as Record<string, unknown>

afterEach(() => {
  delete globalAny[STREAM_ATTR_RENDERER_SESSION_KEY]
  delete globalAny[STREAM_ATTR_RENDERER_STATE_KEY]
})

describe('renderer stream timing diagnostics — default (inert)', () => {
  it('the collector is disabled unless the build-time switch is on', () => {
    // The default vitest define inlines 'false' for __PERF_STREAM_ATTR__.
    expect(isStreamAttrRendererMeasureEnabled()).toBe(false)
  })

  it('resolveStreamWriteDiagnostics returns the supplied context and undefined otherwise (inert)', () => {
    expect(resolveStreamWriteDiagnostics(undefined)).toBeUndefined()
    const supplied = { correlationId: 'stm-e2e-1-abc', ordinal: 1 }
    expect(resolveStreamWriteDiagnostics(supplied)).toBe(supplied)
  })

  it('record/reset are no-ops when disabled and the state reports disabled', () => {
    const state = readStreamAttrRendererState()
    expect(state.enabled).toBe(false)
    expect(state.records).toHaveLength(0)
  })

  it('currentStreamAttrSessionId defaults to auto and reflects an injected session', () => {
    expect(currentStreamAttrSessionId()).toBe('auto')
    globalAny[STREAM_ATTR_RENDERER_SESSION_KEY] = 'e2e-s0'
    expect(currentStreamAttrSessionId()).toBe('e2e-s0')
  })

  it('createStreamWriteDiagnosticsContext yields an opaque correlation + ordinal', () => {
    const ctx = createStreamWriteDiagnosticsContext()
    expect(ctx.correlationId).toMatch(/^stm-auto-\d+-[a-z0-9]+$/)
    expect(Number.isInteger(ctx.ordinal)).toBe(true)
    expect(ctx.ordinal).toBeGreaterThanOrEqual(1)
  })
})
