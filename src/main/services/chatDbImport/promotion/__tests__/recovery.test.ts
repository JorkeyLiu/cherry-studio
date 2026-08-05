/**
 * Promotion recovery decision matrix tests (LOCK-4406).
 *
 * Proves:
 * - The decision function is total and deterministic: EVERY input
 *   combination (journal observation × live × snapshot × candidate) yields
 *   exactly one of the four allowed actions with a stable reason code.
 * - No journal ⇒ keep-old-live; invalid journal ⇒ repair-required.
 * - candidate-installed never self-certifies: verified snapshot ⇒ restore,
 *   otherwise repair-required.
 * - replacement-verified accepted only with a present AND verified live DB.
 * - All 12 documented crash points map to their expected action via the
 *   canonical crash-point matrix.
 * - No age-based guessing and no empty-DB action exist in the surface.
 */

import { describe, expect, it } from 'vitest'

import { PROMOTION_JOURNAL_PHASES, type PromotionJournalPhaseV1, type PromotionJournalV1 } from '../journal'
import { PROMOTION_CRASH_POINTS } from '../protocol'
import {
  type CandidateArtifactStatus,
  decidePromotionRecovery,
  type LiveDbArtifactStatus,
  PROMOTION_CRASH_POINT_MATRIX,
  PROMOTION_RECOVERY_ACTIONS,
  type PromotionJournalObservation,
  type PromotionRecoveryInput,
  type SnapshotArtifactStatus
} from '../recovery'

const LIVE_STATUSES: readonly LiveDbArtifactStatus[] = ['missing', 'present-unverified', 'present-verified']
const SNAPSHOT_STATUSES: readonly SnapshotArtifactStatus[] = ['missing', 'present-unverified', 'present-verified']
const CANDIDATE_STATUSES: readonly CandidateArtifactStatus[] = ['missing', 'present']

function journalFor(phase: PromotionJournalPhaseV1): PromotionJournalV1 {
  return { version: 1, sessionId: 'import-s1', candidateId: 'candidate-import-s1', phase }
}

/** Every journal observation: absent, invalid, and each valid phase. */
const JOURNAL_OBSERVATIONS: readonly PromotionJournalObservation[] = [
  { status: 'absent' },
  { status: 'invalid' },
  ...PROMOTION_JOURNAL_PHASES.map((phase) => ({ status: 'valid', journal: journalFor(phase) }) as const)
]

/** The full enumerable input space (5 × 3 × 3 × 2 = 90 combinations). */
function enumerateInputs(): PromotionRecoveryInput[] {
  const inputs: PromotionRecoveryInput[] = []
  for (const journal of JOURNAL_OBSERVATIONS) {
    for (const live of LIVE_STATUSES) {
      for (const snapshot of SNAPSHOT_STATUSES) {
        for (const candidate of CANDIDATE_STATUSES) {
          inputs.push({ journal, live, snapshot, candidate })
        }
      }
    }
  }
  return inputs
}

