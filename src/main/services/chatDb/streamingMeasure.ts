/**
 * PERF-STREAM-ATTR-001 Main-process streaming-persistence measurement
 * collector (LOCK-STREAM-ATTR-001..005).
 *
 * Measurement-only instrumentation for the streaming persistence write paths
 * (`chatdb:update-single-block`, `chatdb:update-blocks`). It is INERT unless
 * the dedicated measurement switch is explicitly enabled:
 *
 *   PERF_STREAM_ATTR=1 pnpm native:run electron -- pnpm dev   # enabled
 *   (unset/empty)                                            # inert (default)
 *
 * An enabled process persistently collects bounded, privacy-safe, closed-field
 * per-call duration/count records into an in-memory ring buffer published on
 * a well-known `globalThis` key, where the production-build Playwright
 * measurement spec reads them via `electronApp.evaluate` (the established
 * Main-state handoff pattern — no new IPC contract, no schema change, no
 * unbounded logging, no user-visible behavior).
 *
 * Record field set is intentionally closed (PERF-LOCK-006 / LOCK-STREAM-ATTR-003):
 * only opaque correlation ids, ordinals, stage names, monotonic durations,
 * ok flags, and non-sensitive numeric counts/lengths. Never message content,
 * credentials, paths, raw DB sizes, or profile fields.
 *
 * All timings are L3 directional/non-threshold (LOCK-STREAM-ATTR-005); the
 * E2E spec asserts only correctness/parity/completeness gates.
 *
 * This file is NOT a *.test.ts / *.bench.ts file so it is never collected by
 * Vitest as a test or benchmark.
 */

import {
  resolveStreamAttrGate,
  STREAM_ATTR_ENV,
  STREAM_ATTR_MAX_RECORDS,
  type StreamAttrRecord
} from '@shared/diagnostics/streamAttr'

/**
 * Well-known `globalThis` key the Main-process collector publishes to. The E2E
 * spec reads it via `electronApp.evaluate`; the app bundle and the test share
 * one Main-process JS context.
 */
export const STREAM_ATTR_MAIN_STATE_KEY = '__perfStreamAttrMainV1__'

export interface StreamAttrMainState {
  /** True when the collector is enabled for this process. */
  enabled: boolean
  /** Bounded ring of records (oldest dropped at STREAM_ATTR_MAX_RECORDS). */
  records: StreamAttrRecord[]
}

/**
 * Resolve the Main-process gate source. Prefer the build-time define (inlined
 * into the main + renderer bundles AND the vitest config, so the two processes
 * are guaranteed consistent in a measurement build); fall back to the runtime
 * env for unbundled contexts (e.g. a standalone tsx run).
 */
function resolveStreamAttrGateSource(): string | undefined {
  if (typeof __PERF_STREAM_ATTR__ !== 'undefined') {
    if (__PERF_STREAM_ATTR__ === 'true') return '1'
    if (__PERF_STREAM_ATTR__ === 'false') return ''
    return __PERF_STREAM_ATTR__
  }
  return process.env[STREAM_ATTR_ENV]
}

/** Freshly resolve the current enabled state (idempotent, cheap). */
function currentStreamAttrEnabled(): boolean {
  return resolveStreamAttrGate(resolveStreamAttrGateSource())
}

function ensureState(): StreamAttrMainState {
  const globalAny = globalThis as Record<string, unknown>
  const existing = globalAny[STREAM_ATTR_MAIN_STATE_KEY] as StreamAttrMainState | undefined
  if (existing && Array.isArray(existing.records)) {
    return existing
  }
  const state: StreamAttrMainState = { enabled: currentStreamAttrEnabled(), records: [] }
  globalAny[STREAM_ATTR_MAIN_STATE_KEY] = state
  return state
}

/**
 * True when the Main-process streaming measurement collector is enabled.
 *
 * Also ensures the published state object exists (lazily, on first call) so
 * the production-build E2E can read the actual enabled flag via
 * `electronApp.evaluate`. The aggregate calls this on every streaming write,
 * so the state is guaranteed present after the first measured write.
 */
export function isStreamAttrMeasureEnabled(): boolean {
  ensureState()
  return currentStreamAttrEnabled()
}

/**
 * Record one closed-field measurement record. No-op when the collector is
 * disabled (inert by default, LOCK-STREAM-ATTR-001). Bounded: the ring drops
 * the oldest record past STREAM_ATTR_MAX_RECORDS so a misbehaving caller can
 * never grow memory unboundedly.
 */
export function recordStreamAttrRecord(record: StreamAttrRecord): void {
  if (!currentStreamAttrEnabled()) return
  const state = ensureState()
  state.records.push(record)
  if (state.records.length > STREAM_ATTR_MAX_RECORDS) {
    state.records.splice(0, state.records.length - STREAM_ATTR_MAX_RECORDS)
  }
}

/**
 * Reset the Main-process collector state (used by the E2E spec between
 * samples). No-op when disabled — a disabled process has no state to reset.
 */
export function resetStreamAttrMainState(): void {
  if (!currentStreamAttrEnabled()) return
  const globalAny = globalThis as Record<string, unknown>
  globalAny[STREAM_ATTR_MAIN_STATE_KEY] = { enabled: currentStreamAttrEnabled(), records: [] }
}

/** Read the current Main-process collector state (test/evaluate seam). */
export function readStreamAttrMainState(): StreamAttrMainState {
  return ensureState()
}
