/**
 * Runtime wire validation for ChatImport stats/result contracts (Phase 4.2).
 *
 * Scope:
 * - Validates the explicit source-read and candidate-import stats shapes plus
 *   the candidate-ready result, and the versioned envelope that wraps them.
 * - Import-only wire contracts stay narrow and strictly validated: exact field
 *   sets (missing OR extra keys rejected), safe non-negative integer counts,
 *   and backward version rejection rather than permissive coercion (LOCK-4211D).
 *
 * Reuses {@link ValidationError} and JSON-safety guarantees from chatDb; adds
 * no dependency on Electron, Node, Drizzle, or SQLite.
 */

import { validateNonEmptyString, ValidationError } from '../chatDb/validation'
import type { CandidateImportStats, CandidateReadyResult, ChatImportEnvelope, SourceReadStats } from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current ChatImport wire format version. Bump on breaking wire changes. */
export const CHAT_IMPORT_WIRE_VERSION = 1 as const

/** Allowed envelope phases. */
const ENVELOPE_PHASES: ReadonlySet<string> = new Set(['discovery', 'reading', 'complete', 'error'])

/** Exact keys for the envelope. */
const ENVELOPE_KEYS = ['sessionId', 'phase', 'version', 'data'] as const

/** Exact keys for {@link SourceReadStats} (LOCK-4211A). */
const SOURCE_READ_STATS_KEYS = [
  'topicRecordCount',
  'blockRecordCount',
  'segmentRecordCount',
  'sourceFileRecordCount'
] as const

/** Exact keys for {@link CandidateImportStats} (LOCK-4211B). */
const CANDIDATE_IMPORT_STATS_KEYS = [
  'topicCount',
  'messageCount',
  'blockCount',
  'segmentCount',
  'segmentMembershipCount',
  'fileReferenceCount',
  'pageCount',
  'elapsedMs'
] as const

/** Exact keys for {@link CandidateReadyResult} (LOCK-4211C). */
const CANDIDATE_READY_RESULT_KEYS = ['sessionId', 'candidateId', 'stats'] as const

/** Count fields of {@link CandidateImportStats} (all safe non-negative integers). */
const CANDIDATE_IMPORT_COUNT_KEYS = CANDIDATE_IMPORT_STATS_KEYS.filter((k) => k !== 'elapsedMs')

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/**
 * Assert the value is a plain object (not null, not an array).
 */
function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(path, 'Expected a plain object')
  }
}

/**
 * Enforce an exact key set: reject any missing required key and any extra key.
 */
function assertExactKeys(obj: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set<string>(keys)
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`${path}.${key}`, `Unknown property '${key}'`)
    }
  }
  for (const key of keys) {
    if (!(key in obj)) {
      throw new ValidationError(`${path}.${key}`, `Required property '${key}' is missing`)
    }
  }
}

/**
 * Validate a safe, non-negative integer count.
 * Rejects non-numbers, NaN/Infinity, non-integers, negatives, and values
 * outside the safe integer range.
 */
