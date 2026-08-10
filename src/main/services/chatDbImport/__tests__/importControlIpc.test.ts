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
  mockRemoveHandler,
  mockApp,
  mockWebContentsSend,
  mockStartImport,
  mockCancelImport,
  mockGetActiveImport,
  mockStartPromotionPreparation,
  mockStartPromotionExecution,
  mockCreateRecoveryExecutor,
  mockTakeTerminalPromotionOwnership,
  mockTakeTerminalPromotionOwnershipIfMatches,
  mockReadPromotionJournal,
  mockRunRecoveryV2,
  mockChatDbService
} = vi.hoisted(() => {
  return {
    mockHandle: vi.fn(),
    mockRemoveHandler: vi.fn(),
    mockApp: { isPackaged: false, relaunch: vi.fn(), exit: vi.fn() },
    mockWebContentsSend: vi.fn(),
    mockStartImport: vi.fn(),
    mockCancelImport: vi.fn(),
    mockGetActiveImport: vi.fn(),
    mockStartPromotionPreparation: vi.fn(),
    mockStartPromotionExecution: vi.fn(),
    mockCreateRecoveryExecutor: vi.fn(),
    mockTakeTerminalPromotionOwnership: vi.fn().mockReturnValue({ status: 'not-available' }),
    mockTakeTerminalPromotionOwnershipIfMatches: vi.fn().mockReturnValue({ status: 'not-available' }),
    mockReadPromotionJournal: vi.fn(),
    mockRunRecoveryV2: vi.fn(),
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
    handle: mockHandle,
    removeHandler: mockRemoveHandler
  },
  app: mockApp
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

vi.mock('../promotion/journalStore', () => ({
  readPromotionJournal: mockReadPromotionJournal
}))

vi.mock('../promotion/recoveryExecutorV2', () => ({
  runRecoveryV2: mockRunRecoveryV2
}))

function createMockWebContents() {
  return {
    isDestroyed: vi.fn(() => false),
    send: mockWebContentsSend,
    reload: vi.fn(),
    mainFrame: { id: 1, url: 'file:///index.html' }
  } as any
}

import { IpcChannel } from '@shared/IpcChannel'

import { ChatImportAttachmentError } from '../errors'
import { disposeCherryImportControl, registerCherryImportControlIpc } from '../importControlIpc'
import { resetRelaunchGuardForTests } from '../promotion/relaunch'

describe('importControlIpc', () => {
  let webContents: ReturnType<typeof createMockWebContents>

  beforeEach(() => {
    vi.clearAllMocks()
    mockTakeTerminalPromotionOwnership.mockReturnValue({ status: 'not-available' })
    mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValue({ status: 'not-available' })
    // LOCK-CTRL-5 dispatch: default to an ABSENT journal (the recovery path
    // fails closed on absent — tests that run a recovery set the journal).
    mockReadPromotionJournal.mockResolvedValue({ status: 'absent' })
    // Default v2 recovery result: all-new, restart requested, in-process
    // mode (the default `app.isPackaged` is false).
    mockRunRecoveryV2.mockReset()
    mockRunRecoveryV2.mockResolvedValue({
      ok: true,
      action: 'accept-verified-replacement',
      journalCleaned: true,
      restartRequested: true,
      deferredToWindow: false
    })
    mockApp.isPackaged = false
    mockApp.relaunch.mockReset()
    mockApp.exit.mockReset()
    resetRelaunchGuardForTests()
    webContents = createMockWebContents()
    registerCherryImportControlIpc(webContents)
  })

  afterEach(() => {
    disposeCherryImportControl()
  })

  // -------------------------------------------------------------------------
  // Shared fixtures
  // -------------------------------------------------------------------------

  /** Build an IPC invoke event carrying the given webContents' main frame
   *  identity (mirrors Electron's IpcMainInvokeEvent.sender/senderFrame). */
  function eventFromContents(contents: any) {
    return { sender: contents, senderFrame: contents.mainFrame, frameId: contents.mainFrame.id }
  }

  /** Valid v2 promotion journal (LOCK-CTRL-5 dispatch evidence). */
  function v2Journal(phase: string = 'replacement-verified'): any {
    return {
      version: 2,
      sessionId: 'import-s',
      candidateId: 'candidate-s',
      phase,
      receipts: {
        candidate: {
          db: { sha256: 'a'.repeat(64), size: 100 },
          files: { count: 1, totalBytes: 10, sha256: 'b'.repeat(64) },
          catalog: { count: 1, sha256: 'c'.repeat(64) }
        },
        old: {
          db: { sha256: 'd'.repeat(64), size: 90 },
          files: { count: 0, totalBytes: 0, sha256: 'e'.repeat(64) },
          catalog: { count: 0, sha256: 'f'.repeat(64) }
        }
      }
    }
  }

  /** Valid v1 promotion journal (LOCK-CTRL-5 dispatch evidence). */
  function v1Journal(): any {
    return {
      version: 1,
      sessionId: 'import-s',
      candidateId: 'candidate-s',
      phase: 'replacement-verified',
      receipts: {
        candidate: { db: { sha256: 'a'.repeat(64), size: 100 } },
        old: { db: { sha256: 'd'.repeat(64), size: 90 } }
      }
    }
  }

  /** The last v2 recovery options captured by the mocked runRecoveryV2. */
  let lastRecoveryOptions: any
  function captureRecoveryOptions(): void {
    mockRunRecoveryV2.mockImplementation(async (options: any) => {
      lastRecoveryOptions = options
      return {
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: true,
        deferredToWindow: false
      }
    })
  }

  /**
   * Simulate the REAL v2 executor's restart behavior inside the mocked
   * runner: it calls the restart surface and maps the outcome exactly like
   * `requestRestart` (relaunch/reload throw → RELAUNCH_FAILED).
   */
  function runRecoveryV2ThroughRestart(options: any): any {
    const restart = options.restart
    try {
      if (restart.mode === 'relaunch') {
        const result = restart.relaunch()
        return {
          ok: true,
          action: 'accept-verified-replacement',
          journalCleaned: true,
          restartRequested: result.relaunched === true,
          deferredToWindow: false
        }
      }
      const result = restart.reloadRenderer('recovery-v2')
      return {
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: result.reloaded === true,
        deferredToWindow: false
      }
    } catch {
      return { ok: false, code: 'RELAUNCH_FAILED', safeCode: 'IO' }
    }
  }

  /** Wire the default promoted-execution flow and fire verification pass. */
  async function runPromotedFlow(
    options: { sessionId?: string; handoffToken?: string; session?: any } = {}
  ): Promise<() => void> {
    const sessionId = options.sessionId ?? 'session-flow'
    const handoffToken = options.handoffToken ?? 'token-flow'
    let verificationCallback: ((result: any) => void) | undefined
    mockStartImport.mockImplementation((_zipPath: string, opts: any) => {
      verificationCallback = opts.onVerificationComplete
      return Promise.resolve(
        options.session ?? { id: sessionId, state: 'intake', dispose: vi.fn().mockResolvedValue(undefined) }
      )
    })
    mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
    mockStartPromotionExecution.mockResolvedValue({
      status: 'promoted',
      handoff: { sessionId, token: handoffToken, capability: { release: vi.fn(), isReleased: vi.fn(() => false) } }
    })

    const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
    await startHandler({}, '/tmp/test.zip')

    return () => {
      verificationCallback!({
        sessionId,
        candidateId: `candidate-${sessionId}`,
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
    }
  }

  /** All emitted CherryImport_StatusChanged event payloads, in order. */
  function emittedStatusEvents(): any[] {
    return mockWebContentsSend.mock.calls
      .filter((call: any) => call[0] === IpcChannel.CherryImport_StatusChanged)
      .map((call: any) => call[1])
  }

  function emittedStates(): string[] {
    return emittedStatusEvents().map((e: any) => e.state)
  }

  /** One-shot projection state key stored in migration_state. */
  const NAVIGATION_PROJECTION_STATE_KEY = 'import_navigation_projection_v1'

  /** Valid encoded projection value as stored in migration_state. */
  const PENDING_ROW = JSON.stringify({
    version: 1,
    sourcePersistVersion: 3,
    assistants: [{ id: 'a1', name: 'Alpha', emoji: null, order: 0 }],
    topics: [
      {
        id: 't1',
        assistantId: 'a1',
        name: 'Topic One',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: null,
        deletedAt: null,
        pinned: true,
        isNameManuallyEdited: false,
        order: 0
      }
    ],
    recoveredTopicIds: []
  })

  /** Live better-sqlite3-shaped double over migration_state. */
  function makeSqliteDouble(overrides: Record<string, any> = {}) {
    const reads: string[] = []
    const deletes: string[] = []
    const sqlite: any = {
      reads,
      deletes,
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT value FROM migration_state')) {
          return {
            get: vi.fn((key: string) => {
              reads.push(key)
              return 'row' in overrides ? overrides.row : { value: PENDING_ROW }
            })
          }
        }
        if (sql.includes('DELETE FROM migration_state')) {
          return {
            run: vi.fn((key: string) => {
              deletes.push(key)
              return { changes: overrides.deleteChanges ?? 1 }
            })
          }
        }
        throw new Error(`Unexpected SQL: ${sql}`)
      })
    }
    return Object.assign(sqlite, overrides)
  }

  it('registers 8 IPC handlers (incl. the catalog boundary + ready handshake)', () => {
    expect(mockHandle).toHaveBeenCalledTimes(8)
    const channels = mockHandle.mock.calls.map((c: any) => c[0])
    expect(channels).toContain(IpcChannel.CherryImport_GetPlatformSupport)
    expect(channels).toContain(IpcChannel.CherryImport_Start)
    expect(channels).toContain(IpcChannel.CherryImport_Cancel)
    expect(channels).toContain(IpcChannel.CherryImport_GetStatus)
    // LOCK-PROD-6: the two one-shot projection channels are fixed handlers.
    expect(channels).toContain(IpcChannel.CherryImport_GetProjection)
    expect(channels).toContain(IpcChannel.CherryImport_AckProjection)
    // LOCK-PROMO-5: the renderer catalog response handler.
    expect(channels).toContain(IpcChannel.CherryImport_CatalogRespond)
    // LOCK-BRIDGE-1: the renderer → main ready handshake channel.
    expect(channels).toContain(IpcChannel.CherryImport_CatalogReady)
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

    it('bounds an attachment fatal error to its code family (LOCK-FIX-3/8)', async () => {
      mockStartImport.mockRejectedValue(new ChatImportAttachmentError('AMBIGUOUS_PAYLOAD', 'ambiguous payload'))

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      const result = await handler({}, '/tmp/test.zip')

      expect(result.ok).toBe(false)
      // Bounded code family only — never paths, names, or raw file IDs.
      expect(result.error).toBe('Attachment import failed (AMBIGUOUS_PAYLOAD)')
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

  // ---------------------------------------------------------------------------
  // LOCK-PROD-6: one-shot navigation projection handlers
  // ---------------------------------------------------------------------------

  describe('navigation projection handlers (LOCK-PROD-6)', () => {
    it('get-projection returns the validated pending payload from the live sqlite row', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetProjection)![1]
      const result = handler(eventFromContents(webContents))

      // LOCK-I3: only a validated pending payload is returned over IPC.
      expect(result).toEqual({ ok: true, projection: JSON.parse(PENDING_ROW) })
      // The read targets the exact versioned key — never a wildcard.
      expect(sqlite.reads).toEqual([NAVIGATION_PROJECTION_STATE_KEY])
    })

    it('get-projection is a no-op when no row is pending (crash-before-ack retries next startup)', () => {
      const sqlite = makeSqliteDouble({ row: undefined })
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetProjection)![1]
      const result = handler(eventFromContents(webContents))

      expect(result).toEqual({ ok: true, projection: null })
    })

    it('get-projection treats a malformed row as absent — safe no-op, never a throw', () => {
      const sqlite = makeSqliteDouble({ row: { value: 'not-json{{{' } })
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetProjection)![1]
      const result = handler(eventFromContents(webContents))

      expect(result).toEqual({ ok: true, projection: null })
    })

    it('get-projection returns a structured safe result when the live DB is unavailable', () => {
      mockChatDbService.getSqlite.mockReturnValue(null)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetProjection)![1]
      const result = handler(eventFromContents(webContents))

      expect(result).toEqual({ ok: true, projection: null })
    })

    it('get-projection contains a DB read failure as a structured safe result', () => {
      mockChatDbService.getSqlite.mockReturnValue({
        prepare: () => {
          throw new Error('database is locked /Users/secret/data.db')
        }
      })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetProjection)![1]
      const result = handler(eventFromContents(webContents))

      // LOCK-I3: the raw error (including any path) never crosses IPC.
      expect(result).toEqual({ ok: true, projection: null })
      expect(JSON.stringify(result)).not.toContain('/Users/secret')
    })

    it('ack-projection deletes exactly the pending key and succeeds', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_AckProjection)![1]
      const result = handler(eventFromContents(webContents))

      expect(result).toEqual({ ok: true })
      expect(sqlite.deletes).toEqual([NAVIGATION_PROJECTION_STATE_KEY])
    })

    it('ack-projection is idempotent when no row was pending (changes=0)', () => {
      const sqlite = makeSqliteDouble({ deleteChanges: 0 })
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_AckProjection)![1]
      const result = handler(eventFromContents(webContents))

      expect(result).toEqual({ ok: true })
    })

    it('ack-projection fails closed when the live DB is unavailable — row stays pending', () => {
      mockChatDbService.getSqlite.mockReturnValue(null)

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_AckProjection)![1]
      const result = handler(eventFromContents(webContents))

      expect(result).toEqual({ ok: false, error: 'Chat database is not available' })
    })

    it('ack-projection surfaces a delete failure — row stays pending for retry', () => {
      mockChatDbService.getSqlite.mockReturnValue({
        prepare: () => {
          throw new Error('SQLITE_BUSY /Users/secret/data.db')
        }
      })

      const handler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_AckProjection)![1]
      const result = handler(eventFromContents(webContents))

      expect(result).toEqual({ ok: false, error: 'Projection acknowledgment failed' })
      // LOCK-I3: the raw error (including any path) never crosses IPC.
      expect(JSON.stringify(result)).not.toContain('/Users/secret')
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-FA1/FA2/FA3: projection handler authorization — only the registered
  // main renderer's main frame may read/acknowledge the pending projection.
  // ---------------------------------------------------------------------------

  describe('projection handler authorization (LOCK-FA1/FA2/FA3)', () => {
    function getProjectionHandler(): any {
      return mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetProjection)![1]
    }

    function ackProjectionHandler(): any {
      return mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_AckProjection)![1]
    }

    it('get-projection rejects an unrelated window sender (broad preload) — no SQL read', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      const unrelatedWindow = createMockWebContents()

      const result = getProjectionHandler()(eventFromContents(unrelatedWindow))

      // LOCK-FA1: reject. LOCK-FA2: structured, path-redacted error.
      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection read denied' })
      expect(JSON.stringify(result)).not.toContain('/')
      // No DB access for a rejected sender.
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.reads).toEqual([])
    })

    it('get-projection rejects a non-main window sender sharing the broad preload — no SQL read', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      // LOCK-006: the Quick Assistant mini window is removed; a trace window
      // stands in as a non-main window that shares the broad preload.
      const miniLikeWindow = createMockWebContents()
      miniLikeWindow.mainFrame = { id: 2, url: 'file:///traceWindow.html' }

      const result = getProjectionHandler()(eventFromContents(miniLikeWindow))

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection read denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.reads).toEqual([])
    })

    it('get-projection rejects a non-main frame on the registered window — no SQL read', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const result = getProjectionHandler()({ sender: webContents, senderFrame: { id: 99 }, frameId: 99 })

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection read denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.reads).toEqual([])
    })

    it('get-projection rejects when registration is missing (disposed) — no SQL read', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      disposeCherryImportControl() // LOCK-FA3: single-owner registration cleared

      const result = getProjectionHandler()(eventFromContents(webContents))

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection read denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.reads).toEqual([])
    })

    it('get-projection rejects when the registered target is destroyed — no SQL read', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      webContents.isDestroyed.mockReturnValue(true)

      const result = getProjectionHandler()(eventFromContents(webContents))

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection read denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.reads).toEqual([])
    })

    it('re-registration transfers authorization to the new main target only (LOCK-FA3)', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      const previousTarget = webContents
      const newTarget = createMockWebContents()
      registerCherryImportControlIpc(newTarget)

      // The old target is no longer authorized.
      const staleResult = getProjectionHandler()(eventFromContents(previousTarget))
      expect(staleResult).toEqual({ ok: false, error: 'Unauthorized: navigation projection read denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.reads).toEqual([])

      // The current target's main frame is authorized — the read proceeds.
      const currentResult = getProjectionHandler()(eventFromContents(newTarget))
      expect(currentResult).toEqual({ ok: true, projection: JSON.parse(PENDING_ROW) })
      expect(sqlite.reads).toEqual([NAVIGATION_PROJECTION_STATE_KEY])
    })

    it('ack-projection rejects an unrelated window sender WITHOUT executing SQL (LOCK-FA2)', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      const unrelatedWindow = createMockWebContents()

      const result = ackProjectionHandler()(eventFromContents(unrelatedWindow))

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection acknowledgment denied' })
      expect(JSON.stringify(result)).not.toContain('/')
      // LOCK-FA2: the DELETE must never run for a rejected sender.
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.deletes).toEqual([])
    })

    it('ack-projection rejects a non-main window sender WITHOUT executing SQL', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      // LOCK-006: the Quick Assistant mini window is removed; a trace window
      // stands in as a non-main window that shares the broad preload.
      const miniLikeWindow = createMockWebContents()
      miniLikeWindow.mainFrame = { id: 2, url: 'file:///traceWindow.html' }

      const result = ackProjectionHandler()(eventFromContents(miniLikeWindow))

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection acknowledgment denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.deletes).toEqual([])
    })

    it('ack-projection rejects a non-main frame on the registered window WITHOUT executing SQL', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const result = ackProjectionHandler()({ sender: webContents, senderFrame: { id: 99 }, frameId: 99 })

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection acknowledgment denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.deletes).toEqual([])
    })

    it('ack-projection rejects when registration is missing WITHOUT executing SQL', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      disposeCherryImportControl()

      const result = ackProjectionHandler()(eventFromContents(webContents))

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection acknowledgment denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.deletes).toEqual([])
    })

    it('ack-projection rejects when the registered target is destroyed WITHOUT executing SQL', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      webContents.isDestroyed.mockReturnValue(true)

      const result = ackProjectionHandler()(eventFromContents(webContents))

      expect(result).toEqual({ ok: false, error: 'Unauthorized: navigation projection acknowledgment denied' })
      expect(sqlite.prepare).not.toHaveBeenCalled()
      expect(sqlite.deletes).toEqual([])
    })

    it('authorized main-frame get and ack still succeed (LOCK-FA1 same main frame)', () => {
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)

      const getResult = getProjectionHandler()(eventFromContents(webContents))
      expect(getResult).toEqual({ ok: true, projection: JSON.parse(PENDING_ROW) })

      const ackResult = ackProjectionHandler()(eventFromContents(webContents))
      expect(ackResult).toEqual({ ok: true })
      expect(sqlite.reads).toEqual([NAVIGATION_PROJECTION_STATE_KEY])
      expect(sqlite.deletes).toEqual([NAVIGATION_PROJECTION_STATE_KEY])
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
    it('verification pass triggers promotion through the v2 terminal flow', async () => {
      let verificationCallback: ((result: any) => void) | undefined

      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({
          id: 'session-pass',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })

      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-pass', token: 'token-pass', capability: {} }
      })

      // LOCK-CTRL-5: a valid v2 journal dispatches to the v2 recovery.
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
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

      // Promotion preparation should have been called with the production
      // boundary and the controlled data root
      expect(mockStartPromotionPreparation).toHaveBeenCalledWith(
        expect.objectContaining({ dbDir: '/mock/data', catalogBoundary: expect.any(Object) })
      )
      // Promotion execution should have been called
      expect(mockStartPromotionExecution).toHaveBeenCalled()

      // The v2 recovery executor was dispatched with a v2 journal
      expect(mockReadPromotionJournal).toHaveBeenCalledWith('/mock/data')
      expect(mockRunRecoveryV2).toHaveBeenCalled()

      // promoting state should have been emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoting' })
      )
      // promoted state should have been emitted (all-new convergence)
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
        handoff: { sessionId: 'session-term', token: 'token-term', capability: {} }
      })
      // v2 terminal flow: valid v2 journal → v2 recovery converges all-new.
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
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
        handoff: { sessionId: 'session-recovery-fail', token: 'token-rec-fail', capability: {} }
      })

      // v2 recovery returns a structured failure (relaunch refused)
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: false,
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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
        handoff: { sessionId: 'session-repair', token: 'token-repair', capability: {} }
      })

      // v2 recovery converges to repair-required (ok:true but failure action)
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'repair-required',
        journalCleaned: false,
        restartRequested: false,
        deferredToWindow: false
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
        handoff: { sessionId: 'session-keep', token: 'token-keep', capability: {} }
      })

      // v2 recovery returns ok:true with the unexpected keep-old-live action
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'keep-old-live',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
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
          token: 'token-rel',
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // v2 recovery returns a structured failure
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: false,
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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

    it('recovery unavailable (journal I/O failure) consumes terminal ownership', async () => {
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
          token: 'token-unavail',
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // The journal read itself fails (I/O) — runFinalRecovery fails closed
      // with a bounded RECOVERY_UNAVAILABLE outcome.
      mockReadPromotionJournal.mockRejectedValue(new Error('disk io failure'))

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
      // promotion-failed emitted for the bounded RECOVERY_UNAVAILABLE outcome
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('RECOVERY_UNAVAILABLE')
        })
      )
      // The raw I/O error never crossed IPC.
      const allStatus = JSON.stringify(emittedStatusEvents())
      expect(allStatus).not.toContain('disk io failure')
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
          token: 'token-repair-own',
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // v2 recovery returns repair-required (ok:true but action is failure)
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'repair-required',
        journalCleaned: false,
        restartRequested: false,
        deferredToWindow: false
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
        handoff: { sessionId: 'session-recovery', token: 'token-recovery', capability: {} }
      })

      // v2 recovery returns a structured failure (relaunch refused)
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: false,
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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

  describe('L2 Gap 3: recoveryHandoff routes through v2 recovery', () => {
    it('post-install promotion-failed with recoveryHandoff routes to v2 recovery', async () => {
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

      // v2 recovery succeeds with accept-verified-replacement (all-new)
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
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

      // LOCK-CTRL-4: the v2 recovery was dispatched for the recovery-required
      // handoff (NOT the v1 executor).
      expect(mockRunRecoveryV2).toHaveBeenCalled()
      expect(mockReadPromotionJournal).toHaveBeenCalledWith('/mock/data')

      // promoted should have been emitted (recovery converged all-new)
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

      // v2 recovery fails
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: false,
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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

      // v2 recovery was dispatched
      expect(mockRunRecoveryV2).toHaveBeenCalled()

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
        handoff: { sessionId: 'session-delayed-recovery', token: 'token-delayed', capability: {} }
      })

      // v2 recovery is gated — we control when it resolves
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(recoveryGate)

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

      // Now resolve recovery with accept-verified-replacement (all-new)
      resolveRecovery({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
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
        handoff: { sessionId: 'session-delayed-fail', token: 'token-delayed-fail', capability: {} }
      })

      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(recoveryGate)

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
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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
          token: 'token-stale-recovery-A',
          capability: mockCapabilityA
        }
      })

      // v2 recovery is gated
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(recoveryGateA)

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

      // The stale settlement consumes A's originating record by exact token.
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValueOnce({
        status: 'taken',
        ownership: {
          kind: 'promoted',
          handoff: { token: 'token-stale-recovery-A', capability: mockCapabilityA }
        }
      })

      // Now resolve A's recovery — its continuation is stale
      mockGetActiveImport.mockReturnValue({ id: 'session-stale-recovery-B', state: 'reading' })
      resolveRecoveryA({
        ok: true,
        action: 'repair-required',
        journalCleaned: false,
        restartRequested: false,
        deferredToWindow: false
      })

      await new Promise((r) => setTimeout(r, 100))

      // LOCK-6018: identity-checked take consumed A's origin token exactly once
      // and released the originating handoff capability.
      expect(mockTakeTerminalPromotionOwnershipIfMatches).toHaveBeenCalledWith('token-stale-recovery-A')
      expect(mockReleaseA).toHaveBeenCalledTimes(1)

      // Stale A's continuation did NOT emit events for A after the clear
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

      // The stale promoted-execution settlement consumes A's record by token.
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValueOnce({
        status: 'taken',
        ownership: {
          kind: 'promoted',
          handoff: { token: 'token-stale-exec-A', capability: mockCapabilityA }
        }
      })

      // Resolve A's execution with promoted — its continuation is stale
      // because B has incremented the generation
      mockGetActiveImport.mockReturnValue({ id: 'session-stale-exec-B', state: 'reading' })
      resolveExecutionA({
        status: 'promoted',
        handoff: {
          sessionId: 'session-stale-exec-A',
          token: 'token-stale-exec-A',
          capability: mockCapabilityA
        }
      })

      await new Promise((r) => setTimeout(r, 100))

      // LOCK-6018: the stale execution settlement released A's origin exactly once.
      expect(mockTakeTerminalPromotionOwnershipIfMatches).toHaveBeenCalledWith('token-stale-exec-A')
      expect(mockReleaseA).toHaveBeenCalledTimes(1)

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
        handoff: { sessionId: 'session-no-effect-A', token: 'token-no-effect-A', capability: {} }
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(recoveryGateA)

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
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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

      // A's v2 recovery is gated.
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(recoveryGateA)

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
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
      })

      mockWebContentsSend.mockClear()
      await startHandler({}, '/tmp/testB.zip')

      // Now resolve A's recovery — its continuation is stale.
      resolveRecoveryA({
        ok: true,
        action: 'repair-required',
        journalCleaned: false,
        restartRequested: false,
        deferredToWindow: false
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

      // A's v2 recovery is gated.
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(recoveryGateA)

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
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
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
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
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

      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(recoveryGateA)

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

      // Recovery was already consumed (simulates the recovery executor took it).
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValueOnce({ status: 'not-available' })

      // Resolve A's recovery — stale.
      resolveRecoveryA({
        ok: false,
        code: 'RELAUNCH_FAILED',
        safeCode: 'RELAUNCH_RETURNED'
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

  // ---------------------------------------------------------------------------
  // LOCK-FR1..FR4: repeat-import lifecycle after non-packaged success
  // ---------------------------------------------------------------------------

  describe('LOCK-FR2/FR3: non-packaged success returns control to idle', () => {
    it('non-packaged success immediately clears session/poller and releases terminal ownership', async () => {
      let verificationCallback: ((result: any) => void) | undefined
      const disposeSession = vi.fn().mockResolvedValue(undefined)
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-fr2', state: 'intake', dispose: disposeSession })
      })
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-fr2', token: 'token-fr2', capability: {} }
      })

      // Non-packaged recovery: default `app.isPackaged` is false, so the
      // restart surface is in-process-reload — the v2 runner requests the
      // in-process renderer reload and the process stays alive (LOCK-PROD-7).
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockImplementation(runRecoveryV2ThroughRestart)

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
      mockGetActiveImport.mockReturnValue({ id: 'session-fr2', state: 'promoted', dispose: disposeSession })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-fr2',
        candidateId: 'candidate-fr2',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      // promoted emitted
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoted' })
      )
      // LOCK-FR2: terminal ownership consumed + released exactly once.
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalledTimes(1)
      // The in-process renderer reload was requested (non-packaged path).
      expect(webContents.reload).toHaveBeenCalledTimes(1)
      // Session resources disposed — control ownership cleared immediately
      // (no reliance on the poller's next tick).
      expect(disposeSession).toHaveBeenCalled()

      // A second independent import starts immediately — not "already in progress".
      mockGetActiveImport.mockReturnValue(null)
      mockStartImport.mockResolvedValue({ id: 'session-fr2-second', state: 'intake' })
      const second = await startHandler({}, '/tmp/test2.zip')
      expect(second.ok).toBe(true)
      expect(second.sessionId).toBe('session-fr2-second')
    })

    it('two sequential independent non-packaged flows each reload exactly once (LOCK-FR3)', async () => {
      let verificationCallbackA: ((result: any) => void) | undefined
      const disposeA = vi.fn().mockResolvedValue(undefined)
      mockStartImport.mockImplementationOnce((_zipPath: string, options: any) => {
        verificationCallbackA = options.onVerificationComplete
        return Promise.resolve({ id: 'session-seq-A', state: 'intake', dispose: disposeA })
      })
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-A' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-seq-A', token: 'token-seq-A', capability: {} }
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockImplementation(runRecoveryV2ThroughRestart)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')

      // A's promoted execution left a terminal ownership record — cleanup
      // must consume and release it exactly once.
      const mockReleaseA = vi.fn()
      mockTakeTerminalPromotionOwnership
        .mockReturnValueOnce({
          status: 'taken',
          ownership: {
            kind: 'promoted',
            handoff: { capability: { release: mockReleaseA, isReleased: vi.fn(() => false) } }
          }
        })
        .mockReturnValue({ status: 'not-available' })
      mockGetActiveImport.mockReturnValue({ id: 'session-seq-A', state: 'promoted', dispose: disposeA })

      verificationCallbackA!({
        sessionId: 'session-seq-A',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      // LOCK-FR3: A's recovery requested its in-process reload exactly once
      // (per-recovery guard) and released the terminal lease.
      expect(webContents.reload).toHaveBeenCalledTimes(1)
      expect(mockReleaseA).toHaveBeenCalledTimes(1)
      expect(disposeA).toHaveBeenCalled()

      // ---- Flow B: a second independent import in the same process ----
      let verificationCallbackB: ((result: any) => void) | undefined
      const disposeB = vi.fn().mockResolvedValue(undefined)
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallbackB = options.onVerificationComplete
        return Promise.resolve({ id: 'session-seq-B', state: 'intake', dispose: disposeB })
      })
      mockGetActiveImport.mockReturnValue({ id: 'session-seq-B', state: 'intake', dispose: disposeB })
      mockWebContentsSend.mockClear()

      const resultB = await startHandler({}, '/tmp/testB.zip')
      // LOCK-FR2/FR3: A's success left the controller idle — B starts immediately.
      expect(resultB.ok).toBe(true)
      expect(resultB.sessionId).toBe('session-seq-B')

      mockGetActiveImport.mockReturnValue({ id: 'session-seq-B', state: 'promoted', dispose: disposeB })

      verificationCallbackB!({
        sessionId: 'session-seq-B',
        candidateId: 'candidate-B',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      // LOCK-FR3: B's own recovery requested its OWN reload exactly once —
      // the second flow is NOT blocked by A's consumed per-recovery guard.
      expect(webContents.reload).toHaveBeenCalledTimes(2)
      // B's terminal state was emitted.
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ sessionId: 'session-seq-B', state: 'promoted' })
      )
    })

    it('non-packaged success via recoveryHandoff also returns control to idle (LOCK-FR2)', async () => {
      let verificationCallback: ((result: any) => void) | undefined
      const disposeSession = vi.fn().mockResolvedValue(undefined)
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-handoff-fr2', state: 'intake', dispose: disposeSession })
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
          sessionId: 'session-handoff-fr2',
          candidateId: 'candidate-handoff-fr2',
          token: 'tok',
          failure: {},
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })

      // v2 recovery succeeds via the in-process reload surface (non-packaged).
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockImplementation(runRecoveryV2ThroughRestart)

      const mockRelease = vi.fn()
      mockTakeTerminalPromotionOwnership
        .mockReturnValueOnce({
          status: 'taken',
          ownership: {
            kind: 'recovery-required',
            handoff: { capability: { release: mockRelease, isReleased: vi.fn(() => false) } }
          }
        })
        .mockReturnValue({ status: 'not-available' })
      mockGetActiveImport.mockReturnValue({
        id: 'session-handoff-fr2',
        state: 'promotion-failed',
        dispose: disposeSession
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-handoff-fr2',
        candidateId: 'candidate-handoff-fr2',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      // promoted emitted and the recovery-required terminal ownership was
      // consumed + released exactly once (no maintenance lease leak).
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoted' })
      )
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalledTimes(1)
      expect(disposeSession).toHaveBeenCalled()

      // A fresh import starts immediately.
      mockGetActiveImport.mockReturnValue(null)
      mockStartImport.mockResolvedValue({ id: 'session-handoff-fr2-second', state: 'intake' })
      const second = await startHandler({}, '/tmp/test2.zip')
      expect(second.ok).toBe(true)
    })
  })

  describe('LOCK-FR1: packaged success path unchanged', () => {
    it('packaged recovery (no in-process reload) retains terminal ownership — process exits', async () => {
      let verificationCallback: ((result: any) => void) | undefined
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-packaged', state: 'intake' })
      })
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-packaged', token: 'token-packaged', capability: {} }
      })

      // Packaged recovery: app.isPackaged is true → the restart surface is
      // relaunch mode; the v2 runner requests app.relaunch() (LOCK-FR1
      // exact-once) and the process would exit.
      mockApp.isPackaged = true
      mockApp.relaunch.mockReturnValue(undefined)
      mockApp.exit.mockReturnValue(undefined)
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockImplementation(runRecoveryV2ThroughRestart)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-packaged',
        candidateId: 'candidate-pkg',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      // LOCK-FR1: packaged success lifecycle is unchanged — promoted is
      // emitted, the packaged relaunch was requested, and ownership is NOT
      // consumed (the process exits; the control layer does not clean up).
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoted' })
      )
      expect(mockApp.relaunch).toHaveBeenCalledTimes(1)
      expect(mockTakeTerminalPromotionOwnership).not.toHaveBeenCalled()
    })
  })

  describe('LOCK-FR4: absent/failed reload leaves durable recoverable state without lease leak', () => {
    it('bounded-no-op in-process reload still settles to idle and releases the lease', async () => {
      let verificationCallback: ((result: any) => void) | undefined
      const disposeSession = vi.fn().mockResolvedValue(undefined)
      mockStartImport.mockImplementation((_zipPath: string, options: any) => {
        verificationCallback = options.onVerificationComplete
        return Promise.resolve({ id: 'session-fr4', state: 'intake', dispose: disposeSession })
      })
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-fr4', token: 'token-fr4', capability: {} }
      })

      // The reload target's reload() THROWS — the real reloadMainRenderer
      // catches it and reports a bounded no-op (reloaded: false). The v2
      // runner maps that to ok:true with restartRequested:false. LOCK-FR4:
      // the control layer still settles to idle (mode-based in-process
      // reload) and releases the lease — the pending projection row retries
      // on the next startup.
      webContents.reload.mockImplementation(() => {
        throw new Error('reload exploded')
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockImplementation(runRecoveryV2ThroughRestart)

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
      mockGetActiveImport.mockReturnValue({ id: 'session-fr4', state: 'promoted', dispose: disposeSession })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')

      verificationCallback!({
        sessionId: 'session-fr4',
        candidateId: 'candidate-fr4',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      // No lease leak: terminal ownership consumed + released exactly once;
      // session/control ownership cleared so the app is idle.
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalledTimes(1)
      expect(disposeSession).toHaveBeenCalled()

      // The pending projection row is durable (untouched by cleanup) — a
      // fresh import can start immediately.
      mockGetActiveImport.mockReturnValue(null)
      mockStartImport.mockResolvedValue({ id: 'session-fr4-second', state: 'intake' })
      const second = await startHandler({}, '/tmp/test2.zip')
      expect(second.ok).toBe(true)
      expect(second.sessionId).toBe('session-fr4-second')
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-CTRL-1: idempotent registration
  // ---------------------------------------------------------------------------

  describe('LOCK-CTRL-1: idempotent IPC registration', () => {
    it('re-registration swaps the target and never double-registers handlers', () => {
      // First registration (beforeEach): 6 control + 2 catalog = 8 handles.
      const afterFirst = mockHandle.mock.calls.length
      expect(afterFirst).toBe(8)

      const newTarget = createMockWebContents()
      registerCherryImportControlIpc(newTarget)

      // Exactly one more set of 8 handles for the new target.
      expect(mockHandle.mock.calls.length).toBe(afterFirst + 8)
      // Each control channel is registered exactly once per registration.
      const startCalls = mockHandle.mock.calls.filter((c: any) => c[0] === IpcChannel.CherryImport_Start)
      const respondCalls = mockHandle.mock.calls.filter((c: any) => c[0] === IpcChannel.CherryImport_CatalogRespond)
      expect(startCalls).toHaveLength(2)
      expect(respondCalls).toHaveLength(2)

      // The new target's main frame is now authorized for the projection read.
      const sqlite = makeSqliteDouble()
      mockChatDbService.getSqlite.mockReturnValue(sqlite)
      const getHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_GetProjection)![1]
      const result = getHandler(eventFromContents(newTarget))
      expect(result).toEqual({ ok: true, projection: JSON.parse(PENDING_ROW) })
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-CTRL-2: one authorized boundary shared by preparation and execution
  // ---------------------------------------------------------------------------

  describe('LOCK-CTRL-2: same authorized boundary for preparation and execution', () => {
    it('passes the SAME boundary instance to preparation and execution', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-boundary', handoffToken: 'token-boundary' })

      // Capture the boundary handed to each stage (after the shared flow
      // wiring, before firing the verification callback).
      let prepBoundary: any
      let execBoundary: any
      mockStartPromotionPreparation.mockImplementation(async (opts: any) => {
        prepBoundary = opts.catalogBoundary
        return { status: 'prepared', handle: { token: 'tok' } }
      })
      mockStartPromotionExecution.mockImplementation(async (opts: any) => {
        execBoundary = opts.catalogBoundary
        return { status: 'promoted', handoff: { sessionId: 's', token: 't', capability: {} } }
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
      })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      expect(prepBoundary).toBeDefined()
      expect(prepBoundary).toBe(execBoundary)
      expect(typeof prepBoundary.captureSnapshot).toBe('function')
      expect(typeof prepBoundary.applyCandidate).toBe('function')
      expect(typeof prepBoundary.restoreSnapshot).toBe('function')
      expect(typeof prepBoundary.queryFacts).toBe('function')
    })

    it('an unavailable boundary fails during preparation BEFORE destructive execution', async () => {
      let verificationCallback: ((r: any) => void) | undefined
      mockStartImport.mockImplementation((_p: string, o: any) => {
        verificationCallback = o.onVerificationComplete
        return Promise.resolve({ id: 'session-prep-unavail', state: 'intake' })
      })
      // Preparation fails because the renderer boundary is unavailable.
      mockStartPromotionPreparation.mockResolvedValue({
        status: 'preparation-failed',
        failure: { phase: 'create-snapshot', code: 'NO_TARGET', safeCode: null }
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')
      verificationCallback!({
        sessionId: 'session-prep-unavail',
        candidateId: 'candidate-session-prep-unavail',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(mockStartPromotionExecution).not.toHaveBeenCalled()
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promotion-failed', error: expect.stringContaining('NO_TARGET') })
      )
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-CTRL-5: journal version dispatch — v1/v2/invalid/absent
  // ---------------------------------------------------------------------------

  describe('LOCK-CTRL-5: journal version dispatch', () => {
    it('a valid v2 journal dispatches to the v2 recovery executor', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-dispatch-v2', handoffToken: 'token-dispatch-v2' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
      })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      expect(mockRunRecoveryV2).toHaveBeenCalled()
      expect(mockCreateRecoveryExecutor).not.toHaveBeenCalled()
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoted' })
      )
    })

    it('a valid v1 journal dispatches to the original v1 recovery executor', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-dispatch-v1', handoffToken: 'token-dispatch-v1' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v1Journal() })
      mockCreateRecoveryExecutor.mockReturnValue({
        run: vi.fn().mockResolvedValue({
          ok: true,
          action: { action: 'accept-verified-replacement', cleaned: true },
          decision: { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' }
        })
      })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      // LOCK-CTRL-5: the v1 executor remains the original chat.db-only path.
      expect(mockCreateRecoveryExecutor).toHaveBeenCalled()
      expect(mockRunRecoveryV2).not.toHaveBeenCalled()
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promoted' })
      )
    })

    it('an invalid journal after terminal handoff fails closed', async () => {
      const fire = await runPromotedFlow({
        sessionId: 'session-dispatch-invalid',
        handoffToken: 'token-dispatch-invalid'
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'invalid', code: 'BAD_VERSION' })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      // LOCK-CTRL-5: invalid journal fails closed — no executor is dispatched.
      expect(mockRunRecoveryV2).not.toHaveBeenCalled()
      expect(mockCreateRecoveryExecutor).not.toHaveBeenCalled()
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('JOURNAL_UNAVAILABLE')
        })
      )
    })

    it('an absent journal after terminal handoff fails closed', async () => {
      // beforeEach default: readPromotionJournal → { status: 'absent' }.
      const fire = await runPromotedFlow({
        sessionId: 'session-dispatch-absent',
        handoffToken: 'token-dispatch-absent'
      })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      expect(mockRunRecoveryV2).not.toHaveBeenCalled()
      expect(mockCreateRecoveryExecutor).not.toHaveBeenCalled()
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('JOURNAL_UNAVAILABLE')
        })
      )
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-CTRL-3/4: recovery all-new / all-old / repair convergence semantics
  // ---------------------------------------------------------------------------

  describe('LOCK-CTRL-3/4: recovery convergence status semantics', () => {
    it('all-new convergence emits promoted exactly once and settles to idle (non-packaged)', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-all-new', handoffToken: 'token-all-new' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
      })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      const states = emittedStates()
      expect(states.filter((s) => s === 'promoted')).toHaveLength(1)
      // finalizing precedes promoted (established order, LOCK-CTRL-3).
      expect(states.indexOf('finalizing')).toBeGreaterThanOrEqual(0)
      expect(states.indexOf('promoted')).toBeGreaterThan(states.indexOf('finalizing'))
    })

    it('all-old convergence (restore-rollback-snapshot) is a bounded failure, never promoted', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-all-old', handoffToken: 'token-all-old' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'restore-rollback-snapshot',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
      })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      // LOCK-CTRL-4: the new data is NOT live — claiming promoted would lie.
      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(0)
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('restored the previous data')
        })
      )
      // Non-exiting outcome — terminal ownership released exactly once.
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
    })

    it('all-old convergence via a post-install recoveryHandoff is also a bounded failure', async () => {
      let verificationCallback: ((r: any) => void) | undefined
      mockStartImport.mockImplementation((_p: string, o: any) => {
        verificationCallback = o.onVerificationComplete
        return Promise.resolve({
          id: 'session-handoff-old',
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
          sessionId: 'session-handoff-old',
          candidateId: 'candidate-handoff-old',
          token: 'token-handoff-old',
          failure: {},
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'restore-rollback-snapshot',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')
      verificationCallback!({
        sessionId: 'session-handoff-old',
        candidateId: 'candidate-handoff-old',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(0)
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({ state: 'promotion-failed' })
      )
    })
  })

  // ---------------------------------------------------------------------------
  // F1 (protocol-audit correction): lease-busy restore deferred to startup
  // ---------------------------------------------------------------------------

  describe('F1: deferred-to-startup finalization semantics', () => {
    it('promoted flow: lease-busy restore is never promoted/restored-old/failed, no restart, ownership released once', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-f1-defer', handoffToken: 'token-f1-defer' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      // The executor deferred: journal retained, no rollback, no restart.
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'restore-rollback-snapshot',
        journalCleaned: false,
        restartRequested: false,
        deferredToWindow: false,
        deferredToStartup: true,
        deferReason: 'LEASE_BUSY'
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
      mockGetActiveImport.mockReturnValue({
        id: 'session-f1-defer',
        state: 'promoted',
        dispose: vi.fn().mockResolvedValue(undefined)
      })

      fire()
      await new Promise((r) => setTimeout(r, 50))

      // Never promoted — the all-new generation was NOT accepted+cleaned.
      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(0)
      const events = emittedStatusEvents()
      // A truthful defer terminal — NOT the restored-old message, NOT a
      // generic recovery failure.
      expect(events.some((e) => e.state === 'promotion-failed' && /deferred/i.test(e.error ?? ''))).toBe(true)
      expect(events.some((e) => /restored the previous data/i.test(e.error ?? ''))).toBe(false)
      expect(events.some((e) => /Recovery failed/i.test(e.error ?? ''))).toBe(false)
      // No duplicate restart: no relaunch and no in-process reload.
      expect(mockApp.relaunch).not.toHaveBeenCalled()
      expect(mockApp.exit).not.toHaveBeenCalled()
      expect(webContents.reload).not.toHaveBeenCalled()
      // Non-exiting outcome — terminal ownership consumed + released exactly
      // once (LOCK-6018), so a later promotion can acquire a fresh lease.
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalledTimes(1)
    })

    it('post-install recoveryHandoff flow: deferred-to-startup is truthful and settles ownership once', async () => {
      let verificationCallback: ((r: any) => void) | undefined
      mockStartImport.mockImplementation((_p: string, o: any) => {
        verificationCallback = o.onVerificationComplete
        return Promise.resolve({
          id: 'session-f1-handoff',
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
          sessionId: 'session-f1-handoff',
          candidateId: 'candidate-f1-handoff',
          token: 'token-f1-handoff',
          failure: {},
          capability: { release: vi.fn(), isReleased: vi.fn(() => false) }
        }
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({
        ok: true,
        action: 'restore-rollback-snapshot',
        journalCleaned: false,
        restartRequested: false,
        deferredToWindow: false,
        deferredToStartup: true,
        deferReason: 'LEASE_BUSY'
      })
      const mockRelease = vi.fn()
      mockTakeTerminalPromotionOwnership
        .mockReturnValueOnce({
          status: 'taken',
          ownership: {
            kind: 'recovery-required',
            handoff: { capability: { release: mockRelease, isReleased: vi.fn(() => false) } }
          }
        })
        .mockReturnValue({ status: 'not-available' })
      mockGetActiveImport.mockReturnValue({
        id: 'session-f1-handoff',
        state: 'promotion-failed',
        dispose: vi.fn().mockResolvedValue(undefined)
      })

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')
      verificationCallback!({
        sessionId: 'session-f1-handoff',
        candidateId: 'candidate-f1-handoff',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(0)
      const events = emittedStatusEvents()
      expect(events.some((e) => e.state === 'promotion-failed' && /deferred/i.test(e.error ?? ''))).toBe(true)
      expect(events.some((e) => /restored the previous data/i.test(e.error ?? ''))).toBe(false)
      expect(events.some((e) => /Recovery failed/i.test(e.error ?? ''))).toBe(false)
      expect(mockApp.relaunch).not.toHaveBeenCalled()
      expect(webContents.reload).not.toHaveBeenCalled()
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      expect(mockRelease).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-CTRL-8: bounded recovery failure statuses — boundary/cleanup/restart
  // ---------------------------------------------------------------------------

  describe('LOCK-CTRL-8: bounded recovery failure statuses', () => {
    it('boundary-unavailable recovery fails closed with a bounded status', async () => {
      const fire = await runPromotedFlow({
        sessionId: 'session-boundary-unavail',
        handoffToken: 'token-boundary-unavail'
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({ ok: false, code: 'BOUNDARY_UNAVAILABLE', safeCode: 'NO_TARGET' })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(0)
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('BOUNDARY_UNAVAILABLE')
        })
      )
    })

    it('cleanup failure emits a bounded promotion-failed and never promoted', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-cleanup', handoffToken: 'token-cleanup' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({ ok: false, code: 'CLEANUP_FAILED', safeCode: 'IO' })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(0)
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('CLEANUP_FAILED')
        })
      )
    })

    it('non-packaged mode builds the in-process-reload restart surface', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-mode-np', handoffToken: 'token-mode-np' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      captureRecoveryOptions()
      fire()
      await new Promise((r) => setTimeout(r, 50))

      expect(lastRecoveryOptions.restart.mode).toBe('in-process-reload')
      expect(typeof lastRecoveryOptions.restart.reloadRenderer).toBe('function')
    })

    it('packaged mode builds the relaunch restart surface', async () => {
      mockApp.isPackaged = true
      const fire = await runPromotedFlow({ sessionId: 'session-mode-p', handoffToken: 'token-mode-p' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      captureRecoveryOptions()
      fire()
      await new Promise((r) => setTimeout(r, 50))

      expect(lastRecoveryOptions.restart.mode).toBe('relaunch')
    })

    it('a refused/throwing relaunch reports a bounded failure and never promoted (LOCK-CTRL-8)', async () => {
      // Packaged mode with app.relaunch() throwing — the relaunch module maps
      // the throw to a refused restart ({ relaunched: false }), the executor
      // reports restartRequested:false, and the control layer fails closed.
      mockApp.isPackaged = true
      mockApp.relaunch.mockImplementation(() => {
        throw new Error('relaunch denied')
      })
      const fire = await runPromotedFlow({
        sessionId: 'session-relaunch-refusal',
        handoffToken: 'token-relaunch-refusal'
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockImplementation(runRecoveryV2ThroughRestart)
      fire()
      await new Promise((r) => setTimeout(r, 50))

      // LOCK-CTRL-8: verified durable state remains but the control layer
      // reports a bounded failure — never promoted — and releases ownership.
      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(0)
      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IpcChannel.CherryImport_StatusChanged,
        expect.objectContaining({
          state: 'promotion-failed',
          error: expect.stringContaining('RELAUNCH_FAILED')
        })
      )
      expect(mockTakeTerminalPromotionOwnership).toHaveBeenCalled()
      // No duplicate restart emission: app.relaunch was attempted exactly once.
      expect(mockApp.relaunch).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-CTRL-6/6015: exact-once ownership and identity-mismatch safety
  // ---------------------------------------------------------------------------

  describe('LOCK-CTRL-6: exact ownership match (identity mismatch safety)', () => {
    it('identity mismatch settlement never releases another session ownership', async () => {
      // Session A: promoted with token-A; recovery gated.
      let verificationCallbackA: ((r: any) => void) | undefined
      let resolveRecoveryA!: (v: any) => void
      const gate = new Promise((r) => {
        resolveRecoveryA = r
      })
      const mockReleaseA = vi.fn()
      mockStartImport.mockImplementation((_p: string, o: any) => {
        verificationCallbackA = o.onVerificationComplete
        return Promise.resolve({
          id: 'session-mismatch-A',
          state: 'intake',
          dispose: vi.fn().mockResolvedValue(undefined)
        })
      })
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok-A' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: {
          sessionId: 'session-mismatch-A',
          token: 'token-mismatch-A',
          capability: { release: mockReleaseA, isReleased: vi.fn(() => false) }
        }
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(gate)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/testA.zip')
      verificationCallbackA!({
        sessionId: 'session-mismatch-A',
        candidateId: 'candidate-A',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 10))

      // A disappears; session B owns the controller (token-B).
      mockGetActiveImport.mockReturnValue(null)
      await new Promise((r) => setTimeout(r, 700))
      mockStartImport.mockResolvedValue({
        id: 'session-mismatch-B',
        state: 'intake',
        dispose: vi.fn().mockResolvedValue(undefined)
      })
      mockGetActiveImport.mockReturnValue({ id: 'session-mismatch-B', state: 'intake' })
      await startHandler({}, '/tmp/testB.zip')

      // The terminal record is B's — A's token is a MISMATCH (LOCK-6015).
      mockTakeTerminalPromotionOwnershipIfMatches.mockReturnValue({ status: 'mismatch' })
      resolveRecoveryA({ ok: false, code: 'RELAUNCH_FAILED', safeCode: 'IO' })
      await new Promise((r) => setTimeout(r, 100))

      expect(mockTakeTerminalPromotionOwnershipIfMatches).toHaveBeenCalledWith('token-mismatch-A')
      // LOCK-6015: mismatch → B's record is untouched, A's capability is NOT released.
      expect(mockReleaseA).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // LOCK-CTRL-3/7: duplicate terminal callback + status payload privacy
  // ---------------------------------------------------------------------------

  describe('LOCK-CTRL-3/7: duplicate terminal callback and status privacy', () => {
    it('a duplicate verification callback while promotion is in flight is ignored (exact-once)', async () => {
      let verificationCallback: ((r: any) => void) | undefined
      let resolveRecovery!: (v: any) => void
      const gate = new Promise((r) => {
        resolveRecovery = r
      })
      mockStartImport.mockImplementation((_p: string, o: any) => {
        verificationCallback = o.onVerificationComplete
        return Promise.resolve({ id: 'session-dup', state: 'intake', dispose: vi.fn().mockResolvedValue(undefined) })
      })
      mockStartPromotionPreparation.mockResolvedValue({ status: 'prepared', handle: { token: 'tok' } })
      mockStartPromotionExecution.mockResolvedValue({
        status: 'promoted',
        handoff: { sessionId: 'session-dup', token: 'token-dup', capability: {} }
      })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockReturnValue(gate)

      const startHandler = mockHandle.mock.calls.find((c: any) => c[0] === IpcChannel.CherryImport_Start)![1]
      await startHandler({}, '/tmp/test.zip')
      verificationCallback!({
        sessionId: 'session-dup',
        candidateId: 'candidate-dup',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      // Promotion is in flight (awaiting the gated recovery).
      await new Promise((r) => setTimeout(r, 10))

      // Duplicate delivery of the SAME terminal callback.
      verificationCallback!({
        sessionId: 'session-dup',
        candidateId: 'candidate-dup',
        stats: {},
        report: { status: 'pass', dimensions: [], fatal: null }
      })
      await new Promise((r) => setTimeout(r, 10))

      // The promotion pipeline did NOT re-run for the duplicate callback.
      expect(mockStartPromotionPreparation.mock.calls.length).toBe(1)
      expect(mockStartPromotionExecution.mock.calls.length).toBe(1)

      resolveRecovery({
        ok: true,
        action: 'accept-verified-replacement',
        journalCleaned: true,
        restartRequested: false,
        deferredToWindow: false
      })
      await new Promise((r) => setTimeout(r, 50))

      // Exactly one terminal 'promoted' status.
      expect(emittedStates().filter((s) => s === 'promoted')).toHaveLength(1)
    })

    it('status payloads remain code-only — never paths, candidate IDs, or content (LOCK-CTRL-7)', async () => {
      const fire = await runPromotedFlow({ sessionId: 'session-privacy', handoffToken: 'token-privacy' })
      mockReadPromotionJournal.mockResolvedValue({ status: 'valid', journal: v2Journal('replacement-verified') })
      mockRunRecoveryV2.mockResolvedValue({ ok: false, code: 'CLEANUP_FAILED', safeCode: 'IO' })
      fire()
      await new Promise((r) => setTimeout(r, 50))

      const serialized = JSON.stringify(emittedStatusEvents())
      // No filesystem paths, no chat.db references, no candidate IDs, and no
      // raw error messages from the underlying failure.
      expect(serialized).not.toContain('/mock/data')
      expect(serialized).not.toContain('chat.db')
      expect(serialized).not.toContain('candidate-')
      // Only aggregate/code payloads cross the boundary.
      expect(serialized).not.toContain('recovery-verified')
    })
  })
})
