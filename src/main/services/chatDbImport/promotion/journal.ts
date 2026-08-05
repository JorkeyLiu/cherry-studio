/**
 * Promotion journal — strict schema + pure codec (Phase 4.4.0, LOCK-4404;
 * Phase 2 L2 promotion protocol, LOCK-PROMO-2/10/12).
 *
 * The journal is the persistent promotion progress record written with
 * crash-safe replacement semantics (see journalStore.ts).
 *
 * Two schema versions are supported:
 * - v1 (LOCK-4404) — the original chat.db-only protocol:
 *   `version / sessionId / candidateId / phase` with phase ∈
 *   `snapshot-ready | candidate-installed | replacement-verified`.
 * - v2 (LOCK-PROMO-2) — the three-artifact protocol:
 *   `version / sessionId / candidateId / phase / receipts` with phase ∈
 *   `candidates-ready | snapshots-ready | db-installed | files-installed |
 *    catalog-pending | catalog-applied | replacement-verified`.
 *
 * Backward compatibility (LOCK-PROMO-10): v1 journals remain decodable and
 * are recovered under their ORIGINAL chat.db-only protocol (the recovery
 * matrix dispatches on the journal `version`). A v1 journal is NEVER
 * reinterpreted as a partially installed Files generation.
 *
 * Privacy bound (LOCK-PROMO-12): the journal never carries private
 * filenames, paths, content, or raw file IDs. v2 adds aggregate integrity
 * receipts ONLY — counts + canonical SHA-256 digests over the candidate and
 * old-generation artifacts (see {@link PromotionArtifactReceipts}).
 *
 * Schema bound (LOCK-4404): no arbitrary paths are ever recorded; consumers
 * derive every artifact location from the fixed owned filename constants
 * below, and IDs are runtime-validated against the same strict allowlist
 * used for candidate directory ownership (candidateDb SESSION_ID_PATTERN).
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

// ---------------------------------------------------------------------------
// Constants — schema versions, phases, fixed owned filenames
// ---------------------------------------------------------------------------

/** Journal schema version 1 — the original chat.db-only codec. */
export const PROMOTION_JOURNAL_VERSION_V1 = 1 as const

/** Journal schema version 2 — the three-artifact (db/Files/catalog) codec. */
export const PROMOTION_JOURNAL_VERSION_V2 = 2 as const

/** The version the current writer produces (v2). */
export const PROMOTION_JOURNAL_VERSION = PROMOTION_JOURNAL_VERSION_V2

/** Supported journal schema versions. */
export const PROMOTION_JOURNAL_VERSIONS = [1, 2] as const

export type PromotionJournalVersion = (typeof PROMOTION_JOURNAL_VERSIONS)[number]

/**
 * v1 persisted promotion phases (LOCK-4404), in operation order.
 */
export const PROMOTION_JOURNAL_PHASES_V1 = ['snapshot-ready', 'candidate-installed', 'replacement-verified'] as const

/**
 * Backward-compat alias: `PROMOTION_JOURNAL_PHASES` names the v1 phases.
 * (Pre-Phase-2 consumers enumerated the v1 phase set through this export.)
 */
export const PROMOTION_JOURNAL_PHASES = PROMOTION_JOURNAL_PHASES_V1

/**
 * v2 persisted promotion phases (LOCK-PROMO-2), in operation order:
 * - `candidates-ready`   — all three candidate artifacts exist and passed
 *                          the sealed/parity gates; candidate aggregate
 *                          receipts journaled. No live mutation yet.
 * - `snapshots-ready`    — retained rollback snapshots for live chat.db,
 *                          live Files, and the live Dexie files catalog all
 *                          exist and were verified; old-generation
 *                          aggregate receipts journaled. The destructive
 *                          window may begin.
 * - `db-installed`       — the candidate chat.db was installed at the live
 *                          path; the replacement is NOT yet verified.
 * - `files-installed`    — the candidate Files directory was installed at
 *                          the live path by same-filesystem directory
 *                          rename/swap; not yet verified.
 * - `catalog-pending`    — the catalog apply transaction is pending (about
 *                          to run or in flight); ordinary UI is blocked.
 * - `catalog-applied`    — the single Dexie catalog replace-all transaction
 *                          committed and was verified.
 * - `replacement-verified` — every installed artifact passed the
 *                          post-install verification gates.
 */
