/**
 * v2 three-artifact recovery decision matrix tests (LOCK-PROMO-6/10,
 * LOCK-JRNL-1/3/4).
 *
 * Proves, for the ENTIRE observable v2 input space:
 * - The decision is total and deterministic: EVERY combination (journal
 *   observation × live × dbSnapshot × candidate × files × filesSnapshot ×
 *   filesStaging × catalogSnapshot × catalogApplied × candidateCatalog ×
 *   liveDbReceiptMatchesCandidate — both boolean values AND the optional
 *   absent value) yields exactly one of the five v2 actions with a stable
 *   bounded reason code.
 * - absent journal ⇒ keep-old-live; invalid journal ⇒ repair-required;
 *   v1 journal ⇒ repair-required (never reinterpreted).
 * - candidates-ready ⇒ keep-old (no mutation, old receipts not yet
 *   captured — a restore cannot be verified, so nothing is invented).
 * - snapshots-ready:
 *   - intact old (live present ∧ candidate present) ⇒ keep-old;
 *   - live missing ⇒ restore ONLY when all three snapshots verify;
 *   - candidate missing (install rename consumed it before `db-installed`
 *     was journaled ⇒ MIXED generation) ⇒ NEVER keep-old: restore when the
 *     snapshots verify, else repair.
 * - db-installed ⇒ forward is impossible (Files/catalog still old): restore
 *   when the snapshots verify, else repair. NEVER accepted as success.
 * - files-installed / catalog-pending ⇒ complete-catalog-apply ONLY when
 *   the installed db AND Files verify, the candidate catalog handoff is
 *   verified, and no mid-install swap-staging evidence remains; otherwise
 *   restore/repair.
 * - catalog-applied / replacement-verified ⇒ accept ONLY when
 *   catalogApplied is verified AND db+Files verify; otherwise restore/repair.
 * - Every documented v2 crash point maps to its expected decision via the
 *   canonical crash-point matrix; every crash-point row is consistent with
 *   the pure function and the artifact-probe reality (candidate chat.db is
 *   consumed by the db install, candidate catalog handoff survives).
 * - Rollback-midway crashes (LOCK-AMB-3/4): forward completion at
 *   files-installed/catalog-pending and accept-new at
 *   catalog-applied/replacement-verified require the live DB to be EXACTLY
 *   the candidate (size + SHA-256 vs the journal candidate db receipt). A
 *   restored OLD db (crash between DB restore and Files/catalog restore)
 *   never forwards or accepts — it converges all-old via restore/repair.
 * - Decision reasons carry bounded codes only — no filenames/paths/content.
 * - Memory bound (LOCK-MEM-1/2): the full 236,196-combination space is
 *   enumerated lazily by a generator and NEVER materialized as an array.
 *   Every exhaustive assertion iterates the generator once, filtering by
 *   predicate inside the loop, so peak RSS stays flat while the exact
 *   cartesian coverage and every determinism assertion are preserved.
 */

import { describe, expect, it } from 'vitest'

import { PROMOTION_JOURNAL_VERSION_V2, type PromotionJournalPhaseV2, type PromotionJournalV2 } from '../journal'
import { PROMOTION_CRASH_POINTS_V2 } from '../protocol'
import {
  type CandidateArtifactStatus,
  decidePromotionRecoveryV2,
  type FilesArtifactStatus,
  type LiveDbArtifactStatus,
  PROMOTION_CRASH_POINT_MATRIX_V2,
  PROMOTION_RECOVERY_ACTIONS_V2,
  type PromotionCrashPointExpectationV2,
  type PromotionJournalObservation,
  type PromotionRecoveryDecisionV2,
  type PromotionRecoveryInputV2,
  type SnapshotArtifactStatus
} from '../recovery'

// LOCK-MEM-3: exhaustive sweeps over the full 236,196-combination space need
// more than the 20s project default. `exhaustiveIt` applies a 120s cap to
// every full-space sweep below; the normal focused single-fork run completes
// far below it.
const EXHAUSTIVE_TIMEOUT_MS = 120_000

function exhaustiveIt(name: string, fn: () => void): void {
  it(name, { timeout: EXHAUSTIVE_TIMEOUT_MS }, fn)
}

const LIVE_STATUSES: readonly LiveDbArtifactStatus[] = ['missing', 'present-unverified', 'present-verified']
const SNAPSHOT_STATUSES: readonly SnapshotArtifactStatus[] = ['missing', 'present-unverified', 'present-verified']
const FILES_STATUSES: readonly FilesArtifactStatus[] = ['missing', 'present-unverified', 'present-verified']
const CANDIDATE_STATUSES: readonly CandidateArtifactStatus[] = ['missing', 'present']
const BINARY_STATUSES: readonly ('missing' | 'present')[] = ['missing', 'present']
const CATALOG_APPLIED_STATUSES: readonly ('unknown' | 'verified' | 'unverified')[] = [
  'unknown',
  'verified',
  'unverified'
]
/** The optional field: absent (undefined) is a real callable value. */
const CANDIDATE_CATALOG_VALUES: readonly ('missing' | 'present' | undefined)[] = ['missing', 'present', undefined]
/** LOCK-AMB-3 exact candidate-receipt identity — both boolean values + the optional absent value. */
const LIVE_DB_RECEIPT_MATCH_VALUES: readonly (boolean | undefined)[] = [false, true, undefined]

