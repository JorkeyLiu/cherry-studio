/**
 * Shared diagnostic primitives for PERF-STREAM-ATTR-001 streaming-persistence
 * measurement (LOCK-STREAM-ATTR-001..005).
 *
 * Extends the established sendTiming diagnostics pattern (LOCK-001..004) to
 * the streaming write channels (`chatdb:update-single-block`,
 * `chatdb:update-blocks`):
 *
 * - `resolveStreamAttrGate` deterministically resolves the dedicated
 *   measurement switch (`PERF_STREAM_ATTR`): unset/empty = inert (default),
 *   `1`/`true` = enabled, anything else = fail-loud.
 * - `newStreamCorrelationId` + `newStreamAttrOrdinal` generate the opaque,
 *   non-sensitive per-call correlation identity that pairs renderer-side
 *   records with Main-side records of the same call.
 * - `StreamAttrRecord` is the closed-field stage record both sides emit:
 *   stage names, monotonic durations, ok flags, an opaque correlation id, a
 *   1-based ordinal, and non-sensitive numeric counts/lengths. Never message
 *   content, credentials, paths, raw DB sizes, or profile fields
 *   (PERF-LOCK-006 / LOCK-STREAM-ATTR-003).
 *
 * Dependency-free: no Electron/Node imports — safe for renderer, main, and
 * the shared unit-test lane.
 */

/** Env/switch name that enables the streaming-persistence measurement. */
export const STREAM_ATTR_ENV = 'PERF_STREAM_ATTR'

/** Bounded ring size (drop-oldest) on both sides. */
export const STREAM_ATTR_MAX_RECORDS = 6000

/**
 * Closed-field per-call record emitted by renderer and Main collectors.
 * `sessionId` is informational only (the E2E resets each collector ring per
 * sample); `correlationId`/`ordinal` pair the renderer record with the
 * Main-side record of the same call.
 */
export interface StreamAttrRecord {
  /** Stable channel-under-test, e.g. `chatdb:update-single-block`. */
  channel: string
  /** Stable measurement stage, e.g. `renderer.serialize`, `main.handler`. */
  stage: string
  /** Opaque per-call correlation id shared by renderer and main records. */
  correlationId?: string
  /** 1-based ordinal within the measured write session. */
  ordinal?: number
  /** Monotonic elapsed milliseconds (performance.now() delta). */
  durationMs: number
  /** Success/failure of the measured operation. */
  ok: boolean
  /** Non-sensitive content byte/character length observed at this call. */
  contentLength?: number
  /** True when a content-touching update actually changed the stored content. */
  changed?: boolean
  /** Number of blocks in a batch write. */
  blockCount?: number
  /** Count of batch blocks that existed before the write. */
  existingBlocks?: number
  /** Count of batch blocks that did NOT exist before the write (inserts). */
  newBlocks?: number
  /** Count of existing content-touching blocks whose content actually changed. */
  changedBlocks?: number
  /** Count of existing content-touching blocks whose content stayed identical. */
  unchangedBlocks?: number
}

/**
 * Deterministically resolve the PERF_STREAM_ATTR gate.
 *
 * - unset / empty / whitespace-only → disabled (the default; the collector is
 *   completely inert);
 * - `1` or `true` (case-insensitive) → enabled;
 * - any other non-empty value → throws loudly, so a misconfigured switch can
 *   never silently run — or silently skip — the measurement.
 */
export function resolveStreamAttrGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `PERF_STREAM_ATTR must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the documented measurement build/run.`
  )
}

/** Per-process ordinal counter for a measurement session. */
let streamAttrOrdinalCounter = 0

/** Per-process ordinal for the next measured write call (1-based, capped). */
export function nextStreamAttrOrdinal(): number {
  streamAttrOrdinalCounter += 1
  // The wire contract bounds ordinals at 100 per session; the E2E resets the
  // session per sample, so a wrap is never expected. Bounded defensively.
  return streamAttrOrdinalCounter > 100 ? 100 : streamAttrOrdinalCounter
}

/**
 * Generate an opaque, non-sensitive per-call correlation id that pairs a
 * renderer-side record with its Main-side counterpart. Contains no user data.
 */
export function newStreamCorrelationId(sessionId: string, ordinal: number): string {
  return `stm-${sessionId}-${ordinal}-${Math.random().toString(36).slice(2, 10)}`
}

/** Per-process measurement-session seed (default session identity). */
export function defaultStreamAttrSessionId(): string {
  return 'auto'
}
