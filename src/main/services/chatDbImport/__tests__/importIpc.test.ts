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

// Mock loggerService
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

// Mock isolatedSession
const { mockGetActiveReader } = vi.hoisted(() => ({
  mockGetActiveReader: vi.fn((): any => null)
}))

vi.mock('../isolatedSession', () => ({
  getActiveReader: mockGetActiveReader
}))

import { IpcChannel } from '@shared/IpcChannel'

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
    it('registers 3 handle handlers (Ready, Discover, ReadPage) and 2 on listeners (Complete, Error)', () => {
      disposer = registerChatImportIpc()

      // ipcMain.handle called for Ready, Discover, ReadPage
      expect(mockHandle).toHaveBeenCalledTimes(3)
      // ipcMain.on called for Complete, Error
      expect(mockOn).toHaveBeenCalledTimes(2)
    })

    it('registers handle for the expected channels', () => {
      disposer = registerChatImportIpc()

      expect(handlers.has(IpcChannel.ChatImport_Ready)).toBe(true)
      expect(handlers.has(IpcChannel.ChatImport_Discover)).toBe(true)
      expect(handlers.has(IpcChannel.ChatImport_ReadPage)).toBe(true)
    })

    it('registers on listeners for Complete and Error', () => {
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