export const V2_PHASES: readonly PromotionJournalPhaseV2[] = [
  'candidates-ready',
  'snapshots-ready',
  'db-installed',
  'files-installed',
  'catalog-pending',
  'catalog-applied',
  'replacement-verified'
]

function v2JournalFor(phase: PromotionJournalPhaseV2): PromotionJournalV2 {
  return {
    version: PROMOTION_JOURNAL_VERSION_V2,
    sessionId: 'import-s1',
    candidateId: 'candidate-import-s1',
    phase,
    receipts: { candidate: { db: null, files: null, catalog: null }, old: { db: null, files: null, catalog: null } }
  }
}

/** Every journal observation: absent, invalid, and each valid v2 phase. */
const JOURNAL_OBSERVATIONS: readonly PromotionJournalObservation[] = [
  { status: 'absent' },
  { status: 'invalid' },
  ...V2_PHASES.map((phase) => ({ status: 'valid', journal: v2JournalFor(phase) }) as const)
]

/**
 * The exact size of the enumerable v2 input space
 * (9 journals × 3 live × 3 dbSnapshot × 2 candidate × 3 files ×
 * 3 filesSnapshot × 2 filesStaging × 3 catalogSnapshot × 3 catalogApplied ×
 * 3 candidateCatalog × 3 liveDbReceiptMatchesCandidate). LOCK-MEM-1/2: the
 * exhaustive tests assert the lazy generator reproduces this exact count on
 * every iteration instead of materializing a 236,196-element array.
 */
const PROMOTION_RECOVERY_INPUT_COMBINATION_COUNT = 236196

/**
 * Lazy generator over the full enumerable v2 input space
 * (9 × 3 × 3 × 2 × 3 × 3 × 2 × 3 × 3 × 3 × 3 = 236,196). Yields one input
 * at a time so exhaustive tests never hold the whole space in memory
 * (LOCK-MEM-2). Fresh iterations — including repeated `for...of` passes
 * within one test run — reproduce the identical cartesian space every time.
 */
