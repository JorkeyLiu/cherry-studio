/**
 * Shared verification result and diagnostic contracts (LOCK-4304).
 *
 * Defines the 14 documented verification dimensions, the structured
 * per-dimension result shape, and the bounded, safe diagnostic type used
 * by the candidate verifier (Phase 4.3.2). Nothing here reads databases.
 *
 * Safety bound (LOCK-4304): diagnostics may carry the dimension, the
 * entity/table name, an entity ID, a field path, expected/actual digest or
 * count/order metadata, a machine code, and a message derived ONLY from
 * those structured fields. They must NEVER contain raw chat content, raw
 * overflow payloads, SQL, filesystem paths, or stack traces.
 * Use {@link createDiagnostic} — it assembles the message exclusively from
 * the structured fields, so raw content cannot leak in.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

// ---------------------------------------------------------------------------
// Dimensions — one-to-one with docs/sqlite-migration.md Phase 4.3 ①–⑭
// ---------------------------------------------------------------------------

/**
 * The 14 documented verification dimensions (LOCK-4304). Order is the
 * canonical report order and maps one-to-one to the documented list:
 *
 *  1. `id_sets`            — ① source vs target ID set match
 *  2. `table_counts`       — ② per-table record counts
 *  3. `field_digests`      — ③ key-field content hash comparison
 *  4. `order`              — ④ message/block sort_order vs source order
 *  5. `fk_references`      — ⑤ foreign-key reference integrity
 *  6. `relations`          — ⑥ topic→message→block, segment→message relations
 *  7. `file_references`    — ⑦ file-reference snapshot integrity
 *  8. `segments`           — ⑧ segment/membership completeness
 *  9. `structured_json`    — ⑨ structured model/tool object integrity
 * 10. `overflow`           — ⑩ overflow data integrity
 * 11. `integrity_check`    — ⑪ PRAGMA integrity_check
 * 12. `foreign_key_check`  — ⑫ PRAGMA foreign_key_check
 * 13. `sample_reads`       — ⑬ repository-level application sample reads
 * 14. `search_projection`  — ⑭ derived FTS/normalized search projection
 *     (LOCK-SP-1..4): sqlite_master object inventory, canonical vs
 *     normalized vs FTS count parity, message_id/content parity against
 *     shared normalizeSearchText, exact FTS↔normalized multiset parity,
 *     and a fixed MATCH smoke query.
 */
export const VERIFICATION_DIMENSIONS = [
  'id_sets',
  'table_counts',
  'field_digests',
  'order',
  'fk_references',
  'relations',
  'file_references',
  'segments',
  'structured_json',
  'overflow',
  'integrity_check',
  'foreign_key_check',
  'sample_reads',
  'search_projection'
] as const

export type VerificationDimension = (typeof VERIFICATION_DIMENSIONS)[number]

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Machine-readable diagnostic codes for verification mismatches. */
export type VerificationDiagnosticCode =
  | 'COUNT_MISMATCH'
  | 'MISSING_ENTITY'
  | 'UNEXPECTED_ENTITY'
  | 'FIELD_DIGEST_MISMATCH'
  | 'RELATION_MISMATCH'
  | 'ORDER_MISMATCH'
  | 'OVERFLOW_DIGEST_MISMATCH'
  | 'STRUCTURED_JSON_MISMATCH'
  | 'FK_REFERENCE_BROKEN'
  | 'MEMBERSHIP_MISMATCH'
  | 'INTEGRITY_CHECK_FAILED'
  | 'FOREIGN_KEY_CHECK_VIOLATION'
  | 'SAMPLE_READ_FAILED'
  | 'SAMPLE_READ_MISMATCH'
  // Derived search projection (LOCK-SP-1..4). Evidence is fixed codes,
  // counts, schema object names, and entity IDs ONLY — never normalized/raw
  // content, digests of content, SQL, or filesystem paths.
  | 'SEARCH_PROJECTION_OBJECT_MISSING'
  | 'SEARCH_PROJECTION_COUNT_MISMATCH'
  | 'SEARCH_PROJECTION_MESSAGE_ID_MISMATCH'
  | 'SEARCH_PROJECTION_CONTENT_MISMATCH'
  | 'SEARCH_PROJECTION_ROW_MISSING'
  | 'SEARCH_PROJECTION_ROW_UNEXPECTED'
  // Aggregate FTS↔normalized multiset-parity failure (LOCK-SP-2/3): emitted
  // once when the exact ordered merge finds any row-level inequality. The
  // per-row ROW_MISSING/ROW_UNEXPECTED diagnostics carry the exact entity
  // IDs; this code carries fixed counts only.
  | 'SEARCH_PROJECTION_FTS_MISMATCH'
  | 'SEARCH_PROJECTION_SMOKE_FAILED'
  | 'SEARCH_PROJECTION_READ_FAILED'

/**
 * Safe expected/actual evidence value: a canonical digest, a count, an
 * order position, or a related entity ID. Never raw chat content.
 */
export type VerificationEvidenceValue = string | number | null

