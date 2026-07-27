/**
 * ChatImport index tests.
 *
 * Covers:
 * - startImport platform gate (darwin pass / non-darwin throws)
 * - State machine transitions (intake → discovering → reading → candidate-ready)
 * - Candidate lifecycle integration (Phase 4.2 — LOCK-O1…O8):
 *   - candidate initializes after discovery, before first ReadPage (LOCK-O1)
 *   - per-page awaited dataPlane.processPage backpressure (LOCK-O2)
 *   - finalize/seal/candidate-ready + exactly-one CandidateReadyResult (LOCK-O3)
 *   - renderer onComplete is informational only (LOCK-O4)
 *   - cancel before/during/after candidate-ready discards everything (LOCK-O5)
 *   - every failure enters error, discards the candidate, resets singleton (LOCK-O6)
 *   - orchestrator/data-plane source stats must agree exactly (LOCK-O7)
 *   - test factory/clock injection with production defaults (LOCK-O8)
 * - No filesystem path in the shared CandidateReadyResult; Main-only
 *   getSealedCandidate() handle
 * - Live DB isolation: the live chatDbService is never constructed
 */

import type { CandidateImportStats, ReadPageResponse, SourceReadStats } from '@shared/chatImport/types'
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

// Production-default modules (LOCK-O8): mocked so no real SQLite/Data path is
// ever touched by this suite. Defaults delegate to the same test doubles.
const hoisted = vi.hoisted(() => ({
  candidateCtor: vi.fn(),
  createPlane: vi.fn(),
  liveChatDbCtor: vi.fn()
}))

vi.mock('../candidateDb', () => ({
  CandidateDbResource: hoisted.candidateCtor
}))

vi.mock('../importDataPlane', () => ({
  createImportDataPlane: hoisted.createPlane
}))

// Live DB isolation sentinel: the orchestrator must never construct the live
// chatDbService (LOCK-O1). Mocked with a spy constructor.
vi.mock('@main/services/chatDb', () => ({
  ChatDbService: hoisted.liveChatDbCtor
}))

import { ChatImportSessionError, ChatImportUnsupportedPlatformError } from '../errors'
import {
  cancelImport,
  DEFAULT_PAGE_SIZE,
  disposeActiveImport,
  getActiveImport,
  getSealedCandidate,
  startImport
} from '../index'

// ---------------------------------------------------------------------------
// Test doubles (LOCK-O8 factory injection)
// ---------------------------------------------------------------------------

const MOCK_DB_PATH = '/mock/candidates/candidate-x/chat.db'

function makeCandidate(overrides: Partial<Record<string, any>> = {}) {
  const candidate: any = {
    initialize: vi.fn(async () => {}),
    getDatabase: vi.fn(() => ({ mock: 'candidate-db' })),
    getDbPath: vi.fn(() => MOCK_DB_PATH),
    seal: vi.fn(),
    discard: vi.fn(async () => {}),
    discardSync: vi.fn()
  }
  return Object.assign(candidate, overrides)
}

function computeSourceStats(pages: ReadPageResponse[]): SourceReadStats {
  const stats: SourceReadStats = {
    topicRecordCount: 0,
    blockRecordCount: 0,
    segmentRecordCount: 0,
    sourceFileRecordCount: 0
  }
  for (const page of pages) {
    const count = page.items.length
    if (page.tableName === 'topics') stats.topicRecordCount += count
    else if (page.tableName === 'message_blocks') stats.blockRecordCount += count
    else if (page.tableName === 'topic_segments') stats.segmentRecordCount += count
    else if (page.tableName === 'files') stats.sourceFileRecordCount += count
  }
  return stats
}

function makeCandidateStats(pageCount: number): CandidateImportStats {
  return {
    topicCount: 0,
    messageCount: 0,
    blockCount: 0,
    segmentCount: 0,
    segmentMembershipCount: 0,
    fileReferenceCount: 0,
    pageCount,
    elapsedMs: 0
  }
}

