/**
 * Send-diagnostics context ownership tests (LOCK-003/004).
 *
 * Focused unit tests for the per-send correlation context model:
 * - Each send owns a distinct opaque correlation id.
 * - Ordinals advance 1, 2, ... within a send and are consumed from the
 *   CALLER'S OWN context, so overlapping sends / interleaved append callers
 *   never cross-attribute another send's context.
 * - Callers without a context (uninstrumented append paths) get no
 *   diagnostics and no ordinal consumption.
 */

import { describe, expect, it } from 'vitest'

import {
  consumeNextAppendDiagnostics,
  createSendDiagnosticsContext,
  type SendDiagnosticsContext
} from '../sendTimingDiagnostics'

describe('sendTimingDiagnostics context ownership (LOCK-004)', () => {
  it('creates a context with a fresh opaque correlation id and ordinal 1', () => {
    const ctx = createSendDiagnosticsContext()
    expect(ctx.correlationId).toMatch(/^snd-[a-z0-9]+-[a-z0-9]+$/)
    expect(ctx.nextOrdinal).toBe(1)
  })

  it('creates distinct correlation ids for distinct sends', () => {
    const a = createSendDiagnosticsContext()
    const b = createSendDiagnosticsContext()
    expect(a.correlationId).not.toBe(b.correlationId)
  })

  it('consumes ordinals 1, 2, 3 from one context in order', () => {
    const ctx = createSendDiagnosticsContext()
    expect(consumeNextAppendDiagnostics(ctx)).toEqual({ correlationId: ctx.correlationId, ordinal: 1 })
    expect(consumeNextAppendDiagnostics(ctx)).toEqual({ correlationId: ctx.correlationId, ordinal: 2 })
    expect(consumeNextAppendDiagnostics(ctx)).toEqual({ correlationId: ctx.correlationId, ordinal: 3 })
  })

  it('never cross-attributes ordinals across interleaved sends', () => {
    const ctxA = createSendDiagnosticsContext()
    const ctxB = createSendDiagnosticsContext()

    const a1 = consumeNextAppendDiagnostics(ctxA) // user append of send A
    const b1 = consumeNextAppendDiagnostics(ctxB) // user append of send B
    const b2 = consumeNextAppendDiagnostics(ctxB) // assistant stub 1 of send B
    const a2 = consumeNextAppendDiagnostics(ctxA) // assistant stub of send A

    expect(a1).toEqual({ correlationId: ctxA.correlationId, ordinal: 1 })
    expect(b1).toEqual({ correlationId: ctxB.correlationId, ordinal: 1 })
    expect(b2).toEqual({ correlationId: ctxB.correlationId, ordinal: 2 })
    expect(a2).toEqual({ correlationId: ctxA.correlationId, ordinal: 2 })
  })

  it('multi-model stubs continue the ordinal sequence after the user append', () => {
    const ctx = createSendDiagnosticsContext()
    expect(consumeNextAppendDiagnostics(ctx)?.ordinal).toBe(1) // user append
    expect(consumeNextAppendDiagnostics(ctx)?.ordinal).toBe(2) // assistant stub 1
    expect(consumeNextAppendDiagnostics(ctx)?.ordinal).toBe(3) // assistant stub 2
  })

  it('returns undefined for uninstrumented callers and does not mutate a context', () => {
    const ctx: SendDiagnosticsContext = { correlationId: 'snd-fixed', nextOrdinal: 1 }
    expect(consumeNextAppendDiagnostics(undefined)).toBeUndefined()
    expect(consumeNextAppendDiagnostics(null as unknown as SendDiagnosticsContext)).toBeUndefined()
    // Context untouched by the uninstrumented calls above.
    expect(ctx.nextOrdinal).toBe(1)
  })
})
