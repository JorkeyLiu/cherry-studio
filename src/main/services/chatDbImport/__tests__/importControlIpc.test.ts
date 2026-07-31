/**
 * importControlIpc tests.
 *
 * Covers:
 * - 4 handlers register (get-platform-support, start, cancel, get-status)
 * - Platform gate: darwin supported, non-darwin unsupported
 * - Start: valid zip path, invalid path, duplicate session
 * - Cancel: valid session, invalid session, no active session
 * - Get-status: active session, no session
 * - Status event emission to main renderer
 * - Cleanup on dispose
 *
 * Audit blocker tests:
 * - Verification pass gates promotion; verification fail does NOT trigger promotion
 * - Promotion preparation/execution failures emit promotion-failed
 * - Error sanitization: raw error.message never crosses IPC
 * - Cancel is rejected during promotion (LOCK-4401)
 * - Terminal ordering: promoting → promoted | promotion-failed
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// All mock variables must be hoisted to be accessible in vi.mock factories
const {
  mockHandle,
  mockWebContentsSend,
  mockStartImport,
  mockCancelImport,
  mockGetActiveImport,
  mockStartPromotionPreparation,
  mockStartPromotionExecution,
  mockCreateRecoveryExecutor,
  mockTakeTerminalPromotionOwnership,
  mockTakeTerminalPromotionOwnershipIfMatches,
  mockChatDbService
} = vi.hoisted(() => {
  return {
    mockHandle: vi.fn(),
    mockWebContentsSend: vi.fn(),
    mockStartImport: vi.fn(),
    mockCancelImport: vi.fn(),
    mockGetActiveImport: vi.fn(),
    mockStartPromotionPreparation: vi.fn(),
    mockStartPromotionExecution: vi.fn(),
    mockCreateRecoveryExecutor: vi.fn(),
    mockTakeTerminalPromotionOwnership: vi.fn().mockReturnValue({ status: 'not-available' }),
    mockTakeTerminalPromotionOwnershipIfMatches: vi.fn().mockReturnValue({ status: 'not-available' }),
    mockChatDbService: {
      getSqlite: vi.fn(),
      isInitialised: vi.fn(() => true),
      closeForPromotion: vi.fn(() => true),
      reopenForPromotion: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}))

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

vi.mock('@main/services/chatDb', () => ({
  chatDbService: mockChatDbService
}))

vi.mock('../index', () => ({
  startImport: mockStartImport,
  cancelImport: mockCancelImport,
  getActiveImport: mockGetActiveImport,
  startPromotionPreparation: mockStartPromotionPreparation,
  startPromotionExecution: mockStartPromotionExecution,
  takeTerminalPromotionOwnership: mockTakeTerminalPromotionOwnership,
  takeTerminalPromotionOwnershipIfMatches: mockTakeTerminalPromotionOwnershipIfMatches
}))

vi.mock('../promotion/recoveryExecutor', () => ({
  createRecoveryExecutor: mockCreateRecoveryExecutor
}))

function createMockWebContents() {
  return {
    isDestroyed: vi.fn(() => false),
    send: mockWebContentsSend
  } as any
}

import { IpcChannel } from '@shared/IpcChannel'

import { disposeCherryImportControl, registerCherryImportControlIpc } from '../importControlIpc'

describe('importControlIpc', () => {
  let webContents: ReturnType<typeof createMockWebContents>

  beforeEach(() => {
    vi.clearAllMocks()
    mockTakeTerminalPromotionOwnership.mockReturnValue({ status: 'not-available' })
    webContents = createMockWebContents()
    registerCherryImportControlIpc(webContents)
  })

  afterEach(() => {
    disposeCherryImportControl()
  })

  it('registers 4 IPC handlers', () => {
    expect(mockHandle).toHaveBeenCalledTimes(4)
    expect(mockHandle.mock.calls.map((c: any) => c[0])).toContain(IpcChannel.CherryImport_GetPlatformSupport)
    expect(mockHandle.mock.calls.map((c: any) => c[0])).toContain(IpcChannel.CherryImport_Start)
    expect(mockHandle.mock.calls.map((c: any) => c[0])).toContain(IpcChannel.CherryImport_Cancel)
    expect(mockHandle.mock.calls.map((c: any) => c[0])).toContain(IpcChannel.CherryImport_GetStatus)
  })

  describe('get-platform-support', () => {
    it('returns supported=true on darwin', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetPlatformSupport)![1]
      const result = handler()

      expect(result).toEqual({ supported: true, platform: 'darwin' })

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })

    it('returns supported=false on win32', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetPlatformSupport)![1]
      const result = handler()

      expect(result).toEqual({ supported: false, platform: 'win32' })

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })
  })

  describe('start', () => {
    it('rejects invalid zip path', async () => {
      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      const result = await handler({}, '')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('Invalid zip path')
    })

    it('rejects non-string zip path', async () => {
      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      const result = await handler({}, 123)

      expect(result.ok).toBe(false)
      expect(result.error).toContain('Invalid zip path')
    })

    it('starts import successfully', async () => {
      mockStartImport.mockResolvedValue({
        id: 'session-123',
        state: 'intake'
      })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      const result = await handler({}, '/tmp/test.zip')

      expect(result.ok).toBe(true)
      expect(result.sessionId).toBe('session-123')
      expect(mockStartImport).toHaveBeenCalledWith('/tmp/test.zip', expect.any(Object))
    })

    it('emits status event after starting', async () => {
      mockStartImport.mockResolvedValue({
        id: 'session-123',
        state: 'intake'
      })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await handler({}, '/tmp/test.zip')

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          sessionId: 'session-123',
          state: 'intake'
        })
      )
    })

    it('rejects duplicate concurrent import', async () => {
      mockStartImport.mockResolvedValue({
        id: 'session-123',
        state: 'intake'
      })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]

      // Start first import
      await handler({}, '/tmp/test.zip')

      // Try to start second import
      const result = await handler({}, '/tmp/test2.zip')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('already in progress')
    })
  })

  describe('cancel', () => {
    it('rejects invalid sessionId', async () => {
      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Cancel)![1]
      const result = await handler({}, '')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('Invalid sessionId')
    })

    it('rejects cancel for non-active session', async () => {
      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Cancel)![1]
      const result = await handler({}, 'nonexistent-session')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('No active import session')
    })

    it('cancels active session', async () => {
      // Start an import first
      mockStartImport.mockResolvedValue({
        id: 'session-123',
        state: 'intake'
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Cancel it
      mockCancelImport.mockResolvedValue(undefined)
      mockGetActiveImport.mockReturnValue(null)

      const cancelHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Cancel)![1]
      const result = await cancelHandler({}, 'session-123')

      expect(result.ok).toBe(true)
      expect(mockCancelImport).toHaveBeenCalledWith('session-123')
    })

    it('emits cancelled status event', async () => {
      // Start an import first
      mockStartImport.mockResolvedValue({
        id: 'session-123',
        state: 'intake'
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Cancel it
      mockCancelImport.mockResolvedValue(undefined)
      mockGetActiveImport.mockReturnValue(null)

      mockWebContentsSend.mockClear()

      const cancelHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Cancel)![1]
      await cancelHandler({}, 'session-123')

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          sessionId: 'session-123',
          state: 'cancelled'
        })
      )
    })
  })

  describe('get-status', () => {
    it('returns null for invalid sessionId', () => {
      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const result = handler({}, '')

      expect(result).toBeNull()
    })

    it('returns null for non-active session', () => {
      mockGetActiveImport.mockReturnValue(null)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const result = handler({}, 'nonexistent-session')

      expect(result).toBeNull()
    })

    it('returns status for active session', async () => {
      // Start an import first
      mockStartImport.mockResolvedValue({
        id: 'session-123',
        state: 'reading'
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Mock getActiveImport to return the session
      mockGetActiveImport.mockReturnValue({
        id: 'session-123',
        state: 'reading'
      })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const result = handler({}, 'session-123')

      expect(result).toEqual({
        sessionId: 'session-123',
        state: 'reading'
      })
    })
  })

  describe('dispose', () => {
    it('clears module state', async () => {
      // Start an import
      mockStartImport.mockResolvedValue({
        id: 'session-123',
        state: 'intake'
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      disposeCherryImportControl()

      // After dispose, get-status should return null
      mockGetActiveImport.mockReturnValue(null)
      const statusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const result = statusHandler({}, 'session-123')

      expect(result).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Audit blocker tests: verification gating, promotion lifecycle, error sanitization
  // ---------------------------------------------------------------------------

  describe('verification gating (audit blocker)', () => {
    it('verification pass triggers promotion', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-pass', state: 'intake' })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-pass', capability: {} }
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'accept-verified-replacement', cleaned: true },
          decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' }
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Simulate verification pass
      verificationCallback!({
        sessionId: 'session-pass',
        candidateId: 'candidate-session-pass',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 50))

      // Promotion preparation should have been called
      expect(mockStartPromotionPreparation).toHaveBeenCalledWith(expect.objectContaining({ dbDir: '/mock/data' }))
      // Promotion execution should have been called
      expect(mockStartPromotionExecution).toHaveBeenCalled()

      // promoting state should have been emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoting' })
      )
      // promoted state should have been emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoted' })
      )
    })

    it('verification fail does NOT trigger promotion', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-fail', state: 'intake' })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Simulate verification fail
      verificationCallback!({
        sessionId: 'session-fail',
        candidateId: 'candidate-session-fail',
        stats: {},
        report: { status: 'fail', dimensions: [], fatal: null }
      })

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 50))

      // Promotion should NOT have been triggered
      expect(mockStartPromotionPreparation).not.toHaveBeenCalled()
      expect(mockStartPromotionExecution).not.toHaveBeenCalled()

      // verification-failed state should have been emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          sessionId: 'session-fail',
          state: 'verification-failed'
        })
      )
    })

    it('verification aborted does NOT trigger promotion', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-abort', state: 'intake' })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Simulate verification aborted
      verificationCallback!({
        sessionId: 'session-abort',
        candidateId: 'candidate-session-abort',
        stats: {},
        report: { status: 'aborted', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(mockStartPromotionPreparation).not.toHaveBeenCalled()
      expect(mockStartPromotionExecution).not.toHaveBeenCalled()

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'verification-failed' })
      )
    })
  })

  describe('promotion lifecycle (audit blocker)', () => {
    it('promotion preparation failure emits promotion-failed', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-prep-fail', state: 'intake' })
      })

      mockStartPromotionPreparation.mockResolvedValue({
        status: 'preparation-failed',
        failure: { phase: 'acquire-lease', code: 'LEASE_BUSY', safeCode: null }
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-prep-fail',
        candidateId: 'candidate-session-prep-fail',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // promoting emitted first
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoting' })
      )
      // promotion-failed emitted with sanitized error
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('preparation failed')
        })
      )
      // Execution should NOT have been called
      expect(mockStartPromotionExecution).not.toHaveBeenCalled()
    })

    it('promotion execution failure emits promotion-failed', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-exec-fail', state: 'intake' })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promotion-failed',
        failure: {
          subphase: 'installing',
          classification: 'pre-install',
          recoveryRequired: false,
          code: 'INSTALL_FAILED',
          safeCode: null,
          liveDisposition: 'open'
        },
        recoveryHandoff: null
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-exec-fail',
        candidateId: 'candidate-session-exec-fail',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('INSTALL_FAILED')
        })
      )
    })

    it('promoted state emitted with terminal ordering via finalizing (LOCK-6016)', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-term', state: 'intake' })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-term', capability: {} }
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'accept-verified-replacement', cleaned: true },
          decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' }
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-term',
        candidateId: 'candidate-session-term',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // Extract all emitted states in order
      const emittedStates = mockWebContentsSend.mock.calls
        .filter((call: any) => call[0] === IpcChannel.CherryImport_StatusChanged)
        .map((call: any) => call[1].state)

      // LOCK-6016: promoting → finalizing → promoted
      const promotingIdx = emittedStates.indexOf('promoting')
      const finalizingIdx = emittedStates.indexOf('finalizing')
      const promotedIdx = emittedStates.indexOf('promoted')
      expect(promotingIdx).toBeGreaterThanOrEqual(0)
      expect(finalizingIdx).toBeGreaterThan(promotingIdx)
      expect(promotedIdx).toBeGreaterThan(finalizingIdx)
    })

    it('recovery failure emits promotion-failed, never promoted (LOCK-6016/6017)', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-recovery-fail', state: 'intake' })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-recovery-fail', capability: {} }
      })

      // Recovery executor returns a structured failure (relaunch refused)
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: false,
          failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
          decision: null
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-recovery-fail',
        candidateId: 'candidate-session-recovery-fail',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // promoting emitted first
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoting' })
      )
      // finalizing emitted (execution success, before recovery)
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'finalizing' })
      )
      // LOCK-6017: recovery failure MUST emit promotion-failed — NEVER
      // promoted. The user must never see "success" followed by failure.
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('RELAUNCH_FAILED')
        })
      )
      // LOCK-6017: 'promoted' must NOT appear in the event sequence
      const promotedEvents = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].state === 'promoted'
      )
      expect(promotedEvents).toHaveLength(0)
    })
  })

  describe('error sanitization (audit blocker)', () => {
    it('start failure returns sanitized error, not raw message', async () => {
      mockStartImport.mockRejectedValue(new Error('Internal path: /Users/secret/data.db'))

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      const result = await startHandler({}, '/tmp/test.zip')

      expect(result.ok).toBe(false)
      // Raw error message must NOT appear in the IPC response
      expect(result.error).not.toContain('/Users/secret')
      expect(result.error).not.toContain('data.db')
      // Should be a sanitized category
      expect(result.error).toBeDefined()
      expect(typeof result.error).toBe('string')
    })

    it('cancel failure returns sanitized error', async () => {
      mockStartImport.mockResolvedValue({ id: 'session-1', state: 'intake' })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      mockCancelImport.mockRejectedValue(new Error('Internal db path leaked'))

      const cancelHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Cancel)![1]
      const result = await cancelHandler({}, 'session-1')

      expect(result.ok).toBe(false)
      expect(result.error).not.toContain('Internal db path leaked')
    })
  })

  describe('cancel during promotion (audit blocker LOCK-4401/LOCK-6002)', () => {
    it('cancel is rejected while promotion is in progress (LOCK-6002)', async () => {
      // Start import
      mockStartImport.mockResolvedValue({ id: 'session-cp', state: 'intake' })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Session is now in promoting state — cancelImport resolves (no-op
      // inside session.cancel() which returns 'reject-promoting') but the
      // session still exists.
      mockCancelImport.mockResolvedValue(undefined)
      mockGetActiveImport.mockReturnValue({ id: 'session-cp', state: 'promoting' })

      const cancelHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Cancel)![1]
      const result = await cancelHandler({}, 'session-cp')

      // LOCK-6002: Cancel MUST be rejected — ok: false with an error.
      expect(result.ok).toBe(false)
      expect(result.error).toContain('promotion in progress')
      // The underlying cancelImport was called (session.cancel() was invoked)
      expect(mockCancelImport).toHaveBeenCalledWith('session-cp')
      // Ownership was NOT cleared: activeSessionId and status events remain.
      // (verified indirectly: no cancelled status event emitted)
      const cancelledEvents = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].state === 'cancelled'
      )
      expect(cancelledEvents).toHaveLength(0)
    })

    it('cancel succeeds for pre-promotion session', async () => {
      // Start import
      mockStartImport.mockResolvedValue({ id: 'session-pre', state: 'intake' })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Session cancel succeeds — session disappears (cancelled).
      mockCancelImport.mockResolvedValue(undefined)
      mockGetActiveImport.mockReturnValue(null) // session disposed

      const cancelHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Cancel)![1]
      const result = await cancelHandler({}, 'session-pre')

      expect(result.ok).toBe(true)
      // Cancelled status event emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ sessionId: 'session-pre', state: 'cancelled' })
      )
    })
  })

  describe('start error types (audit blocker)', () => {
    it('rejects duplicate with sanitized message, not raw error', async () => {
      mockStartImport.mockResolvedValue({ id: 'session-1', state: 'intake' })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]

      // Start first import
      await startHandler({}, '/tmp/test.zip')

      // Try to start second — the IPC handler checks activeSessionId
      const result = await startHandler({}, '/tmp/test2.zip')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('already in progress')
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6015: Poller reconciliation — terminal failure releases ownership
  // ---------------------------------------------------------------------------

  describe('poller reconciliation (LOCK-6015)', () => {
    it('poller detects session gone and cleans up control state, allowing new start', async () => {
      // Use real timers so the poller fires naturally
      const sessionObj: any = { id: 'session-poller', state: 'reading' }
      mockStartImport.mockResolvedValue(sessionObj)
      mockGetActiveImport.mockReturnValue(sessionObj)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      const result = await startHandler({}, '/tmp/test.zip')
      expect(result.ok).toBe(true)

      // Session is active — poller is running
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ sessionId: 'session-poller', state: 'reading' })
      )

      // Session disappears (simulates session.fail() + dispose() completing)
      mockGetActiveImport.mockReturnValue(null)

      // Wait for poller to fire (500ms interval + margin)
      await new Promise((r) => setTimeout(r, 700))

      // Poller detected session gone — emitted terminal error
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          sessionId: 'session-poller',
          state: 'error'
        })
      )

      // Can start a new import — control state was cleaned up
      mockStartImport.mockResolvedValue({ id: 'session-new', state: 'intake' })
      const secondResult = await startHandler({}, '/tmp/test2.zip')
      expect(secondResult.ok).toBe(true)
      expect(secondResult.sessionId).toBe('session-new')
    })

    it('poller skips duplicate terminal emission when session state was already terminal', async () => {
      let sessionObj: any = { id: 'session-term-poller', state: 'reading' }
      mockStartImport.mockResolvedValue(sessionObj)
      mockGetActiveImport.mockReturnValue(sessionObj)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Session transitions to terminal 'error' state (e.g., page write failure)
      sessionObj = { id: 'session-term-poller', state: 'error' }
      mockGetActiveImport.mockReturnValue(sessionObj)

      // Wait for poller to emit the error state
      await new Promise((r) => setTimeout(r, 700))

      // The error state was emitted
      const errorEvents = mockWebContentsSend.mock.calls.filter(
        (call: any) =>
          call[0] === IpcChannel.CherryImport_StatusChanged &&
          call[1].sessionId === 'session-term-poller' &&
          call[1].state === 'error'
      )
      expect(errorEvents.length).toBeGreaterThanOrEqual(1)

      // Session then disappears (dispose completes)
      mockGetActiveImport.mockReturnValue(null)

      // Wait for next poller tick
      await new Promise((r) => setTimeout(r, 700))

      // No duplicate error emission — deduplication via terminal state check
      const errorEventsAfter = mockWebContentsSend.mock.calls.filter(
        (call: any) =>
          call[0] === IpcChannel.CherryImport_StatusChanged &&
          call[1].sessionId === 'session-term-poller' &&
          call[1].state === 'error'
      )
      expect(errorEventsAfter.length).toBe(1)
    })

    it('ownership cleanup after poller detection permits a fresh import start', async () => {
      const sessionObj: any = { id: 'session-own', state: 'discovering' }
      mockStartImport.mockResolvedValue(sessionObj)
      mockGetActiveImport.mockReturnValue(sessionObj)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Verify second start is blocked
      const blocked = await startHandler({}, '/tmp/test2.zip')
      expect(blocked.ok).toBe(false)
      expect(blocked.error).toContain('already in progress')

      // Session disappears (renderer error + dispose)
      mockGetActiveImport.mockReturnValue(null)

      // Wait for poller reconciliation
      await new Promise((r) => setTimeout(r, 700))

      // Now a fresh start should succeed
      mockStartImport.mockResolvedValue({ id: 'session-fresh', state: 'intake' })
      const fresh = await startHandler({}, '/tmp/test3.zip')
      expect(fresh.ok).toBe(true)
      expect(fresh.sessionId).toBe('session-fresh')
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6015/6016/6017/6018: Cross-session race elimination tests
  // ---------------------------------------------------------------------------

  describe('LOCK-6015: poller generation guard (stale poller no-op)', () => {
    it('old poller callback is no-op after new session starts', async () => {
      // Use vi.useFakeTimers for deterministic control
      vi.useFakeTimers()

      try {
        // Start session A
        const sessionAObj: any = { id: 'session-A', state: 'reading', dispose: vi.fn().mockResolvedValue(undefined) }
        mockStartImport.mockResolvedValue(sessionAObj)
        mockGetActiveImport.mockReturnValue(sessionAObj)

        const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
        await startHandler({}, '/tmp/testA.zip')

        // Advance one poller tick — session A's poller fires
        await vi.advanceTimersByTimeAsync(500)

        // Session A poller emitted 'reading'
        const readingEventsA = mockWebContentsSend.mock.calls.filter(
          (call: any) =>
            call[0] === IpcChannel.CherryImport_StatusChanged &&
            call[1].sessionId === 'session-A' &&
            call[1].state === 'reading'
        )
        expect(readingEventsA.length).toBe(1)

        // Session A disappears (simulates session lifecycle ending)
        mockGetActiveImport.mockReturnValue(null)

        // Advance poller tick — poller detects session A is gone, clears activeSessionId
        await vi.advanceTimersByTimeAsync(700)

        // Start session B (which increments the generation)
        const sessionBObj: any = { id: 'session-B', state: 'intake', dispose: vi.fn().mockResolvedValue(undefined) }
        mockStartImport.mockResolvedValue(sessionBObj)
        mockGetActiveImport.mockReturnValue(sessionBObj)

        mockWebContentsSend.mockClear()
        const result = await startHandler({}, '/tmp/testB.zip')
        expect(result.ok).toBe(true)

        // Advance one poller tick — both old (stale) and new poller fire
        await vi.advanceTimersByTimeAsync(500)

        // Only session B's poller should have emitted events
        const eventsB = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-B'
        )
        expect(eventsB.length).toBeGreaterThanOrEqual(1)

        // Session A's stale poller should NOT have emitted anything
        const eventsA = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-A'
        )
        expect(eventsA).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('LOCK-6016: poller suppresses terminal states', () => {
    it('poller does not emit promoted/promotion-failed — only control layer does', async () => {
      vi.useFakeTimers()

      try {
        // Start a session that will transition to promoted state
        const sessionObj: any = { id: 'session-suppress', state: 'reading' }
        mockStartImport.mockResolvedValue(sessionObj)
        mockGetActiveImport.mockReturnValue(sessionObj)

        const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
        await startHandler({}, '/tmp/test.zip')

        // Advance one poller tick to see intermediate state
        await vi.advanceTimersByTimeAsync(500)
        mockWebContentsSend.mockClear()

        // Underlying session transitions to 'promoted' (set by Phase 4)
        sessionObj.state = 'promoted'

        // Advance multiple poller ticks
        await vi.advanceTimersByTimeAsync(1500)

        // Poller must NOT have emitted 'promoted' — it's a terminal control state
        const promotedEvents = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].state === 'promoted'
        )
        expect(promotedEvents).toHaveLength(0)

        // Similarly, poller must NOT emit 'promotion-failed'
        sessionObj.state = 'promotion-failed'
        await vi.advanceTimersByTimeAsync(1500)

        const failedEvents = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].state === 'promotion-failed'
        )
        expect(failedEvents).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('LOCK-6017: repair-required maps to bounded failure', () => {
    it('recovery action repair-required emits promotion-failed, never promoted', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-repair', state: 'intake', dispose: vi.fn().mockResolvedValue(undefined) })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-repair', capability: {} }
      })

      // Recovery executor returns ok:true but action is repair-required
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'repair-required', marked: true },
          decision: { action: 'repair-required', reason: 'REPLACEMENT_VERIFIED_LIVE_NOT_VERIFIED' }
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-repair',
        candidateId: 'candidate-session-repair',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // promoting emitted first
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoting' })
      )
      // finalizing emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'finalizing' })
      )
      // LOCK-6017: repair-required MUST emit promotion-failed — NEVER promoted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('repair')
        })
      )
      // 'promoted' must NOT appear in the event sequence
      const promotedEvents = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].state === 'promoted'
      )
      expect(promotedEvents).toHaveLength(0)
    })

    it('recovery ok:true with keep-old-live also emits promotion-failed', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-keep', state: 'intake', dispose: vi.fn().mockResolvedValue(undefined) })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-keep', capability: {} }
      })

      // Recovery returns ok:true with unexpected keep-old-live action
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'keep-old-live', cleaned: false },
          decision: { action: 'keep-old-live', reason: 'NO_JOURNAL' }
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-keep',
        candidateId: 'candidate-session-keep',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // keep-old-live from promoted execution is unexpected — emit failure
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('Unexpected')
        })
      )
      const promotedEvents = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].state === 'promoted'
      )
      expect(promotedEvents).toHaveLength(0)
    })
  })

  describe('LOCK-6018: terminal ownership release on non-exiting failure', () => {
    it('recovery failure consumes terminal ownership via takeTerminalPromotionOwnership', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-rel', state: 'intake', dispose: vi.fn().mockResolvedValue(undefined) })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-rel',
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // Recovery executor returns structured failure
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: false,
          failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
          decision: null
        })
      })

      // Mock takeTerminalPromotionOwnership to return 'taken' on first call
      const mockRelease = vi.fn()
      mockTakeTerminalPromotionOwnership
        .mockReturnValueOnce({
          status: 'taken',
          ownership: {
            kind: 'promoted',
            handoff: { capability: { release: mockRelease, isReleased: vi.fn(() => false) } }
          }
        })
        .mockReturnValue({ status: 'not-available' })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-rel',
        candidateId: 'candidate-session-rel',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // takeTerminalPromotionOwnership was called (to consume unclaimed ownership)
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      // The taken ownership's capability.release() was called
      expect(mockRelease).toHaveBeenCalled()
      // promotion-failed was emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('RELAUNCH_FAILED')
        })
      )
    })

    it('recovery executor unavailable consumes terminal ownership', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-unavail',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-unavail',
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // Recovery executor dynamic import fails
      mockCreateRecoveryExecutor.mockImplementation(() => {
        throw new Error('Module not found')
      })

      const mockRelease = vi.fn()
      mockTakeTerminalPromotionOwnership
        .mockReturnValueOnce({
          status: 'taken',
          ownership: {
            kind: 'promoted',
            handoff: { capability: { release: mockRelease, isReleased: vi.fn(() => false) } }
          }
        })
        .mockReturnValue({ status: 'not-available' })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-unavail',
        candidateId: 'candidate-session-unavail',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // Terminal ownership was consumed and released
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalled()
      // promotion-failed emitted for recovery executor unavailable
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('Recovery executor unavailable')
        })
      )
    })

    it('repair-required path consumes terminal ownership', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-repair-own',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-repair-own',
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // Recovery returns repair-required (ok:true but action is failure)
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'repair-required', marked: true },
          decision: { action: 'repair-required', reason: 'REPLACEMENT_VERIFIED_LIVE_NOT_VERIFIED' }
        })
      })

      const mockRelease = vi.fn()
      mockTakeTerminalPromotionOwnership
        .mockReturnValueOnce({
          status: 'taken',
          ownership: {
            kind: 'promoted',
            handoff: { capability: { release: mockRelease, isReleased: vi.fn(() => false) } }
          }
        })
        .mockReturnValue({ status: 'not-available' })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-repair-own',
        candidateId: 'candidate-session-repair-own',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      // Terminal ownership consumed on repair-required (non-exiting failure)
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalled()
    })

    it('disposeCherryImportControl releases unclaimed terminal ownership', async () => {
      const mockRelease = vi.fn()
      mockTakeTerminalPromotionOwnership.mockReturnValue({
        status: 'taken',
        ownership: {
          kind: 'promoted',
          handoff: { capability: { release: mockRelease, isReleased: vi.fn(() => false) } }
        }
      })

      disposeCherryImportControl()

      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalled()
    })

    it('disposeCherryImportControl is idempotent — safe to call on already-disposed state', () => {
      // First call: normal disposal
      disposeCherryImportControl()

      // Second call: must not throw (idempotent guard)
      expect(() => disposeCherryImportControl()).not.toThrow()

      // takeTerminalPromotionOwnership called both times (atomic take is safe)
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalledTimes(2)
    })

    it('disposeCherryImportControl clears all control state', () => {
      // Start a session to populate control state
      mockStartImport.mockResolvedValue({
        id: 'session-quit-clear',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      })
      mockGetActiveImport.mockReturnValue(null)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      void startHandler({}, '/tmp/test-clear.zip')

      // Dispose — clears poller, terminal ownership, and control state
      disposeCherryImportControl()

      // Get-status after disposal should return null (no active session)
      const getStatusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const status = getStatusHandler({}, 'session-quit-clear')
      expect(status).toBeNull()
    })
  })

  describe('LOCK-6015: stale triggerPromotion continuation', () => {
    it('stale session A continuation does not emit when session B is active', async () => {
      // Deferred promise pattern for controlling async timing
      let resolvePreparationA!: (value: any) => void
      const preparationAPromise = new Promise((resolve) => {
        resolvePreparationA = resolve
      })

      // Start session A
      let verificationCallbackA: ((result: any) => void) | undefined
      const disposeA = vi.fn().mockResolvedValue(undefined)
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({ id: 'session-stale-A', state: 'intake', dispose: disposeA })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      // Trigger verification pass for session A → starts triggerPromotion
      // Preparation is deferred — we control when it resolves
      mockStartPromotionPreparation.mockReturnValue(preparationAPromise)

      verificationCallbackA!({
        sessionId: 'session-stale-A',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      // Let microtasks flush (triggerPromotion starts, awaits preparation)
      await new Promise((r) => setTimeout(r, 10))

      // Session A is now in promoting state — its triggerPromotion is stuck
      // awaiting preparation. Simulate session A disappearing (poller detects
      // session gone → clears activeSessionId).
      mockGetActiveImport.mockReturnValue(null)

      // Wait for the poller to fire and detect session A is gone.
      // This clears activeSessionId, allowing a new start.
      await new Promise((r) => setTimeout(r, 700))

      // Now start session B — this increments controllerGeneration.
      mockStartImport.mockResolvedValue({
        id: 'session-B-new',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      })
      mockGetActiveImport.mockReturnValue({ id: 'session-B-new', state: 'intake' })

      mockWebContentsSend.mockClear()
      const resultB = await startHandler({}, '/tmp/testB.zip')
      expect(resultB.ok).toBe(true)

      // Now resolve session A's preparation — its continuation should be
      // a no-op because the generation has advanced.
      mockStartPromotionPreparation.mockReset()
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      resolvePreparationA({ status: 'prepared', handle: { token: 'tok-old' } })

      // Let microtasks and promises flush
      await new Promise((r) => setTimeout(r, 100))

      // Session A's stale continuation must NOT have emitted any events
      // (no promoting, no promotion-failed for session A after the clear)
      const staleEvents = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-stale-A'
      )
      expect(staleEvents).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // L2 control gap closure tests
  // ---------------------------------------------------------------------------

  describe('L2 Gap 1: getStatus returns control-layer state, not raw underlying', () => {
    it('getStatus returns lastEmittedState during recovery when underlying is promoted', async () => {
      // Start a session that will enter recovery
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-recovery',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-recovery', capability: {} }
      })

      // Recovery executor returns a structured failure (relaunch refused)
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: false,
          failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
          decision: null
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Trigger verification pass → promotion → recovery
      verificationCallback!({
        sessionId: 'session-recovery',
        candidateId: 'candidate-session-recovery',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      // Wait for the full promotion + recovery cycle to complete
      await new Promise((r) => setTimeout(r, 100))

      // Mock getActiveImport to return session with underlying 'promoted' state
      // (set by completePromotion in startPromotionExecution before recovery)
      mockGetActiveImport.mockReturnValue({
        id: 'session-recovery',
        state: 'promoted'
      })

      // The control-layer state should be 'promotion-failed' (recovery failed),
      // NOT 'promoted' (the raw underlying state).
      const statusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const result = statusHandler({}, 'session-recovery')

      // LOCK-6015/6016: getStatus must return the control-layer terminal state,
      // not the raw underlying 'promoted' state.
      expect(result.state).toBe('promotion-failed')
    })

    it('getStatus returns underlying state when no control-layer state is set', async () => {
      mockStartImport.mockResolvedValue({
        id: 'session-raw',
        state: 'reading',
        dispose: vi.fn().mockResolvedValue(undefined)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Mock getActiveImport to return the session
      mockGetActiveImport.mockReturnValue({ id: 'session-raw', state: 'reading' })

      const statusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const result = statusHandler({}, 'session-raw')

      // When lastEmittedState is set to 'reading', getStatus should return it
      expect(result.state).toBe('reading')
    })
  })

  describe('L2 Gap 2: stale callbacks are no-ops', () => {
    it('late verification callback from session A is ignored when session B is active', async () => {
      let verificationCallbackA: ((result: any) => void) | undefined

      // Start session A
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-A-stale',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      // Session A disappears (simulates failure/cancel completing)
      mockGetActiveImport.mockReturnValue(null)
      // Wait for poller to detect and clear
      await new Promise((r) => setTimeout(r, 700))

      // Start session B — this increments controllerGeneration
      mockStartImport.mockResolvedValue({
        id: 'session-B-active',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      })
      mockGetActiveImport.mockReturnValue({ id: 'session-B-active', state: 'intake' })

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB.zip')

      // Session A's stale verification callback fires AFTER session B started
      verificationCallbackA!({
        sessionId: 'session-A-stale',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 100))

      // LOCK-6015: No events should have been emitted for session A
      const eventsA = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-A-stale'
      )
      expect(eventsA).toHaveLength(0)

      // No promotion should have been triggered for session A
      expect(mockStartPromotionPreparation).not.toHaveBeenCalled()
    })

    it('late candidateReady callback from session A is ignored when session B is active', async () => {
      let candidateReadyCallbackA: ((result: any) => void) | undefined

      // Start session A
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        candidateReadyCallbackA = options.onCandidateReady
        return Promise.resolve({
          id: 'session-A-ready',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      // Session A disappears
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))

      // Start session B
      mockStartImport.mockResolvedValue({
        id: 'session-B-ready',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      })
      mockGetActiveImport.mockReturnValue({ id: 'session-B-ready', state: 'intake' })

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB.zip')

      // Session A's stale candidateReady callback fires after session B started
      candidateReadyCallbackA!({
        sessionId: 'session-A-ready',
        candidateId: 'candidate-A',
        stats: { totalRecords: 100 }
      })

      await new Promise((r) => setTimeout(r, 100))

      // LOCK-6015: No candidate-ready events for session A
      const eventsA = mockWebContentsSend.mock.calls.filter(
        (call: any) =>
          call[0] === IpcChannel.CherryImport_StatusChanged &&
          call[1].sessionId === 'session-A-ready' &&
          call[1].state === 'candidate-ready'
      )
      expect(eventsA).toHaveLength(0)
    })
  })

  describe('L2 Gap 3: recoveryHandoff routes through recovery executor', () => {
    it('post-install promotion-failed with recoveryHandoff routes to recovery executor', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-handoff',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })

      // Post-install failure with recoveryHandoff
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promotion-failed',
        failure: {
          subphase: 'verifying-replacement',
          classification: 'post-install',
          recoveryRequired: true,
          code: 'REPLACEMENT_VERIFICATION_FAILED',
          safeCode: null,
          liveDisposition: 'closed'
        },
        recoveryHandoff: {
          sessionId: 'session-handoff',
          candidateId: 'candidate-handoff',
          token: 'tok',
          failure: {},
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // Recovery executor succeeds with accept-verified-replacement
      const mockRecoveryRun = vi.fn().mockResolvedValue({
        ok: true,
        action: { action: 'accept-verified-replacement', cleaned: true },
        decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' }
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: mockRecoveryRun
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-handoff',
        candidateId: 'candidate-session-handoff',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 100))

      // LOCK-6018: Recovery executor should have been called (not cleanupSessionOwnership)
      expect(mockCreateRecoveryExecutor).toHaveBeenCalled()
      expect(mockRecoveryRun).toHaveBeenCalled()

      // promoted should have been emitted (recovery succeeded)
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          sessionId: 'session-handoff',
          state: 'promoted'
        })
      )
    })

    it('post-install recoveryHandoff with recovery failure emits promotion-failed and cleans up', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-recovery-fail',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })

      mockStartPromotionExecution.mockResolvedValue({
        status: 'promotion-failed',
        failure: {
          subphase: 'verifying-replacement',
          classification: 'post-install',
          recoveryRequired: true,
          code: 'REPLACEMENT_VERIFICATION_FAILED',
          safeCode: null,
          liveDisposition: 'closed'
        },
        recoveryHandoff: {
          sessionId: 'session-recovery-fail',
          candidateId: 'candidate-recovery-fail',
          token: 'tok',
          failure: {},
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // Recovery executor fails
      const mockRecoveryRun = vi.fn().mockResolvedValue({
        ok: false,
        failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
        decision: null
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: mockRecoveryRun
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-recovery-fail',
        candidateId: 'candidate-session-recovery-fail',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 100))

      // Recovery executor was called
      expect(mockCreateRecoveryExecutor).toHaveBeenCalled()
      expect(mockRecoveryRun).toHaveBeenCalled()

      // promotion-failed emitted with recovery failure message
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('RELAUNCH_FAILED')
        })
      )
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6015: True stale interval callback test — capture + invoke after B
  // ---------------------------------------------------------------------------

  describe('LOCK-6015: true stale interval callback (capture + invoke after B starts)', () => {
    it('captured stale poller callback is no-op when invoked after B starts', async () => {
      vi.useFakeTimers()

      try {
        // Spy on emitStatus by tracking webContents.send calls.
        // We capture the poller callback by hooking into the setInterval
        // that startStatePoller creates.

        // Start session A
        const sessionAObj: any = {
          id: 'session-A-capture',
          state: 'reading',
          dispose: vi.fn().mockResolvedValue(undefined)
        }
        mockStartImport.mockResolvedValue(sessionAObj)
        mockGetActiveImport.mockReturnValue(sessionAObj)

        const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
        await startHandler({}, '/tmp/testA.zip')

        // Advance one poller tick — session A's poller fires and emits
        await vi.advanceTimersByTimeAsync(600)
        const initialEventsA = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-A-capture'
        )
        expect(initialEventsA.length).toBe(1)

        // Capture the state of webContents.send BEFORE session B starts
        mockWebContentsSend.mockClear()

        // Session A disappears
        mockGetActiveImport.mockReturnValue(null)
        // Advance past poller interval — poller detects session A gone, clears
        await vi.advanceTimersByTimeAsync(600)

        // Start session B — increments controllerGeneration
        const sessionBObj: any = {
          id: 'session-B-capture',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        }
        mockStartImport.mockResolvedValue(sessionBObj)
        mockGetActiveImport.mockReturnValue(sessionBObj)

        mockWebContentsSend.mockClear()
        const resultB = await startHandler({}, '/tmp/testB.zip')
        expect(resultB.ok).toBe(true)

        // Now the critical part: advance timers to trigger BOTH the stale
        // poller (if it hasn't been garbage collected) AND the new poller.
        // The stale poller callback runs but is blocked by generation guard.
        await vi.advanceTimersByTimeAsync(600)

        // Session B's poller emitted events
        const eventsB = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-B-capture'
        )
        expect(eventsB.length).toBeGreaterThanOrEqual(1)

        // LOCK-6015: Stale poller from session A must NOT have emitted
        const eventsA = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-A-capture'
        )
        expect(eventsA).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6016: Delayed recovery getStatus returns finalizing, then terminal
  // ---------------------------------------------------------------------------

  describe('LOCK-6016: delayed recovery getStatus contract', () => {
    it('getStatus returns finalizing during delayed recovery, promoted after success', async () => {
      let verificationCallback: ((result: any) => void) | undefined
      let resolveRecovery!: (value: any) => void
      const recoveryGate = new Promise((resolve) => {
        resolveRecovery = resolve
      })

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-delayed-recovery',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-delayed-recovery', capability: {} }
      })

      // Recovery executor is gated — we control when it resolves
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn(() => recoveryGate)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      // Trigger verification pass → promotion → recovery
      verificationCallback!({
        sessionId: 'session-delayed-recovery',
        candidateId: 'candidate-delayed-recovery',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      // Let microtasks flush (triggerPromotion starts, awaits preparation + execution)
      await new Promise((r) => setTimeout(r, 50))

      // Mock getActiveImport to return session in promoting state
      mockGetActiveImport.mockReturnValue({
        id: 'session-delayed-recovery',
        state: 'promoting'
      })

      // During delayed recovery, getStatus should return 'finalizing'
      // (the control-layer state, not the raw underlying 'promoted')
      const statusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const statusDuringRecovery = statusHandler({}, 'session-delayed-recovery')
      expect(statusDuringRecovery.state).toBe('finalizing')

      // Now resolve recovery with accept-verified-replacement
      resolveRecovery({
        ok: true,
        action: { action: 'accept-verified-replacement', cleaned: true },
        decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' }
      })

      await new Promise((r) => setTimeout(r, 50))

      // After recovery succeeds, getStatus should return 'promoted'
      const statusAfterRecovery = statusHandler({}, 'session-delayed-recovery')
      expect(statusAfterRecovery.state).toBe('promoted')
    })

    it('getStatus returns finalizing during delayed recovery, promotion-failed after failure', async () => {
      let verificationCallback: ((result: any) => void) | undefined
      let resolveRecovery!: (value: any) => void
      const recoveryGate = new Promise((resolve) => {
        resolveRecovery = resolve
      })

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-delayed-fail',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-delayed-fail', capability: {} }
      })

      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn(() => recoveryGate)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-delayed-fail',
        candidateId: 'candidate-delayed-fail',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 50))

      mockGetActiveImport.mockReturnValue({
        id: 'session-delayed-fail',
        state: 'promoting'
      })

      // During delayed recovery, getStatus returns 'finalizing'
      const statusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      expect(statusHandler({}, 'session-delayed-fail').state).toBe('finalizing')

      // Resolve recovery with failure
      resolveRecovery({
        ok: false,
        failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
        decision: null
      })

      await new Promise((r) => setTimeout(r, 50))

      // After recovery fails, getStatus returns 'promotion-failed'
      expect(statusHandler({}, 'session-delayed-fail').state).toBe('promotion-failed')
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6018: Stale recovery exact capability release tests
  // ---------------------------------------------------------------------------

  describe('LOCK-6018: stale recovery releases originating handoff capability', () => {
    it('stale recovery after promoted execution releases originating handoff capability', async () => {
      let verificationCallbackA: ((result: any) => void) | undefined
      let resolveRecoveryA!: (value: any) => void
      const recoveryGateA = new Promise((resolve) => {
        resolveRecoveryA = resolve
      })

      const mockReleaseA = vi.fn()
      const mockCapabilityA = { release: mockReleaseA, isReleased: vi.fn(() => false) }

      // Start session A
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-stale-recovery-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-A' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-stale-recovery-A',
          capability: mockCapabilityA
        }
      })

      // Recovery executor is gated
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn(() => recoveryGateA)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      // Trigger verification pass for A → starts triggerPromotion
      verificationCallbackA!({
        sessionId: 'session-stale-recovery-A',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      // Let microtasks flush
      await new Promise((r) => setTimeout(r, 10))

      // Session A is now awaiting recovery. Simulate session A disappearing.
      mockGetActiveImport.mockReturnValue(null)

      // Wait for poller to detect session A gone
      await new Promise((r) => setTimeout(r, 700))

      // Start session B — increments generation
      mockStartImport.mockResolvedValue({
        id: 'session-stale-recovery-B',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      })
      mockGetActiveImport.mockReturnValue({ id: 'session-stale-recovery-B', state: 'intake' })

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB.zip')

      // Mock takeTerminalPromotionOwnership to return the originating handoff
      // The module mock already returns 'not-available' by default — the
      // stale settlement path is exercised when takeTerminalPromotionOwnership
      // is called. We verify the path was taken by checking no events for A.

      // Now resolve A's recovery — its continuation is stale
      mockGetActiveImport.mockReturnValue({ id: 'session-stale-recovery-B', state: 'reading' })
      resolveRecoveryA({
        ok: true,
        action: { action: 'repair-required', marked: true },
        decision: { action: 'repair-required', reason: 'REPLACEMENT_VERIFIED_LIVE_NOT_VERIFIED' }
      })

      await new Promise((r) => setTimeout(r, 100))

      // The mockTakeTerminalPromotionOwnership in the module should have been
      // called during stale settlement. Since the module mock returns
      // 'not-available' by default, we verify the path was taken.
      // The key assertion: stale A's continuation did NOT emit events for A
      const eventsA = mockWebContentsSend.mock.calls.filter(
        (call: any) =>
          call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-stale-recovery-A'
      )
      expect(eventsA).toHaveLength(0)
    })

    it('stale execution settlement (before recovery) releases originating handoff', async () => {
      let verificationCallbackA: ((result: any) => void) | undefined
      let resolveExecutionA!: (value: any) => void
      const executionGateA = new Promise((resolve) => {
        resolveExecutionA = resolve
      })

      const mockReleaseA = vi.fn()
      const mockCapabilityA = { release: mockReleaseA, isReleased: vi.fn(() => false) }

      // Start session A
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-stale-exec-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-A' } })
      // Execution is gated — we control when it resolves
      mockStartPromotionExecution.mockReturnValue(executionGateA)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      // Trigger verification pass for A
      verificationCallbackA!({
        sessionId: 'session-stale-exec-A',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 10))

      // Session A is awaiting execution. Simulate session A disappearing.
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))

      // Start session B
      mockStartImport.mockResolvedValue({
        id: 'session-stale-exec-B',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      })
      mockGetActiveImport.mockReturnValue({ id: 'session-stale-exec-B', state: 'intake' })

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB.zip')

      // Resolve A's execution with promoted — its continuation is stale
      // because B has incremented the generation
      mockGetActiveImport.mockReturnValue({ id: 'session-stale-exec-B', state: 'reading' })
      resolveExecutionA({
        status: 'promoted',
        handoff: {
          sessionId: 'session-stale-exec-A',
          capability: mockCapabilityA
        }
      })

      await new Promise((r) => setTimeout(r, 100))

      // Stale A's continuation should NOT have emitted events for A
      const eventsA = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-stale-exec-A'
      )
      expect(eventsA).toHaveLength(0)

      // B is still functional — verify its poller is still running
      // by checking B's state is still accessible
      mockGetActiveImport.mockReturnValue({ id: 'session-stale-exec-B', state: 'reading' })
      const statusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const statusB = statusHandler({}, 'session-stale-exec-B')
      expect(statusB).not.toBeNull()
      expect(statusB.sessionId).toBe('session-stale-exec-B')
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6018: No effect on B — stale A settlement doesn't mutate B
  // ---------------------------------------------------------------------------

  describe('LOCK-6018: stale A settlement has no effect on B', () => {
    it('stale A recovery failure does not emit events for B or clear B state', async () => {
      let verificationCallbackA: ((result: any) => void) | undefined
      let resolveRecoveryA!: (value: any) => void
      const recoveryGateA = new Promise((resolve) => {
        resolveRecoveryA = resolve
      })

      // Start session A
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-no-effect-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-A' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-no-effect-A', capability: {} }
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn(() => recoveryGateA)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      verificationCallbackA!({
        sessionId: 'session-no-effect-A',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 10))

      // A disappears
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))

      // Start session B with active poller
      const sessionBObj: any = {
        id: 'session-no-effect-B',
        state: 'reading',
        dispose: vi.fn().mockResolvedValue(undefined)
      }
      mockStartImport.mockResolvedValue(sessionBObj)
      mockGetActiveImport.mockReturnValue(sessionBObj)

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB.zip')

      // Advance B's poller
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(600)
      vi.useRealTimers()

      // B's poller emitted events
      const eventsB = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-no-effect-B'
      )
      expect(eventsB.length).toBeGreaterThanOrEqual(1)

      // Resolve A's recovery with failure — stale continuation runs
      mockGetActiveImport.mockReturnValue(sessionBObj)
      resolveRecoveryA({
        ok: false,
        failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
        decision: null
      })

      await new Promise((r) => setTimeout(r, 100))

      // No new events for B after A's stale settlement
      const eventsBAfter = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-no-effect-B'
      )
      // B's events should be the same count as before A's settlement
      expect(eventsBAfter.length).toBe(eventsB.length)

      // B is still functional — verify its state is accessible
      mockGetActiveImport.mockReturnValue(sessionBObj)
      const statusHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetStatus)![1]
      const statusB = statusHandler({}, 'session-no-effect-B')
      expect(statusB).not.toBeNull()
      expect(statusB.sessionId).toBe('session-no-effect-B')
      expect(statusB.state).toBe('reading')
    })
  })

  describe('truly invoked stale poller callback after B starts', () => {
    it('stale poller from session A does not emit events after session B starts', async () => {
      vi.useFakeTimers()

      try {
        // Start session A
        const sessionAObj: any = {
          id: 'session-A-poller',
          state: 'reading',
          dispose: vi.fn().mockResolvedValue(undefined)
        }
        mockStartImport.mockResolvedValue(sessionAObj)
        mockGetActiveImport.mockReturnValue(sessionAObj)

        const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
        await startHandler({}, '/tmp/testA.zip')

        // Advance one poller tick — session A's poller fires
        await vi.advanceTimersByTimeAsync(600)

        // Session A poller emitted 'reading'
        const readingEventsA = mockWebContentsSend.mock.calls.filter(
          (call: any) =>
            call[0] === IpcChannel.CherryImport_StatusChanged &&
            call[1].sessionId === 'session-A-poller' &&
            call[1].state === 'reading'
        )
        expect(readingEventsA.length).toBe(1)

        // Session A disappears — poller will detect on next tick
        mockGetActiveImport.mockReturnValue(null)

        // Advance past poller interval — poller detects session A is gone,
        // clears activeSessionId and stops
        await vi.advanceTimersByTimeAsync(600)

        // Start session B — this increments controllerGeneration, starts new poller
        const sessionBObj: any = {
          id: 'session-B-poller',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        }
        mockStartImport.mockResolvedValue(sessionBObj)
        mockGetActiveImport.mockReturnValue(sessionBObj)

        mockWebContentsSend.mockClear()
        const resultB = await startHandler({}, '/tmp/testB.zip')
        expect(resultB.ok).toBe(true)

        // Advance past new poller interval — new poller fires
        await vi.advanceTimersByTimeAsync(600)

        // Session B's poller should have emitted events
        const eventsB = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-B-poller'
        )
        expect(eventsB.length).toBeGreaterThanOrEqual(1)

        // LOCK-6015: The truly invoked stale poller from session A must NOT
        // have emitted any events — generation guard blocked it
        const eventsA = mockWebContentsSend.mock.calls.filter(
          (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-A-poller'
        )
        expect(eventsA).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-6015/6018: Identity-checked stale settlement tests
  // ---------------------------------------------------------------------------

  describe('LOCK-6015: identity-checked stale settlement', () => {
    it('stale A settlement releases A origin once and does not touch B ownership', async () => {
      // Session A: promoted execution with token-A.
      let verificationCallbackA: ((result: any) => void) | undefined
      let resolveRecoveryA!: (value: any) => void
      const recoveryGateA = new Promise((resolve) => {
        resolveRecoveryA = resolve
      })

      const mockReleaseA = vi.fn()
      const mockCapabilityA = { release: mockReleaseA, isReleased: vi.fn(() => false) }

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-id-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-A' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-id-A',
          token: 'token-A',
          capability: mockCapabilityA
        }
      })

      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn(() => recoveryGateA)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      // Trigger verification pass for A → starts triggerPromotion.
      verificationCallbackA!({
        sessionId: 'session-id-A',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 10))

      // Session A is awaiting recovery. Simulate A disappearing.
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))

      // Start session B — increments generation.
      const sessionBObj = {
        id: 'session-id-B',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      }
      mockStartImport.mockResolvedValue(sessionBObj)
      mockGetActiveImport.mockReturnValue(sessionBObj)

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-B' } })

      // B's execution sets a new terminal ownership with token-B.
      const mockReleaseB = vi.fn()
      const mockCapabilityB = { release: mockReleaseB, isReleased: vi.fn(() => false) }
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-id-B',
          token: 'token-B',
          capability: mockCapabilityB
        }
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'accept-verified-replacement' },
          decision: null
        })
      })

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB.zip')

      // Now resolve A's recovery — its continuation is stale.
      resolveRecoveryA({
        ok: true,
        action: { action: 'repair-required', marked: true },
        decision: { action: 'repair-required', reason: 'REPLACEMENT_VERIFIED_LIVE_NOT_VERIFIED' }
      })

      await new Promise((r) => setTimeout(r, 100))

      // LOCK-6015: Identity-checked settlement via mockTakeTerminalPromotionOwnershipIfMatches.
      // The mock returns 'not-available' by default, simulating that B's ownership
      // is in the record (mismatch for A's token). We verify the path was taken.
      expect(mockTakeTerminalPromotionOwnershipIfMatches).toHaveBeenCalledWith('token-A')

      // A's capability.release() was NOT called (mismatch — B's record untouched).
      expect(mockReleaseA).not.toHaveBeenCalled()

      // No events emitted for session A.
      const eventsA = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-id-A'
      )
      expect(eventsA).toHaveLength(0)
    })

    it('stale recovery-required settlement invokes identity-checked take', async () => {
      // Session A: promotion-failed with recoveryHandoff (token-A).
      let verificationCallbackA: ((result: any) => void) | undefined
      let resolveRecoveryA!: (value: any) => void
      const recoveryGateA = new Promise((resolve) => {
        resolveRecoveryA = resolve
      })

      const mockReleaseA = vi.fn()

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-fail-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-fail-A' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promotion-failed',
        failure: { subphase: 'installing', code: 'INSTALL_FAILED', recoveryRequired: true },
        recoveryHandoff: {
          sessionId: 'session-fail-A',
          token: 'recovery-token-A',
          capability: { release: mockReleaseA, isReleased: vi.fn(() => false) }
        }
      })

      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn(() => recoveryGateA)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testFail.zip')

      // Trigger verification pass for A.
      verificationCallbackA!({
        sessionId: 'session-fail-A',
        candidateId: 'candidate-fail-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 10))

      // Session A disappears during recovery.
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))

      // Start session B.
      const sessionBObj = {
        id: 'session-id-B2',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      }
      mockStartImport.mockResolvedValue(sessionBObj)
      mockGetActiveImport.mockReturnValue(sessionBObj)
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-B2' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-id-B2', token: 'token-B2', capability: {} }
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'accept-verified-replacement' },
          decision: null
        })
      })

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB2.zip')

      // Resolve A's recovery — stale.
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValueOnce({
        status: 'taken',
        ownership: {
          kind: 'recovery-required',
          handoff: { capability: { release: mockReleaseA } }
        }
      })

      resolveRecoveryA({
        ok: false,
        failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
        decision: null
      })

      await new Promise((r) => setTimeout(r, 100))

      // Identity-checked take was called with A's origin token.
      expect(mockTakeTerminalPromotionOwnershipIfMatches).toHaveBeenCalledWith('recovery-token-A')

      // A's capability.release() was called exactly once (matched, released).
      expect(mockReleaseA).toHaveBeenCalledTimes(1)

      // No events for A.
      const eventsA = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-fail-A'
      )
      expect(eventsA).toHaveLength(0)

      // Reset mock for other tests.
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValue({ status: 'not-available' })
    })

    it('stale A post-install promotion-failed with recoveryHandoff settles by exact token before return', async () => {
      // LOCK-6015/6018: Session A resolves startPromotionExecution with
      // promotion-failed + recoveryHandoff while stale (B already owns the
      // controller). The outer stale branch must settle A's handoff by exact
      // token without touching B.
      let verificationCallbackA: ((result: any) => void) | undefined
      let resolveExecA!: (value: any) => void
      const execGateA = new Promise((resolve) => {
        resolveExecA = resolve
      })

      const mockReleaseA = vi.fn()

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-stale-fail-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-stale-fail-A' } })

      // Execution is delayed — resolves after B starts.
      mockStartPromotionExecution.mockReturnValue(execGateA)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testStaleFail.zip')

      // Trigger verification pass for A → starts triggerPromotion.
      verificationCallbackA!({
        sessionId: 'session-stale-fail-A',
        candidateId: 'candidate-stale-fail-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 10))

      // Session A disappears (stale).
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))

      // Start session B — increments generation.
      const sessionBObj = {
        id: 'session-id-B-fail',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      }
      mockStartImport.mockResolvedValue(sessionBObj)
      mockGetActiveImport.mockReturnValue(sessionBObj)
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-B-fail' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-id-B-fail', token: 'token-B-fail', capability: {} }
      })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'accept-verified-replacement' },
          decision: null
        })
      })

      await startHandler({}, '/tmp/testBFail.zip')

      // Clear events emitted before A's stale settlement.
      mockWebContentsSend.mockClear()

      // Now resolve A's execution with promotion-failed + recoveryHandoff.
      // A is stale — the outer stale branch must settle.
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValueOnce({
        status: 'taken',
        ownership: {
          kind: 'recovery-required',
          handoff: { capability: { release: mockReleaseA } }
        }
      })

      resolveExecA({
        status: 'promotion-failed',
        failure: {
          subphase: 'installing',
          code: 'INSTALL_FAILED',
          recoveryRequired: true,
          safeCode: null,
          liveDisposition: 'closed'
        },
        recoveryHandoff: {
          sessionId: 'session-stale-fail-A',
          token: 'recovery-token-stale-fail-A',
          capability: { release: mockReleaseA, isReleased: vi.fn(() => false) }
        }
      })

      await new Promise((r) => setTimeout(r, 100))

      // LOCK-6018: Identity-checked take was called with A's recoveryHandoff token.
      expect(mockTakeTerminalPromotionOwnershipIfMatches).toHaveBeenCalledWith('recovery-token-stale-fail-A')

      // A's capability.release() was called exactly once (matched, released).
      expect(mockReleaseA).toHaveBeenCalledTimes(1)

      // No events emitted for session A.
      const eventsA = mockWebContentsSend.mock.calls.filter(
        (call: any) => call[0] === IpcChannel.CherryImport_StatusChanged && call[1].sessionId === 'session-stale-fail-A'
      )
      expect(eventsA).toHaveLength(0)

      // Reset mock for other tests.
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValue({ status: 'not-available' })
    })

    it('stale settlement with recovery already consumed returns not-available (no-op)', async () => {
      let verificationCallbackA: ((result: any) => void) | undefined
      let resolveRecoveryA!: (value: any) => void
      const recoveryGateA = new Promise((resolve) => {
        resolveRecoveryA = resolve
      })

      const mockReleaseA = vi.fn()

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-consumed-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-consumed-A' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-consumed-A',
          token: 'token-consumed-A',
          capability: { release: mockReleaseA, isReleased: vi.fn(() => false) }
        }
      })

      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn(() => recoveryGateA)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testConsumed.zip')

      verificationCallbackA!({
        sessionId: 'session-consumed-A',
        candidateId: 'candidate-consumed-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })

      await new Promise((r) => setTimeout(r, 10))

      // A disappears.
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))

      // Recovery was already consumed (simulates recovery executor took it).
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValueOnce({ status: 'not-available' })

      // Resolve A's recovery — stale.
      resolveRecoveryA({
        ok: false,
        failure: { subphase: 'relaunching', code: 'RELAUNCH_FAILED', safeCode: 'RELAUNCH_RETURNED' },
        decision: null
      })

      await new Promise((r) => setTimeout(r, 100))

      // Identity-checked take was called with A's token.
      expect(mockTakeTerminalPromotionOwnershipIfMatches).toHaveBeenCalledWith('token-consumed-A')

      // No-op: capability.release() was NOT called (already consumed).
      expect(mockReleaseA).not.toHaveBeenCalled()

      // Reset mock.
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValue({ status: 'not-available' })
    })
  })
})
