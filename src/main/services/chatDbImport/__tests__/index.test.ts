/**
 * ChatImport index tests.
 *
 * Covers:
 * - startImport platform gate (darwin pass / non-darwin throws)
 * - State machine transitions
 * - cancelImport transitions to cancelled and disposes
 * - getActiveImport returns expected
 * - onReadyForBulk callback
 * - IPC callback wiring (orchestrator sends Discover/ReadPage and receives responses)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock all dependencies
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

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/app')
  }
}))

vi.mock('../tempWorkspace', () => ({
  createTempWorkspace: vi.fn().mockResolvedValue('/tmp/cherry-import-test'),
  dispose: vi.fn(),
  disposeAsync: vi.fn().mockResolvedValue(undefined),
  recoverOrphanedTempWorkspaces: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../zipIntake', () => ({
  extractZip: vi.fn().mockResolvedValue({
    destDir: '/tmp/cherry-import-test',
    indexedDbDir: '/tmp/cherry-import-test/IndexedDB',
    entryCount: 10,
    totalUncompressedBytes: 1024
  })
}))

vi.mock('../isolatedSession', () => ({
  createIsolatedReader: vi.fn().mockResolvedValue({
    sessionId: 'test',
    window: {},
    electronSession: {}
  }),
  dispose: vi.fn().mockResolvedValue(undefined),
  disposeSync: vi.fn(),
  getActiveReader: vi.fn(() => null)
}))

// Track the IPC callbacks passed to registerChatImportIpc
const mockSendDiscover = vi.fn()
const mockSendReadPage = vi.fn()
const mockSendCancel = vi.fn()
let capturedCallbacks: any = null

vi.mock('../importIpc', () => ({
  registerChatImportIpc: vi.fn((callbacks?: any) => {
    capturedCallbacks = callbacks
    return () => {}
  }),
  sendCancel: vi.fn((...args: any[]) => mockSendCancel(...args)),
  sendReadPage: vi.fn((...args: any[]) => mockSendReadPage(...args)),
  sendDiscover: vi.fn((...args: any[]) => mockSendDiscover(...args))
}))

import { ChatImportSessionError, ChatImportUnsupportedPlatformError } from '../errors'
import { cancelImport, DEFAULT_PAGE_SIZE, disposeActiveImport, getActiveImport, startImport } from '../index'

describe('ChatImport index', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedCallbacks = null
    // Dispose any active session
    disposeActiveImport()
  })

  afterEach(() => {
    disposeActiveImport()
  })

  // =========================================================================
  // Platform gate (A-9)
  // =========================================================================

  describe('platform gate', () => {
    it('throws ChatImportUnsupportedPlatformError on non-darwin platforms', async () => {
      const error = new ChatImportUnsupportedPlatformError('win32')
      expect(error.name).toBe('ChatImportUnsupportedPlatformError')
      expect(error.message).toContain('win32')
      expect(error.message).toContain('macOS')
    })

    it('ChatImportUnsupportedPlatformError includes linux', () => {
      const error = new ChatImportUnsupportedPlatformError('linux')
      expect(error.message).toContain('linux')
    })
  })

  // =========================================================================
  // getActiveImport
  // =========================================================================

  describe('getActiveImport', () => {
    it('returns null when no import is active', () => {
      expect(getActiveImport()).toBeNull()
    })
  })

  // =========================================================================
  // cancelImport
  // =========================================================================

  describe('cancelImport', () => {
    it('does nothing when no session exists with given id', async () => {
      await expect(cancelImport('nonexistent')).resolves.not.toThrow()
    })
  })

  // =========================================================================
  // Error classes
  // =========================================================================

  describe('error classes', () => {
    it('ChatImportSessionError has correct name', () => {
      const error = new ChatImportSessionError('test')
      expect(error.name).toBe('ChatImportSessionError')
      expect(error.message).toContain('test')
    })

    it('ChatImportUnsupportedPlatformError lists the platform', () => {
      const error = new ChatImportUnsupportedPlatformError('darwin')
      expect(error.message).toContain('darwin')
    })
  })

  // =========================================================================
  // IPC callback wiring
  // =========================================================================

  describe('IPC callback wiring', () => {
    const itOnDarwin = process.platform === 'darwin' ? it : it.skip

    itOnDarwin('registerChatImportIpc is called with callbacks', async () => {
      const { registerChatImportIpc } = await import('../importIpc')
      const session = await startImport('/tmp/test.zip')

      expect(registerChatImportIpc).toHaveBeenCalled()
      expect(capturedCallbacks).toBeDefined()
      expect(capturedCallbacks.onReady).toBeInstanceOf(Function)
      expect(capturedCallbacks.onDiscover).toBeInstanceOf(Function)
      expect(capturedCallbacks.onReadPage).toBeInstanceOf(Function)
      expect(capturedCallbacks.onComplete).toBeInstanceOf(Function)
      expect(capturedCallbacks.onError).toBeInstanceOf(Function)

      await session.dispose()
    })

    itOnDarwin('onReady triggers sendDiscover', async () => {
      const session = await startImport('/tmp/test.zip')

      capturedCallbacks.onReady(session.id)
      expect(mockSendDiscover).toHaveBeenCalledWith(session.id)

      await session.dispose()
    })

    itOnDarwin('onReady ignores renderer "pending" sessionId and uses authoritative closure sessionId', async () => {
      const session = await startImport('/tmp/test.zip')

      // Renderer sends 'pending' as the sessionId because it cannot know the
      // real UUID before the session is established.
      capturedCallbacks.onReady('pending')

      // Main MUST send discover with the real sessionId from the closure,
      // NOT the renderer's 'pending' value.
      expect(mockSendDiscover).toHaveBeenCalledTimes(1)
      expect(mockSendDiscover).toHaveBeenCalledWith(session.id)
      expect(mockSendDiscover).not.toHaveBeenCalledWith('pending')

      await session.dispose()
    })

    itOnDarwin('onDiscover transitions to reading and sends first ReadPage', async () => {
      const session = await startImport('/tmp/test.zip')

      capturedCallbacks.onDiscover(session.id, {
        databaseName: 'CherryStudio',
        nativeVersion: 110,
        logicalVersion: 11,
        tableNames: ['topics', 'message_blocks']
      })

      expect(session.state).toBe('reading')
      expect(mockSendReadPage).toHaveBeenCalledWith(session.id, {
        tableName: 'topics',
        cursor: null,
        pageSize: DEFAULT_PAGE_SIZE
      })

      await session.dispose()
    })

    itOnDarwin('onReadPage accumulates stats and sends next page when hasMore', async () => {
      const session = await startImport('/tmp/test.zip')

      // Trigger reading state
      capturedCallbacks.onDiscover(session.id, {
        databaseName: 'CherryStudio',
        nativeVersion: 110,
        logicalVersion: 11,
        tableNames: ['topics']
      })
      mockSendReadPage.mockClear()

      // Simulate a page response with hasMore=true
      capturedCallbacks.onReadPage(session.id, {
        tableName: 'topics',
        items: [{ id: '1' }, { id: '2' }],
        cursor: '2',
        hasMore: true
      })

      expect(mockSendReadPage).toHaveBeenCalledWith(session.id, {
        tableName: 'topics',
        cursor: '2',
        pageSize: DEFAULT_PAGE_SIZE
      })

      await session.dispose()
    })

    itOnDarwin('onReadPage moves to next entity when !hasMore', async () => {
      const session = await startImport('/tmp/test.zip')

      capturedCallbacks.onDiscover(session.id, {
        databaseName: 'CherryStudio',
        nativeVersion: 110,
        logicalVersion: 11,
        tableNames: ['topics', 'message_blocks']
      })
      mockSendReadPage.mockClear()

      // Simulate last page of first entity
      capturedCallbacks.onReadPage(session.id, {
        tableName: 'topics',
        items: [{ id: '1' }],
        cursor: '1',
        hasMore: false
      })

      // Should send read for next entity
      expect(mockSendReadPage).toHaveBeenCalledWith(session.id, {
        tableName: 'message_blocks',
        cursor: null,
        pageSize: DEFAULT_PAGE_SIZE
      })

      await session.dispose()
    })

    itOnDarwin('onComplete transitions to ready-for-bulk', async () => {
      const onReadyForBulk = vi.fn()
      const session = await startImport('/tmp/test.zip', { onReadyForBulk })

      capturedCallbacks.onComplete(session.id, {
        topicCount: 5,
        messageCount: 100,
        blockCount: 200,
        segmentCount: 10,
        fileRefCount: 3
      })

      expect(session.state).toBe('ready-for-bulk')
      expect(onReadyForBulk).toHaveBeenCalledWith(session.id, {
        topicCount: 5,
        messageCount: 100,
        blockCount: 200,
        segmentCount: 10,
        fileRefCount: 3
      })

      await session.dispose()
    })

    itOnDarwin('onReadPage last entity last page self-completes to ready-for-bulk with accumulated stats', async () => {
      const onReadyForBulk = vi.fn()
      const session = await startImport('/tmp/test.zip', { onReadyForBulk })

      // Transition to reading
      capturedCallbacks.onDiscover(session.id, {
        databaseName: 'CherryStudio',
        nativeVersion: 110,
        logicalVersion: 11,
        tableNames: ['topics', 'message_blocks', 'topic_segments', 'files']
      })
      mockSendReadPage.mockClear()

      // Walk through all 4 entities with single pages.
      // Entity 0: topics
      capturedCallbacks.onReadPage(session.id, {
        tableName: 'topics',
        items: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
        cursor: 't3',
        hasMore: false
      })
      expect(mockSendReadPage).toHaveBeenLastCalledWith(session.id, {
        tableName: 'message_blocks',
        cursor: null,
        pageSize: DEFAULT_PAGE_SIZE
      })
      mockSendReadPage.mockClear()

      // Entity 1: message_blocks
      capturedCallbacks.onReadPage(session.id, {
        tableName: 'message_blocks',
        items: [{ id: 'b1' }, { id: 'b2' }],
        cursor: 'b2',
        hasMore: false
      })
      expect(mockSendReadPage).toHaveBeenLastCalledWith(session.id, {
        tableName: 'topic_segments',
        cursor: null,
        pageSize: DEFAULT_PAGE_SIZE
      })
      mockSendReadPage.mockClear()

      // Entity 2: topic_segments
      capturedCallbacks.onReadPage(session.id, {
        tableName: 'topic_segments',
        items: [{ id: 's1' }],
        cursor: 's1',
        hasMore: false
      })
      expect(mockSendReadPage).toHaveBeenLastCalledWith(session.id, {
        tableName: 'files',
        cursor: null,
        pageSize: DEFAULT_PAGE_SIZE
      })
      mockSendReadPage.mockClear()

      // Entity 3 (last): files — hasMore=false must self-complete
      capturedCallbacks.onReadPage(session.id, {
        tableName: 'files',
        items: [{ id: 'f1' }, { id: 'f2' }],
        cursor: 'f2',
        hasMore: false
      })

      // Assert: no more ReadPage sent (all entities exhausted)
      expect(mockSendReadPage).not.toHaveBeenCalled()

      // Assert: state transitioned to ready-for-bulk
      expect(session.state).toBe('ready-for-bulk')

      // Assert: onReadyForBulk called exactly once with accumulated stats
      expect(onReadyForBulk).toHaveBeenCalledTimes(1)
      expect(onReadyForBulk).toHaveBeenCalledWith(session.id, {
        topicCount: 3,
        messageCount: 0,
        blockCount: 2,
        segmentCount: 1,
        fileRefCount: 2
      })

      await session.dispose()
    })

    itOnDarwin('onError transitions to error state', async () => {
      const session = await startImport('/tmp/test.zip')

      capturedCallbacks.onError(session.id, {
        code: 'DISCOVERY_FAILED',
        message: 'test error'
      })

      expect(session.state).toBe('error')

      await session.dispose()
    })
  })

  // =========================================================================
  // State machine (when on darwin)
  // =========================================================================

  describe('state machine', () => {
    const itOnDarwin = process.platform === 'darwin' ? it : it.skip

    itOnDarwin('startImport creates a session on darwin', async () => {
      const session = await startImport('/tmp/test.zip')
      expect(session).toBeDefined()
      expect(session.id).toContain('import-')
      expect(getActiveImport()).toBe(session)

      await session.dispose()
    })

    itOnDarwin('second concurrent import throws ChatImportSessionError', async () => {
      const session1 = await startImport('/tmp/test1.zip')

      await expect(startImport('/tmp/test2.zip')).rejects.toThrow(ChatImportSessionError)

      await session1.dispose()
    })

    itOnDarwin('getActiveImport returns the active session', async () => {
      const session = await startImport('/tmp/test.zip')
      expect(getActiveImport()).toBe(session)
      await session.dispose()
    })

    itOnDarwin('dispose cleans up the session', async () => {
      const session = await startImport('/tmp/test.zip')
      expect(getActiveImport()).not.toBeNull()

      await session.dispose()
      expect(getActiveImport()).toBeNull()
    })
  })

  // =========================================================================
  // disposeActiveImport
  // =========================================================================

  describe('disposeActiveImport', () => {
    it('does nothing when no session is active', () => {
      expect(() => disposeActiveImport()).not.toThrow()
    })
  })
})