function validateSafeCount(value: unknown, path: string): void {
  if (typeof value !== 'number') {
    throw new ValidationError(path, `Expected a number, got ${typeof value}`)
  }
  if (!Number.isFinite(value)) {
    throw new ValidationError(path, `Expected a finite number, got ${value}`)
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(path, `Expected an integer, got ${value}`)
  }
  if (value < 0) {
    throw new ValidationError(path, `Expected a non-negative integer, got ${value}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(path, `Expected a safe integer, got ${value}`)
  }
}

/**
 * Validate a non-negative finite duration in milliseconds.
 * Fractional values are allowed (high-resolution timers); non-finite and
 * negative values are rejected.
 */
function validateElapsedMs(value: unknown, path: string): void {
  if (typeof value !== 'number') {
    throw new ValidationError(path, `Expected a number, got ${typeof value}`)
  }
  if (!Number.isFinite(value)) {
    throw new ValidationError(path, `Expected a finite number, got ${value}`)
  }
  if (value < 0) {
    throw new ValidationError(path, `Expected a non-negative duration, got ${value}`)
  }
}

// ---------------------------------------------------------------------------
// Stats validators
// ---------------------------------------------------------------------------

/**
 * Validate a {@link SourceReadStats} (LOCK-4211A). Strict: exact keys, all
 * fields safe non-negative integers. Returns the value typed on success.
 */
export function validateSourceReadStats(value: unknown, path = 'sourceReadStats'): SourceReadStats {
  assertPlainObject(value, path)
  assertExactKeys(value, SOURCE_READ_STATS_KEYS, path)
  for (const key of SOURCE_READ_STATS_KEYS) {
    validateSafeCount(value[key], `${path}.${key}`)
  }
  return value as unknown as SourceReadStats
}

/**
 * Validate a {@link CandidateImportStats} (LOCK-4211B). Strict: exact keys,
 * all `*Count`/`pageCount` fields safe non-negative integers, `elapsedMs` a
 * non-negative finite number. Returns the value typed on success.
 */
export function validateCandidateImportStats(value: unknown, path = 'candidateImportStats'): CandidateImportStats {
  assertPlainObject(value, path)
  assertExactKeys(value, CANDIDATE_IMPORT_STATS_KEYS, path)
  for (const key of CANDIDATE_IMPORT_COUNT_KEYS) {
    validateSafeCount(value[key], `${path}.${key}`)
  }
  validateElapsedMs(value.elapsedMs, `${path}.elapsedMs`)
  return value as unknown as CandidateImportStats
}

/**
 * Validate a {@link CandidateReadyResult} (LOCK-4211C). Strict: exact keys,
 * non-empty `sessionId`/`candidateId`, nested {@link CandidateImportStats}.
 * Never accepts filesystem paths or SQL fields. Returns the value typed on
 * success.
 */
export function validateCandidateReadyResult(value: unknown, path = 'candidateReadyResult'): CandidateReadyResult {
  assertPlainObject(value, path)
  assertExactKeys(value, CANDIDATE_READY_RESULT_KEYS, path)
  validateNonEmptyString(value.sessionId, `${path}.sessionId`)
  validateNonEmptyString(value.candidateId, `${path}.candidateId`)
  validateCandidateImportStats(value.stats, `${path}.stats`)
  return value as unknown as CandidateReadyResult
}

// ---------------------------------------------------------------------------
// Envelope validator (version behavior — LOCK-4211D)
// ---------------------------------------------------------------------------

/**
 * Validate a {@link ChatImportEnvelope}. Strict: exact keys, non-empty
 * `sessionId`, known `phase`, and `version` strictly equal to
 * {@link CHAT_IMPORT_WIRE_VERSION}. Any other version is rejected (backward
 * rejection, no coercion). The payload is validated by `validateData`.
 */
export function validateChatImportEnvelope<T>(
  value: unknown,
  validateData: (data: unknown, path: string) => T,
  path = 'envelope'
): ChatImportEnvelope<T> {
  assertPlainObject(value, path)
  assertExactKeys(value, ENVELOPE_KEYS, path)
  validateNonEmptyString(value.sessionId, `${path}.sessionId`)
  if (typeof value.phase !== 'string' || !ENVELOPE_PHASES.has(value.phase)) {
    throw new ValidationError(`${path}.phase`, `Unknown phase '${String(value.phase)}'`)
  }
  if (value.version !== CHAT_IMPORT_WIRE_VERSION) {
    throw new ValidationError(
      `${path}.version`,
      `Unsupported wire version ${String(value.version)}; expected ${CHAT_IMPORT_WIRE_VERSION}`
    )
  }
  const data = validateData(value.data, `${path}.data`)
  return {
    sessionId: value.sessionId as string,
    phase: value.phase as ChatImportEnvelope<T>['phase'],
    version: CHAT_IMPORT_WIRE_VERSION,
    data
  }
}

// ---------------------------------------------------------------------------
// Type guards (non-throwing)
// ---------------------------------------------------------------------------

/** Non-throwing guard for {@link SourceReadStats}. */
export function isSourceReadStats(value: unknown): value is SourceReadStats {
  try {
    validateSourceReadStats(value)
    return true
  } catch {
    return false
  }
}

/** Non-throwing guard for {@link CandidateImportStats}. */
export function isCandidateImportStats(value: unknown): value is CandidateImportStats {
  try {
    validateCandidateImportStats(value)
    return true
  } catch {
    return false
  }
}

/** Non-throwing guard for {@link CandidateReadyResult}. */
export function isCandidateReadyResult(value: unknown): value is CandidateReadyResult {
  try {
    validateCandidateReadyResult(value)
    return true
  } catch {
    return false
  }
}
