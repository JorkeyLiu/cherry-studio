/**
 * importIpc tests.
 *
 * Covers:
 * - 5 handlers register (Ready handle, Discover handle, ReadPage handle, Complete on, Error on)
 * - Identity rejection (wrong sender)
 * - Disposer removes only registered listeners
 * - Malformed envelope rejection
 * - Phase validation per channel
 * - DiscoveryResult / ReadPageResponse shape validation
 * - nativeVersion >= 120 rejection
 * - Callback invocation
 *
 * Pattern follows src/main/services/chatDb/__tests__/ipc.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron's ipcMain
const { handlers, onListeners, mockHandle, mockOn, mockRemoveHandler, mockRemoveAllListeners } = vi.hoisted(() => {
  const h = new Map<string, (...args: any[]) => any>()
  const o = new Map<string, (...args: any[]) => any>()
  return {
    handlers: h,
    onListeners: o,
    mockHandle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      h.set(channel, handler)
    }),
    mockOn: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      o.set(channel, handler)
    }),
    mockRemoveHandler: vi.fn((channel: string) => {
      h.delete(channel)
    }),
    mockRemoveAllListeners: vi.fn((channel: string) => {
      o.delete(channel)
    })
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle,
    on: mockOn,
    removeHandler: mockRemoveHandler,
    removeAllListeners: mockRemoveAllListeners
  }
}))

// Per-context logger mock registry (same pattern as index.test.ts): each
// module context gets its own cached info/warn/error/debug mock so tests can
// assert on the 'chatDbImport' context logs deterministically.
const loggerHoisted = vi.hoisted(() => {
  const contexts = new Map<
    string,
    {
      info: ReturnType<typeof vi.fn>
      warn: ReturnType<typeof vi.fn>
      error: ReturnType<typeof vi.fn>
      debug: ReturnType<typeof vi.fn>
    }
  >()
  return {
    withContext: (name: string) => {
      let ctx = contexts.get(name)
      if (!ctx) {
        ctx = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
        contexts.set(name, ctx)
      }
      return ctx
    }
  }
})

// Mock loggerService
vi.mock('@logger', () => ({
  loggerService: {
    withContext: loggerHoisted.withContext
  }
}))

// Mock isolatedSession
const { mockGetActiveReader } = vi.hoisted(() => ({
  mockGetActiveReader: vi.fn((): any => null)
}))

vi.mock('../isolatedSession', () => ({
  getActiveReader: mockGetActiveReader
}))

import { IpcChannel } from '@shared/IpcChannel'

import { ChatImportDataPlaneError } from '../importDataPlane'
import { registerChatImportIpc } from '../importIpc'

/** Helper to create a mock active reader with matching mainFrame. */
function makeReader(sessionId = 'test') {
  const mainFrame = { id: 1 }
  return {
    sessionId,
    window: {
      webContents: {
        mainFrame,
        send: vi.fn()
      }
    },
    mainFrame
  }
}

/** Helper to create a sender event with a given frame. */
function makeEvent(frame: any) {
  return { senderFrame: frame, sender: { send: vi.fn() } }
}

