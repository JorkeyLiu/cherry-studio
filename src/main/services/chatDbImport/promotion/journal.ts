/**
 * Promotion journal v1 — strict schema + pure codec (Phase 4.4.0, LOCK-4404).
 *
 * The journal is the persistent promotion progress record that Phase 4.4.1+
 * will write with crash-safe replacement semantics. Phase 4.4.0 defines ONLY
 * the byte format: schema, fixed owned filenames, and a pure encode/decode
 * pair. This module performs NO filesystem, SQLite, or Electron operations
 * (LOCK-4405) — the crash-safe filesystem writer is later scope.
 *
 * Schema bound (LOCK-4404): journal v1 contains exactly
 * `version` / `sessionId` / `candidateId` / `phase`, where phase is one of
 * `snapshot-ready | candidate-installed | replacement-verified`. No arbitrary
 * paths are ever recorded: consumers derive every artifact location from the
 * fixed owned filename constants below, and IDs are runtime-validated against
 * the same strict allowlist used for candidate directory ownership
 * (candidateDb SESSION_ID_PATTERN) so an ID can never smuggle a path.
 *
 * Rollback snapshot contract (LOCK-4403, naming only — no snapshot
 * operations in 4.4.0):
 * - Fixed name {@link ROLLBACK_SNAPSHOT_FILENAME} next to the live chat.db
 *   (same filesystem — atomic rename is possible).
 * - One-retained ordering: a new snapshot is produced at
 *   {@link ROLLBACK_SNAPSHOT_STAGING_FILENAME} via SQLite online backup while
 *   the live DB is still open, verified, and only then atomically renamed
 *   over any previous snapshot. At most one snapshot is ever retained, and it
 *   remains retained after the replacement is verified.
 * - The live WAL/SHM sidecars are NEVER copied — the online backup API
 *   produces a self-contained snapshot.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

// ---------------------------------------------------------------------------
// Constants — schema version, phases, fixed owned filenames
// ---------------------------------------------------------------------------

/** Journal schema version covered by this codec. */
export const PROMOTION_JOURNAL_VERSION = 1 as const

/**
 * The three persisted promotion phases (LOCK-4404), in operation order:
 * - `snapshot-ready`        — rollback snapshot created AND verified; the
 *                             destructive window may begin.
 * - `candidate-installed`   — the candidate has been installed at the live
 *                             path; the replacement is NOT yet verified.
 * - `replacement-verified`  — the installed replacement passed the
 *                             post-install verification gates.
 */
export const PROMOTION_JOURNAL_PHASES = ['snapshot-ready', 'candidate-installed', 'replacement-verified'] as const

export type PromotionJournalPhase = (typeof PROMOTION_JOURNAL_PHASES)[number]

/**
 * Fixed owned journal filename (relative to the Data root — the OWNER
 * resolves it; the journal itself never records a path).
 */
export const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'

/**
 * Fixed rollback snapshot filename next to the live chat.db (LOCK-4403).
 * Matches the documented crash-recovery family (chat.db.restore /
 * chat.db.repair / chat.db.backup markers).
 */
export const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'

/** Fixed staging name for the one-retained snapshot replacement ordering. */
export const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'

/**
 * Strict allowlist for journal IDs — identical to the candidateDb session ID
 * policy. Rejects anything that could encode a path (no separators, dots,
 * or `..`), which enforces the LOCK-4404 "no arbitrary paths" bound.
 */
const JOURNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Exact key set of a v1 journal document. Extra keys are rejected. */
const JOURNAL_V1_KEYS = ['version', 'sessionId', 'candidateId', 'phase'] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Journal v1 document — exactly these four fields (LOCK-4404). */
export interface PromotionJournalV1 {
  readonly version: typeof PROMOTION_JOURNAL_VERSION
  readonly sessionId: string
  readonly candidateId: string
  readonly phase: PromotionJournalPhase
}

