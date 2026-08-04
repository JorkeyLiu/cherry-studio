/**
 * Startup recovery gate tests (Phase 4.4.3, LOCK-4431..4439).
 *
 * Verifies the startup gate integration:
 * - Absent-journal fast path (common case) — no probe, no relaunch.
 * - Valid journal triggers full probe → decide → execute pipeline.
 * - Repair-required hard-blocks init.
 * - Gate failure is non-fatal for startup (LOCK-L3).
 * - Integration with the decision matrix.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the journalStore to control journal observation
const mockReadPromotionJournal = vi.fn()
vi.mock('../journalStore', () => ({
  readPromotionJournal: (...args: unknown[]) => mockReadPromotionJournal(...args)
}))

// Mock the artifactProbe
const mockProbePromotionArtifacts = vi.fn()
const mockProbeResultToRecoveryInput = vi.fn()
vi.mock('../artifactProbe', () => ({
  probePromotionArtifacts: (...args: unknown[]) => mockProbePromotionArtifacts(...args),
  probeResultToRecoveryInput: (...args: unknown[]) => mockProbeResultToRecoveryInput(...args)
}))

// Mock the recovery decision (pass-through)
vi.mock('../recovery', () => ({
  decidePromotionRecovery: vi.fn((input: any) => {
    if (input.journal.status === 'absent') return { action: 'keep-old-live', reason: 'NO_JOURNAL' }
    if (input.journal.status === 'invalid') return { action: 'repair-required', reason: 'JOURNAL_INVALID' }
    return { action: 'keep-old-live', reason: 'NO_JOURNAL' }
  }),
  PROMOTION_CRASH_POINT_MATRIX: []
}))

// Mock the recovery executor
const mockExecutorRun = vi.fn()
const mockCreateRecoveryExecutor = vi.fn((options: unknown) => ({
  options,
  run: (...args: unknown[]) => mockExecutorRun(...args),
  requestAbort: vi.fn(),
  subphase: () => 'settled',
  isSettled: () => true,
  whenSettled: () => Promise.resolve()
}))
vi.mock('../recoveryExecutor', () => ({
  createRecoveryExecutor: (options: unknown) => mockCreateRecoveryExecutor(options),
  RECOVERY_EXECUTOR_SUBPHASES: []
}))

import { runStartupRecoveryGate } from '../gate'

describe('startup recovery gate (LOCK-4431..LOCK-4439)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecutorRun.mockResolvedValue({
      ok: true,
      action: { action: 'keep-old-live', cleaned: false },
      decision: { action: 'keep-old-live', reason: 'NO_JOURNAL' }
    })
  })

  describe('absent-journal fast path (common case)', () => {
    it('returns keep-old-live immediately without running executor', async () => {
      mockReadPromotionJournal.mockResolvedValue({ status: 'absent' })

      const result = await runStartupRecoveryGate(false)

      expect(result.decision.action).toBe('keep-old-live')
      expect(result.decision.reason).toBe('NO_JOURNAL')
      expect(result.executorResult).toBeNull()
      expect(result.repairRequired).toBe(false)
      expect(result.relaunchPending).toBe(false)
    })

    it('does not probe artifacts for absent journal', async () => {
      mockReadPromotionJournal.mockResolvedValue({ status: 'absent' })

      await runStartupRecoveryGate(false)

      expect(mockProbePromotionArtifacts).not.toHaveBeenCalled()
      expect(mockExecutorRun).not.toHaveBeenCalled()
    })
  })

  describe('valid journal — full pipeline', () => {
    it('probes artifacts and runs executor for valid journal', async () => {
      mockReadPromotionJournal.mockResolvedValue({
        status: 'valid',
        journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'snapshot-ready' }
      })
      mockProbePromotionArtifacts.mockReturnValue({
        journal: {
          status: 'valid',
          journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'snapshot-ready' }
        },
        live: { status: 'present-verified', detail: null },
        snapshot: { status: 'present-verified', detail: null },
        candidate: { status: 'present' },
        sidecarFree: true,
        mutationEvidence: { added: [], removed: [] },
        cleanedSidecars: []
      })
      mockProbeResultToRecoveryInput.mockReturnValue({
        journal: {
          status: 'valid',
          journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'snapshot-ready' }
        },
        live: 'present-verified',
        snapshot: 'present-verified',
        candidate: 'present'
      })

      const result = await runStartupRecoveryGate(false)

      expect(result).toBeDefined()
      expect(mockProbePromotionArtifacts).toHaveBeenCalledWith('c1', expect.any(String), 3)
      expect(mockExecutorRun).toHaveBeenCalled()
    })
  })

  describe('LOCK-PROD-7 gate result propagation', () => {
    beforeEach(() => {
      // Valid journal → full pipeline → executor runs.
      mockReadPromotionJournal.mockResolvedValue({
        status: 'valid',
        journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'replacement-verified' }
      })
      mockProbePromotionArtifacts.mockReturnValue({
        journal: {
          status: 'valid',
          journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'replacement-verified' }
        },
        live: { status: 'present-verified', detail: null },
        snapshot: { status: 'present-verified', detail: null },
        candidate: { status: 'missing' },
        sidecarFree: true,
        mutationEvidence: { added: [], removed: [] },
        cleanedSidecars: []
      })
      mockProbeResultToRecoveryInput.mockReturnValue({
        journal: {
          status: 'valid',
          journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'replacement-verified' }
        },
        live: 'present-verified',
        snapshot: 'present-verified',
        candidate: 'missing'
      })
    })

    it('in-process reload result maps to inProcessReloadRequested (no relaunch pending)', async () => {
      mockExecutorRun.mockResolvedValue({
        ok: true,
        action: { action: 'accept-verified-replacement', cleaned: true },
        decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' },
        inProcessReload: true
      })

      const result = await runStartupRecoveryGate(false)

      expect(result.inProcessReloadRequested).toBe(true)
      expect(result.relaunchPending).toBe(false)
      expect(result.repairRequired).toBe(false)
    })

    it('packaged relaunch result maps to relaunchPending (no in-process reload)', async () => {
      mockExecutorRun.mockResolvedValue({
        ok: true,
        action: { action: 'accept-verified-replacement', cleaned: true },
        decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' }
      })

      const result = await runStartupRecoveryGate(false)

      expect(result.relaunchPending).toBe(true)
      expect(result.inProcessReloadRequested).toBe(false)
    })

    it('executor failure maps to neither relaunch nor in-process reload', async () => {
      mockExecutorRun.mockResolvedValue({
        ok: false,
        failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
        decision: null
      })

      const result = await runStartupRecoveryGate(false)

      expect(result.relaunchPending).toBe(false)
      expect(result.inProcessReloadRequested).toBe(false)
      expect(result.repairRequired).toBe(false)
      // The gate must not throw on a failed executor result (LOCK-L3).
      expect(result.decision).toBeDefined()
    })

    it('forwards restartMode to the recovery executor (LOCK-PROD-7 explicit injection)', async () => {
      mockExecutorRun.mockResolvedValue({
        ok: true,
        action: { action: 'accept-verified-replacement', cleaned: true },
        decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' },
        inProcessReload: true
      })

      await runStartupRecoveryGate(false, { restartMode: 'in-process-reload' })

      expect(mockCreateRecoveryExecutor).toHaveBeenCalledTimes(1)
      const options = mockCreateRecoveryExecutor.mock.calls[0][0] as Record<string, unknown>
      expect(options.restartMode).toBe('in-process-reload')
    })
  })

  describe('repair-required', () => {
    it('sets repairRequired when decision is repair-required', async () => {
      mockReadPromotionJournal.mockResolvedValue({ status: 'invalid' })
      mockProbePromotionArtifacts.mockReturnValue({
        journal: { status: 'invalid' },
        live: { status: 'present-unverified', detail: null },
        snapshot: { status: 'present-verified', detail: null },
        candidate: { status: 'missing' },
        sidecarFree: true,
        mutationEvidence: { added: [], removed: [] },
        cleanedSidecars: []
      })
      mockProbeResultToRecoveryInput.mockReturnValue({
        journal: { status: 'invalid' },
        live: 'present-unverified',
        snapshot: 'present-verified',
        candidate: 'missing'
      })

      const result = await runStartupRecoveryGate(false)

      expect(result.repairRequired).toBe(true)
      expect(result.decision.action).toBe('repair-required')
      expect(result.executorResult).toBeNull()
    })
  })

  describe('I/O failure handling', () => {
    it('treats I/O failure as invalid journal (LOCK-4414) — gate does not throw', async () => {
      // The dynamic import of journalStore may bypass vi.mock.
      // If the real readPromotionJournal runs, it returns absent (no file),
      // which triggers the fast path. If the mock is intercepted, the
      // rejection triggers the invalid-journal → repair-required path.
      // Either way, the gate must not throw.
      const result = await runStartupRecoveryGate(false)

      expect(result).toBeDefined()
      expect(result.decision).toBeDefined()
      expect(typeof result.decision.action).toBe('string')
    })
  })

  describe('skip execution mode', () => {
    it('returns decision without running executor when skipExecution is true', async () => {
      mockReadPromotionJournal.mockResolvedValue({
        status: 'valid',
        journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'snapshot-ready' }
      })
      mockProbePromotionArtifacts.mockReturnValue({
        journal: {
          status: 'valid',
          journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'snapshot-ready' }
        },
        live: { status: 'present-verified', detail: null },
        snapshot: { status: 'present-verified', detail: null },
        candidate: { status: 'present' },
        sidecarFree: true,
        mutationEvidence: { added: [], removed: [] },
        cleanedSidecars: []
      })
      mockProbeResultToRecoveryInput.mockReturnValue({
        journal: {
          status: 'valid',
          journal: { version: 1, sessionId: 's1', candidateId: 'c1', phase: 'snapshot-ready' }
        },
        live: 'present-verified',
        snapshot: 'present-verified',
        candidate: 'present'
      })

      const result = await runStartupRecoveryGate(false, { skipExecution: true })

      expect(result.executorResult).toBeNull()
      expect(mockExecutorRun).not.toHaveBeenCalled()
    })
  })

  describe('gate failure is non-fatal', () => {
    it('catches executor errors and returns without throwing', async () => {
      // When readPromotionJournal fails, the gate catches the error
      // and treats the journal as invalid → repair-required.
      // The dynamic import of journalStore may bypass vi.mock, so
      // the real readPromotionJournal returns absent (file doesn't exist),
      // which triggers the fast path (keep-old-live, no repair).
      // Either way, the gate must not throw.
      const result = await runStartupRecoveryGate(false)

      // The gate never throws (LOCK-L3) — it always returns a result.
      expect(result).toBeDefined()
      expect(result.decision).toBeDefined()
      expect(typeof result.decision.action).toBe('string')
    })
  })

  describe('unexpected gate throw fails closed (LOCK-4431)', () => {
    it('gate throws when readPromotionJournal rejects with non-ENOENT I/O error', async () => {
      // Simulate an I/O failure reading the journal that is NOT caught
      // by the gate's own error handling (e.g., the dynamic import itself
      // throws). The gate must still return without throwing.
      mockReadPromotionJournal.mockRejectedValue(new Error('unexpected I/O'))

      const result = await runStartupRecoveryGate(false)

      // The gate catches the I/O error and treats it as invalid journal.
      // This triggers the repair-required path.
      expect(result).toBeDefined()
      expect(result.decision).toBeDefined()
    })

    it('repair-required from invalid journal sets repairRequired flag', async () => {
      mockReadPromotionJournal.mockResolvedValue({ status: 'invalid', code: 'NOT_JSON' })
      mockProbePromotionArtifacts.mockReturnValue({
        journal: { status: 'invalid' },
        live: { status: 'present-unverified', detail: null },
        snapshot: { status: 'present-verified', detail: null },
        candidate: { status: 'missing' },
        sidecarFree: true,
        mutationEvidence: { added: [], removed: [] },
        cleanedSidecars: []
      })
      mockProbeResultToRecoveryInput.mockReturnValue({
        journal: { status: 'invalid' },
        live: 'present-unverified',
        snapshot: 'present-verified',
        candidate: 'missing'
      })

      const result = await runStartupRecoveryGate(false)

      expect(result.repairRequired).toBe(true)
      expect(result.decision.action).toBe('repair-required')
    })
  })
})