describe('ChatImport IPC Registration', () => {
  let disposer: () => void

  beforeEach(() => {
    handlers.clear()
    onListeners.clear()
    vi.clearAllMocks()
    mockGetActiveReader.mockReturnValue(null)
  })

  afterEach(() => {
    if (disposer) disposer()
  })

  // =========================================================================
  // Handler count
  // =========================================================================

  describe('handler registration', () => {
    it('registers 3 handle handlers (Ready, Discover, ReadPage) and 3 on listeners (Complete, Error, Projection)', () => {
      disposer = registerChatImportIpc()

      // ipcMain.handle called for Ready, Discover, ReadPage
      expect(mockHandle).toHaveBeenCalledTimes(3)
      // ipcMain.on called for Complete, Error, Projection (LOCK-PROD-2/6)
      expect(mockOn).toHaveBeenCalledTimes(3)
    })

    it('registers handle for the expected channels', () => {
      disposer = registerChatImportIpc()

      expect(handlers.has(IpcChannel.ChatImport_Ready)).toBe(true)
      expect(handlers.has(IpcChannel.ChatImport_Discover)).toBe(true)
      expect(handlers.has(IpcChannel.ChatImport_ReadPage)).toBe(true)
    })

    it('registers on listeners for Complete, Error and Projection', () => {
      disposer = registerChatImportIpc()

      expect(onListeners.has(IpcChannel.ChatImport_Complete)).toBe(true)
      expect(onListeners.has(IpcChannel.ChatImport_Error)).toBe(true)
    })
  })

  // =========================================================================
  // Disposer
  // =========================================================================

  describe('disposer', () => {
    it('removes all registered handlers and listeners', () => {
      disposer = registerChatImportIpc()

      const handleCount = handlers.size
      const onCount = onListeners.size
      expect(handleCount).toBeGreaterThan(0)
      expect(onCount).toBeGreaterThan(0)

      disposer()

      expect(mockRemoveHandler).toHaveBeenCalledTimes(handleCount)
      expect(mockRemoveAllListeners).toHaveBeenCalledTimes(onCount)
      expect(handlers.size).toBe(0)
      expect(onListeners.size).toBe(0)
    })

    it('stale disposer is a no-op', () => {
      const disposer1 = registerChatImportIpc()
      // Re-register (disposes first)
      disposer = registerChatImportIpc()

      // Try to use stale disposer
      disposer1()

      // Should have only removed handlers for the second registration
      expect(handlers.size).toBeGreaterThan(0)
    })

    it('re-registration disposes prior registration', () => {
      disposer = registerChatImportIpc()
      const firstHandleCount = handlers.size

      // Re-register
      disposer = registerChatImportIpc()

      // The prior registration was disposed, then new one installed
      expect(mockRemoveHandler).toHaveBeenCalled()
      expect(handlers.size).toBe(firstHandleCount)
    })
  })

  // =========================================================================
  // Identity validation (R-9)
  // =========================================================================

  describe('identity validation', () => {
    it('rejects Ready when no active reader exists', async () => {
      disposer = registerChatImportIpc()

      mockGetActiveReader.mockReturnValue(null)
      const handler = handlers.get(IpcChannel.ChatImport_Ready)!

      const result = await handler({ senderFrame: { id: 1 } }, 'test-session')

      expect(result).toEqual({ ok: false, error: 'Sender identity mismatch' })
    })

    it('rejects Ready when sender frame does not match', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Ready)!
      const result = await handler({ senderFrame: { id: 999 } }, 'test-session')

      expect(result).toEqual({ ok: false, error: 'Sender identity mismatch' })
    })

    it('accepts Ready when sender frame matches', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Ready)!
      const result = await handler(makeEvent(reader.mainFrame), 'test-session')

      expect(result).toEqual({ ok: true })
    })

    it('rejects Discover when sender frame does not match', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(
        { senderFrame: { id: 999 } },
        {
          sessionId: 'test',
          phase: 'discovery',
          version: 1,
          data: { databaseName: 'x', nativeVersion: 110, logicalVersion: 11, tableNames: [] }
        }
      )

      expect(result).toEqual({ ok: false, error: 'Sender identity mismatch' })
    })

    it('rejects ReadPage when sender frame does not match', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(
        { senderFrame: { id: 999 } },
        {
          sessionId: 'test',
          phase: 'reading',
          version: 1,
          data: { tableName: 'topics', items: [], cursor: null, hasMore: false }
        }
      )

      expect(result).toEqual({ ok: false, error: 'Sender identity mismatch' })
    })
  })

  // =========================================================================
  // Ready handler
  // =========================================================================

  describe('Ready handler', () => {
    it('rejects empty sessionId', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Ready)!
      const result = await handler(makeEvent(reader.mainFrame), '')

      expect(result).toEqual({ ok: false, error: 'Invalid sessionId' })
    })

    it('invokes onReady callback on success', async () => {
      const onReady = vi.fn()
      disposer = registerChatImportIpc({ onReady })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Ready)!
      const result = await handler(makeEvent(reader.mainFrame), 'session-123')

      expect(result).toEqual({ ok: true })
      expect(onReady).toHaveBeenCalledWith('session-123')
    })
  })

  // =========================================================================
  // Envelope validation — all channels
  // =========================================================================

  describe('envelope validation', () => {
    it('Discover rejects null envelope', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), null)

      expect(result.ok).toBe(false)
      expect(result.error).toContain('plain object')
    })

    it('Discover rejects wrong phase', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'reading',
        version: 1,
        data: { databaseName: 'x', nativeVersion: 110, logicalVersion: 11, tableNames: [] }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('phase')
    })

    it('Discover rejects wrong version', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 2,
        data: { databaseName: 'x', nativeVersion: 110, logicalVersion: 11, tableNames: [] }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('version')
    })

    it('Discover rejects missing sessionId', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        phase: 'discovery',
        version: 1,
        data: { databaseName: 'x', nativeVersion: 110, logicalVersion: 11, tableNames: [] }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('sessionId')
    })

    it('ReadPage rejects wrong phase', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: { tableName: 'topics', items: [], cursor: null, hasMore: false }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('phase')
    })

    it('Complete handler does not return (fire-and-forget)', () => {
      const onComplete = vi.fn()
      disposer = registerChatImportIpc({ onComplete })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Complete)!
      // ipcMain.on handlers are synchronous, return void
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'complete',
        version: 1,
        data: { topicRecordCount: 1, blockRecordCount: 3, segmentRecordCount: 4, sourceFileRecordCount: 5 }
      })

      expect(onComplete).toHaveBeenCalledWith('test', {
        topicRecordCount: 1,
        blockRecordCount: 3,
        segmentRecordCount: 4,
        sourceFileRecordCount: 5
      })
    })

    it('Complete rejects legacy SourceStats field names (strict SourceReadStats)', () => {
      const onComplete = vi.fn()
      disposer = registerChatImportIpc({ onComplete })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Complete)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'complete',
        version: 1,
        data: { topicCount: 1, messageCount: 2, blockCount: 3, segmentCount: 4, fileRefCount: 5 }
      })

      expect(onComplete).not.toHaveBeenCalled()
    })

    it('Complete rejects stats with a missing field', () => {
      const onComplete = vi.fn()
      disposer = registerChatImportIpc({ onComplete })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Complete)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'complete',
        version: 1,
        data: { topicRecordCount: 1, blockRecordCount: 3, segmentRecordCount: 4 }
      })

      expect(onComplete).not.toHaveBeenCalled()
    })

    it('Complete rejects non-integer counts', () => {
      const onComplete = vi.fn()
      disposer = registerChatImportIpc({ onComplete })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Complete)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'complete',
        version: 1,
        data: { topicRecordCount: 1.5, blockRecordCount: 3, segmentRecordCount: 4, sourceFileRecordCount: 5 }
      })

      expect(onComplete).not.toHaveBeenCalled()
    })

    it('Complete rejects wrong phase', () => {
      const onComplete = vi.fn()
      disposer = registerChatImportIpc({ onComplete })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Complete)!
      handler(makeEvent(reader.mainFrame), { sessionId: 'test', phase: 'error', version: 1, data: {} })

      expect(onComplete).not.toHaveBeenCalled()
    })

    it('Error handler invokes onError callback', () => {
      const onError = vi.fn()
      disposer = registerChatImportIpc({ onError })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Error)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'error',
        version: 1,
        data: { code: 'TEST_ERROR', message: 'test' }
      })

      expect(onError).toHaveBeenCalledWith('test', { code: 'TEST_ERROR', message: 'test' })
    })
  })

  // =========================================================================
  // DiscoveryResult shape validation
  // =========================================================================

  describe('DiscoveryResult validation', () => {
    it('rejects missing databaseName', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: { nativeVersion: 110, logicalVersion: 11, tableNames: [] }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('databaseName')
    })

    it('rejects nativeVersion >= 120 (future version)', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: { databaseName: 'CherryStudio', nativeVersion: 120, logicalVersion: 12, tableNames: [] }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('FUTURE_VERSION_REJECTED')
    })

    it('accepts valid discovery with nativeVersion < 120', async () => {
      const onDiscover = vi.fn()
      disposer = registerChatImportIpc({ onDiscover })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: { databaseName: 'CherryStudio', nativeVersion: 110, logicalVersion: 11, tableNames: ['topics'] }
      })

      expect(result).toEqual({ ok: true })
      expect(onDiscover).toHaveBeenCalledWith('test', {
        databaseName: 'CherryStudio',
        nativeVersion: 110,
        logicalVersion: 11,
        tableNames: ['topics']
      })
    })
  })

  // =========================================================================
  // ReadPageResponse shape validation
  // =========================================================================

  describe('ReadPageResponse validation', () => {
    it('rejects missing tableName', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'reading',
        version: 1,
        data: { items: [], cursor: null, hasMore: false }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('tableName')
    })

    it('rejects non-array items', async () => {
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'reading',
        version: 1,
        data: { tableName: 'topics', items: 'not-array', cursor: null, hasMore: false }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('items')
    })

    it('accepts valid read page response', async () => {
      const onReadPage = vi.fn()
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'reading',
        version: 1,
        data: { tableName: 'topics', items: [{ id: '1' }], cursor: '1', hasMore: true }
      })

      expect(result).toEqual({ ok: true })
      expect(onReadPage).toHaveBeenCalledWith('test', {
        tableName: 'topics',
        items: [{ id: '1' }],
        cursor: '1',
        hasMore: true
      })
    })
  })

  // =========================================================================
  // Projection handler (LOCK-PROD-2/6, LOCK-I1) — renderer → main source
  // Local Storage payload. Fire-and-forget (ipcMain.on); Main parses and
  // persists the minimal projection. The raw string never crosses IPC back.
  // =========================================================================

  describe('Projection handler', () => {
    /** Register a fresh registration and fire the Projection handler once. */
    function fireProjection(persist: unknown, callbacks: { onProjection?: (...args: any[]) => any } = {}) {
      disposer = registerChatImportIpc(callbacks)
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)
      const handler = onListeners.get(IpcChannel.ChatImport_Projection)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: { persist }
      })
      return { reader, handler }
    }

    it('registers an ipcMain.on listener on ChatImport_Projection', () => {
      disposer = registerChatImportIpc()
      expect(onListeners.has(IpcChannel.ChatImport_Projection)).toBe(true)
    })

    it('rejects the payload when the sender identity does not match (R-9)', () => {
      const onProjection = vi.fn()
      disposer = registerChatImportIpc({ onProjection })
      mockGetActiveReader.mockReturnValue(makeReader())

      const handler = onListeners.get(IpcChannel.ChatImport_Projection)!
      handler(
        { senderFrame: { id: 999 } },
        {
          sessionId: 'test',
          phase: 'discovery',
          version: 1,
          data: { persist: 'x' }
        }
      )

      expect(onProjection).not.toHaveBeenCalled()
    })

    it('rejects a null envelope without invoking the callback', () => {
      const onProjection = vi.fn()
      disposer = registerChatImportIpc({ onProjection })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Projection)!
      handler(makeEvent(reader.mainFrame), null)

      expect(onProjection).not.toHaveBeenCalled()
    })

    it('rejects a wrong phase', () => {
      const onProjection = vi.fn()
      disposer = registerChatImportIpc({ onProjection })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Projection)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'reading',
        version: 1,
        data: { persist: 'x' }
      })

      expect(onProjection).not.toHaveBeenCalled()
    })

    it('rejects a wrong version', () => {
      const onProjection = vi.fn()
      disposer = registerChatImportIpc({ onProjection })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Projection)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 2,
        data: { persist: 'x' }
      })

      expect(onProjection).not.toHaveBeenCalled()
    })

    it('accepts a string persist and invokes onProjection with the raw payload', () => {
      const onProjection = vi.fn()
      fireProjection('{"assistants":[]}', { onProjection })
      expect(onProjection).toHaveBeenCalledWith('test', { persist: '{"assistants":[]}' })
    })

    it('accepts a null persist (missing source key) and passes persist: null', () => {
      const onProjection = vi.fn()
      disposer = registerChatImportIpc({ onProjection })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Projection)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: { persist: null }
      })

      expect(onProjection).toHaveBeenCalledWith('test', { persist: null })
    })

    it('rejects every non-string non-null persist value (number, boolean, object, array)', () => {
      for (const bad of [42, true, { a: 1 }, [1]]) {
        const onProjection = vi.fn()
        fireProjection(bad, { onProjection })
        expect(onProjection).not.toHaveBeenCalled()
        disposer()
        disposer = null as unknown as () => void
      }
    })

    it('contains an async onProjection rejection (no unhandled rejection)', async () => {
      const onUnhandled = vi.fn()
      process.on('unhandledRejection', onUnhandled)
      try {
        const onProjection = vi.fn(async () => {
          throw new Error('projection hook failed')
        })
        disposer = registerChatImportIpc({ onProjection })
        const reader = makeReader()
        mockGetActiveReader.mockReturnValue(reader)

        const handler = onListeners.get(IpcChannel.ChatImport_Projection)!
        handler(makeEvent(reader.mainFrame), {
          sessionId: 'test',
          phase: 'discovery',
          version: 1,
          data: { persist: 'x' }
        })

        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(onProjection).toHaveBeenCalled()
        expect(onUnhandled).not.toHaveBeenCalled()
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })
  })

  // =========================================================================
  // Async callback transport contract (Phase 4.2 — LOCK-T2/T3/T4)
  // =========================================================================

  describe('async callback awaiting and containment', () => {
    function makeReadPageEnvelope() {
      return {
        sessionId: 'test',
        phase: 'reading',
        version: 1,
        data: { tableName: 'topics', items: [{ id: '1' }], cursor: '1', hasMore: true }
      }
    }

    it('ReadPage ack resolves only AFTER an async onReadPage callback resolves (backpressure)', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let callbackSettled = false
      const onReadPage = vi.fn(async () => {
        await gate
        callbackSettled = true
      })

      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      let ackSettled = false
      const ackPromise = handler(makeEvent(reader.mainFrame), makeReadPageEnvelope()).then((r: any) => {
        ackSettled = true
        return r
      })

      // Flush microtasks: the ack must still be pending while the callback is
      await Promise.resolve()
      await Promise.resolve()
      expect(onReadPage).toHaveBeenCalled()
      expect(ackSettled).toBe(false)

      release()
      const result = await ackPromise
      expect(callbackSettled).toBe(true)
      expect(result).toEqual({ ok: true })
    })

    it('ReadPage converts an async onReadPage rejection into a structured failure ack', async () => {
      const onReadPage = vi.fn(async () => {
        throw new Error('candidate write failed')
      })
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), makeReadPageEnvelope())

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
      expect(result.error).toContain('candidate write failed')
    })

    it('ReadPage summarizes a ChatImportDataPlaneError ack to bounded code/table context (LOCK-PRIV-2)', async () => {
      // A data-plane rejection's raw message carries source IDs (entityId,
      // source block/message IDs). The IPC ack must expose ONLY the bounded
      // machine code + table — never the raw detail.
      const onReadPage = vi.fn(() => {
        throw new ChatImportDataPlaneError(
          'INVALID_ROW',
          `topics[0] (id=secret-topic-0x1): field 'id' must be a non-empty string (got undefined)`,
          { tableName: 'topics', entityId: 'secret-topic-0x1' }
        )
      })
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), makeReadPageEnvelope())

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
      expect(result.error).toContain('DATA_PLANE_REJECTION(INVALID_ROW, table=topics)')
      // LOCK-PRIV-2: never entityId, error.detail, or raw error.message.
      expect(result.error).not.toContain('secret-topic-0x1')
      expect(result.error).not.toContain("field 'id' must be a non-empty string")
      expect(result.error).not.toContain('topics[0]')
    })

    it('ReadPage summarizes a cause-wrapped ChatImportDataPlaneError ack (LOCK-PRIV-4/5)', async () => {
      // A rejection nested inside an Error.cause chain must still produce a
      // bounded ack — the wrapper's raw message must never leak.
      const secret = 'secret-topic-0xWrappedIpc'
      const rejection = new ChatImportDataPlaneError(
        'INVALID_ROW',
        `topics[0] (id=${secret}): field 'id' must be a non-empty string`,
        { tableName: 'topics', entityId: secret }
      )
      const wrapper = new Error(`wrapped failure containing ${secret}`)
      wrapper.cause = rejection
      const onReadPage = vi.fn(() => {
        throw wrapper
      })
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), makeReadPageEnvelope())

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
      expect(result.error).toContain('DATA_PLANE_REJECTION(INVALID_ROW, table=topics)')
      // LOCK-PRIV-5: neither the wrapper message nor the raw detail leaks
      // into the serialized ack.
      expect(result.error).not.toContain(secret)
      expect(result.error).not.toContain('wrapped failure')
      expect(JSON.stringify(result)).not.toContain(secret)
    })

    it('ReadPage summarizes an AggregateError-contained ChatImportDataPlaneError ack (LOCK-PRIV-4/5)', async () => {
      const secret = 'secret-block-0xAggIpc'
      const rejection = new ChatImportDataPlaneError(
        'OWNERSHIP_MISMATCH',
        `message_blocks[0] (id=${secret}): block owner mismatch`,
        { tableName: 'message_blocks', entityId: secret }
      )
      const onReadPage = vi.fn(() => {
        throw new AggregateError([new Error(`raw aggregate entry with ${secret}`), rejection])
      })
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), makeReadPageEnvelope())

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
      expect(result.error).toContain('DATA_PLANE_REJECTION(OWNERSHIP_MISMATCH, table=message_blocks)')
      expect(result.error).not.toContain(secret)
      expect(result.error).not.toContain('raw aggregate entry')
      expect(JSON.stringify(result)).not.toContain(secret)
    })

    it('ReadPage keeps the generic message when the error tree has no data-plane rejection (LOCK-PRIV-5)', async () => {
      const wrapper = new Error('outer generic failure')
      wrapper.cause = new Error('inner generic failure')
      const onReadPage = vi.fn(() => {
        throw wrapper
      })
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), makeReadPageEnvelope())

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
      expect(result.error).toContain('outer generic failure')
    })

    // =======================================================================
    // Renderer-controlled value bounding at the log boundary (LOCK-PRIV-6)
    // =======================================================================

    function importLogger() {
      return loggerHoisted.withContext('chatDbImport') as {
        info: ReturnType<typeof vi.fn>
        warn: ReturnType<typeof vi.fn>
        error: ReturnType<typeof vi.fn>
        debug: ReturnType<typeof vi.fn>
      }
    }

    function allLogText(): string {
      const logger = importLogger()
      return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
        .map((call) => call.map(String).join(' '))
        .join('\n')
    }

    it('Error channel logs only the allowlisted code family, never the renderer message (LOCK-PRIV-6)', () => {
      const sentinel = 'SENTINEL-0xErrorChannel'
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Error)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'error',
        version: 1,
        data: { code: 'READ_FAILED', message: `secret ${sentinel}` }
      })

      expect(
        importLogger().error.mock.calls.some((call) => String(call[0]).includes('RENDERER_ERROR(READ_FAILED)'))
      ).toBe(true)
      expect(allLogText()).not.toContain(sentinel)
      expect(allLogText()).not.toContain('secret ')
    })

    it('Error channel bounds an untrusted renderer code to static UNKNOWN (LOCK-PRIV-6)', () => {
      const sentinel = 'SENTINEL-0xHostileCode'
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Error)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'error',
        version: 1,
        data: { code: `DROP TABLE messages; -- ${sentinel}`, message: `secret ${sentinel}` }
      })

      expect(importLogger().error.mock.calls.some((call) => String(call[0]).includes('RENDERER_ERROR(UNKNOWN)'))).toBe(
        true
      )
      expect(allLogText()).not.toContain(sentinel)
      expect(allLogText()).not.toContain('DROP TABLE')
    })

    it('Discover channel logs the table count, never renderer table entries (LOCK-PRIV-6)', async () => {
      const sentinel = 'SENTINEL-0xTableNames'
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: {
          databaseName: 'CherryStudio',
          nativeVersion: 110,
          logicalVersion: 11,
          tableNames: [`${sentinel}`, 'topics']
        }
      })

      expect(result).toEqual({ ok: true })
      expect(importLogger().info.mock.calls.some((call) => String(call[0]).includes('tables=2'))).toBe(true)
      expect(allLogText()).not.toContain(sentinel)
    })

    it('ReadPage channel logs a bounded table label, never the renderer table name (LOCK-PRIV-6)', async () => {
      const sentinel = 'SENTINEL-0xTableName'
      const onReadPage = vi.fn()
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'reading',
        version: 1,
        data: { tableName: sentinel, items: [{ id: '1' }], cursor: null, hasMore: false }
      })

      expect(result).toEqual({ ok: true })
      expect(importLogger().info.mock.calls.some((call) => String(call[0]).includes('table=unknown'))).toBe(true)
      expect(allLogText()).not.toContain(sentinel)
    })

    it('Complete channel invalid stats log stays static (no renderer key names) (LOCK-PRIV-6)', () => {
      const sentinel = 'SENTINEL-0xCompleteKey'
      disposer = registerChatImportIpc()
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = onListeners.get(IpcChannel.ChatImport_Complete)!
      handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'complete',
        version: 1,
        data: { topicRecordCount: 1, [sentinel]: 'x' }
      })

      expect(importLogger().warn.mock.calls.some((call) => String(call[0]).includes('Invalid source read stats'))).toBe(
        true
      )
      expect(allLogText()).not.toContain(sentinel)
    })

    it('ReadPage converts a synchronous onReadPage throw into a structured failure ack', async () => {
      const onReadPage = vi.fn(() => {
        throw new Error('sync boom')
      })
      disposer = registerChatImportIpc({ onReadPage })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_ReadPage)!
      const result = await handler(makeEvent(reader.mainFrame), makeReadPageEnvelope())

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
      expect(result.error).toContain('sync boom')
    })

    it('Ready converts an async onReady rejection into a structured failure ack', async () => {
      const onReady = vi.fn(async () => {
        throw new Error('ready hook failed')
      })
      disposer = registerChatImportIpc({ onReady })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Ready)!
      const result = await handler(makeEvent(reader.mainFrame), 'session-123')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
    })

    it('Discover converts an async onDiscover rejection into a structured failure ack', async () => {
      const onDiscover = vi.fn(async () => {
        throw new Error('discover hook failed')
      })
      disposer = registerChatImportIpc({ onDiscover })
      const reader = makeReader()
      mockGetActiveReader.mockReturnValue(reader)

      const handler = handlers.get(IpcChannel.ChatImport_Discover)!
      const result = await handler(makeEvent(reader.mainFrame), {
        sessionId: 'test',
        phase: 'discovery',
        version: 1,
        data: { databaseName: 'CherryStudio', nativeVersion: 110, logicalVersion: 11, tableNames: ['topics'] }
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('CALLBACK_FAILED')
    })

    it('Complete contains an async onComplete rejection (no unhandled rejection)', async () => {
      const onUnhandled = vi.fn()
      process.on('unhandledRejection', onUnhandled)
      try {
        const onComplete = vi.fn(async () => {
          throw new Error('complete hook failed')
        })
        disposer = registerChatImportIpc({ onComplete })
        const reader = makeReader()
        mockGetActiveReader.mockReturnValue(reader)

        const handler = onListeners.get(IpcChannel.ChatImport_Complete)!
        handler(makeEvent(reader.mainFrame), {
          sessionId: 'test',
          phase: 'complete',
          version: 1,
          data: { topicRecordCount: 1, blockRecordCount: 2, segmentRecordCount: 3, sourceFileRecordCount: 4 }
        })

        // Let the contained promise settle plus a macrotask for the
        // unhandledRejection event to fire if containment were broken.
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(onComplete).toHaveBeenCalled()
        expect(onUnhandled).not.toHaveBeenCalled()
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })

    it('Error contains an async onError rejection (no unhandled rejection)', async () => {
      const onUnhandled = vi.fn()
      process.on('unhandledRejection', onUnhandled)
      try {
        const onError = vi.fn(async () => {
          throw new Error('error hook failed')
        })
        disposer = registerChatImportIpc({ onError })
        const reader = makeReader()
        mockGetActiveReader.mockReturnValue(reader)

        const handler = onListeners.get(IpcChannel.ChatImport_Error)!
        handler(makeEvent(reader.mainFrame), {
          sessionId: 'test',
          phase: 'error',
          version: 1,
          data: { code: 'X', message: 'y' }
        })

        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(onError).toHaveBeenCalled()
        expect(onUnhandled).not.toHaveBeenCalled()
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    })
  })
})
