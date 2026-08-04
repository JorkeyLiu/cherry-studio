/**
 * L2 imported-trash five-day retention baseline (LOCK-TRASH-1..10).
 *
 * Shared by BOTH sides of the retention contract:
 * - The L2 import data plane (marker generation + injection into projected
 *   TopicData overflow before staging/write — LOCK-TRASH-3/4).
 * - The ChatDb trash purge (effective-retention-start computation +
 *   invalid-marker accounting — LOCK-TRASH-6/7) and topic restore
 *   (internal marker removal — LOCK-TRASH-8).
 *
 * Locked semantics:
 * - LOCK-TRASH-1: the importer owns one internal overflow key
 *   `l2TrashRetentionStartedAt`, written ONLY for imported soft-deleted
 *   topics; active topics never receive it.
 * - LOCK-TRASH-2: exactly one immutable baseline per import session from an
 *   injectable Main clock; all topics of the session share the identical
 *   canonical string.
 * - LOCK-TRASH-5: marker validation is strict canonical UTC ISO — string,
 *   `new Date(value).toISOString() === value`, finite timestamp. All parsing
 *   uses epoch milliseconds, never lexical date comparison.
 * - LOCK-TRASH-6: purge effective retention start =
 *   max(parsed original deletedAt, parsed valid marker). Missing marker /
 *   L3 legacy data uses deletedAt exactly as before; an invalid marker
 *   falls back to deletedAt.
 * - LOCK-TRASH-10: Main-side parsing is fail-safe. A non-object/malformed
 *   `extra` column is treated as an invalid-marker fallback by the purge
 *   seam (never an abort); an unparseable deletedAt retains the topic.
 *
 * Main-only module — never expose over IPC/preload/renderer. The renderer
 * keeps its own `TRASH_RETENTION_DAYS` window constant; Main only consumes
 * the caller-generated cutoff.
 */

/** Importer-owned internal overflow key (LOCK-TRASH-1/4). */
export const L2_TRASH_RETENTION_MARKER = 'l2TrashRetentionStartedAt'

/**
 * LOCK-TRASH-5: strict canonical UTC ISO validation.
 *
 * Accepts only a string whose value is byte-for-byte
 * `new Date(value).toISOString()` and whose epoch is finite. Anything else —
 * wrong type, non-canonical representation, out-of-range date, empty string —
 * is NOT a valid marker.
 */
