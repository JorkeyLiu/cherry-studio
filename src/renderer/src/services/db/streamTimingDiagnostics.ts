/**
 * PERF-STREAM-ATTR-001 renderer-side streaming-persistence measurement
 * collector (LOCK-STREAM-ATTR-001..005).
 *
 * Measurement-only instrumentation for the streaming persistence write paths
 * (`chatdb:update-single-block`, `chatdb:update-blocks`) on the renderer
 * side: throttle scheduling delay, wire serialization (cloneForWire), the
 * real IPC round-trip, and the total update call. It is INERT unless the
 * dedicated measurement switch is explicitly enabled at BUILD time:
 *
 *   PERF_STREAM_ATTR=1 pnpm build    # the renderer bundle inlines the switch
 *   (unset/empty)                    # inert (default; nothing is inlined)
 *
 * An enabled renderer collects bounded, privacy-safe, closed-field per-call
 * records into an in-memory ring buffer published on a well-known global key,
 * where the production-build Playwright measurement spec reads them via
 * `page.evaluate` (the established page-context handoff pattern).
 *
 * Record field set is intentionally closed (PERF-LOCK-006 / LOCK-STREAM-ATTR-003):
 * only opaque correlation ids, ordinals, stage names, monotonic durations,
 * ok flags, and non-sensitive numeric counts/lengths.
 */

import type { StreamWriteDiagnostics } from '@shared/chatDb'
import {
  newStreamCorrelationId,
  nextStreamAttrOrdinal,
  resolveStreamAttrGate,
  STREAM_ATTR_MAX_RECORDS,
  type StreamAttrRecord
} from '@shared/diagnostics/streamAttr'

/**
 * Well-known global key the renderer collector publishes to. The E2E spec
 * reads it via `page.evaluate`; the app bundle and the test share one page
 * JS context (the established `window.store` handoff pattern).
 */
export const STREAM_ATTR_RENDERER_STATE_KEY = '__perfStreamAttrRendererV1__'

/** Global key the E2E spec may set to a deterministic session id per sample. */
export const STREAM_ATTR_RENDERER_SESSION_KEY = '__perfStreamAttrSessionId__'

export interface StreamAttrRendererState {
  /** True when the collector is enabled for this renderer bundle. */
  enabled: boolean
  /** Bounded ring of records (oldest dropped at STREAM_ATTR_MAX_RECORDS). */
  records: StreamAttrRecord[]
}

/** One renderer-side per-call measurement context (opaque + ordinal). */
export interface StreamWriteDiagnosticsContext {
  correlationId: string
  ordinal: number
}

/**
 * Module-level enabled flag. The renderer gate is a build-time define
 * (injected by electron.vite.config.ts / vitest.config.ts); default builds
 * inline the literal string `'false'`. Normalize the define sentinel before
 * the strict shared gate: `'false'` (or unset) → disabled; `'true'` → enabled;
 * any other value → fail-loud via the shared gate.
 */
const streamAttrEnabled = resolveStreamAttrGate(
  typeof __PERF_STREAM_ATTR__ !== 'undefined'
    ? __PERF_STREAM_ATTR__ === 'true'
      ? '1'
      : __PERF_STREAM_ATTR__ === 'false'
        ? ''
        : __PERF_STREAM_ATTR__
    : undefined
)

/** True when the renderer streaming measurement collector is enabled. */
export function isStreamAttrRendererMeasureEnabled(): boolean {
  return streamAttrEnabled
}

/** Current measurement-session id (test-injectable, default 'auto'). */
export function currentStreamAttrSessionId(): string {
  const globalAny = globalThis as Record<string, unknown>
  const session = globalAny[STREAM_ATTR_RENDERER_SESSION_KEY]
  return typeof session === 'string' && session.length > 0 ? session : 'auto'
}

/**
 * Create a fresh per-call measurement context. Each measured write call gets
 * its own opaque correlation id + 1-based ordinal so the renderer-side
 * serialize/IPC records pair with the Main-side handler/transaction records
 * of the SAME call.
 */
export function createStreamWriteDiagnosticsContext(): StreamWriteDiagnosticsContext {
  const ordinal = nextStreamAttrOrdinal()
  return { correlationId: newStreamCorrelationId(currentStreamAttrSessionId(), ordinal), ordinal }
}

/**
 * Resolve the per-call diagnostics for a streaming write: an explicitly
 * supplied context wins (the throttled path passes one so the scheduling
 * record and the serialize/IPC records share the same correlation); otherwise
 * a fresh context is created when the collector is enabled; otherwise
 * undefined (inert, preserving prior behavior exactly).
 */
export function resolveStreamWriteDiagnostics(supplied?: StreamWriteDiagnostics): StreamWriteDiagnostics | undefined {
  if (supplied) return supplied
  if (!streamAttrEnabled) return undefined
  return createStreamWriteDiagnosticsContext()
}

function readState(): StreamAttrRendererState {
  const globalAny = globalThis as Record<string, unknown>
  const existing = globalAny[STREAM_ATTR_RENDERER_STATE_KEY] as StreamAttrRendererState | undefined
  if (existing && Array.isArray(existing.records)) {
    return existing
  }
  const state: StreamAttrRendererState = { enabled: streamAttrEnabled, records: [] }
  globalAny[STREAM_ATTR_RENDERER_STATE_KEY] = state
  return state
}

/**
 * Record one closed-field measurement record. No-op when the collector is
 * disabled (inert by default, LOCK-STREAM-ATTR-001). Bounded: the ring drops
 * the oldest record past STREAM_ATTR_MAX_RECORDS.
 */
export function recordStreamAttrRendererRecord(record: StreamAttrRecord): void {
  if (!streamAttrEnabled) return
  const state = readState()
  state.records.push(record)
  if (state.records.length > STREAM_ATTR_MAX_RECORDS) {
    state.records.splice(0, state.records.length - STREAM_ATTR_MAX_RECORDS)
  }
}

/** Reset the renderer collector state (used by the E2E spec between samples). */
export function resetStreamAttrRendererState(): void {
  if (!streamAttrEnabled) return
  const globalAny = globalThis as Record<string, unknown>
  globalAny[STREAM_ATTR_RENDERER_STATE_KEY] = { enabled: true, records: [] }
}

/** Read the current renderer collector state (test/evaluate seam). */
export function readStreamAttrRendererState(): StreamAttrRendererState {
  return readState()
}
// Eagerly publish the enabled flag via a DIRECT global-object assignment so
// the production-build E2E can verify switch consistency before any measured
// write creates a record — and so a bundler's tree-shaker cannot drop the
// side effect. Inert when disabled: a single empty { enabled: false, records:
// [] } object, never mutated.
;(globalThis as Record<string, unknown>)[STREAM_ATTR_RENDERER_STATE_KEY] = { enabled: streamAttrEnabled, records: [] }