function* enumerateInputsV2(): Generator<PromotionRecoveryInputV2, void, void> {
  for (const journal of JOURNAL_OBSERVATIONS) {
    for (const live of LIVE_STATUSES) {
      for (const dbSnapshot of SNAPSHOT_STATUSES) {
        for (const candidate of CANDIDATE_STATUSES) {
          for (const files of FILES_STATUSES) {
            for (const filesSnapshot of SNAPSHOT_STATUSES) {
              for (const filesStaging of BINARY_STATUSES) {
                for (const catalogSnapshot of SNAPSHOT_STATUSES) {
                  for (const catalogApplied of CATALOG_APPLIED_STATUSES) {
                    for (const candidateCatalog of CANDIDATE_CATALOG_VALUES) {
                      for (const liveDbReceiptMatchesCandidate of LIVE_DB_RECEIPT_MATCH_VALUES) {
                        yield {
                          journal,
                          live,
                          dbSnapshot,
                          candidate,
                          files,
                          filesSnapshot,
                          filesStaging,
                          catalogSnapshot,
                          catalogApplied,
                          ...(candidateCatalog === undefined ? {} : { candidateCatalog }),
                          ...(liveDbReceiptMatchesCandidate === undefined ? {} : { liveDbReceiptMatchesCandidate })
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

/** Build a specific v2 input from overrides (defaults = fully verified old). */
function input(
  journal: PromotionJournalObservation,
  overrides: Partial<Omit<PromotionRecoveryInputV2, 'journal'>> = {}
): PromotionRecoveryInputV2 {
  return {
    journal,
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    // The default live DB is assumed to be EXACTLY the candidate (the normal
    // forward state); rollback-midway / mixed states override to false.
    liveDbReceiptMatchesCandidate: true,
    ...overrides
  }
}

const ALL_VERIFIED: Record<string, string> = {
  dbSnapshot: 'present-verified',
  filesSnapshot: 'present-verified',
  catalogSnapshot: 'present-verified'
}

describe('decidePromotionRecoveryV2 (LOCK-PROMO-6)', () => {
  describe('exhaustive totality + determinism over the full input space', () => {
    exhaustiveIt(
      'returns exactly one allowed action + bounded reason for all 236,196 combinations, stable across calls',
      () => {
        let count = 0
        for (const input of enumerateInputsV2()) {
          count += 1
          const first = decidePromotionRecoveryV2(input)
          const second = decidePromotionRecoveryV2(input)
          expect(PROMOTION_RECOVERY_ACTIONS_V2).toContain(first.action)
          expect(typeof first.reason).toBe('string')
          // Deterministic: identical input ⇒ identical single decision.
          expect(second).toEqual(first)
        }
        // LOCK-MEM-1: the lazy generator yields the exact full cartesian space.
        expect(count).toBe(PROMOTION_RECOVERY_INPUT_COMBINATION_COUNT)
      }
    )

    exhaustiveIt('reproduces the exact 236,196-combination space on repeated fresh iterations (LOCK-MEM-2)', () => {
      for (let pass = 0; pass < 2; pass += 1) {
        let count = 0
        // Count via next() so the loop carries no unused binding.
        const generator = enumerateInputsV2()
        while (!generator.next().done) {
          count += 1
        }
        expect(count).toBe(PROMOTION_RECOVERY_INPUT_COMBINATION_COUNT)
      }
    })

    it('never yields an action outside the five v2 actions', () => {
      expect(PROMOTION_RECOVERY_ACTIONS_V2).toEqual([
        'keep-old-live',
        'complete-catalog-apply',
        'accept-verified-replacement',
        'restore-rollback-snapshot',
        'repair-required'
      ])
    })
  })

  describe('journal base decisions', () => {
    exhaustiveIt('absent journal always keeps the current live state regardless of artifacts', () => {
      for (const input of enumerateInputsV2()) {
        if (input.journal.status !== 'absent') continue
        expect(decidePromotionRecoveryV2(input)).toEqual({ action: 'keep-old-live', reason: 'NO_JOURNAL' })
      }
    })

    exhaustiveIt('invalid journal always requires repair (progress unknowable)', () => {
      for (const input of enumerateInputsV2()) {
        if (input.journal.status !== 'invalid') continue
        expect(decidePromotionRecoveryV2(input)).toEqual({ action: 'repair-required', reason: 'JOURNAL_INVALID' })
      }
    })

    it('a v1 journal is NEVER reinterpreted as a partial Files generation (LOCK-PROMO-10)', () => {
      for (const phase of V2_PHASES) {
        const v1Input: PromotionRecoveryInputV2 = {
          journal: {
            status: 'valid',
            journal: { version: 1, sessionId: 'import-s1', candidateId: 'candidate-import-s1', phase }
          } as unknown as PromotionJournalObservation,
          live: 'present-verified',
          dbSnapshot: 'present-verified',
          candidate: 'present',
          files: 'present-verified',
          filesSnapshot: 'present-verified',
          filesStaging: 'missing',
          catalogSnapshot: 'present-verified',
          catalogApplied: 'verified',
          // A v1 journal carries no v2 candidate receipts — the identity
          // comparison is impossible and fails closed.
          liveDbReceiptMatchesCandidate: false
        }
        expect(decidePromotionRecoveryV2(v1Input)).toEqual({
          action: 'repair-required',
          reason: 'V2_JOURNAL_WITH_V1_INPUT'
        })
      }
    })
  })

  describe('phase candidates-ready', () => {
    exhaustiveIt(
      'always keeps the current live state — no mutation ever began, old receipts are not captured yet',
      () => {
        for (const sample of enumerateInputsV2()) {
          if (sample.journal.status !== 'valid') continue
          if ((sample.journal.journal as PromotionJournalV2).phase !== 'candidates-ready') continue
          const decision = decidePromotionRecoveryV2(sample)
          expect(decision.action).toBe('keep-old-live')
          expect(decision.reason).toBe('CANDIDATES_READY_NO_MUTATION')
        }
      }
    )
  })

  describe('phase snapshots-ready', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('snapshots-ready') }

    it('keeps the old live when the old generation is intact (live present ∧ candidate present)', () => {
      for (const live of ['present-unverified', 'present-verified'] as const) {
        for (const files of FILES_STATUSES) {
          for (const catalogApplied of CATALOG_APPLIED_STATUSES) {
            const decision = decidePromotionRecoveryV2(
              input(journal, { live, candidate: 'present', files, catalogApplied })
            )
            expect(decision).toEqual({ action: 'keep-old-live', reason: 'SNAPSHOTS_READY_LIVE_INTACT' })
          }
        }
      }
    })

    it('restores the all-old generation when the live DB is missing and ALL THREE snapshots verify', () => {
      for (const live of ['missing'] as const) {
        for (const candidate of CANDIDATE_STATUSES) {
          const decision = decidePromotionRecoveryV2(input(journal, { live, candidate, ...ALL_VERIFIED }))
          expect(decision).toEqual({
            action: 'restore-rollback-snapshot',
            reason: 'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_VERIFIED'
          })
        }
      }
    })

    it('repairs when the live DB is missing and any snapshot is missing/unverified — a partial restore is never chosen', () => {
      const snapshotFields = ['dbSnapshot', 'filesSnapshot', 'catalogSnapshot'] as const
      for (const missing of snapshotFields) {
        const overrides: Record<string, string> = { ...ALL_VERIFIED, [missing]: 'missing' }
        const decision = decidePromotionRecoveryV2(
          input(journal, { live: 'missing', candidate: 'present', ...overrides })
        )
        expect(decision).toEqual({
          action: 'repair-required',
          reason: 'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_UNAVAILABLE'
        })
      }
    })

    it('treats a consumed candidate as the ambiguous install window: NEVER keep-old, restore when verified', () => {
      // after-db-install-before-db-installed: live holds the unverified
      // candidate mixed with old Files/catalog — accepting it would boot a
      // MIXED generation (LOCK-JRNL-4).
      for (const live of ['present-unverified', 'present-verified'] as const) {
        const decision = decidePromotionRecoveryV2(input(journal, { live, candidate: 'missing', ...ALL_VERIFIED }))
        expect(decision).toEqual({
          action: 'restore-rollback-snapshot',
          reason: 'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED'
        })
      }
    })

    it('ambiguous install without all verified snapshots requires repair', () => {
      for (const live of ['present-unverified', 'present-verified'] as const) {
        for (const missing of ['dbSnapshot', 'filesSnapshot', 'catalogSnapshot'] as const) {
          const overrides: Record<string, string> = { ...ALL_VERIFIED, [missing]: 'present-unverified' }
          const decision = decidePromotionRecoveryV2(input(journal, { live, candidate: 'missing', ...overrides }))
          expect(decision).toEqual({
            action: 'repair-required',
            reason: 'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_UNAVAILABLE'
          })
        }
      }
    })
  })

  describe('phase db-installed (partial phase — never accepted as success)', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('db-installed') }

    it('restores the all-old generation when the snapshots verify — forward completion is impossible', () => {
      for (const live of LIVE_STATUSES) {
        for (const files of FILES_STATUSES) {
          for (const catalogApplied of CATALOG_APPLIED_STATUSES) {
            const decision = decidePromotionRecoveryV2(input(journal, { live, files, catalogApplied, ...ALL_VERIFIED }))
            expect(decision.action).toBe('restore-rollback-snapshot')
            expect(decision.reason).toBe('DB_INSTALLED_RESTORE_SNAPSHOT_VERIFIED')
          }
        }
      }
    })

    exhaustiveIt('never accepts or completes forward at db-installed regardless of artifact verification', () => {
      for (const sample of enumerateInputsV2()) {
        if (sample.journal.status !== 'valid') continue
        if ((sample.journal.journal as PromotionJournalV2).phase !== 'db-installed') continue
        const decision = decidePromotionRecoveryV2(sample)
        expect(['accept-verified-replacement', 'complete-catalog-apply']).not.toContain(decision.action)
      }
    })

    it('repairs when the snapshots do not all verify', () => {
      for (const missing of ['dbSnapshot', 'filesSnapshot', 'catalogSnapshot'] as const) {
        const overrides: Record<string, string> = { ...ALL_VERIFIED, [missing]: 'missing' }
        const decision = decidePromotionRecoveryV2(input(journal, overrides))
        expect(decision).toEqual({ action: 'repair-required', reason: 'DB_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE' })
      }
    })
  })

  describe('phase files-installed', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('files-installed') }

    it('completes forward when db + Files verify, the candidate catalog handoff verifies, and no staging evidence remains', () => {
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          candidate: 'missing',
          candidateCatalog: 'present',
          filesStaging: 'missing',
          ...ALL_VERIFIED
        })
      )
      expect(decision).toEqual({ action: 'complete-catalog-apply', reason: 'FILES_INSTALLED_FORWARD_VERIFIABLE' })
    })

    it('never completes forward when the installed db is unverified', () => {
      for (const live of ['missing', 'present-unverified'] as const) {
        const decision = decidePromotionRecoveryV2(
          input(journal, {
            live,
            files: 'present-verified',
            candidate: 'missing',
            candidateCatalog: 'present',
            filesStaging: 'missing',
            ...ALL_VERIFIED
          })
        )
        expect(decision.action).not.toBe('complete-catalog-apply')
      }
    })

    it('never completes forward when the installed Files fail parity', () => {
      for (const files of ['missing', 'present-unverified'] as const) {
        const decision = decidePromotionRecoveryV2(
          input(journal, {
            live: 'present-verified',
            files,
            candidate: 'missing',
            candidateCatalog: 'present',
            filesStaging: 'missing',
            ...ALL_VERIFIED
          })
        )
        expect(decision.action).not.toBe('complete-catalog-apply')
      }
    })

    it('never completes forward when the candidate catalog handoff is unavailable (LOCK-JRNL-3)', () => {
      for (const candidateCatalog of ['missing', undefined] as const) {
        const decision = decidePromotionRecoveryV2(
          input(journal, {
            live: 'present-verified',
            files: 'present-verified',
            candidate: 'missing',
            filesStaging: 'missing',
            ...ALL_VERIFIED,
            ...(candidateCatalog === undefined ? {} : { candidateCatalog })
          })
        )
        expect(decision.action).not.toBe('complete-catalog-apply')
      }
    })

    it('never completes forward while mid-install swap-staging evidence remains (LOCK-JRNL-4 unexpected staging artifact)', () => {
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          candidate: 'missing',
          candidateCatalog: 'present',
          filesStaging: 'present',
          ...ALL_VERIFIED
        })
      )
      expect(decision.action).not.toBe('complete-catalog-apply')
      // The proven all-old convergence is safe and preferred over repair.
      expect(decision.action).toBe('restore-rollback-snapshot')
    })

    exhaustiveIt('restores (snapshots verified) or repairs when forward is not verifiable', () => {
      for (const sample of enumerateInputsV2()) {
        if (sample.journal.status !== 'valid') continue
        if ((sample.journal.journal as PromotionJournalV2).phase !== 'files-installed') continue
        const decision = decidePromotionRecoveryV2(sample)
        if (decision.action === 'complete-catalog-apply') continue
        const allSnapshotsVerified =
          sample.dbSnapshot === 'present-verified' &&
          sample.filesSnapshot === 'present-verified' &&
          sample.catalogSnapshot === 'present-verified'
        if (allSnapshotsVerified) {
          expect(decision).toEqual({
            action: 'restore-rollback-snapshot',
            reason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
          })
        } else {
          expect(decision).toEqual({
            action: 'repair-required',
            reason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE'
          })
        }
      }
    })
  })

  describe('phase catalog-pending', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('catalog-pending') }

    it('completes forward when db + Files verify, the candidate catalog handoff verifies, and no staging evidence remains', () => {
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          candidate: 'missing',
          candidateCatalog: 'present',
          filesStaging: 'missing',
          ...ALL_VERIFIED
        })
      )
      expect(decision).toEqual({ action: 'complete-catalog-apply', reason: 'CATALOG_PENDING_FORWARD_VERIFIABLE' })
    })

    it('a committed catalog transaction (catalogApplied=verified) still completes forward at catalog-pending', () => {
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          candidate: 'missing',
          candidateCatalog: 'present',
          filesStaging: 'missing',
          catalogApplied: 'verified',
          ...ALL_VERIFIED
        })
      )
      expect(decision).toEqual({ action: 'complete-catalog-apply', reason: 'CATALOG_PENDING_FORWARD_VERIFIABLE' })
    })

    exhaustiveIt('restores (snapshots verified) or repairs when forward is not verifiable', () => {
      for (const sample of enumerateInputsV2()) {
        if (sample.journal.status !== 'valid') continue
        if ((sample.journal.journal as PromotionJournalV2).phase !== 'catalog-pending') continue
        const decision = decidePromotionRecoveryV2(sample)
        if (decision.action === 'complete-catalog-apply') continue
        const allSnapshotsVerified =
          sample.dbSnapshot === 'present-verified' &&
          sample.filesSnapshot === 'present-verified' &&
          sample.catalogSnapshot === 'present-verified'
        if (allSnapshotsVerified) {
          expect(decision).toEqual({
            action: 'restore-rollback-snapshot',
            reason: 'CATALOG_PENDING_RESTORE_SNAPSHOT_VERIFIED'
          })
        } else {
          expect(decision).toEqual({
            action: 'repair-required',
            reason: 'CATALOG_PENDING_RESTORE_SNAPSHOT_UNAVAILABLE'
          })
        }
      }
    })
  })

  describe('phase catalog-applied', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('catalog-applied') }

    it('accepts the replacement ONLY when the catalog facts verify AND the installed db + Files verify', () => {
      const decision = decidePromotionRecoveryV2(
        input(journal, { live: 'present-verified', files: 'present-verified', catalogApplied: 'verified' })
      )
      expect(decision).toEqual({ action: 'accept-verified-replacement', reason: 'CATALOG_APPLIED_ACCEPT_ALL_VERIFIED' })
    })

    it('never accepts when catalogApplied is unknown or unverified', () => {
      for (const catalogApplied of ['unknown', 'unverified'] as const) {
        const decision = decidePromotionRecoveryV2(input(journal, { catalogApplied }))
        expect(decision.action).not.toBe('accept-verified-replacement')
      }
    })

    it('never accepts when the installed db or Files fails verification', () => {
      for (const live of ['missing', 'present-unverified'] as const) {
        const decision = decidePromotionRecoveryV2(
          input(journal, { live, files: 'present-verified', catalogApplied: 'verified' })
        )
        expect(decision.action).not.toBe('accept-verified-replacement')
      }
      for (const files of ['missing', 'present-unverified'] as const) {
        const decision = decidePromotionRecoveryV2(
          input(journal, { live: 'present-verified', files, catalogApplied: 'verified' })
        )
        expect(decision.action).not.toBe('accept-verified-replacement')
      }
    })

    exhaustiveIt('restores (snapshots verified) or repairs for every non-accept combination', () => {
      for (const sample of enumerateInputsV2()) {
        if (sample.journal.status !== 'valid') continue
        if ((sample.journal.journal as PromotionJournalV2).phase !== 'catalog-applied') continue
        const decision = decidePromotionRecoveryV2(sample)
        if (decision.action === 'accept-verified-replacement') continue
        const allSnapshotsVerified =
          sample.dbSnapshot === 'present-verified' &&
          sample.filesSnapshot === 'present-verified' &&
          sample.catalogSnapshot === 'present-verified'
        if (allSnapshotsVerified) {
          expect(decision).toEqual({
            action: 'restore-rollback-snapshot',
            reason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
          })
        } else {
          expect(decision).toEqual({
            action: 'repair-required',
            reason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_UNAVAILABLE'
          })
        }
      }
    })
  })

  describe('phase replacement-verified', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('replacement-verified') }

    it('accepts the replacement ONLY when the catalog facts verify AND the installed db + Files verify', () => {
      const decision = decidePromotionRecoveryV2(
        input(journal, { live: 'present-verified', files: 'present-verified', catalogApplied: 'verified' })
      )
      expect(decision).toEqual({
        action: 'accept-verified-replacement',
        reason: 'REPLACEMENT_VERIFIED_ACCEPT_ALL_VERIFIED'
      })
    })

    it('never accepts with any contradiction (catalog unverified, db unverified, files unverified)', () => {
      for (const catalogApplied of ['unknown', 'unverified'] as const) {
        expect(decidePromotionRecoveryV2(input(journal, { catalogApplied })).action).not.toBe(
          'accept-verified-replacement'
        )
      }
      for (const live of ['missing', 'present-unverified'] as const) {
        expect(decidePromotionRecoveryV2(input(journal, { live, catalogApplied: 'verified' })).action).not.toBe(
          'accept-verified-replacement'
        )
      }
      for (const files of ['missing', 'present-unverified'] as const) {
        expect(decidePromotionRecoveryV2(input(journal, { files, catalogApplied: 'verified' })).action).not.toBe(
          'accept-verified-replacement'
        )
      }
    })

    exhaustiveIt('restores (snapshots verified) or repairs for every non-accept combination', () => {
      for (const sample of enumerateInputsV2()) {
        if (sample.journal.status !== 'valid') continue
        if ((sample.journal.journal as PromotionJournalV2).phase !== 'replacement-verified') continue
        const decision = decidePromotionRecoveryV2(sample)
        if (decision.action === 'accept-verified-replacement') continue
        const allSnapshotsVerified =
          sample.dbSnapshot === 'present-verified' &&
          sample.filesSnapshot === 'present-verified' &&
          sample.catalogSnapshot === 'present-verified'
        if (allSnapshotsVerified) {
          expect(decision).toEqual({
            action: 'restore-rollback-snapshot',
            reason: 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_VERIFIED'
          })
        } else {
          expect(decision).toEqual({
            action: 'repair-required',
            reason: 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_UNAVAILABLE'
          })
        }
      }
    })
  })

  describe('v2 crash-point matrix (LOCK-PROMO-6 coverage anchor)', () => {
    it('covers every one of the documented v2 crash points', () => {
      const covered = new Set(PROMOTION_CRASH_POINT_MATRIX_V2.map((row) => row.crashPoint))
      for (const crashPoint of PROMOTION_CRASH_POINTS_V2) {
        expect(covered.has(crashPoint)).toBe(true)
      }
      expect(PROMOTION_CRASH_POINTS_V2).toHaveLength(23)
    })

    it('every matrix row decision matches decidePromotionRecoveryV2 exactly', () => {
      for (const row of PROMOTION_CRASH_POINT_MATRIX_V2) {
        const decision = decisionForRow(row)
        expect(decision.action).toBe(row.expectedAction)
        expect(decision.reason).toBe(row.expectedReason)
      }
    })

    it('every valid-journal row is probe-realistic: the candidate DB is consumed from db-install onward, the catalog handoff survives', () => {
      for (const row of PROMOTION_CRASH_POINT_MATRIX_V2) {
        if (row.journal === 'absent') {
          // No journal → the probe cannot resolve a candidateId, so the
          // handoff probe reports missing; the candidate column is irrelevant
          // to the NO_JOURNAL decision (keep-old always). The receipt
          // identity is impossible without a journal (fail closed).
          expect(row.candidateCatalog).toBe('missing')
          expect(row.liveDbReceiptMatchesCandidate).toBe(false)
          continue
        }
        const phase = row.journal
        if (phase === 'candidates-ready') {
          // No install ran yet — the candidate DB and the catalog handoff exist.
          expect(row.candidate).toBe('present')
          expect(row.candidateCatalog).toBe('present')
        } else if (phase === 'snapshots-ready') {
          // Pre-install rows keep the candidate; the ambiguous row 8 has it consumed.
          expect(row.candidate).toBe(row.crashPoint === 'after-db-install-before-db-installed' ? 'missing' : 'present')
          expect(row.candidateCatalog).toBe('present')
        } else {
          // db-installed and later: the candidate DB was renamed to live.
          expect(row.candidate).toBe('missing')
          expect(row.candidateCatalog).toBe('present')
        }
        expect(row.filesStaging).toBe(
          row.crashPoint === 'after-files-install-before-files-installed' ? 'present' : 'missing'
        )
      }
    })

    it('the receipt identity is probe-realistic: true only for a present-verified live DB at forward/accept phases, except rollback-midway (LOCK-AMB-3)', () => {
      const forwardPhases = ['files-installed', 'catalog-pending', 'catalog-applied', 'replacement-verified']
      const rollbackMidway = new Set([
        'after-rollback-db-restore-before-files-restore',
        'after-rollback-files-restore-before-catalog-restore'
      ])
      for (const row of PROMOTION_CRASH_POINT_MATRIX_V2) {
        if (rollbackMidway.has(row.crashPoint)) {
          // The restored OLD db is SQLite-valid (probe present-verified) but
          // is NOT the candidate generation — the whole point of LOCK-AMB-3.
          expect(row.live).toBe('present-verified')
          expect(row.liveDbReceiptMatchesCandidate).toBe(false)
          continue
        }
        const expected =
          row.journal !== 'absent' && forwardPhases.includes(row.journal) && row.live === 'present-verified'
        expect(row.liveDbReceiptMatchesCandidate).toBe(expected)
      }
    })

    it('will-quit-during-promotion is covered across the v2 phases that own the candidate', () => {
      const rows = PROMOTION_CRASH_POINT_MATRIX_V2.filter((row) => row.crashPoint === 'will-quit-during-promotion')
      const journals = rows.map((row) => row.journal).sort()
      expect(journals).toEqual([
        'absent',
        'candidates-ready',
        'catalog-pending',
        'db-installed',
        'replacement-verified'
      ])
    })

    it('the post-db-install crash point converges all-old instead of accepting the mixed generation', () => {
      const row = PROMOTION_CRASH_POINT_MATRIX_V2.find((r) => r.crashPoint === 'after-db-install-before-db-installed')
      expect(row).toBeDefined()
      expect(row!.expectedAction).toBe('restore-rollback-snapshot')
      expect(row!.expectedReason).toBe('SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED')
    })

    it('every rollback-midway crash point converges all-old at all four affected late phases (LOCK-AMB-6)', () => {
      const rows = PROMOTION_CRASH_POINT_MATRIX_V2.filter(
        (r) =>
          r.crashPoint === 'after-rollback-db-restore-before-files-restore' ||
          r.crashPoint === 'after-rollback-files-restore-before-catalog-restore'
      )
      expect(rows).toHaveLength(8)
      // Both crash points × the four affected late phases.
      expect(new Set(rows.map((r) => r.crashPoint))).toEqual(
        new Set([
          'after-rollback-db-restore-before-files-restore',
          'after-rollback-files-restore-before-catalog-restore'
        ])
      )
      expect(new Set(rows.map((r) => r.journal))).toEqual(
        new Set(['files-installed', 'catalog-pending', 'catalog-applied', 'replacement-verified'])
      )
      // Never forward (complete-catalog-apply) or accept-new in ANY of them.
      for (const row of rows) {
        expect(row.live).toBe('present-verified')
        expect(row.files).toBe(
          row.crashPoint === 'after-rollback-db-restore-before-files-restore'
            ? 'present-verified'
            : 'present-unverified'
        )
        expect(row.catalogApplied).toBe('verified')
        expect(row.liveDbReceiptMatchesCandidate).toBe(false)
        expect(row.expectedAction).toBe('restore-rollback-snapshot')
        expect(row.expectedReason).toMatch(/RESTORE_SNAPSHOT_VERIFIED$/)
      }
    })
  })

  describe('rollback-midway receipt identity (LOCK-AMB-3/4)', () => {
    it('files-installed: forward completion requires the live DB to be EXACTLY the candidate — a restored OLD db falls to restore/repair', () => {
      const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('files-installed') }
      // Every other forward evidence is perfect; only the exact candidate
      // identity is missing (the rollback-midway crash state R1). Both the
      // explicit false and the pre-field undefined must fail closed.
      const base = {
        journal,
        live: 'present-verified' as const,
        dbSnapshot: 'present-verified' as const,
        candidate: 'missing' as const,
        files: 'present-verified' as const,
        filesSnapshot: 'present-verified' as const,
        filesStaging: 'missing' as const,
        catalogSnapshot: 'present-verified' as const,
        catalogApplied: 'verified' as const,
        candidateCatalog: 'present' as const
      }
      for (const matches of [false, undefined] as const) {
        const decision = decidePromotionRecoveryV2(
          matches === undefined ? base : { ...base, liveDbReceiptMatchesCandidate: matches }
        )
        expect(decision.action).not.toBe('complete-catalog-apply')
        expect(decision).toEqual({
          action: 'restore-rollback-snapshot',
          reason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
        })
      }
    })

    it('catalog-pending: forward completion requires the exact candidate identity — a restored OLD db falls to restore (R3)', () => {
      const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('catalog-pending') }
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          candidate: 'missing',
          candidateCatalog: 'present',
          filesStaging: 'missing',
          catalogApplied: 'verified',
          liveDbReceiptMatchesCandidate: false,
          ...ALL_VERIFIED
        })
      )
      expect(decision).toEqual({
        action: 'restore-rollback-snapshot',
        reason: 'CATALOG_PENDING_RESTORE_SNAPSHOT_VERIFIED'
      })
    })

    it('catalog-applied: accept-new requires the exact candidate identity — a restored OLD db falls to restore (R5)', () => {
      const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('catalog-applied') }
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          catalogApplied: 'verified',
          liveDbReceiptMatchesCandidate: false,
          ...ALL_VERIFIED
        })
      )
      expect(decision.action).not.toBe('accept-verified-replacement')
      expect(decision).toEqual({
        action: 'restore-rollback-snapshot',
        reason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
      })
    })

    it('replacement-verified: accept-new requires the exact candidate identity — a restored OLD db falls to restore (R7)', () => {
      const journal: PromotionJournalObservation = {
        status: 'valid',
        journal: v2JournalFor('replacement-verified')
      }
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          catalogApplied: 'verified',
          liveDbReceiptMatchesCandidate: false,
          ...ALL_VERIFIED
        })
      )
      expect(decision.action).not.toBe('accept-verified-replacement')
      expect(decision).toEqual({
        action: 'restore-rollback-snapshot',
        reason: 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_VERIFIED'
      })
    })

    it('the same rollback-midway states repair (never forward/accept) when the retained snapshots do not all verify', () => {
      const journal: PromotionJournalObservation = { status: 'valid', journal: v2JournalFor('files-installed') }
      const decision = decidePromotionRecoveryV2(
        input(journal, {
          live: 'present-verified',
          files: 'present-verified',
          candidate: 'missing',
          candidateCatalog: 'present',
          filesStaging: 'missing',
          catalogApplied: 'verified',
          dbSnapshot: 'missing',
          liveDbReceiptMatchesCandidate: false
        })
      )
      expect(decision.action).not.toBe('complete-catalog-apply')
      expect(decision).toEqual({
        action: 'repair-required',
        reason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE'
      })
    })

    it('a DB-restored crash at snapshots-ready and db-installed is unaffected (the receipt identity is only consulted at the four late phases)', () => {
      // snapshots-ready: the matrix already treats a consumed candidate as
      // the ambiguous install window — restore, independent of the identity.
      const snapshotsJournal: PromotionJournalObservation = {
        status: 'valid',
        journal: v2JournalFor('snapshots-ready')
      }
      expect(
        decidePromotionRecoveryV2(
          input(snapshotsJournal, {
            live: 'present-verified',
            candidate: 'missing',
            liveDbReceiptMatchesCandidate: false,
            ...ALL_VERIFIED
          })
        ).action
      ).toBe('restore-rollback-snapshot')
      // db-installed: forward is impossible by phase — restore regardless.
      const dbInstalledJournal: PromotionJournalObservation = {
        status: 'valid',
        journal: v2JournalFor('db-installed')
      }
      expect(
        decidePromotionRecoveryV2(
          input(dbInstalledJournal, {
            live: 'present-verified',
            liveDbReceiptMatchesCandidate: true,
            ...ALL_VERIFIED
          })
        ).action
      ).toBe('restore-rollback-snapshot')
    })

    exhaustiveIt(
      'the exhaustive space never forwards or accepts at the four late phases when the identity is false/undefined',
      () => {
        const latePhases = ['files-installed', 'catalog-pending', 'catalog-applied', 'replacement-verified']
        for (const sample of enumerateInputsV2()) {
          if (sample.journal.status !== 'valid') continue
          const phase = (sample.journal.journal as PromotionJournalV2).phase
          if (!latePhases.includes(phase)) continue
          const decision = decidePromotionRecoveryV2(sample)
          if (sample.liveDbReceiptMatchesCandidate !== true) {
            expect(decision.action).not.toBe('complete-catalog-apply')
            expect(decision.action).not.toBe('accept-verified-replacement')
          }
        }
      }
    )
  })

  describe('bounded reason codes — no private data (LOCK-JRNL-6)', () => {
    /** The exact bounded v2 reason-code union (aggregate codes only). */
    const REASON_CODES: readonly string[] = [
      'NO_JOURNAL',
      'JOURNAL_INVALID',
      'V2_JOURNAL_WITH_V1_INPUT',
      'CANDIDATES_READY_NO_MUTATION',
      'SNAPSHOTS_READY_LIVE_INTACT',
      'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_VERIFIED',
      'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_UNAVAILABLE',
      'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED',
      'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_UNAVAILABLE',
      'DB_INSTALLED_RESTORE_SNAPSHOT_VERIFIED',
      'DB_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE',
      'FILES_INSTALLED_FORWARD_VERIFIABLE',
      'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED',
      'FILES_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE',
      'CATALOG_PENDING_FORWARD_VERIFIABLE',
      'CATALOG_PENDING_RESTORE_SNAPSHOT_VERIFIED',
      'CATALOG_PENDING_RESTORE_SNAPSHOT_UNAVAILABLE',
      'CATALOG_APPLIED_ACCEPT_ALL_VERIFIED',
      'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED',
      'CATALOG_APPLIED_RESTORE_SNAPSHOT_UNAVAILABLE',
      'REPLACEMENT_VERIFIED_ACCEPT_ALL_VERIFIED',
      'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_VERIFIED',
      'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_UNAVAILABLE'
    ]

    exhaustiveIt('every decision reason is a bounded aggregate code — never a filename, path, or content', () => {
      for (const sample of enumerateInputsV2()) {
        const decision = decidePromotionRecoveryV2(sample)
        expect(REASON_CODES).toContain(decision.reason)
      }
    })

    it('the JSON serialization of any decision carries no private artifact names', () => {
      // LOCK-MEM-2: single-item access via the lazy generator's next() — no
      // full-space materialization is needed for a one-item serialization.
      const first = enumerateInputsV2().next()
      if (first.done) {
        throw new Error('input space unexpectedly empty')
      }
      const raw = JSON.stringify(decidePromotionRecoveryV2(first.value))
      expect(raw).not.toContain('chat.db')
      expect(raw).not.toContain('import')
    })
  })
})

/** Build the pure input for a crash-point matrix row (probe-consistent). */
function decisionForRow(row: PromotionCrashPointExpectationV2): PromotionRecoveryDecisionV2 {
  const journal: PromotionJournalObservation =
    row.journal === 'absent' ? { status: 'absent' } : { status: 'valid', journal: v2JournalFor(row.journal) }
  return decidePromotionRecoveryV2({
    journal,
    live: row.live,
    dbSnapshot: row.dbSnapshot,
    candidate: row.candidate,
    files: row.files,
    filesSnapshot: row.filesSnapshot,
    filesStaging: row.filesStaging,
    catalogSnapshot: row.catalogSnapshot,
    catalogApplied: row.catalogApplied,
    candidateCatalog: row.candidateCatalog,
    liveDbReceiptMatchesCandidate: row.liveDbReceiptMatchesCandidate
  })
}