export const PROMOTION_JOURNAL_PHASES_V2 = [
  'candidates-ready',
  'snapshots-ready',
  'db-installed',
  'files-installed',
  'catalog-pending',
  'catalog-applied',
  'replacement-verified'
] as const

/** v1 phase union. */
export type PromotionJournalPhaseV1 = (typeof PROMOTION_JOURNAL_PHASES_V1)[number]

/** v2 phase union. */
export type PromotionJournalPhaseV2 = (typeof PROMOTION_JOURNAL_PHASES_V2)[number]

/** Every phase across both schema versions. */
export type PromotionJournalPhase = PromotionJournalPhaseV1 | PromotionJournalPhaseV2

/**
 * Fixed owned journal filename (relative to the Data root — the OWNER
 * resolves it; the journal itself never records a path).
 */
export const PROMOTION_JOURNAL_FILENAME = 'chat-import-promotion.journal.json'

/**
 * Fixed rollback snapshot filename next to the live chat.db (LOCK-4403).
 */
export const ROLLBACK_SNAPSHOT_FILENAME = 'chat.db.pre-import-backup'

/** Fixed staging name for the one-retained snapshot replacement ordering. */
export const ROLLBACK_SNAPSHOT_STAGING_FILENAME = 'chat.db.pre-import-backup.staging'

/**
 * Fixed retained rollback snapshot directory for the LIVE Files directory
 * (LOCK-PROMO-3/4). Same filesystem as the live Files dir — installed by
 * directory rename/swap, never per-file overwrite.
 */
export const FILES_ROLLBACK_SNAPSHOT_DIRNAME = 'Files.pre-import-backup'

/** Fixed staging name for the one-retained Files snapshot replacement. */
export const FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME = 'Files.pre-import-backup.staging'

/** Fixed Files-swap staging name used during the files-installed rename swap. */
export const FILES_PROMOTE_STAGING_DIRNAME = 'Files.promote-staging'

/**
 * Fixed retained rollback snapshot file for the LIVE Dexie files catalog
 * (LOCK-PROMO-3). Captured through the minimal renderer/Dexie boundary and
 * written durably by Main before any live mutation.
 */
export const FILES_CATALOG_SNAPSHOT_FILENAME = 'files-catalog.snapshot.json'

/** Fixed staging name for the catalog snapshot replacement write. */
export const FILES_CATALOG_SNAPSHOT_STAGING_FILENAME = 'files-catalog.snapshot.json.staging'

/**
 * Strict allowlist for journal IDs — identical to the candidateDb session ID
 * policy. Rejects anything that could encode a path (no separators, dots,
 * or `..`), which enforces the LOCK-4404 "no arbitrary paths" bound.
 */
const JOURNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Exact key set of a v1 journal document. Extra keys are rejected. */
const JOURNAL_V1_KEYS = ['version', 'sessionId', 'candidateId', 'phase'] as const

/** Exact key set of a v2 journal document. Extra keys are rejected. */
const JOURNAL_V2_KEYS = ['version', 'sessionId', 'candidateId', 'phase', 'receipts'] as const

// ---------------------------------------------------------------------------
// Aggregate integrity receipts (LOCK-PROMO-12 — aggregate receipts only)
// ---------------------------------------------------------------------------

/** Aggregate receipt for one chat.db artifact (sha256 + byte size). */
export interface PromotionJournalDbReceipt {
  readonly sha256: string
  readonly size: number
}

/**
 * Aggregate receipt for one Files directory generation, derived from the
 * canonical catalog/manifest rows (never a raw directory listing):
 * `sha256` digests the sorted `name\0size\0sha256` records.
 */
export interface PromotionJournalFilesReceipt {
  readonly count: number
  readonly totalBytes: number
  readonly sha256: string
}

