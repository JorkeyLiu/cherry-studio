/**
 * isolatedSession tests.
 *
 * Covers:
 * - Singleton enforcement
 * - dispose nulls ref
 * - getActiveReader returns expected value
 *
 * Electron session.fromPath may need mock — follows existing pattern
 * in src/main/services/chatDb/__tests__/ipc.test.ts for mocking Electron.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron
const { mockWindow, mockSession, mockDestroy } = vi.hoisted(() => {
  const mockDestroy = vi.fn()
  const mockIsDestroyed = vi.fn(() => false)
  const mockSend = vi.fn()

  const mockWindow = {
    webContents: {
      mainFrame: {},
      on: vi.fn(),
      send: mockSend,
      setWindowOpenHandler: vi.fn()
    },
    on: vi.fn(),
    destroy: mockDestroy,
    isDestroyed: mockIsDestroyed,
    loadURL: vi.fn().mockResolvedValue(undefined)
  }

  const mockSession = {
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined)
  }

  return { mockWindow, mockSession, mockDestroy }
})

vi.mock('electron', () => ({
  BrowserWindow: vi.fn().mockImplementation(() => mockWindow),
  session: {
    fromPath: vi.fn().mockReturnValue(mockSession)
  }
}))

// Mock node:url
vi.mock('node:url', () => ({
  pathToFileURL: vi.fn((p: string) => ({ href: `file://${p}` }))
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

import { ChatImportSessionError } from '../errors'
import { createIsolatedReader, dispose, getActiveReader } from '../isolatedSession'

describe('isolatedSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the active reader by disposing
    dispose()
  })

  afterEach(async () => {
    await dispose()
  })

  // =========================================================================
  // getActiveReader
  // =========================================================================

  describe('getActiveReader', () => {
    it('returns null when no session is active', () => {
      expect(getActiveReader()).toBeNull()
    })
  })

  // =========================================================================
  // createIsolatedReader
  // =========================================================================

  describe('createIsolatedReader', () => {
    const baseOptions = {
      sessionId: 'test-session-1',
      workspaceRoot: '/tmp/test-idb',
      htmlPath: '/app/chatImport.html',
      preloadPath: '/app/chat-import-preload.js',
      onReady: vi.fn(),
      onDiscover: vi.fn(),
      onReadPage: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      onCancel: vi.fn()
    }

    it('creates a reader and sets it as active', async () => {
      const reader = await createIsolatedReader(baseOptions)

      expect(reader).not.toBeNull()
      expect(reader.sessionId).toBe('test-session-1')
      expect(getActiveReader()).toBe(reader)
    })

    it('loads the HTML via file:// URL', async () => {
      await createIsolatedReader(baseOptions)

      expect(mockWindow.loadURL).toHaveBeenCalledWith('file:///app/chatImport.html')
    })

    it('throws ChatImportSessionError if a session already exists (R-5)', async () => {
      await createIsolatedReader(baseOptions)

      await expect(createIsolatedReader({ ...baseOptions, sessionId: 'test-session-2' })).rejects.toThrow(
        ChatImportSessionError
      )
    })
  })

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('destroys the window and nulls the ref', async () => {
      const options = {
        sessionId: 'test-dispose',
        workspaceRoot: '/tmp/test-idb',
        htmlPath: '/app/chatImport.html',
        preloadPath: '/app/chat-import-preload.js',
        onReady: vi.fn(),
        onDiscover: vi.fn(),
        onReadPage: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
        onCancel: vi.fn()
      }

      await createIsolatedReader(options)
      expect(getActiveReader()).not.toBeNull()

      await dispose()

      expect(mockDestroy).toHaveBeenCalled()
      expect(getActiveReader()).toBeNull()
    })

    it('is idempotent', async () => {
      await createIsolatedReader({
        sessionId: 'test-idempotent',
        workspaceRoot: '/tmp/test-idb',
        htmlPath: '/app/chatImport.html',
        preloadPath: '/app/chat-import-preload.js',
        onReady: vi.fn(),
        onDiscover: vi.fn(),
        onReadPage: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
        onCancel: vi.fn()
      })

      await dispose()
      await dispose() // Second call should not throw

      expect(getActiveReader()).toBeNull()
    })

    it('does not throw if no session is active', async () => {
      await expect(dispose()).resolves.not.toThrow()
    })

    it('clears session storage data and cache', async () => {
      await createIsolatedReader({
        sessionId: 'test-cleanup',
        workspaceRoot: '/tmp/test-idb',
        htmlPath: '/app/chatImport.html',
        preloadPath: '/app/chat-import-preload.js',
        onReady: vi.fn(),
        onDiscover: vi.fn(),
        onReadPage: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
        onCancel: vi.fn()
      })

      await dispose()

      expect(mockSession.clearStorageData).toHaveBeenCalled()
      expect(mockSession.clearCache).toHaveBeenCalled()
    })
  })
})