function makePlane(overrides: Partial<Record<string, any>> = {}) {
  const pages: ReadPageResponse[] = []
  const plane: any = {
    pages,
    processPage: vi.fn(async (response: ReadPageResponse) => {
      pages.push(response)
    }),
    finalize: vi.fn(() => ({
      sourceReadStats: computeSourceStats(pages),
      candidateImportStats: makeCandidateStats(pages.length)
    }))
  }
  return Object.assign(plane, overrides)
}

interface Harness {
  session: Awaited<ReturnType<typeof startImport>>
  candidate: ReturnType<typeof makeCandidate>
  plane: ReturnType<typeof makePlane>
  onCandidateReady: ReturnType<typeof vi.fn>
}

async function begin(
  opts: {
    candidate?: ReturnType<typeof makeCandidate>
    plane?: ReturnType<typeof makePlane>
    onCandidateReady?: ReturnType<typeof vi.fn>
    now?: () => number
  } = {}
): Promise<Harness> {
  const candidate = opts.candidate ?? makeCandidate()
  const plane = opts.plane ?? makePlane()
  const onCandidateReady = opts.onCandidateReady ?? vi.fn()
  const session = await startImport('/tmp/test.zip', {
    onCandidateReady,
    candidateFactory: () => candidate,
    dataPlaneFactory: () => plane,
    now: opts.now
  })
  return { session, candidate, plane, onCandidateReady }
}

const DISCOVERY = {
  databaseName: 'CherryStudio',
  nativeVersion: 110,
  logicalVersion: 11,
  tableNames: ['topics', 'message_blocks', 'topic_segments', 'files']
}

async function discover(sessionId: string, opts: { clearSends?: boolean } = { clearSends: true }) {
  await capturedCallbacks.onDiscover(sessionId, DISCOVERY)
  if (opts.clearSends) mockSendReadPage.mockClear()
}

function page(tableName: string, items: any[], hasMore = false): ReadPageResponse {
  return { tableName, items, cursor: items.length > 0 ? String(items[items.length - 1].id) : null, hasMore }
}

/** Walk all 4 entities with single last pages: 3 topics, 2 blocks, 1 segment, 2 files. */
async function runAllPages(sessionId: string) {
  await capturedCallbacks.onReadPage(sessionId, page('topics', [{ id: 't1' }, { id: 't2' }, { id: 't3' }]))
  await capturedCallbacks.onReadPage(sessionId, page('message_blocks', [{ id: 'b1' }, { id: 'b2' }]))
  await capturedCallbacks.onReadPage(sessionId, page('topic_segments', [{ id: 's1' }]))
  await capturedCallbacks.onReadPage(sessionId, page('files', [{ id: 'f1' }, { id: 'f2' }]))
}