/**
 * Aggregate receipt for one Dexie files catalog generation:
 * `sha256` digests the sorted canonical `id\0name\0size\0count` records.
 */
export interface PromotionJournalCatalogReceipt {
  readonly count: number
  readonly sha256: string
}

/**
 * The three-artifact aggregate receipts of ONE generation (candidate or
 * old). A `null` field means the artifact does not exist in that generation
 * (e.g. an empty/missing live Files directory or an empty catalog).
 */
export interface PromotionArtifactReceipts {
  readonly db: PromotionJournalDbReceipt | null
  readonly files: PromotionJournalFilesReceipt | null
  readonly catalog: PromotionJournalCatalogReceipt | null
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Journal v1 document — exactly these four fields (LOCK-4404). */
export interface PromotionJournalV1 {
  readonly version: typeof PROMOTION_JOURNAL_VERSION_V1
  readonly sessionId: string
  readonly candidateId: string
  readonly phase: PromotionJournalPhaseV1
}

/**
 * Journal v2 document (LOCK-PROMO-2/12). Carries the candidate-generation
 * receipts (written at `candidates-ready`, immutable afterwards) and the
 * old-generation receipts (filled at `snapshots-ready`, then immutable).
 */
export interface PromotionJournalV2 {
  readonly version: typeof PROMOTION_JOURNAL_VERSION_V2
  readonly sessionId: string
  readonly candidateId: string
  readonly phase: PromotionJournalPhaseV2
  readonly receipts: {
    /** Candidate-generation aggregate receipts (immutable once written). */
    readonly candidate: PromotionArtifactReceipts
    /**
     * Old-generation aggregate receipts. All-null before `snapshots-ready`
     * (the live generation has not been snapshotted yet); filled once at
     * `snapshots-ready` and immutable afterwards. `null` per artifact also
     * means that artifact was absent in the old generation.
     */
    readonly old: PromotionArtifactReceipts
  }
}

/** Any decodable journal document (v1 or v2). */
export type PromotionJournalDoc = PromotionJournalV1 | PromotionJournalV2

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
  | 'INVALID_RECEIPTS'

/** Result of {@link decodePromotionJournal}. Never throws for bad input. */
export type PromotionJournalDecodeResult =
  | { readonly ok: true; readonly journal: PromotionJournalDoc }
  | { readonly ok: false; readonly code: PromotionJournalDecodeErrorCode }

// ---------------------------------------------------------------------------
// Codec — pure functions only
// ---------------------------------------------------------------------------

/** True when `value` is a valid journal ID under the strict allowlist. */
export function isValidPromotionJournalId(value: unknown): value is string {
  return typeof value === 'string' && JOURNAL_ID_PATTERN.test(value)
}

/** True when `value` is one of the v1 phases. */
export function isPromotionJournalPhaseV1(value: unknown): value is PromotionJournalPhaseV1 {
  return typeof value === 'string' && (PROMOTION_JOURNAL_PHASES_V1 as readonly string[]).includes(value)
}

/** True when `value` is one of the v2 phases. */
export function isPromotionJournalPhaseV2(value: unknown): value is PromotionJournalPhaseV2 {
  return typeof value === 'string' && (PROMOTION_JOURNAL_PHASES_V2 as readonly string[]).includes(value)
}

/** True when `value` is any supported journal phase. */
export function isPromotionJournalPhase(value: unknown): value is PromotionJournalPhase {
  return isPromotionJournalPhaseV1(value) || isPromotionJournalPhaseV2(value)
}

// --- Receipt validation helpers (pure) --------------------------------------

/** True when `value` is a well-formed db receipt. */
export function isValidDbReceipt(value: unknown): value is PromotionJournalDbReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(r.sha256) &&
    typeof r.size === 'number' &&
    Number.isSafeInteger(r.size) &&
    r.size >= 0
  )
}