describe('decidePromotionRecovery (LOCK-4406)', () => {
  describe('exhaustive determinism over the full input space', () => {
    it('returns exactly one allowed action + reason for all 90 combinations, stable across calls', () => {
      const inputs = enumerateInputs()
      expect(inputs).toHaveLength(90)

      for (const input of inputs) {
        const first = decidePromotionRecovery(input)
        const second = decidePromotionRecovery(input)
        expect(PROMOTION_RECOVERY_ACTIONS).toContain(first.action)
        expect(typeof first.reason).toBe('string')
        // Deterministic: identical input ⇒ identical single decision.
        expect(second).toEqual(first)
      }
    })

    it('never yields an action outside the four allowed actions (no empty-DB creation action exists)', () => {
      expect(PROMOTION_RECOVERY_ACTIONS).toEqual([
        'keep-old-live',
        'accept-verified-replacement',
        'restore-rollback-snapshot',
        'repair-required'
      ])
    })
  })

  describe('no journal / invalid journal', () => {
    it('absent journal always keeps the current live DB regardless of artifacts', () => {
      for (const live of LIVE_STATUSES) {
        for (const snapshot of SNAPSHOT_STATUSES) {
          for (const candidate of CANDIDATE_STATUSES) {
            expect(decidePromotionRecovery({ journal: { status: 'absent' }, live, snapshot, candidate })).toEqual({
              action: 'keep-old-live',
              reason: 'NO_JOURNAL'
            })
          }
        }
      }
    })

    it('invalid journal always requires explicit repair (progress unknowable)', () => {
      for (const live of LIVE_STATUSES) {
        for (const snapshot of SNAPSHOT_STATUSES) {
          for (const candidate of CANDIDATE_STATUSES) {
            expect(decidePromotionRecovery({ journal: { status: 'invalid' }, live, snapshot, candidate })).toEqual({
              action: 'repair-required',
              reason: 'JOURNAL_INVALID'
            })
          }
        }
      }
    })
  })

  describe('phase snapshot-ready', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: journalFor('snapshot-ready') }

    it('keeps the old live when candidate and live are both intact (install not started)', () => {
      for (const live of ['present-unverified', 'present-verified'] as const) {
        for (const snapshot of SNAPSHOT_STATUSES) {
          expect(decidePromotionRecovery({ journal, live, snapshot, candidate: 'present' })).toEqual({
            action: 'keep-old-live',
            reason: 'SNAPSHOT_READY_INSTALL_NOT_STARTED'
          })
        }
      }
    })

    it('restores the verified snapshot when the live DB is missing but the candidate remains', () => {
      expect(
        decidePromotionRecovery({ journal, live: 'missing', snapshot: 'present-verified', candidate: 'present' })
      ).toEqual({ action: 'restore-rollback-snapshot', reason: 'SNAPSHOT_READY_LIVE_MISSING_SNAPSHOT_VERIFIED' })
    })

    it('requires repair when the live DB is missing and no verified snapshot exists', () => {
      for (const snapshot of ['missing', 'present-unverified'] as const) {
        expect(decidePromotionRecovery({ journal, live: 'missing', snapshot, candidate: 'present' })).toEqual({
          action: 'repair-required',
          reason: 'SNAPSHOT_READY_LIVE_MISSING_SNAPSHOT_UNAVAILABLE'
        })
      }
    })

    it('treats a missing candidate as the ambiguous install window: verified snapshot ⇒ restore', () => {
      for (const live of LIVE_STATUSES) {
        expect(decidePromotionRecovery({ journal, live, snapshot: 'present-verified', candidate: 'missing' })).toEqual({
          action: 'restore-rollback-snapshot',
          reason: 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED'
        })
      }
    })

    it('ambiguous install without a verified snapshot requires repair (never trust torn state)', () => {
      for (const live of LIVE_STATUSES) {
        for (const snapshot of ['missing', 'present-unverified'] as const) {
          expect(decidePromotionRecovery({ journal, live, snapshot, candidate: 'missing' })).toEqual({
            action: 'repair-required',
            reason: 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_UNAVAILABLE'
          })
        }
      }
    })
  })

  describe('phase candidate-installed (replacement never self-certifies)', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: journalFor('candidate-installed') }

    it('restores the verified snapshot regardless of live/candidate status', () => {
      for (const live of LIVE_STATUSES) {
        for (const candidate of CANDIDATE_STATUSES) {
          expect(decidePromotionRecovery({ journal, live, snapshot: 'present-verified', candidate })).toEqual({
            action: 'restore-rollback-snapshot',
            reason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
          })
        }
      }
    })

    it('requires repair without a verified snapshot — an unverified snapshot is never restored', () => {
      for (const live of LIVE_STATUSES) {
        for (const snapshot of ['missing', 'present-unverified'] as const) {
          for (const candidate of CANDIDATE_STATUSES) {
            expect(decidePromotionRecovery({ journal, live, snapshot, candidate })).toEqual({
              action: 'repair-required',
              reason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_UNAVAILABLE'
            })
          }
        }
      }
    })
  })

  describe('phase replacement-verified', () => {
    const journal: PromotionJournalObservation = { status: 'valid', journal: journalFor('replacement-verified') }

    it('accepts the replacement only when the live DB is present AND verified', () => {
      for (const snapshot of SNAPSHOT_STATUSES) {
        for (const candidate of CANDIDATE_STATUSES) {
          expect(decidePromotionRecovery({ journal, live: 'present-verified', snapshot, candidate })).toEqual({
            action: 'accept-verified-replacement',
            reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED'
          })
        }
      }
    })

    it('any contradiction (live missing or unverified) requires repair', () => {
      for (const live of ['missing', 'present-unverified'] as const) {
        for (const snapshot of SNAPSHOT_STATUSES) {
          for (const candidate of CANDIDATE_STATUSES) {
            expect(decidePromotionRecovery({ journal, live, snapshot, candidate })).toEqual({
              action: 'repair-required',
              reason: 'REPLACEMENT_VERIFIED_LIVE_NOT_VERIFIED'
            })
          }
        }
      }
    })
  })

  describe('crash-point matrix (12 documented crash points)', () => {
    it('covers every one of the 12 listed crash points', () => {
      const covered = new Set(PROMOTION_CRASH_POINT_MATRIX.map((row) => row.crashPoint))
      for (const crashPoint of PROMOTION_CRASH_POINTS) {
        expect(covered.has(crashPoint)).toBe(true)
      }
      expect(PROMOTION_CRASH_POINTS).toHaveLength(12)
    })

    it('every matrix row decision matches decidePromotionRecovery exactly', () => {
      for (const row of PROMOTION_CRASH_POINT_MATRIX) {
        const journal: PromotionJournalObservation =
          row.journal === 'absent'
            ? { status: 'absent' }
            : { status: 'valid', journal: journalFor(row.journal as PromotionJournalPhaseV1) }
        const decision = decidePromotionRecovery({
          journal,
          live: row.live,
          snapshot: row.snapshot,
          candidate: row.candidate
        })
        expect(decision.action).toBe(row.expectedAction)
        expect(decision.reason).toBe(row.expectedReason)
      }
    })

    it('verification-failure crash points (integrity/fk/sample) all restore the verified snapshot', () => {
      const failurePoints = ['integrity-check-failed', 'foreign-key-check-failed', 'sample-read-failed'] as const
      for (const crashPoint of failurePoints) {
        const rows = PROMOTION_CRASH_POINT_MATRIX.filter((row) => row.crashPoint === crashPoint)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          expect(row.expectedAction).toBe('restore-rollback-snapshot')
        }
      }
    })

    it('will-quit-during-promotion is covered across all persisted phases', () => {
      const rows = PROMOTION_CRASH_POINT_MATRIX.filter((row) => row.crashPoint === 'will-quit-during-promotion')
      const journals = rows.map((row) => row.journal).sort()
      expect(journals).toEqual(['absent', 'candidate-installed', 'replacement-verified', 'snapshot-ready'])
    })
  })
})