/** Machine-readable decode rejection codes (bounded; never carry content). */
export type PromotionJournalDecodeErrorCode =
  | 'NOT_JSON'
  | 'NOT_OBJECT'
  | 'MISSING_KEY'
  | 'UNEXPECTED_KEY'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_SESSION_ID'
  | 'INVALID_CANDIDATE_ID'
  | 'INVALID_PHASE'

/** Result of {@link decodePromotionJournal}. Never throws for bad input. */
export type PromotionJournalDecodeResult =
  | { readonly ok: true; readonly journal: PromotionJournalV1 }
  | { readonly ok: false; readonly code: PromotionJournalDecodeErrorCode }

// ---------------------------------------------------------------------------
// Codec — pure functions only
// ---------------------------------------------------------------------------

/** True when `value` is a valid journal ID under the strict allowlist. */
export function isValidPromotionJournalId(value: unknown): value is string {
  return typeof value === 'string' && JOURNAL_ID_PATTERN.test(value)
}

/** True when `value` is one of the three v1 phases. */
export function isPromotionJournalPhase(value: unknown): value is PromotionJournalPhase {
  return typeof value === 'string' && (PROMOTION_JOURNAL_PHASES as readonly string[]).includes(value)
}

/**
 * Encode a v1 journal to its canonical byte format (deterministic key
 * order). Validates the document first: encoding an invalid journal is a
 * programming error and throws.
 */
export function encodePromotionJournal(journal: PromotionJournalV1): string {
  if (journal.version !== PROMOTION_JOURNAL_VERSION) {
    throw new Error(`Refusing to encode promotion journal with unsupported version: ${String(journal.version)}`)
  }
  if (!isValidPromotionJournalId(journal.sessionId)) {
    throw new Error('Refusing to encode promotion journal: invalid sessionId (strict ID allowlist).')
  }
  if (!isValidPromotionJournalId(journal.candidateId)) {
    throw new Error('Refusing to encode promotion journal: invalid candidateId (strict ID allowlist).')
  }
  if (!isPromotionJournalPhase(journal.phase)) {
    throw new Error('Refusing to encode promotion journal: invalid phase.')
  }
  // Canonical fixed key order — deterministic bytes for a given document.
  return JSON.stringify({
    version: journal.version,
    sessionId: journal.sessionId,
    candidateId: journal.candidateId,
    phase: journal.phase
  })
}

/**
 * Decode + strictly validate a v1 journal document (LOCK-4404).
 *
 * Rejects: non-JSON input, non-plain-object roots, missing keys, extra
 * keys, unsupported versions, IDs outside the strict allowlist, and unknown
 * phases. Never throws — malformed persisted state must map to a bounded
 * rejection so recovery can treat it as `invalid` deterministically.
 */
export function decodePromotionJournal(raw: string): PromotionJournalDecodeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'NOT_JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'NOT_OBJECT' }
  }

  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)

  for (const key of keys) {
    if (!(JOURNAL_V1_KEYS as readonly string[]).includes(key)) {
      return { ok: false, code: 'UNEXPECTED_KEY' }
    }
  }
  for (const key of JOURNAL_V1_KEYS) {
    if (!(key in record)) {
      return { ok: false, code: 'MISSING_KEY' }
    }
  }

  if (record.version !== PROMOTION_JOURNAL_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_VERSION' }
  }
  if (!isValidPromotionJournalId(record.sessionId)) {
    return { ok: false, code: 'INVALID_SESSION_ID' }
  }
  if (!isValidPromotionJournalId(record.candidateId)) {
    return { ok: false, code: 'INVALID_CANDIDATE_ID' }
  }
  if (!isPromotionJournalPhase(record.phase)) {
    return { ok: false, code: 'INVALID_PHASE' }
  }

  return {
    ok: true,
    journal: Object.freeze({
      version: PROMOTION_JOURNAL_VERSION,
      sessionId: record.sessionId,
      candidateId: record.candidateId,
      phase: record.phase
    })
  }
}