/** True when `value` is a well-formed files receipt. */
export function isValidFilesReceipt(value: unknown): value is PromotionJournalFilesReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.count === 'number' &&
    Number.isSafeInteger(r.count) &&
    r.count >= 0 &&
    typeof r.totalBytes === 'number' &&
    Number.isSafeInteger(r.totalBytes) &&
    r.totalBytes >= 0 &&
    typeof r.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(r.sha256)
  )
}

/** True when `value` is a well-formed catalog receipt. */
export function isValidCatalogReceipt(value: unknown): value is PromotionJournalCatalogReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.count === 'number' &&
    Number.isSafeInteger(r.count) &&
    r.count >= 0 &&
    typeof r.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(r.sha256)
  )
}

/** True when `value` is a well-formed three-artifact receipt block. */
export function isValidArtifactReceipts(value: unknown): value is PromotionArtifactReceipts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  const keys = Object.keys(r)
  if (keys.length !== 3) return false
  if (!('db' in r) || !('files' in r) || !('catalog' in r)) return false
  if (r.db !== null && !isValidDbReceipt(r.db)) return false
  if (r.files !== null && !isValidFilesReceipt(r.files)) return false
  if (r.catalog !== null && !isValidCatalogReceipt(r.catalog)) return false
  return true
}

/** True when `value` is a well-formed v2 receipts block. */
export function isValidJournalReceipts(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  const keys = Object.keys(r)
  if (keys.length !== 2) return false
  if (!('candidate' in r) || !('old' in r)) return false
  return isValidArtifactReceipts(r.candidate) && isValidArtifactReceipts(r.old)
}

/**
 * Canonical, key-order-independent equality for a db receipt (or null).
 * Compares the fixed receipt fields directly — never serialized key order —
 * so `{sha256, size}` and `{size, sha256}` are equal.
 */
export function dbReceiptsEqual(a: PromotionJournalDbReceipt | null, b: PromotionJournalDbReceipt | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.sha256 === b.sha256 && a.size === b.size
}

/**
 * Canonical, key-order-independent equality for a files receipt (or null).
 */
export function filesReceiptsEqual(
  a: PromotionJournalFilesReceipt | null,
  b: PromotionJournalFilesReceipt | null
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.count === b.count && a.totalBytes === b.totalBytes && a.sha256 === b.sha256
}

/**
 * Canonical, key-order-independent equality for a catalog receipt (or null).
 */
export function catalogReceiptsEqual(
  a: PromotionJournalCatalogReceipt | null,
  b: PromotionJournalCatalogReceipt | null
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.count === b.count && a.sha256 === b.sha256
}

/**
 * Canonical, key-order-independent equality for artifact receipt blocks.
 * Semantically equal blocks compare equal regardless of JSON key insertion
 * order (used by the store transition guards — LOCK-CLOSE-2).
 */
export function artifactReceiptsEqual(a: PromotionArtifactReceipts, b: PromotionArtifactReceipts): boolean {
  return (
    dbReceiptsEqual(a.db, b.db) && filesReceiptsEqual(a.files, b.files) && catalogReceiptsEqual(a.catalog, b.catalog)
  )
}

// ---------------------------------------------------------------------------
// Canonical receipt field order (LOCK-CLOSE-2)
// ---------------------------------------------------------------------------

/**
 * Rebuild a db receipt in canonical field order (`sha256`, `size`) so the
 * encoded bytes are independent of the writer's property insertion order.
 */
function encodeDbReceipt(r: PromotionJournalDbReceipt): { sha256: string; size: number } {
  return { sha256: r.sha256, size: r.size }
}

/** Rebuild a files receipt in canonical field order (`count`, `totalBytes`, `sha256`). */
function encodeFilesReceipt(r: PromotionJournalFilesReceipt): { count: number; totalBytes: number; sha256: string } {
  return { count: r.count, totalBytes: r.totalBytes, sha256: r.sha256 }
}

/** Rebuild a catalog receipt in canonical field order (`count`, `sha256`). */
function encodeCatalogReceipt(r: PromotionJournalCatalogReceipt): { count: number; sha256: string } {
  return { count: r.count, sha256: r.sha256 }
}

