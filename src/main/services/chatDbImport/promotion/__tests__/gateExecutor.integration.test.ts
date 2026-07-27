/**
 * Gate→Executor integration test with real filesystem (Phase 4.4.3).
 *
 * LOCK-4436/4437/4438: tests the full pipeline from journal write/read
 * through decision/action/cleanup with real temp FS, mocking only
 * relaunch/Electron lifecycle and artifact probe (which needs real SQLite).
 *
 * This test verifies:
 * - Real journal write (durable, crash-safe ordering)
 * - Real journal read (strict three-state)
 * - Real decision matrix applied to observations
 * - Real cleanup removes journal, retains snapshot
 * - Relaunch is mocked; cleanup succeeds before relaunch
 * - Repair-required writes durable marker via injected primitive
 */

import * as realFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Unmock real filesystem modules for integration test
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

// Mock @main/config to inject temp data root
vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

import { resetSharedMaintenanceCoordinatorForTests } from '@main/services/chatDb/maintenanceCoordination'

import type { PromotionArtifactProbesResult } from '../artifactProbe'
import { type PromotionJournalV1 } from '../journal'
import {
  advancePromotionJournalToCandidateInstalled,
  advancePromotionJournalToReplacementVerified,
  cleanupPromotionJournalAfterCandidateInstalled,
  getPromotionJournalPath,
  readPromotionJournal,
  writeSnapshotReadyPromotionJournal
} from '../journalStore'
import { decidePromotionRecovery } from '../recovery'
import { createRecoveryExecutor } from '../recoveryExecutor'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDataRoot(): string {
  return realFs.mkdtempSync(path.join(os.tmpdir(), 'cherry-gate-executor-integration-'))
}