/**
 * One bounded verification mismatch (LOCK-4304).
 *
 * Contains only structural metadata — digests, counts, IDs, field paths.
 * Raw chat content (message/block text, overflow payloads) is forbidden.
 */
export interface VerificationDiagnostic {
  /** Which verification dimension detected the mismatch. */
  readonly dimension: VerificationDimension
  /** Manifest entity/table name (e.g. 'messages', 'file_references'). */
  readonly entity: string
  /** Entity ID the mismatch concerns, or null for entity-level counts. */
  readonly entityId: string | null
  /** Field path within the projected record (digest granularity), or null. */
  readonly fieldPath: string | null
  /** Expected digest / count / order metadata (never raw content). */
  readonly expected: VerificationEvidenceValue
  /** Actual digest / count / order metadata (never raw content). */
  readonly actual: VerificationEvidenceValue
  /** Machine-readable code. */
  readonly code: VerificationDiagnosticCode
  /** Message assembled from the structured fields only. */
  readonly message: string
}

/** Input for {@link createDiagnostic} — everything except the derived message. */
export type VerificationDiagnosticInput = Omit<VerificationDiagnostic, 'message'>

/**
 * Build a frozen {@link VerificationDiagnostic}. The message is derived
 * exclusively from the structured fields, guaranteeing that no raw chat
 * content can appear in it (LOCK-4304).
 */
export function createDiagnostic(input: VerificationDiagnosticInput): VerificationDiagnostic {
  const scope = input.entityId !== null ? `${input.entity}/${input.entityId}` : input.entity
  const field = input.fieldPath !== null ? ` field '${input.fieldPath}'` : ''
  const message =
    `${input.code} [${input.dimension}] ${scope}${field}: ` +
    `expected ${formatEvidence(input.expected)}, actual ${formatEvidence(input.actual)}`
  return Object.freeze({ ...input, message })
}

function formatEvidence(value: VerificationEvidenceValue): string {
  if (value === null) return '<none>'
  return typeof value === 'number' ? String(value) : `'${value}'`
}

// ---------------------------------------------------------------------------
// Fatal — sanitized unexpected failures (open/query/corruption)
// ---------------------------------------------------------------------------

/** Category of a sanitized unexpected verifier failure. */
export type VerificationFatalCode = 'CANDIDATE_OPEN_FAILED' | 'CANDIDATE_QUERY_FAILED'

/**
 * Sanitized unexpected failure (LOCK-4304). Carries only a category, a
 * safe machine error code (e.g. `SQLITE_CORRUPT`, an Error name) and an
 * optional field path — never SQL, filesystem paths, stack traces, or raw
 * error messages.
 */
export interface VerificationFatal {
  readonly code: VerificationFatalCode
  /** Safe machine code: SQLITE_* / Node errno-style code or an Error name. */
  readonly errorCode: string
  /** Field path when the failure is canonicalization-related, or null. */
  readonly fieldPath: string | null
  /** Message assembled from the structured fields only. */
  readonly message: string
}

/** Build a frozen {@link VerificationFatal} from structured fields only. */
export function createFatal(
  code: VerificationFatalCode,
  errorCode: string,
  fieldPath: string | null = null
): VerificationFatal {
  const field = fieldPath !== null ? ` field '${fieldPath}'` : ''
  return Object.freeze({ code, errorCode, fieldPath, message: `${code}${field}: ${errorCode}` })
}

// ---------------------------------------------------------------------------
// Per-dimension results + report
// ---------------------------------------------------------------------------

/**
 * Status of one dimension:
 * - 'pass'    — the dimension completed with no mismatches.
 * - 'fail'    — the dimension completed and found mismatches.
 * - 'skipped' — the run ended (abort/fatal) before this dimension
 *               completed; partial diagnostics may still be attached.
 */
export type VerificationDimensionStatus = 'pass' | 'fail' | 'skipped'

/** Result of one verification dimension across all checked entities. */
export interface VerificationDimensionResult {
  readonly dimension: VerificationDimension
  readonly status: VerificationDimensionStatus
  /** Number of comparisons performed for this dimension. */
  readonly checkedCount: number
  /** Bounded diagnostics; empty when status is 'pass'. */
  readonly diagnostics: readonly VerificationDiagnostic[]
  /** Diagnostics dropped beyond the per-dimension cap (truncation metadata). */
  readonly truncatedDiagnosticCount: number
}

/**
 * Aggregate candidate verification report (LOCK-4304).
 *
 * Always contains exactly one result per documented dimension, in
 * {@link VERIFICATION_DIMENSIONS} order.
 * - status 'pass'    — every dimension completed and passed, no fatal.
 * - status 'fail'    — a dimension failed, was skipped due to a sanitized
 *                      unexpected failure, or `fatal` is set.
 * - status 'aborted' — the run stopped at an abort/close checkpoint.
 */
export interface CandidateVerificationReport {
  readonly status: 'pass' | 'fail' | 'aborted'
  readonly dimensions: readonly VerificationDimensionResult[]
  /** Sanitized unexpected open/query failure, or null. */
  readonly fatal: VerificationFatal | null
}