/** Rebuild a three-artifact receipt block in canonical field order (`db`, `files`, `catalog`). */
function encodeArtifactReceipts(r: PromotionArtifactReceipts): {
  db: PromotionJournalDbReceipt | null
  files: PromotionJournalFilesReceipt | null
  catalog: PromotionJournalCatalogReceipt | null
} {
  return {
    db: r.db === null ? null : encodeDbReceipt(r.db),
    files: r.files === null ? null : encodeFilesReceipt(r.files),
    catalog: r.catalog === null ? null : encodeCatalogReceipt(r.catalog)
  }
}

/** Deep-freeze a decoded receipt block in canonical field order (encode(decode(x)) is canonical). */
function freezeArtifactReceipts(r: PromotionArtifactReceipts): PromotionArtifactReceipts {
  return Object.freeze({
    db: r.db === null ? null : Object.freeze({ sha256: r.db.sha256, size: r.db.size }),
    files:
      r.files === null
        ? null
        : Object.freeze({ count: r.files.count, totalBytes: r.files.totalBytes, sha256: r.files.sha256 }),
    catalog: r.catalog === null ? null : Object.freeze({ count: r.catalog.count, sha256: r.catalog.sha256 })
  })
}

/**
 * Encode a journal document (v1 or v2) to its canonical byte format.
 * Every level is canonicalized: the top-level key order AND (for v2) the
 * nested receipts blocks and receipt fields are rebuilt in the fixed writer
 * order, so identical documents encode to identical bytes regardless of the
 * caller's object property insertion order (LOCK-CLOSE-2). Validates the
 * document first: encoding an invalid journal is a programming error and
 * throws.
 */
export function encodePromotionJournal(journal: PromotionJournalDoc): string {
  if (journal.version === PROMOTION_JOURNAL_VERSION_V1) {
    if (!isValidPromotionJournalId(journal.sessionId)) {
      throw new Error('Refusing to encode promotion journal: invalid sessionId (strict ID allowlist).')
    }
    if (!isValidPromotionJournalId(journal.candidateId)) {
      throw new Error('Refusing to encode promotion journal: invalid candidateId (strict ID allowlist).')
    }
    if (!isPromotionJournalPhaseV1(journal.phase)) {
      throw new Error('Refusing to encode promotion journal: invalid v1 phase.')
    }
    return JSON.stringify({
      version: journal.version,
      sessionId: journal.sessionId,
      candidateId: journal.candidateId,
      phase: journal.phase
    })
  }

  // Defensive runtime guard: a correctly-typed caller is always v2 here, but
  // a JS caller could pass a document the type system cannot represent (e.g.
  // version 3). Reject it before applying the v2 codec.
  if (journal.version !== PROMOTION_JOURNAL_VERSION_V2) {
    throw new Error(
      `Refusing to encode promotion journal with unsupported version: ${String(
        (journal as { version: unknown }).version
      )}`
    )
  }
  if (!isValidPromotionJournalId(journal.sessionId)) {
    throw new Error('Refusing to encode promotion journal: invalid sessionId (strict ID allowlist).')
  }
  if (!isValidPromotionJournalId(journal.candidateId)) {
    throw new Error('Refusing to encode promotion journal: invalid candidateId (strict ID allowlist).')
  }
  if (!isPromotionJournalPhaseV2(journal.phase)) {
    throw new Error('Refusing to encode promotion journal: invalid v2 phase.')
  }
  if (!isValidArtifactReceipts(journal.receipts.candidate) || !isValidArtifactReceipts(journal.receipts.old)) {
    throw new Error('Refusing to encode promotion journal: invalid receipts block.')
  }
  // Canonical fixed key order — deterministic bytes for a given document
  // (deep receipts blocks are rebuilt in the fixed writer order too).
  return JSON.stringify({
    version: journal.version,
    sessionId: journal.sessionId,
    candidateId: journal.candidateId,
    phase: journal.phase,
    receipts: {
      candidate: encodeArtifactReceipts(journal.receipts.candidate),
      old: encodeArtifactReceipts(journal.receipts.old)
    }
  })
}