export function isValidL2TrashRetentionMarker(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

/**
 * Parse a strict canonical UTC ISO string to epoch milliseconds.
 *
 * Fail-safe (LOCK-TRASH-10): a non-string, empty string, or unparseable
 * value yields null — callers decide the fallback. Uses `Date.parse` only;
 * never lexical string comparison for retention decisions.
 */
export function parseCanonicalIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * LOCK-TRASH-2/5: generate one canonical UTC ISO baseline (millisecond
 * precision) from an injectable clock. `new Date(clock()).toISOString()` is
 * canonical by construction, so the result always satisfies
 * {@link isValidL2TrashRetentionMarker}. Captured exactly once per import
 * session — never regenerated inside page projection.
 *
 * LOCK-TRASH-12: a hostile/defective injected clock must fail loudly at the
 * call site. A throwing clock propagates its error; a NaN/Infinity/out-of-range
 * reading makes `new Date(...)` an Invalid Date whose `.toISOString()` throws
 * RangeError — the orchestrator must generate the baseline BEFORE publishing
 * the active session so no session is ever stranded by such a failure.
 */
export function generateL2TrashRetentionBaseline(now: () => number = Date.now): string {
  return new Date(now()).toISOString()
}

/**
 * LOCK-TRASH-13: strict canonical UTC ISO cutoff parse (millisecond
 * precision) — identical to the shared IPC contract
 * (`validateIso8601Timestamp`: `YYYY-MM-DDTHH:mm:ss.sssZ`).
 *
 * A parseable-but-non-canonical value (missing `.sssZ`, date-only, offset
 * timezone, space separator, …) returns null so callers reject it with the
 * typed validation semantics. Only the CALLER-GENERATED cutoff uses this
 * strict seam — the fail-safe `deletedAt`/marker parses
 * ({@link parseCanonicalIsoMs}, {@link computeTrashRetentionDecision})
 * stay lenient so LOCK-TRASH-10 retention semantics are unchanged.
 */
export function parseStrictCanonicalIsoMs(value: unknown): number | null {
  if (!isValidL2TrashRetentionMarker(value)) return null
  return parseCanonicalIsoMs(value)
}

/**
 * Result of {@link computeTrashRetentionDecision}.
 */
export interface TrashRetentionDecision {
  /**
   * Effective retention start in epoch milliseconds (LOCK-TRASH-6):
   * max(parsed original deletedAt, parsed valid marker). The purge
   * hard-deletes only when this is strictly earlier than the parsed cutoff.
   */
  readonly effectiveStartMs: number
  /**
   * True when a marker was PRESENT but could not be validated — a marker
   * value of the wrong type / non-canonical representation, or an `extra`
   * column that was malformed/non-object so the marker key was unreadable
   * (LOCK-TRASH-7 count; LOCK-TRASH-10 fallback). A genuinely absent marker
   * (legacy L3 data) is NOT invalid.
   */
  readonly invalidMarker: boolean
}

/**
 * Compute the purge retention decision for one soft-deleted topic row from
 * its raw `deletedAt` column and raw `extra` JSON column.
 *
 * Fail-safe matrix (LOCK-TRASH-6/10):
 * - `deletedAt` unparseable → returns null (topic retained — never
 *   hard-delete a row whose age cannot be determined).
 * - `extra` null/empty (normalized empty overflow) → no marker, legacy
 *   deletedAt behavior, not invalid.
 * - `extra` malformed JSON or a JSON non-object → marker unreadable →
 *   deletedAt fallback AND counted as an invalid marker.
 * - `extra` plain object without the marker key → legacy deletedAt
 *   behavior, not invalid.
 * - marker key present with an invalid value → deletedAt fallback, counted
 *   as an invalid marker.
 * - marker key present with a strict canonical value → effective start =
 *   max(deletedAt, marker) — a future-valid marker protects until its
 *   calculated window.
 */
export function computeTrashRetentionDecision(
  deletedAt: string,
  extra: string | null | undefined
): TrashRetentionDecision | null {
  const deletedAtMs = parseCanonicalIsoMs(deletedAt)
  if (deletedAtMs === null) return null

  // Empty/normalized overflow → no marker (legacy path, NOT invalid).
  if (extra === null || extra === undefined || extra === '' || extra === '{}') {
    return { effectiveStartMs: deletedAtMs, invalidMarker: false }
  }

  let overflow: unknown
  try {
    overflow = JSON.parse(extra) as unknown
  } catch {
    // LOCK-TRASH-10: malformed extra must never abort the purge — fall back
    // to deletedAt and count the unreadable marker.
    return { effectiveStartMs: deletedAtMs, invalidMarker: true }
  }
  if (overflow === null || typeof overflow !== 'object' || Array.isArray(overflow)) {
    // Non-object extra → marker key unreadable → invalid-marker fallback.
    return { effectiveStartMs: deletedAtMs, invalidMarker: true }
  }

  const marker = (overflow as Record<string, unknown>)[L2_TRASH_RETENTION_MARKER]
  if (marker === undefined) {
    // No marker key → L3 legacy data uses deletedAt exactly as before.
    return { effectiveStartMs: deletedAtMs, invalidMarker: false }
  }

  // LOCK-TRASH-5/6: marker validation is STRICT canonical UTC ISO — a
  // non-canonical but parseable string (e.g. missing milliseconds) is an
  // invalid marker and falls back to deletedAt. Never a lenient Date.parse
  // for the marker.
  if (!isValidL2TrashRetentionMarker(marker)) {
    // LOCK-TRASH-6: invalid marker type/value is ignored → deletedAt fallback.
    return { effectiveStartMs: deletedAtMs, invalidMarker: true }
  }

  // LOCK-TRASH-6: effective start = max(original deletedAt, valid marker).
  return { effectiveStartMs: Math.max(deletedAtMs, parseCanonicalIsoMs(marker) as number), invalidMarker: false }
}
