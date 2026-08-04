/**
 * Identity-bound replacement verifier (Phase 4.4.2, LOCK-4424).
 *
 * Proves that the file at the live path IS the installed candidate named
 * by a branded {@link InstallReceipt}, then runs the full readonly DB
 * validation gate over it, then re-proves the identity to close the
 * TOCTOU window around validation:
 *
 *   receipt brand + live-path binding
 *   → live stat identity vs receipt (dev/ino)
 *   → readonly open → integrity → FK → exact migration compatibility →
 *     application sample reads (shared gate, identical to the rollback
 *     snapshot validator, LOCK-4412/LOCK-4424)
 *   → live stat identity re-check (post-validation TOCTOU close)
 *
 * Identity evidence (decision, darwin contract): the gate compares
 * `st_dev` + `st_ino` from bigint stats. On the supported darwin/APFS
 * contract these are stable stat evidence of the same file object across
 * the install rename AND across a legitimate authorized reopen. `size` is
 * deliberately NOT gated here: after the authorized reopen the live DB
 * runs in WAL mode and a legitimate checkpoint may change the main-file
 * size without changing the file object, so gating size would fail
 * verification for a correctly installed replacement. In-place content
 * damage that dev/ino cannot see is exactly what the DB gates catch. The
 * receipt still carries the install-time size as bounded evidence.
 *
 * This unit never mutates anything: readonly open only, no journal I/O,
 * no cleanup, no rollback (LOCK-4425/4428). Never throws for operational
 * failures. Main-only module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'

import type { InstallReceipt } from './install'
import { isInstallReceipt } from './install'
import { type ReadonlyChatDbValidationGate, safeErrorCode, validateReadonlyChatDb } from './readonlyDbValidation'

const logger = loggerService.withContext('chatDbImportReplacementVerifier')

/** Live database filename — always derived from the Data root. */
const LIVE_DB_FILENAME = 'chat.db'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Bounded machine-readable verification failure codes. */
export type ReplacementVerificationFailureCode =
  | 'RECEIPT_INVALID'
  | 'LIVE_STAT_FAILED'
  | 'LIVE_IDENTITY_MISMATCH'
  | 'REPLACEMENT_OPEN_FAILED'
  | 'REPLACEMENT_INTEGRITY_FAILED'
  | 'REPLACEMENT_FOREIGN_KEYS_FAILED'
  | 'REPLACEMENT_MIGRATION_INCOMPATIBLE'
  | 'REPLACEMENT_SEARCH_PROJECTION_FAILED'
  | 'REPLACEMENT_SAMPLE_READ_FAILED'
  | 'POST_VALIDATION_STAT_FAILED'
  | 'POST_VALIDATION_IDENTITY_MISMATCH'

/** Result of {@link verifyReplacement}. Never throws for operational failures. */
export type ReplacementVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: ReplacementVerificationFailureCode
      /** Safe machine sub-code (error code/name only — never messages/paths). */
      readonly safeCode: string | null
    }

export interface VerifyReplacementOptions {
  /** Branded receipt from a successful {@link installCandidate}. */
  receipt: InstallReceipt
  /** Data root containing the live chat.db. Defaults to DATA_PATH. */
  dataRoot?: string
  /** Topics/segments sampled for application-layer reads (default 3, min 1). */
  sampleCount?: number
  /**
   * Test-only hook invoked AFTER all DB gates pass and BEFORE the closing
   * identity re-check (deterministic TOCTOU fault injection).
   */
  onAfterDbValidation?: () => void
}

/** Map a shared readonly validation gate to the bounded REPLACEMENT_* code. */
const GATE_TO_REPLACEMENT_CODE: Record<ReadonlyChatDbValidationGate, ReplacementVerificationFailureCode> = {
  open: 'REPLACEMENT_OPEN_FAILED',
  integrity: 'REPLACEMENT_INTEGRITY_FAILED',
  'foreign-keys': 'REPLACEMENT_FOREIGN_KEYS_FAILED',
  migration: 'REPLACEMENT_MIGRATION_INCOMPATIBLE',
  'search-projection': 'REPLACEMENT_SEARCH_PROJECTION_FAILED',
  'sample-reads': 'REPLACEMENT_SAMPLE_READ_FAILED'
}

function failure(code: ReplacementVerificationFailureCode, safeCode: string | null): ReplacementVerificationResult {
  logger.warn(`Replacement verification failed (${code}): ${safeCode ?? 'no sub-code'}`)
  return Object.freeze({ ok: false as const, code, safeCode })
}

/** Compare the live file object against the receipt identity (dev/ino). */
function liveIdentityMatches(livePath: string, receipt: InstallReceipt): boolean {
  const stat = fs.statSync(livePath, { bigint: true })
  return stat.isFile() && stat.dev === receipt.identity.dev && stat.ino === receipt.identity.ino
}

// ---------------------------------------------------------------------------
// verifyReplacement — identity → DB gates → identity
// ---------------------------------------------------------------------------

/**
 * Prove the live file is the installed candidate bound by `receipt`, then
 * fully validate it (LOCK-4424), then re-prove the identity (TOCTOU
 * close). A verdict only — mutates nothing, journals nothing.
 */
export function verifyReplacement(options: VerifyReplacementOptions): ReplacementVerificationResult {
  const sampleCount = Math.max(1, Math.floor(options.sampleCount ?? 3))
  const dataRoot = options.dataRoot ?? DATA_PATH
  const livePath = path.resolve(path.join(dataRoot, LIVE_DB_FILENAME))

  // --- Receipt gate: brand + live-path binding ----------------------------
  if (!isInstallReceipt(options.receipt)) {
    return failure('RECEIPT_INVALID', 'UNRECOGNIZED')
  }
  if (path.resolve(options.receipt.livePath) !== livePath) {
    return failure('RECEIPT_INVALID', 'LIVE_PATH_MISMATCH')
  }

  // --- Identity gate BEFORE any DB access (LOCK-4424) ---------------------
  try {
    if (!liveIdentityMatches(livePath, options.receipt)) {
      return failure('LIVE_IDENTITY_MISMATCH', 'STAT_IDENTITY_DIVERGED')
    }
  } catch (error) {
    return failure('LIVE_STAT_FAILED', safeErrorCode(error))
  }

  // --- Full readonly DB validation (shared gate, LOCK-4424) ---------------
  const gateFailure = validateReadonlyChatDb(livePath, sampleCount)
  if (gateFailure !== null) {
    return failure(GATE_TO_REPLACEMENT_CODE[gateFailure.gate], gateFailure.safeCode)
  }

  options.onAfterDbValidation?.()

  // --- Identity re-check AFTER validation (TOCTOU close) ------------------
  try {
    if (!liveIdentityMatches(livePath, options.receipt)) {
      return failure('POST_VALIDATION_IDENTITY_MISMATCH', 'STAT_IDENTITY_DIVERGED')
    }
  } catch (error) {
    return failure('POST_VALIDATION_STAT_FAILED', safeErrorCode(error))
  }

  logger.info('Replacement verified: live file identity confirmed before and after all DB gates')
  return Object.freeze({ ok: true as const })
}