/**
 * Decode + strictly validate a journal document (LOCK-4404/LOCK-PROMO-10).
 *
 * Rejects: non-JSON input, non-plain-object roots, missing keys, extra
 * keys, unsupported versions, IDs outside the strict allowlist, unknown
 * phases, and (for v2) malformed receipts. Never throws — malformed
 * persisted state must map to a bounded rejection so recovery can treat it
 * as `invalid` deterministically.
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
    if (
      !(JOURNAL_V1_KEYS as readonly string[]).includes(key) &&
      !(JOURNAL_V2_KEYS as readonly string[]).includes(key)
    ) {
      return { ok: false, code: 'UNEXPECTED_KEY' }
    }
  }
  for (const key of JOURNAL_V1_KEYS) {
    if (!(key in record)) {
      return { ok: false, code: 'MISSING_KEY' }
    }
  }

  if (record.version !== PROMOTION_JOURNAL_VERSION_V1 && record.version !== PROMOTION_JOURNAL_VERSION_V2) {
    return { ok: false, code: 'UNSUPPORTED_VERSION' }
  }
  if (!isValidPromotionJournalId(record.sessionId)) {
    return { ok: false, code: 'INVALID_SESSION_ID' }
  }
  if (!isValidPromotionJournalId(record.candidateId)) {
    return { ok: false, code: 'INVALID_CANDIDATE_ID' }
  }

  if (record.version === PROMOTION_JOURNAL_VERSION_V1) {
    if (!isPromotionJournalPhaseV1(record.phase)) {
      return { ok: false, code: 'INVALID_PHASE' }
    }
    // A v1 document may not carry v2-only keys (strict exact key set).
    if ('receipts' in record) {
      return { ok: false, code: 'UNEXPECTED_KEY' }
    }
    return {
      ok: true,
      journal: Object.freeze({
        version: PROMOTION_JOURNAL_VERSION_V1,
        sessionId: record.sessionId,
        candidateId: record.candidateId,
        phase: record.phase
      })
    }
  }

  // v2 document: the receipts block is required.
  if (keys.length !== JOURNAL_V2_KEYS.length) {
    return { ok: false, code: 'MISSING_KEY' }
  }
  if (!isPromotionJournalPhaseV2(record.phase)) {
    return { ok: false, code: 'INVALID_PHASE' }
  }
  if (!isValidJournalReceipts(record.receipts)) {
    return { ok: false, code: 'INVALID_RECEIPTS' }
  }

  const receipts = record.receipts as { candidate: PromotionArtifactReceipts; old: PromotionArtifactReceipts }
  return {
    ok: true,
    journal: Object.freeze({
      version: PROMOTION_JOURNAL_VERSION_V2,
      sessionId: record.sessionId,
      candidateId: record.candidateId,
      phase: record.phase,
      receipts: {
        candidate: freezeArtifactReceipts(receipts.candidate),
        old: freezeArtifactReceipts(receipts.old)
      }
    })
  }
}

// ---------------------------------------------------------------------------
// v2 phase ordering (pure)
// ---------------------------------------------------------------------------

/** The ordered v2 phase list (index 0 = initial, last = terminal). */
export const PROMOTION_JOURNAL_PHASES_V2_ORDERED: readonly PromotionJournalPhaseV2[] = PROMOTION_JOURNAL_PHASES_V2

/** The v2 phase that may be written without a prior journal. */
export const PROMOTION_JOURNAL_INITIAL_PHASE_V2: PromotionJournalPhaseV2 = 'candidates-ready'

/**
 * True when `next` is the strict successor of `prior` in the v2 phase order
 * (no skips, regressions, or repeats).
 */
export function isV2SuccessorPhase(prior: PromotionJournalPhaseV2, next: PromotionJournalPhaseV2): boolean {
  const priorIndex = PROMOTION_JOURNAL_PHASES_V2_ORDERED.indexOf(prior)
  const nextIndex = PROMOTION_JOURNAL_PHASES_V2_ORDERED.indexOf(next)
  return priorIndex !== -1 && nextIndex === priorIndex + 1
}
