/**
 * Startup recovery seam tests (app-ready lifecycle wiring).
 *
 * Verifies the exact behavior src/main/index.ts relies on:
 * - Both recoveries are invoked on startup (temp workspaces first, then
 *   candidates — preserved original order, LOCK-L1).
 * - A failure in either recovery is contained and logged, never thrown,
 *   and does not prevent the other recovery from running (LOCK-L3).
 *
 * Journal-aware candidate protection (Phase 4.4.1):
 * - absent observation (or none) preserves the pre-4.4.1 cleanup exactly.
 * - valid observation protects the journal-referenced candidate ID
 *   (LOCK-4413: journal is truth, never mtime).
 * - invalid observation blocks candidate cleanup entirely and is surfaced
 *   explicitly in the typed result (LOCK-4414: invalid != absent).
 * - a valid observation with an unsafe candidate ID protects nothing and
 *   blocks cleanup (LOCK-4415).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const recoverOrphanedTempWorkspacesMock = vi.fn()
const recoverOrphanedCandidatesMock = vi.fn()

vi.mock('../tempWorkspace', () => ({
  recoverOrphanedTempWorkspaces: (...args: unknown[]) => recoverOrphanedTempWorkspacesMock(...args)
}))

vi.mock('../candidateDb', () => ({
  recoverOrphanedCandidates: (...args: unknown[]) => recoverOrphanedCandidatesMock(...args),
  // Mirror the owned candidate ID contract used by candidateDb: strict
  // allowlist PLUS the exact owned `candidate-` prefix (the ID IS the leaf).
  isValidOwnedCandidateId: (value: unknown) =>
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    value.startsWith('candidate-') &&
    value.length > 'candidate-'.length
}))

import { loggerService } from '@logger'

import * as promotionRecovery from '../promotion/recovery'
import * as startupRecovery from '../startupRecovery'
import { recoverOrphanedImportArtifacts } from '../startupRecovery'

const VALID_JOURNAL = Object.freeze({
  version: 1 as const,
  sessionId: 'session-abc',
  candidateId: 'candidate-id-123',
  phase: 'snapshot-ready' as const
})

describe('recoverOrphanedImportArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    recoverOrphanedTempWorkspacesMock.mockResolvedValue(undefined)
    recoverOrphanedCandidatesMock.mockResolvedValue(undefined)
  })

  it('invokes temp-workspace recovery then candidate recovery on startup', async () => {
    await recoverOrphanedImportArtifacts()

    expect(recoverOrphanedTempWorkspacesMock).toHaveBeenCalledTimes(1)
    expect(recoverOrphanedCandidatesMock).toHaveBeenCalledTimes(1)

    // Preserved original startup order: temp workspaces before candidates.
    const tempOrder = recoverOrphanedTempWorkspacesMock.mock.invocationCallOrder[0]
    const candidateOrder = recoverOrphanedCandidatesMock.mock.invocationCallOrder[0]
    expect(tempOrder).toBeLessThan(candidateOrder)
  })

  it('calls candidate recovery with no arguments (uses owned default data root)', async () => {
    await recoverOrphanedImportArtifacts()

    expect(recoverOrphanedCandidatesMock).toHaveBeenCalledWith()
  })

  it('contains and logs a temp-workspace recovery failure, still runs candidate recovery', async () => {
    const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
    recoverOrphanedTempWorkspacesMock.mockRejectedValue(new Error('temp recovery failed'))

    const result = await recoverOrphanedImportArtifacts()

    expect(result.tempWorkspaceCleanup).toBe('failed')
    expect(result.candidateCleanup).toBe('completed')
    expect(recoverOrphanedCandidatesMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('Failed to recover orphaned import workspaces (non-fatal):', expect.any(Error))
    warnSpy.mockRestore()
  })

  it('contains and logs a candidate recovery failure without throwing', async () => {
    const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
    recoverOrphanedCandidatesMock.mockRejectedValue(new Error('candidate recovery failed'))

    const result = await recoverOrphanedImportArtifacts()

    expect(result.tempWorkspaceCleanup).toBe('completed')
    expect(result.candidateCleanup).toBe('failed')
    expect(recoverOrphanedTempWorkspacesMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to recover orphaned candidate databases (non-fatal):',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('contains both failures independently (no cascade, no throw)', async () => {
    const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
    recoverOrphanedTempWorkspacesMock.mockRejectedValue(new Error('temp failed'))
    recoverOrphanedCandidatesMock.mockRejectedValue(new Error('candidate failed'))

    const result = await recoverOrphanedImportArtifacts()

    expect(result).toEqual({
      tempWorkspaceCleanup: 'failed',
      candidateCleanup: 'failed',
      protectedCandidateId: null
    })
    expect(warnSpy).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })

  describe('journal-aware candidate protection (Phase 4.4.1)', () => {
    it('absent observation preserves existing behavior (default parameter)', async () => {
      const result = await recoverOrphanedImportArtifacts()

      expect(recoverOrphanedCandidatesMock).toHaveBeenCalledWith()
      expect(result).toEqual({
        tempWorkspaceCleanup: 'completed',
        candidateCleanup: 'completed',
        protectedCandidateId: null
      })
    })

    it('explicit absent observation preserves existing behavior', async () => {
      const result = await recoverOrphanedImportArtifacts({ status: 'absent' })

      expect(recoverOrphanedCandidatesMock).toHaveBeenCalledWith()
      expect(result.candidateCleanup).toBe('completed')
      expect(result.protectedCandidateId).toBeNull()
    })

    it('valid observation passes the journal candidate ID as a protected exclusion (LOCK-4413)', async () => {
      const result = await recoverOrphanedImportArtifacts({ status: 'valid', journal: VALID_JOURNAL })

      expect(recoverOrphanedCandidatesMock).toHaveBeenCalledTimes(1)
      expect(recoverOrphanedCandidatesMock).toHaveBeenCalledWith(undefined, {
        protectedCandidateIds: [VALID_JOURNAL.candidateId]
      })
      expect(result).toEqual({
        tempWorkspaceCleanup: 'completed',
        candidateCleanup: 'completed',
        protectedCandidateId: VALID_JOURNAL.candidateId
      })
    })

    it('invalid observation blocks candidate cleanup entirely and surfaces it (LOCK-4414)', async () => {
      const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)

      const result = await recoverOrphanedImportArtifacts({ status: 'invalid' })

      // Candidate cleanup must NOT run — nothing may be deleted.
      expect(recoverOrphanedCandidatesMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        tempWorkspaceCleanup: 'completed',
        candidateCleanup: 'blocked-invalid-journal',
        protectedCandidateId: null
      })
      // Blocking is surfaced explicitly, not silent.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid'))
      warnSpy.mockRestore()
    })

    it('invalid observation still runs temp-workspace cleanup (safe ordering preserved)', async () => {
      const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)

      await recoverOrphanedImportArtifacts({ status: 'invalid' })

      expect(recoverOrphanedTempWorkspacesMock).toHaveBeenCalledTimes(1)
      warnSpy.mockRestore()
    })

    it('a valid observation with an unsafe candidate ID protects nothing and blocks cleanup (LOCK-4415)', async () => {
      const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)

      const result = await recoverOrphanedImportArtifacts({
        status: 'valid',
        journal: { ...VALID_JOURNAL, candidateId: '../escape' }
      })

      expect(recoverOrphanedCandidatesMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        tempWorkspaceCleanup: 'completed',
        candidateCleanup: 'blocked-unsafe-candidate-id',
        protectedCandidateId: null
      })
      warnSpy.mockRestore()
    })

    it('a valid observation whose candidate ID lacks the owned prefix cannot map to a leaf and blocks cleanup (LOCK-4415)', async () => {
      const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)

      // Allowlist-safe but NOT an owned candidate directory ID: protecting
      // by re-prefixing would name a directory that does not exist, leaving
      // the real promoting candidate deletable — cleanup must be blocked.
      const result = await recoverOrphanedImportArtifacts({
        status: 'valid',
        journal: { ...VALID_JOURNAL, candidateId: 'session-without-prefix' }
      })

      expect(recoverOrphanedCandidatesMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        tempWorkspaceCleanup: 'completed',
        candidateCleanup: 'blocked-unsafe-candidate-id',
        protectedCandidateId: null
      })
      warnSpy.mockRestore()
    })
  })

  describe('promotion recovery contract seam (Phase 4.4.0, LOCK-4405/4406)', () => {
    it('re-exports the pure promotion recovery decision contract unchanged', () => {
      expect(startupRecovery.decidePromotionRecovery).toBe(promotionRecovery.decidePromotionRecovery)
      expect(startupRecovery.PROMOTION_CRASH_POINT_MATRIX).toBe(promotionRecovery.PROMOTION_CRASH_POINT_MATRIX)
    })

    it('the seam performs no journal reads or file probing: recovery run touches only the existing cleanups', async () => {
      // The seam consumes a caller-supplied observation; it never reads
      // journal bytes or probes files itself. With no observation it invokes
      // exactly the two existing cleanups and nothing else.
      await recoverOrphanedImportArtifacts()
      expect(recoverOrphanedTempWorkspacesMock).toHaveBeenCalledTimes(1)
      expect(recoverOrphanedCandidatesMock).toHaveBeenCalledTimes(1)
    })
  })
})