function rmrf(dir: string): void {
  try {
    realFs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

const VALID_SNAPSHOT_READY: PromotionJournalV1 = {
  version: 1,
  sessionId: 'integration-session-001',
  candidateId: 'candidate-integration-001',
  phase: 'snapshot-ready'
}

const VALID_CANDIDATE_INSTALLED: PromotionJournalV1 = {
  version: 1,
  sessionId: 'integration-session-001',
  candidateId: 'candidate-integration-001',
  phase: 'candidate-installed'
}

const VALID_REPLACEMENT_VERIFIED: PromotionJournalV1 = {
  version: 1,
  sessionId: 'integration-session-001',
  candidateId: 'candidate-integration-001',
  phase: 'replacement-verified'
}

function snapshotReadyWithLiveProbes(): PromotionArtifactProbesResult {
  return {
    journal: { status: 'valid', journal: VALID_SNAPSHOT_READY },
    live: { status: 'present-verified', detail: null },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'present' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

function replacementVerifiedWithVerifiedLiveProbes(): PromotionArtifactProbesResult {
  return {
    journal: { status: 'valid', journal: VALID_REPLACEMENT_VERIFIED },
    live: { status: 'present-verified', detail: null },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'missing' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

function invalidJournalProbes(): PromotionArtifactProbesResult {
  return {
    journal: { status: 'invalid' },
    live: { status: 'present-unverified', detail: null },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'missing' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gate→executor integration (real FS)', () => {
  let dataRoot: string
  const retainedSnapshotSentinel = 'retained-snapshot-bytes-for-integration'

  beforeEach(() => {
    vi.clearAllMocks()
    resetSharedMaintenanceCoordinatorForTests()
    dataRoot = makeDataRoot()
  })

  afterEach(() => {
    rmrf(dataRoot)
    vi.restoreAllMocks()
  })

  describe('snapshot-ready journal + live present → keep-old-live + real cleanup', () => {
    it('real journal write → read → decision → cleanup → snapshot retained', async () => {
      // 1. Seed retained snapshot (must survive cleanup)
      const snapshotPath = path.join(dataRoot, 'chat.db.pre-import-backup')
      realFs.writeFileSync(snapshotPath, retainedSnapshotSentinel)

      // 2. Write a real snapshot-ready journal (durable 6-step ordering)
      await writeSnapshotReadyPromotionJournal(VALID_SNAPSHOT_READY, dataRoot)

      // 3. Verify journal is on disk with correct canonical bytes
      const readResult = await readPromotionJournal(dataRoot)
      expect(readResult.status).toBe('valid')
      if (readResult.status === 'valid') {
        expect(readResult.journal).toEqual(VALID_SNAPSHOT_READY)
        expect(readResult.journal.phase).toBe('snapshot-ready')
      }

      // 4. Run real decision matrix (no mock — pure function)
      const decision = decidePromotionRecovery({
        journal: { status: 'valid', journal: VALID_SNAPSHOT_READY },
        live: 'present-verified',
        snapshot: 'present-verified',
        candidate: 'present'
      })
      expect(decision.action).toBe('keep-old-live')
      expect(decision.reason).toBe('SNAPSHOT_READY_INSTALL_NOT_STARTED')

      // 5. Run executor with mocked probe (returns controlled results)
      //    and mocked relaunch
      const mockRelaunch = vi.fn().mockReturnValue({ ok: true, relaunched: false, reason: 'already-relaunched' })
      const executor = createRecoveryExecutor({
        dataRoot,
        liveDb: { isInitialised: () => true },
        primitives: {
          probe: () => snapshotReadyWithLiveProbes(),
          relaunch: mockRelaunch
        }
      })

      const result = await executor.run()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.action.action).toBe('keep-old-live')
      }

      // 6. Journal cleaned up (real unlink + dir sync)
      const afterCleanup = await readPromotionJournal(dataRoot)
      expect(afterCleanup.status).toBe('absent')
      expect(realFs.existsSync(getPromotionJournalPath(dataRoot))).toBe(false)

      // 7. Retained snapshot untouched
      expect(realFs.existsSync(snapshotPath)).toBe(true)
      expect(realFs.readFileSync(snapshotPath, 'utf8')).toBe(retainedSnapshotSentinel)

      // 8. No relaunch for keep-old-live
      expect(mockRelaunch).not.toHaveBeenCalled()
    })
  })

  describe('candidate-installed journal → restore-rollback decision + real cleanup', () => {
    it('real journal advance → read → decision → real cleanup of candidate-installed journal', async () => {
      // 1. Seed retained snapshot
      const snapshotPath = path.join(dataRoot, 'chat.db.pre-import-backup')
      realFs.writeFileSync(snapshotPath, retainedSnapshotSentinel)

      // 2. Write snapshot-ready journal, then advance to candidate-installed
      await writeSnapshotReadyPromotionJournal(VALID_SNAPSHOT_READY, dataRoot)
      await advancePromotionJournalToCandidateInstalled(VALID_CANDIDATE_INSTALLED, dataRoot)

      // 3. Verify journal is in candidate-installed phase
      const readResult = await readPromotionJournal(dataRoot)
      expect(readResult.status).toBe('valid')
      if (readResult.status === 'valid') {
        expect(readResult.journal.phase).toBe('candidate-installed')
      }

      // 4. Run real decision matrix
      const decision = decidePromotionRecovery({
        journal: { status: 'valid', journal: VALID_CANDIDATE_INSTALLED },
        live: 'present-unverified',
        snapshot: 'present-verified',
        candidate: 'missing'
      })
      expect(decision.action).toBe('restore-rollback-snapshot')
      expect(decision.reason).toBe('CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED')

      // 5. Real cleanup of the candidate-installed journal
      //    (directly via the journalStore API — same code path the executor uses)
      const cleanupResult = await cleanupPromotionJournalAfterCandidateInstalled(
        { sessionId: VALID_CANDIDATE_INSTALLED.sessionId, candidateId: VALID_CANDIDATE_INSTALLED.candidateId },
        dataRoot
      )
      expect(cleanupResult).toEqual({ deleted: true })

      // 6. Journal is absent after real cleanup
      const afterCleanup = await readPromotionJournal(dataRoot)
      expect(afterCleanup.status).toBe('absent')
      expect(realFs.existsSync(getPromotionJournalPath(dataRoot))).toBe(false)

      // 7. Retained snapshot untouched
      expect(realFs.existsSync(snapshotPath)).toBe(true)
      expect(realFs.readFileSync(snapshotPath, 'utf8')).toBe(retainedSnapshotSentinel)
    })
  })

  describe('replacement-verified journal + live verified → accept-verified + real cleanup + relaunch', () => {
    it('real journal advance chain → read → decision → cleanup → relaunch', async () => {
      // 1. Seed retained snapshot
      const snapshotPath = path.join(dataRoot, 'chat.db.pre-import-backup')
      realFs.writeFileSync(snapshotPath, retainedSnapshotSentinel)

      // 2. Write full journal chain: snapshot-ready → candidate-installed → replacement-verified
      await writeSnapshotReadyPromotionJournal(VALID_SNAPSHOT_READY, dataRoot)
      await advancePromotionJournalToCandidateInstalled(VALID_CANDIDATE_INSTALLED, dataRoot)
      await advancePromotionJournalToReplacementVerified(VALID_REPLACEMENT_VERIFIED, dataRoot)

      // 3. Verify journal is in replacement-verified phase
      const readResult = await readPromotionJournal(dataRoot)
      expect(readResult.status).toBe('valid')
      if (readResult.status === 'valid') {
        expect(readResult.journal.phase).toBe('replacement-verified')
      }

      // 4. Run real decision matrix
      const decision = decidePromotionRecovery({
        journal: { status: 'valid', journal: VALID_REPLACEMENT_VERIFIED },
        live: 'present-verified',
        snapshot: 'present-verified',
        candidate: 'missing'
      })
      expect(decision.action).toBe('accept-verified-replacement')
      expect(decision.reason).toBe('REPLACEMENT_VERIFIED_LIVE_VERIFIED')

      // 5. Run executor with mocked relaunch
      const mockRelaunch = vi.fn().mockReturnValue({ ok: true, relaunched: true })
      const executor = createRecoveryExecutor({
        dataRoot,
        liveDb: { isInitialised: () => true },
        primitives: {
          probe: () => replacementVerifiedWithVerifiedLiveProbes(),
          relaunch: mockRelaunch
        }
      })

      const result = await executor.run()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.action.action).toBe('accept-verified-replacement')
      }

      // 6. Journal cleaned up (real unlink)
      const afterCleanup = await readPromotionJournal(dataRoot)
      expect(afterCleanup.status).toBe('absent')

      // 7. Relaunch called after cleanup
      expect(mockRelaunch).toHaveBeenCalledTimes(1)

      // 8. Retained snapshot untouched
      expect(realFs.existsSync(snapshotPath)).toBe(true)
      expect(realFs.readFileSync(snapshotPath, 'utf8')).toBe(retainedSnapshotSentinel)
    })
  })

  describe('invalid journal → repair-required + durable marker + no cleanup', () => {
    it('real invalid journal bytes → decision → marker write → journal preserved', async () => {
      // 1. Write invalid journal bytes
      const journalPath = getPromotionJournalPath(dataRoot)
      realFs.writeFileSync(journalPath, 'not valid json {{{', 'utf8')

      // 2. Run real decision matrix
      const decision = decidePromotionRecovery({
        journal: { status: 'invalid' },
        live: 'present-unverified',
        snapshot: 'present-verified',
        candidate: 'missing'
      })
      expect(decision.action).toBe('repair-required')
      expect(decision.reason).toBe('JOURNAL_INVALID')

      // 3. Run executor with mocked markRepairRequiredBeforeInit
      const mockMarkRepair = vi.fn()
      const executor = createRecoveryExecutor({
        dataRoot,
        liveDb: { isInitialised: () => false },
        primitives: {
          probe: () => invalidJournalProbes(),
          markRepairRequiredBeforeInit: mockMarkRepair
        }
      })

      const result = await executor.run()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.action.action).toBe('repair-required')
        expect((result.action as { action: 'repair-required'; marked: boolean }).marked).toBe(true)
      }

      // 4. markRepairRequiredBeforeInit was called
      expect(mockMarkRepair).toHaveBeenCalledTimes(1)

      // 5. Invalid journal bytes preserved (no cleanup for repair-required)
      expect(realFs.existsSync(journalPath)).toBe(true)
      expect(realFs.readFileSync(journalPath, 'utf8')).toBe('not valid json {{{')
    })
  })

  describe('relaunch failure after real cleanup (LOCK-4438)', () => {
    it('real cleanup succeeds but relaunch returns failure', async () => {
      // 1. Seed retained snapshot
      const snapshotPath = path.join(dataRoot, 'chat.db.pre-import-backup')
      realFs.writeFileSync(snapshotPath, retainedSnapshotSentinel)

      // 2. Write replacement-verified journal
      await writeSnapshotReadyPromotionJournal(VALID_SNAPSHOT_READY, dataRoot)
      await advancePromotionJournalToCandidateInstalled(VALID_CANDIDATE_INSTALLED, dataRoot)
      await advancePromotionJournalToReplacementVerified(VALID_REPLACEMENT_VERIFIED, dataRoot)

      // 3. Mock relaunch to fail
      const mockRelaunch = vi.fn().mockReturnValue({ ok: false, reason: 'receipt-invalid' })

      const executor = createRecoveryExecutor({
        dataRoot,
        liveDb: { isInitialised: () => true },
        primitives: {
          probe: () => replacementVerifiedWithVerifiedLiveProbes(),
          relaunch: mockRelaunch
        }
      })

      const result = await executor.run()

      // 4. Cleanup ran (journal absent) but relaunch failed
      const afterCleanup = await readPromotionJournal(dataRoot)
      expect(afterCleanup.status).toBe('absent')
      expect(mockRelaunch).toHaveBeenCalledTimes(1)

      // 5. Result is RELAUNCH_FAILED
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('RELAUNCH_FAILED')
      }

      // 6. Retained snapshot untouched
      expect(realFs.existsSync(snapshotPath)).toBe(true)
      expect(realFs.readFileSync(snapshotPath, 'utf8')).toBe(retainedSnapshotSentinel)
    })
  })
})