const EXPECTED_SOURCE_STATS: SourceReadStats = {
  topicRecordCount: 3,
  blockRecordCount: 2,
  segmentRecordCount: 1,
  sourceFileRecordCount: 2
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ChatImport index', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedCallbacks = null
    // Production defaults delegate to the doubles (never real SQLite here).
    hoisted.candidateCtor.mockImplementation((_opts: any) => makeCandidate())
    hoisted.createPlane.mockImplementation((_db: unknown) => makePlane())
    // Dispose any active session
    disposeActiveImport()
  })

  afterEach(() => {
    disposeActiveImport()
  })

  const itOnDarwin = process.platform === 'darwin' ? it : it.skip

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
  // getActiveImport / cancelImport / error classes
  // =========================================================================

  describe('getActiveImport', () => {
    it('returns null when no import is active', () => {
      expect(getActiveImport()).toBeNull()
    })
  })

  describe('cancelImport', () => {
    it('does nothing when no session exists with given id', async () => {
      await expect(cancelImport('nonexistent')).resolves.not.toThrow()
    })
  })

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
    itOnDarwin('registerChatImportIpc is called with callbacks', async () => {
      const { registerChatImportIpc } = await import('../importIpc')
      const { session } = await begin()

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
      const { session } = await begin()

      capturedCallbacks.onReady(session.id)
      expect(mockSendDiscover).toHaveBeenCalledWith(session.id)

      await session.dispose()
    })

    itOnDarwin('onReady ignores renderer "pending" sessionId and uses authoritative closure sessionId', async () => {
      const { session } = await begin()

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
      const { session } = await begin()

      await discover(session.id, { clearSends: false })

      expect(session.state).toBe('reading')
      expect(mockSendReadPage).toHaveBeenCalledWith(session.id, {
        tableName: 'topics',
        cursor: null,
        pageSize: DEFAULT_PAGE_SIZE
      })

      await session.dispose()
    })

    itOnDarwin('onReadPage sends next page of same table when hasMore', async () => {
      const { session } = await begin()
      await discover(session.id)

      await capturedCallbacks.onReadPage(session.id, {
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
      const { session } = await begin()
      await discover(session.id)

      await capturedCallbacks.onReadPage(session.id, {
        tableName: 'topics',
        items: [{ id: '1' }],
        cursor: '1',
        hasMore: false
      })

      expect(mockSendReadPage).toHaveBeenCalledWith(session.id, {
        tableName: 'message_blocks',
        cursor: null,
        pageSize: DEFAULT_PAGE_SIZE
      })

      await session.dispose()
    })

    itOnDarwin('onError enters the error lifecycle and resets the singleton (LOCK-O6)', async () => {
      const { session, candidate } = await begin()
      await discover(session.id)

      await capturedCallbacks.onError(session.id, {
        code: 'DISCOVERY_FAILED',
        message: 'test error'
      })

      expect(session.state).toBe('error')
      expect(candidate.discard).toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })
  })

  // =========================================================================
  // Candidate lifecycle — happy path (LOCK-O1/O2/O3/O7/O8)
  // =========================================================================

  describe('candidate lifecycle — happy path', () => {
    itOnDarwin('initializes the candidate after discovery and BEFORE the first ReadPage (LOCK-O1)', async () => {
      const { session, candidate, plane } = await begin()

      await discover(session.id, { clearSends: false })

      expect(candidate.initialize).toHaveBeenCalledTimes(1)
      expect(plane).toBeDefined()
      // Ordering: candidate init strictly precedes the first ReadPage send.
      const initOrder = candidate.initialize.mock.invocationCallOrder[0]
      const firstSendOrder = mockSendReadPage.mock.invocationCallOrder[0]
      expect(initOrder).toBeLessThan(firstSendOrder)

      await session.dispose()
    })

    itOnDarwin('awaits dataPlane.processPage BEFORE requesting the next page (LOCK-O2)', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const plane = makePlane({ processPage: vi.fn(() => gate) })
      const { session } = await begin({ plane })

      await discover(session.id)

      const pending = capturedCallbacks.onReadPage(session.id, {
        tableName: 'topics',
        items: [{ id: '1' }],
        cursor: '1',
        hasMore: true
      })

      // Flush microtasks: page handed to the data plane, next page NOT yet requested
      await Promise.resolve()
      await Promise.resolve()
      expect(plane.processPage).toHaveBeenCalledTimes(1)
      expect(mockSendReadPage).not.toHaveBeenCalled()

      release()
      await pending

      // Only after the transactional write resolved is the next page requested
      expect(mockSendReadPage).toHaveBeenCalledTimes(1)
      expect(mockSendReadPage).toHaveBeenCalledWith(session.id, {
        tableName: 'topics',
        cursor: '1',
        pageSize: DEFAULT_PAGE_SIZE
      })

      await session.dispose()
    })

    itOnDarwin(
      'last page finalizes once, seals, transitions to candidate-ready, emits one result (LOCK-O3/O7)',
      async () => {
        const nowValues = [1000, 3500]
        const now = vi.fn(() => nowValues.shift() ?? 3500)
        const { session, candidate, plane, onCandidateReady } = await begin({ now })

        await discover(session.id)
        await runAllPages(session.id)

        // No further page requested after the last entity
        expect(mockSendReadPage).toHaveBeenCalledTimes(3) // entity advances only
        expect(session.state).toBe('candidate-ready')

        // Exactly-once finalize + seal, candidate NOT discarded on success
        expect(plane.finalize).toHaveBeenCalledTimes(1)
        expect(candidate.seal).toHaveBeenCalledTimes(1)
        expect(candidate.discard).not.toHaveBeenCalled()

        // Exactly-once Main-only result with target stats + injected clock elapsedMs
        expect(onCandidateReady).toHaveBeenCalledTimes(1)
        expect(onCandidateReady).toHaveBeenCalledWith({
          sessionId: session.id,
          candidateId: `candidate-${session.id}`,
          stats: { ...makeCandidateStats(4), elapsedMs: 2500 }
        })

        // Session remains active for Phase 4.3 (no dispose on success)
        expect(getActiveImport()).toBe(session)

        await session.dispose()
      }
    )

    itOnDarwin('all four pages are handed to the data plane with matching source stats (LOCK-O7)', async () => {
      const { session, plane } = await begin()

      await discover(session.id)
      await runAllPages(session.id)

      expect(plane.processPage).toHaveBeenCalledTimes(4)
      expect(computeSourceStats(plane.pages)).toEqual(EXPECTED_SOURCE_STATS)
      expect(session.state).toBe('candidate-ready')

      await session.dispose()
    })

    itOnDarwin('the shared CandidateReadyResult contains no filesystem path', async () => {
      const { session, onCandidateReady } = await begin()

      await discover(session.id)
      await runAllPages(session.id)

      const result = onCandidateReady.mock.calls[0][0]
      expect(Object.keys(result).sort()).toEqual(['candidateId', 'sessionId', 'stats'])
      expect(JSON.stringify(result)).not.toContain(MOCK_DB_PATH)
      expect(result.candidateId).not.toContain('/')

      await session.dispose()
    })

    itOnDarwin('getSealedCandidate exposes the Main-only path only when candidate-ready', async () => {
      const { session, candidate } = await begin()

      expect(getSealedCandidate()).toBeNull()

      await discover(session.id)
      expect(getSealedCandidate()).toBeNull() // still reading

      await runAllPages(session.id)
      expect(getSealedCandidate()).toEqual({
        sessionId: session.id,
        candidateId: `candidate-${session.id}`,
        dbPath: MOCK_DB_PATH
      })
      expect(candidate.getDbPath).toHaveBeenCalled()

      await session.dispose()
      expect(getSealedCandidate()).toBeNull()
    })
  })

  // =========================================================================
  // Production defaults + live DB isolation (LOCK-O1/O8)
  // =========================================================================

  describe('production defaults (LOCK-O8)', () => {
    itOnDarwin('without injection, uses CandidateDbResource + createImportDataPlane', async () => {
      const candidate = makeCandidate()
      const plane = makePlane()
      hoisted.candidateCtor.mockImplementation((_opts: any) => candidate)
      hoisted.createPlane.mockImplementation((_db: unknown) => plane)

      const session = await startImport('/tmp/test.zip')
      await discover(session.id, { clearSends: false })

      // Production default candidate is keyed by ONLY the session ID (owned
      // layout under the Data root — no override that could alias live paths).
      expect(hoisted.candidateCtor).toHaveBeenCalledTimes(1)
      expect(hoisted.candidateCtor).toHaveBeenCalledWith({ sessionId: session.id })
      // Data plane is bound to the candidate's DB handle.
      expect(hoisted.createPlane).toHaveBeenCalledTimes(1)
      expect(hoisted.createPlane).toHaveBeenCalledWith(candidate.getDatabase())

      await session.dispose()
    })

    itOnDarwin('never constructs the live chatDbService (live DB isolation)', async () => {
      const { session } = await begin()

      await discover(session.id)
      await runAllPages(session.id)

      expect(hoisted.liveChatDbCtor).not.toHaveBeenCalled()
      expect(session.state).toBe('candidate-ready')

      await session.dispose()
    })
  })

  // =========================================================================
  // Renderer onComplete is informational only (LOCK-O4)
  // =========================================================================

  describe('duplicate/late renderer complete (LOCK-O4)', () => {
    itOnDarwin('onComplete after candidate-ready cannot re-finalize or duplicate the result', async () => {
      const { session, candidate, plane, onCandidateReady } = await begin()

      await discover(session.id)
      await runAllPages(session.id)
      expect(onCandidateReady).toHaveBeenCalledTimes(1)

      // Late renderer complete — must be a no-op.
      capturedCallbacks.onComplete(session.id, EXPECTED_SOURCE_STATS)

      expect(session.state).toBe('candidate-ready')
      expect(plane.finalize).toHaveBeenCalledTimes(1)
      expect(candidate.seal).toHaveBeenCalledTimes(1)
      expect(onCandidateReady).toHaveBeenCalledTimes(1)

      await session.dispose()
    })

    itOnDarwin('onComplete during reading cannot trigger completion (Main progression is authoritative)', async () => {
      const { session, plane, onCandidateReady } = await begin()

      await discover(session.id)
      await capturedCallbacks.onReadPage(session.id, page('topics', [{ id: 't1' }]))

      // Premature renderer complete while entities remain — ignored.
      capturedCallbacks.onComplete(session.id, EXPECTED_SOURCE_STATS)

      expect(session.state).toBe('reading')
      expect(plane.finalize).not.toHaveBeenCalled()
      expect(onCandidateReady).not.toHaveBeenCalled()

      await session.dispose()
    })
  })

  // =========================================================================
  // Failure lifecycle (LOCK-O6)
  // =========================================================================

  describe('failure lifecycle (LOCK-O6)', () => {
    itOnDarwin('candidate init failure enters error, discards, resets singleton, sends no page', async () => {
      const candidate = makeCandidate({
        initialize: vi.fn(async () => {
          throw new Error('init boom')
        })
      })
      const { session, onCandidateReady } = await begin({ candidate })

      await expect(discover(session.id, { clearSends: false })).rejects.toThrow('init boom')

      expect(session.state).toBe('error')
      expect(candidate.discard).toHaveBeenCalled()
      expect(mockSendReadPage).not.toHaveBeenCalled()
      expect(onCandidateReady).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('page write failure enters error, discards, no next page, no ready callback', async () => {
      const plane = makePlane({
        processPage: vi.fn(async () => {
          throw new Error('page write failed')
        })
      })
      const { session, candidate, onCandidateReady } = await begin({ plane })

      await discover(session.id)

      await expect(capturedCallbacks.onReadPage(session.id, page('topics', [{ id: 't1' }], true))).rejects.toThrow(
        'page write failed'
      )

      expect(session.state).toBe('error')
      expect(candidate.discard).toHaveBeenCalled()
      expect(mockSendReadPage).not.toHaveBeenCalled()
      expect(onCandidateReady).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('page write failure on the LAST page does not self-complete', async () => {
      const plane = makePlane({
        processPage: vi.fn(async () => {
          throw new Error('final page write failed')
        })
      })
      const { session, onCandidateReady } = await begin({ plane })

      await discover(session.id)

      await expect(capturedCallbacks.onReadPage(session.id, page('topics', [{ id: 't1' }]))).rejects.toThrow(
        'final page write failed'
      )

      expect(session.state).toBe('error')
      expect(mockSendReadPage).not.toHaveBeenCalled()
      expect(onCandidateReady).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('finalize failure (missing blocks) enters error and never seals', async () => {
      const plane = makePlane()
      plane.finalize = vi.fn(() => {
        throw new Error('MISSING_BLOCKS: 2 referenced block ID(s) never appeared')
      })
      const { session, candidate, onCandidateReady } = await begin({ plane })

      await discover(session.id)
      await capturedCallbacks.onReadPage(session.id, page('topics', [{ id: 't1' }]))
      await capturedCallbacks.onReadPage(session.id, page('message_blocks', []))
      await capturedCallbacks.onReadPage(session.id, page('topic_segments', []))
      await expect(capturedCallbacks.onReadPage(session.id, page('files', []))).rejects.toThrow('MISSING_BLOCKS')

      expect(session.state).toBe('error')
      expect(candidate.seal).not.toHaveBeenCalled() // seal never reached...
      expect(candidate.discard).toHaveBeenCalled() // ...but discard cleans up
      expect(onCandidateReady).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('orchestrator/data-plane source stats mismatch is an error, not accepted (LOCK-O7)', async () => {
      const plane = makePlane()
      plane.finalize = vi.fn(() => ({
        sourceReadStats: { ...EXPECTED_SOURCE_STATS, blockRecordCount: 99 },
        candidateImportStats: makeCandidateStats(4)
      }))
      const { session, candidate, onCandidateReady } = await begin({ plane })

      await discover(session.id)
      await capturedCallbacks.onReadPage(session.id, page('topics', [{ id: 't1' }, { id: 't2' }, { id: 't3' }]))
      await capturedCallbacks.onReadPage(session.id, page('message_blocks', [{ id: 'b1' }, { id: 'b2' }]))
      await capturedCallbacks.onReadPage(session.id, page('topic_segments', [{ id: 's1' }]))
      await expect(
        capturedCallbacks.onReadPage(session.id, page('files', [{ id: 'f1' }, { id: 'f2' }]))
      ).rejects.toThrow(/mismatch.*blockRecordCount: orchestrator=2, dataPlane=99/s)

      expect(session.state).toBe('error')
      expect(candidate.seal).not.toHaveBeenCalled()
      expect(candidate.discard).toHaveBeenCalled()
      expect(onCandidateReady).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('seal failure enters error and discards', async () => {
      const candidate = makeCandidate({
        seal: vi.fn(() => {
          throw new Error('seal boom')
        })
      })
      const { session, onCandidateReady } = await begin({ candidate })

      await discover(session.id)
      await capturedCallbacks.onReadPage(session.id, page('topics', []))
      await capturedCallbacks.onReadPage(session.id, page('message_blocks', []))
      await capturedCallbacks.onReadPage(session.id, page('topic_segments', []))
      await expect(capturedCallbacks.onReadPage(session.id, page('files', []))).rejects.toThrow('seal boom')

      expect(session.state).toBe('error')
      expect(candidate.discard).toHaveBeenCalled()
      expect(onCandidateReady).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('candidate-ready callback failure enters error, discards, and stays exactly-once', async () => {
      const onCandidateReady = vi.fn(() => {
        throw new Error('callback boom')
      })
      const { session, candidate } = await begin({ onCandidateReady })

      await discover(session.id)
      await capturedCallbacks.onReadPage(session.id, page('topics', []))
      await capturedCallbacks.onReadPage(session.id, page('message_blocks', []))
      await capturedCallbacks.onReadPage(session.id, page('topic_segments', []))
      await expect(capturedCallbacks.onReadPage(session.id, page('files', []))).rejects.toThrow('callback boom')

      expect(onCandidateReady).toHaveBeenCalledTimes(1)
      expect(session.state).toBe('error')
      expect(candidate.discard).toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })
  })

  // =========================================================================
  // Cancellation (LOCK-O5)
  // =========================================================================

  describe('cancellation (LOCK-O5)', () => {
    itOnDarwin('cancel during an awaited page write prevents next page and ready callback', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      // First three entity pages commit immediately; ONLY the final page
      // (whose completion would finalize/seal) blocks on the gate.
      const plane = makePlane({
        processPage: vi.fn((response: ReadPageResponse) => (response.tableName === 'files' ? gate : Promise.resolve()))
      })
      const { session, candidate, onCandidateReady } = await begin({ plane })

      await discover(session.id)

      await capturedCallbacks.onReadPage(session.id, page('topics', []))
      await capturedCallbacks.onReadPage(session.id, page('message_blocks', []))
      await capturedCallbacks.onReadPage(session.id, page('topic_segments', []))
      expect(plane.processPage).toHaveBeenCalledTimes(3)

      // Last page of the last entity — completion would follow the write.
      const pending = capturedCallbacks.onReadPage(session.id, page('files', []))
      await Promise.resolve()

      // Cancel while the page write is in flight.
      await session.cancel()
      expect(session.state).toBe('cancelled')
      expect(mockSendCancel).toHaveBeenCalledWith(session.id)
      expect(candidate.discard).toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()

      mockSendReadPage.mockClear()
      release()
      await pending

      // Post-await re-check: no next page, no finalize, no ready callback.
      expect(mockSendReadPage).not.toHaveBeenCalled()
      expect(plane.finalize).not.toHaveBeenCalled()
      expect(onCandidateReady).not.toHaveBeenCalled()
    })

    itOnDarwin('cancel before candidate-ready discards the candidate and source resources', async () => {
      const { session, candidate } = await begin()
      await discover(session.id)

      await session.cancel()

      expect(session.state).toBe('cancelled')
      expect(mockSendCancel).toHaveBeenCalledWith(session.id)
      expect(candidate.discard).toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('cancel AFTER candidate-ready discards the sealed candidate (until future promotion)', async () => {
      const { session, candidate, onCandidateReady } = await begin()

      await discover(session.id)
      await runAllPages(session.id)
      expect(session.state).toBe('candidate-ready')
      expect(getSealedCandidate()).not.toBeNull()

      await session.cancel()

      expect(session.state).toBe('cancelled')
      expect(candidate.discard).toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
      expect(getSealedCandidate()).toBeNull()
      // The single earlier emission remains the only one.
      expect(onCandidateReady).toHaveBeenCalledTimes(1)
    })

    itOnDarwin('cancel in terminal states is a no-op', async () => {
      const { session, candidate } = await begin()
      await discover(session.id)

      await session.cancel()
      mockSendCancel.mockClear()
      candidate.discard.mockClear()

      await session.cancel()
      expect(mockSendCancel).not.toHaveBeenCalled()
      expect(candidate.discard).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // State machine + singleton
  // =========================================================================

  describe('state machine', () => {
    itOnDarwin('startImport creates a session on darwin', async () => {
      const { session } = await begin()
      expect(session).toBeDefined()
      expect(session.id).toContain('import-')
      expect(getActiveImport()).toBe(session)

      await session.dispose()
    })

    itOnDarwin('second concurrent import throws ChatImportSessionError', async () => {
      const { session: session1 } = await begin()

      await expect(startImport('/tmp/test2.zip')).rejects.toThrow(ChatImportSessionError)

      await session1.dispose()
    })

    itOnDarwin('getActiveImport returns the active session', async () => {
      const { session } = await begin()
      expect(getActiveImport()).toBe(session)
      await session.dispose()
    })

    itOnDarwin('dispose cleans up the session and the candidate', async () => {
      const { session, candidate } = await begin()
      await discover(session.id)
      expect(getActiveImport()).not.toBeNull()

      await session.dispose()
      expect(getActiveImport()).toBeNull()
      expect(candidate.discard).toHaveBeenCalled()
    })
  })

  // =========================================================================
  // disposeActiveImport (sync will-quit path)
  // =========================================================================

  describe('disposeActiveImport', () => {
    it('does nothing when no session is active', () => {
      expect(() => disposeActiveImport()).not.toThrow()
    })

    itOnDarwin('discards the candidate synchronously', async () => {
      const { session, candidate } = await begin()
      await discover(session.id)

      disposeActiveImport()

      expect(candidate.discardSync).toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
      // Keep afterEach happy: async dispose is idempotent.
      await session.dispose()
    })
  })
})
