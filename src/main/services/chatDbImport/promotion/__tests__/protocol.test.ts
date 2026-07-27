/**
 * Promotion protocol pure-decision tests (LOCK-4401).
 *
 * Covers:
 * - Unique promotion entry: only verified-candidate may enter promoting
 * - Terminal result states
 * - Cancel boundary: allow / reject-promoting / ignore-terminal (total)
 * - Candidate disposal boundary: promotion-owned states preserved
 * - will-quit boundary: promotion artifacts preserved
 * - Operation ordering contract + the 12 documented crash points
 */

import { describe, expect, it } from 'vitest'

import {
  canEnterPromoting,
  decideCandidateDisposal,
  decidePromotionCancel,
  decideWillQuit,
  isPromotionResultState,
  PROMOTION_CRASH_POINTS,
  PROMOTION_ENTRY_STATE,
  PROMOTION_OPERATION_ORDER,
  PROMOTION_RESULT_STATES,
  type PromotionBoundaryState
} from '../protocol'

/** The full state union — decisions must be total over it. */
const ALL_STATES: readonly PromotionBoundaryState[] = [
  'intake',
  'discovering',
  'reading',
  'candidate-ready',
  'verifying',
  'verified-candidate',
  'verification-failed',
  'cancelled',
  'error',
  'promoting',
  'promoted',
  'promotion-failed'
]

describe('promotion protocol (LOCK-4401)', () => {
  describe('entry guard', () => {
    it('only verified-candidate may enter promoting (unique entry)', () => {
      for (const state of ALL_STATES) {
        expect(canEnterPromoting(state)).toBe(state === 'verified-candidate')
      }
      expect(PROMOTION_ENTRY_STATE).toBe('verified-candidate')
    })
  })

  describe('terminal result states', () => {
    it('promoted and promotion-failed are the only result states', () => {
      expect(PROMOTION_RESULT_STATES).toEqual(['promoted', 'promotion-failed'])
      for (const state of ALL_STATES) {
        expect(isPromotionResultState(state)).toBe(state === 'promoted' || state === 'promotion-failed')
      }
    })
  })

  describe('cancel boundary (total over all states)', () => {
    it('cancel is allowed only before promoting', () => {
      const allowed: PromotionBoundaryState[] = [
        'intake',
        'discovering',
        'reading',
        'candidate-ready',
        'verifying',
        'verified-candidate'
      ]
      for (const state of allowed) {
        expect(decidePromotionCancel(state)).toBe('allow')
      }
    })

    it('cancel is rejected exactly in promoting (no state change, no cleanup)', () => {
      expect(decidePromotionCancel('promoting')).toBe('reject-promoting')
    })

    it('cancel is ignored in every terminal state including promotion results', () => {
      const terminal: PromotionBoundaryState[] = [
        'cancelled',
        'error',
        'verification-failed',
        'promoted',
        'promotion-failed'
      ]
      for (const state of terminal) {
        expect(decidePromotionCancel(state)).toBe('ignore-terminal')
      }
    })

    it('is total: every state maps to exactly one decision', () => {
      for (const state of ALL_STATES) {
        expect(['allow', 'reject-promoting', 'ignore-terminal']).toContain(decidePromotionCancel(state))
      }
    })
  })

  describe('candidate disposal boundary', () => {
    it('preserves the candidate exactly in promotion-owned states', () => {
      for (const state of ALL_STATES) {
        const expected =
          state === 'promoting' || state === 'promoted' || state === 'promotion-failed' ? 'preserve' : 'discard'
        expect(decideCandidateDisposal(state)).toBe(expected)
      }
    })
  })

  describe('will-quit boundary', () => {
    it('preserves promotion artifacts exactly in promotion-owned states', () => {
      for (const state of ALL_STATES) {
        const expected =
          state === 'promoting' || state === 'promoted' || state === 'promotion-failed'
            ? 'preserve-promotion-artifacts'
            : 'dispose-ordinary'
        expect(decideWillQuit(state)).toBe(expected)
      }
    })
  })

  describe('operation ordering contract (LOCK-4403 ordering)', () => {
    it('defines the canonical 12-step order with journal anchors after their operations', () => {
      expect(PROMOTION_OPERATION_ORDER).toEqual([
        'create-rollback-snapshot',
        'verify-rollback-snapshot',
        'publish-rollback-snapshot',
        'journal-snapshot-ready',
        'close-live-db',
        'install-candidate',
        'journal-candidate-installed',
        'reopen-live-db',
        'verify-replacement',
        'journal-replacement-verified',
        'cleanup-journal',
        'relaunch'
      ])
    })

    it('snapshot is created and verified BEFORE any destructive step (LOCK-4403)', () => {
      const order = PROMOTION_OPERATION_ORDER as readonly string[]
      expect(order.indexOf('verify-rollback-snapshot')).toBeLessThan(order.indexOf('close-live-db'))
      expect(order.indexOf('publish-rollback-snapshot')).toBeLessThan(order.indexOf('close-live-db'))
      expect(order.indexOf('close-live-db')).toBeLessThan(order.indexOf('install-candidate'))
    })

    it('the journal is cleaned only AFTER replacement verification; snapshot retained', () => {
      const order = PROMOTION_OPERATION_ORDER as readonly string[]
      expect(order.indexOf('journal-replacement-verified')).toBeLessThan(order.indexOf('cleanup-journal'))
      expect(order.indexOf('cleanup-journal')).toBeLessThan(order.indexOf('relaunch'))
      // No snapshot-removal operation exists: the one retained snapshot
      // survives a verified replacement (LOCK-4403).
      expect(order.some((op) => op.includes('snapshot') && op.includes('remove'))).toBe(false)
    })
  })

  describe('crash points', () => {
    it('lists exactly the 12 documented crash points', () => {
      expect(PROMOTION_CRASH_POINTS).toEqual([
        'before-snapshot',
        'after-snapshot-before-live-close',
        'after-live-close-before-install',
        'after-install-before-reopen',
        'after-reopen-before-integrity',
        'integrity-check-failed',
        'foreign-key-check-failed',
        'sample-read-failed',
        'rollback-installation-interrupted',
        'after-replacement-verified-before-journal-cleanup',
        'before-relaunch',
        'will-quit-during-promotion'
      ])
      expect(PROMOTION_CRASH_POINTS).toHaveLength(12)
    })
  })
})
