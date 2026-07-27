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
 * - Verification orchestration (Phase 4.3.3 — LOCK-4301…4305):
 *   - exactly one verifier starts after the exact-once candidate-ready
 *     callback, bound to the same-data-plane manifest + candidate dbPath
 *   - pass retains the sealed candidate + report (verified-candidate)
 *   - fail delivers the sanitized report exactly once, then verifier close
 *     → candidate discard → source disposal → singleton reset
 *   - cancel before start / during verification / after verified
 *   - callback throw containment; duplicate start/completion attempts;
 *     stale completions; async dispose + sync will-quit resource ordering
 *   - no filesystem path in the verification completion payload
 * - Promotion protocol foundations (Phase 4.4.0 — LOCK-4401/4405):
 *   - claimPromotion is the unique, exact-once entry bounded to
 *     getVerifiedCandidate; token issued once and never reissued
 *   - cancel rejected during promoting (no state change, no cleanup)
 *   - completePromotion settles promoted | promotion-failed exactly once
 *     against the issued token; result states terminal
 *   - async dispose + sync will-quit preserve the promotion-owned candidate
 *   - no live DB / filesystem side effects from claiming or settling
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

// Mock @main/config so importing the promotion preparation module (via the
// index service entry) never touches a live Data path (house pattern).
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

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
  createVerifier: vi.fn(),
  liveChatDbCtor: vi.fn()
}))

vi.mock('../candidateDb', () => ({
  CandidateDbResource: hoisted.candidateCtor
}))

vi.mock('../importDataPlane', () => ({
  createImportDataPlane: hoisted.createPlane
}))

// Production-default verifier (LOCK-O8): mocked so no real better-sqlite3 /
// chatDb read path is ever touched by this suite.
vi.mock('../verification/candidateVerifier', () => ({
  createCandidateVerifier: hoisted.createVerifier
}))

// Live DB isolation sentinel: the orchestrator must never construct the live
// chatDbService (LOCK-O1). Mocked with a spy constructor.
vi.mock('@main/services/chatDb', () => ({
  ChatDbService: hoisted.liveChatDbCtor
}))

import { ChatImportSessionError, ChatImportUnsupportedPlatformError } from '../errors'
import type { PreparedPromotionHandle, PromotionPreparationResult } from '../index'
import {
  cancelImport,
  claimPromotion,
  completePromotion,
  DEFAULT_PAGE_SIZE,
  disposeActiveImport,
  getActiveImport,
  getSealedCandidate,
  getVerifiedCandidate,
  startImport,
  startPromotionPreparation
} from '../index'

// ---------------------------------------------------------------------------
// Test doubles (LOCK-O8 factory injection)
// ---------------------------------------------------------------------------

const MOCK_DB_PATH = '/mock/candidates/candidate-x/chat.db'

/** Opaque manifest sentinel returned by the plane double (LOCK-4301 identity check). */
const MOCK_MANIFEST: any = { mock: 'source-verification-manifest' }

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
    })),
    getSourceVerificationManifest: vi.fn(() => MOCK_MANIFEST)
  }
  return Object.assign(plane, overrides)
}

const REPORT_DIMENSIONS = [
  'id_sets',
  'table_counts',
  'field_digests',
  'order',
  'fk_references',
  'relations',
  'file_references',
  'segments',
  'structured_json',
  'overflow',
  'integrity_check',
  'foreign_key_check',
  'sample_reads'
] as const

/** Sanitized 13-dimension report double (LOCK-4304 shape). */
function makeReport(status: 'pass' | 'fail' | 'aborted' = 'pass', fatal: any = null) {
  return {
    status,
    dimensions: REPORT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: status === 'pass' ? 'pass' : 'skipped',
      checkedCount: 0,
      diagnostics: [],
      truncatedDiagnosticCount: 0
    })),
    fatal
  }
}

function makeVerifier(report: any = makeReport('pass'), overrides: Partial<Record<string, any>> = {}) {
  const verifier: any = {
    run: vi.fn(async () => report),
    close: vi.fn()
  }
  return Object.assign(verifier, overrides)
}

/** Flush the in-flight verification settle (microtasks + one macrotask). */
async function flushVerification() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Verifier double whose run() blocks until the test releases it. */
function makeGatedVerifier() {
  let releaseRun!: (report: any) => void
  const runGate = new Promise<any>((resolve) => {
    releaseRun = resolve
  })
  const verifier = makeVerifier(undefined, { run: vi.fn(() => runGate) })
  return { verifier, releaseRun }
}

interface Harness {
  session: Awaited<ReturnType<typeof startImport>>
  candidate: ReturnType<typeof makeCandidate>
  plane: ReturnType<typeof makePlane>
  verifier: ReturnType<typeof makeVerifier>
  verifierFactory: ReturnType<typeof vi.fn>
  onCandidateReady: ReturnType<typeof vi.fn>
  onVerificationComplete: ReturnType<typeof vi.fn>
}

async function begin(
  opts: {
    candidate?: ReturnType<typeof makeCandidate>
    plane?: ReturnType<typeof makePlane>
    verifier?: ReturnType<typeof makeVerifier>
    verifierFactory?: ReturnType<typeof vi.fn>
    onCandidateReady?: ReturnType<typeof vi.fn>
    onVerificationComplete?: ReturnType<typeof vi.fn>
    now?: () => number
  } = {}
): Promise<Harness> {
  const candidate = opts.candidate ?? makeCandidate()
  const plane = opts.plane ?? makePlane()
  const verifier = opts.verifier ?? makeVerifier()
  const verifierFactory = opts.verifierFactory ?? vi.fn((_options: any) => verifier)
  const onCandidateReady = opts.onCandidateReady ?? vi.fn()
  const onVerificationComplete = opts.onVerificationComplete ?? vi.fn()
  const session = await startImport('/tmp/test.zip', {
    onCandidateReady,
    onVerificationComplete,
    candidateFactory: () => candidate,
    dataPlaneFactory: () => plane,
    verifierFactory,
    now: opts.now
  })
  return { session, candidate, plane, verifier, verifierFactory, onCandidateReady, onVerificationComplete }
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
    hoisted.createVerifier.mockImplementation((_options: any) => makeVerifier())
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
        const { verifier, releaseRun } = makeGatedVerifier()
        const { session, candidate, plane, onCandidateReady } = await begin({ now, verifier })

        await discover(session.id)
        await runAllPages(session.id)

        // No further page requested after the last entity; verification
        // auto-starts after the exact-once ready emission (Phase 4.3.3).
        expect(mockSendReadPage).toHaveBeenCalledTimes(3) // entity advances only
        expect(session.state).toBe('verifying')
        releaseRun(makeReport('pass'))
        await flushVerification()

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
      await flushVerification()
      expect(session.state).toBe('verified-candidate')

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

    itOnDarwin('getSealedCandidate exposes the Main-only path only while a sealed candidate is alive', async () => {
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session, candidate } = await begin({ verifier })

      expect(getSealedCandidate()).toBeNull()

      await discover(session.id)
      expect(getSealedCandidate()).toBeNull() // still reading

      await runAllPages(session.id)
      // Sealed candidate alive across candidate-ready → verifying → verified.
      expect(session.state).toBe('verifying')
      expect(getSealedCandidate()).toEqual({
        sessionId: session.id,
        candidateId: `candidate-${session.id}`,
        dbPath: MOCK_DB_PATH
      })
      expect(candidate.getDbPath).toHaveBeenCalled()

      releaseRun(makeReport('pass'))
      await flushVerification()
      expect(session.state).toBe('verified-candidate')
      expect(getSealedCandidate()).not.toBeNull()

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

      await flushVerification()
      expect(hoisted.liveChatDbCtor).not.toHaveBeenCalled()
      expect(session.state).toBe('verified-candidate')

      await session.dispose()
    })
  })

  // =========================================================================
  // Renderer onComplete is informational only (LOCK-O4)
  // =========================================================================

  describe('duplicate/late renderer complete (LOCK-O4)', () => {
    itOnDarwin('onComplete after candidate-ready cannot re-finalize or duplicate the result', async () => {
      const { session, candidate, plane, verifierFactory, onCandidateReady } = await begin()

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()
      expect(onCandidateReady).toHaveBeenCalledTimes(1)
      expect(session.state).toBe('verified-candidate')

      // Late renderer complete — must be a no-op.
      capturedCallbacks.onComplete(session.id, EXPECTED_SOURCE_STATS)
      await flushVerification()

      expect(session.state).toBe('verified-candidate')
      expect(plane.finalize).toHaveBeenCalledTimes(1)
      expect(candidate.seal).toHaveBeenCalledTimes(1)
      expect(onCandidateReady).toHaveBeenCalledTimes(1)
      expect(verifierFactory).toHaveBeenCalledTimes(1) // no second verification

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

    itOnDarwin('candidate-ready callback failure never starts verification (LOCK-4304)', async () => {
      const onCandidateReady = vi.fn(() => {
        throw new Error('callback boom')
      })
      const { session, verifierFactory, onVerificationComplete } = await begin({ onCandidateReady })

      await discover(session.id)
      await capturedCallbacks.onReadPage(session.id, page('topics', []))
      await capturedCallbacks.onReadPage(session.id, page('message_blocks', []))
      await capturedCallbacks.onReadPage(session.id, page('topic_segments', []))
      await expect(capturedCallbacks.onReadPage(session.id, page('files', []))).rejects.toThrow('callback boom')

      expect(verifierFactory).not.toHaveBeenCalled()
      expect(onVerificationComplete).not.toHaveBeenCalled()
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

    itOnDarwin('cancel AFTER candidate sealing discards the sealed candidate (until future promotion)', async () => {
      const { session, candidate, onCandidateReady } = await begin()

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()
      expect(session.state).toBe('verified-candidate')
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
  // Verification orchestration (Phase 4.3.3 — LOCK-4301…4305)
  // =========================================================================

  describe('verification (Phase 4.3.3)', () => {
    itOnDarwin('starts exactly one verifier with dbPath + same-data-plane manifest + abort signal', async () => {
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session, plane, verifierFactory, onCandidateReady } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)

      // Exactly one verifier, created only AFTER the exact-once ready callback.
      expect(verifierFactory).toHaveBeenCalledTimes(1)
      expect(onCandidateReady.mock.invocationCallOrder[0]).toBeLessThan(verifierFactory.mock.invocationCallOrder[0])

      // LOCK-4301: the manifest is the SAME object the data plane finalized.
      expect(plane.getSourceVerificationManifest).toHaveBeenCalledTimes(1)
      const verifierOptions = verifierFactory.mock.calls[0][0]
      expect(verifierOptions.dbPath).toBe(MOCK_DB_PATH)
      expect(verifierOptions.manifest).toBe(MOCK_MANIFEST)
      expect(verifierOptions.signal).toBeInstanceOf(AbortSignal)
      expect(verifierOptions.signal.aborted).toBe(false)

      expect(session.state).toBe('verifying')

      releaseRun(makeReport('pass'))
      await flushVerification()
      await session.dispose()
    })

    itOnDarwin('happy pass retains the sealed candidate + report and emits exactly one completion', async () => {
      const report = makeReport('pass')
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session, candidate, onVerificationComplete } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)
      expect(session.state).toBe('verifying')

      releaseRun(report)
      await flushVerification()

      expect(session.state).toBe('verified-candidate')
      expect(verifier.run).toHaveBeenCalledTimes(1)
      expect(verifier.close).toHaveBeenCalled()
      // Pass retains the sealed candidate for Phase 4.4 (LOCK-4305).
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(candidate.discardSync).not.toHaveBeenCalled()
      expect(getActiveImport()).toBe(session)

      // Exactly-once Main-only completion with report + ready identity/stats.
      expect(onVerificationComplete).toHaveBeenCalledTimes(1)
      expect(onVerificationComplete).toHaveBeenCalledWith({
        sessionId: session.id,
        candidateId: `candidate-${session.id}`,
        stats: { ...makeCandidateStats(4), elapsedMs: expect.any(Number) },
        report
      })

      // Main-only accessor for the future 4.4 consumer.
      expect(getVerifiedCandidate()).toEqual({
        sessionId: session.id,
        candidateId: `candidate-${session.id}`,
        dbPath: MOCK_DB_PATH,
        report
      })

      await session.dispose()
      expect(getVerifiedCandidate()).toBeNull()
    })

    itOnDarwin('the verification completion payload contains no filesystem path (LOCK-4304)', async () => {
      const { session, onVerificationComplete } = await begin()

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      const payload = onVerificationComplete.mock.calls[0][0]
      expect(Object.keys(payload).sort()).toEqual(['candidateId', 'report', 'sessionId', 'stats'])
      expect(JSON.stringify(payload)).not.toContain(MOCK_DB_PATH)
      expect(JSON.stringify(payload)).not.toContain('/mock')
      expect(payload.candidateId).not.toContain('/')

      await session.dispose()
    })

    itOnDarwin(
      'failing report: exact-once sanitized report, then verifier close → candidate discard → source disposal',
      async () => {
        const report = makeReport('fail')
        const verifier = makeVerifier(report)
        const { session, candidate, onVerificationComplete } = await begin({ verifier })

        await discover(session.id)
        await runAllPages(session.id)
        await flushVerification()

        expect(session.state).toBe('verification-failed')
        // Report delivered exactly once, BEFORE resource cleanup.
        expect(onVerificationComplete).toHaveBeenCalledTimes(1)
        expect(onVerificationComplete.mock.calls[0][0].report).toBe(report)
        expect(onVerificationComplete.mock.invocationCallOrder[0]).toBeLessThan(
          candidate.discard.mock.invocationCallOrder[0]
        )

        // LOCK-4303 order: verifier close → candidate discard → reader →
        // temp workspace. The candidate is never removed while held.
        const { dispose: disposeSessionMock } = (await import('../isolatedSession')) as any
        const { disposeAsync: disposeTempMock } = (await import('../tempWorkspace')) as any
        expect(candidate.discard).toHaveBeenCalledTimes(1)
        expect(verifier.close.mock.invocationCallOrder[0]).toBeLessThan(candidate.discard.mock.invocationCallOrder[0])
        expect(candidate.discard.mock.invocationCallOrder[0]).toBeLessThan(
          disposeSessionMock.mock.invocationCallOrder[0]
        )
        expect(disposeSessionMock.mock.invocationCallOrder[0]).toBeLessThan(disposeTempMock.mock.invocationCallOrder[0])

        // Singleton reset; no verified handle.
        expect(getActiveImport()).toBeNull()
        expect(getVerifiedCandidate()).toBeNull()
        expect(getSealedCandidate()).toBeNull()
      }
    )

    itOnDarwin('open fatal surfaces as a sanitized failing report and cleans up', async () => {
      const report = makeReport('fail', {
        code: 'CANDIDATE_OPEN_FAILED',
        errorCode: 'SQLITE_CANTOPEN',
        fieldPath: null,
        message: 'CANDIDATE_OPEN_FAILED: SQLITE_CANTOPEN'
      })
      const verifier = makeVerifier(report)
      const { session, candidate, onVerificationComplete } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      expect(session.state).toBe('verification-failed')
      expect(onVerificationComplete).toHaveBeenCalledTimes(1)
      const payload = onVerificationComplete.mock.calls[0][0]
      expect(payload.report.fatal.code).toBe('CANDIDATE_OPEN_FAILED')
      expect(JSON.stringify(payload)).not.toContain(MOCK_DB_PATH)
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('verifier run() rejection enters the error lifecycle without a completion callback', async () => {
      const verifier = makeVerifier(undefined, {
        run: vi.fn(async () => {
          throw new Error('lifecycle misuse')
        })
      })
      const { session, candidate, onVerificationComplete } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      expect(session.state).toBe('error')
      expect(onVerificationComplete).not.toHaveBeenCalled()
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('manifest retrieval failure enters the error lifecycle before any verifier exists', async () => {
      const plane = makePlane({
        getSourceVerificationManifest: vi.fn(() => {
          throw new Error('NOT_FINALIZED boom')
        })
      })
      const { session, candidate, verifierFactory, onVerificationComplete, onCandidateReady } = await begin({ plane })

      await discover(session.id)
      await capturedCallbacks.onReadPage(session.id, page('topics', []))
      await capturedCallbacks.onReadPage(session.id, page('message_blocks', []))
      await capturedCallbacks.onReadPage(session.id, page('topic_segments', []))
      await expect(capturedCallbacks.onReadPage(session.id, page('files', []))).rejects.toThrow('NOT_FINALIZED boom')

      expect(onCandidateReady).toHaveBeenCalledTimes(1) // ready stayed exact-once
      expect(verifierFactory).not.toHaveBeenCalled()
      expect(onVerificationComplete).not.toHaveBeenCalled()
      expect(session.state).toBe('error')
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('cancel inside the ready callback prevents verification from starting', async () => {
      const onCandidateReady = vi.fn(async (result: any) => {
        await cancelImport(result.sessionId)
      })
      const { session, candidate, verifierFactory, onVerificationComplete } = await begin({ onCandidateReady })

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      expect(session.state).toBe('cancelled')
      expect(verifierFactory).not.toHaveBeenCalled()
      expect(onVerificationComplete).not.toHaveBeenCalled()
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin(
      'cancel during verification: abort → verifier close → await run → candidate discard; no completion',
      async () => {
        let releaseRun!: (report: any) => void
        const runGate = new Promise<any>((resolve) => {
          releaseRun = resolve
        })
        let signalAbortedAtClose: boolean | null = null
        let capturedSignal: AbortSignal | null = null
        const verifier = makeVerifier(undefined, {
          run: vi.fn(() => runGate),
          close: vi.fn(() => {
            signalAbortedAtClose = capturedSignal?.aborted ?? null
          })
        })
        const verifierFactory = vi.fn((options: any) => {
          capturedSignal = options.signal
          return verifier
        })
        const { session, candidate, onVerificationComplete } = await begin({ verifier, verifierFactory })

        await discover(session.id)
        await runAllPages(session.id)
        expect(session.state).toBe('verifying')

        const cancelPromise = session.cancel()

        // The candidate must NOT be discarded while the verifier holds it:
        // dispose is parked awaiting the in-flight run (LOCK-4303).
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(session.state).toBe('cancelled')
        expect(verifier.close).toHaveBeenCalled()
        expect(signalAbortedAtClose).toBe(true) // abort signaled BEFORE close
        expect(candidate.discard).not.toHaveBeenCalled()

        releaseRun(makeReport('aborted'))
        await cancelPromise

        // Verifier completion awaited, THEN candidate discarded.
        expect(candidate.discard).toHaveBeenCalledTimes(1)
        expect(onVerificationComplete).not.toHaveBeenCalled()
        expect(getActiveImport()).toBeNull()
        expect(getVerifiedCandidate()).toBeNull()
      }
    )

    itOnDarwin('cancel after verified-candidate discards the candidate; completion stays exactly-once', async () => {
      const { session, candidate, onVerificationComplete } = await begin()

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()
      expect(session.state).toBe('verified-candidate')
      expect(onVerificationComplete).toHaveBeenCalledTimes(1)

      await session.cancel()

      expect(session.state).toBe('cancelled')
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(onVerificationComplete).toHaveBeenCalledTimes(1) // still exactly once
      expect(getActiveImport()).toBeNull()
      expect(getVerifiedCandidate()).toBeNull()
    })

    itOnDarwin('completion callback throw on pass is contained: state and candidate retained', async () => {
      const onVerificationComplete = vi.fn(() => {
        throw new Error('verification callback boom')
      })
      const { session, candidate } = await begin({ onVerificationComplete })

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      expect(onVerificationComplete).toHaveBeenCalledTimes(1)
      expect(session.state).toBe('verified-candidate')
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(getActiveImport()).toBe(session)
      expect(getVerifiedCandidate()).not.toBeNull()

      await session.dispose()
    })

    itOnDarwin('completion callback throw on fail is contained: cleanup still runs', async () => {
      const onVerificationComplete = vi.fn(() => {
        throw new Error('verification callback boom')
      })
      const verifier = makeVerifier(makeReport('fail'))
      const { session, candidate } = await begin({ verifier, onVerificationComplete })

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      expect(onVerificationComplete).toHaveBeenCalledTimes(1)
      expect(session.state).toBe('verification-failed')
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('cancel from inside the pass completion callback cannot deadlock or double-clean', async () => {
      const onVerificationComplete = vi.fn(async (result: any) => {
        await cancelImport(result.sessionId)
      })
      const { session, candidate, verifier } = await begin({ onVerificationComplete })

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      expect(onVerificationComplete).toHaveBeenCalledTimes(1)
      expect(session.state).toBe('cancelled')
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(verifier.run).toHaveBeenCalledTimes(1)
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin(
      'duplicate start attempts: late renderer complete/pages cannot start a second verification',
      async () => {
        const { session, verifier, verifierFactory, onVerificationComplete } = await begin()

        await discover(session.id)
        await runAllPages(session.id)

        // Late renderer signals while verifying — all ignored.
        capturedCallbacks.onComplete(session.id, EXPECTED_SOURCE_STATS)
        await capturedCallbacks.onReadPage(session.id, page('files', []))
        await flushVerification()
        capturedCallbacks.onComplete(session.id, EXPECTED_SOURCE_STATS)
        await flushVerification()

        expect(verifierFactory).toHaveBeenCalledTimes(1)
        expect(verifier.run).toHaveBeenCalledTimes(1)
        expect(onVerificationComplete).toHaveBeenCalledTimes(1)
        expect(session.state).toBe('verified-candidate')

        await session.dispose()
      }
    )

    itOnDarwin('stale completion after sync will-quit delivers nothing and leaks nothing', async () => {
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session, candidate, onVerificationComplete } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)
      expect(session.state).toBe('verifying')

      // Sync quit while the run is in flight.
      disposeActiveImport()
      expect(getActiveImport()).toBeNull()
      expect(candidate.discardSync).toHaveBeenCalledTimes(1)

      // The run settles later — stale: no callback, no state transition.
      releaseRun(makeReport('pass'))
      await flushVerification()

      expect(onVerificationComplete).not.toHaveBeenCalled()
      expect(getVerifiedCandidate()).toBeNull()
      expect(candidate.discard).not.toHaveBeenCalled() // async discard never ran

      await session.dispose()
    })

    itOnDarwin('sync will-quit ordering: verifier close → candidate discardSync → reader disposal', async () => {
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session, candidate } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)
      expect(session.state).toBe('verifying')

      disposeActiveImport()

      const { disposeSync: disposeSessionSyncMock } = (await import('../isolatedSession')) as any
      expect(verifier.close).toHaveBeenCalled()
      expect(candidate.discardSync).toHaveBeenCalledTimes(1)
      // LOCK-4303 sync order: verifier close → candidate discardSync → reader.
      expect(verifier.close.mock.invocationCallOrder[0]).toBeLessThan(candidate.discardSync.mock.invocationCallOrder[0])
      expect(candidate.discardSync.mock.invocationCallOrder[0]).toBeLessThan(
        disposeSessionSyncMock.mock.invocationCallOrder[0]
      )

      releaseRun(makeReport('aborted'))
      await flushVerification()
      await session.dispose()
    })

    itOnDarwin('fail() raced during the verification-failed callback await preserves the terminal state', async () => {
      // Accepted 4.3.3 audit correction: `verification-failed` is terminal.
      // A renderer error arriving while the fail-report callback is being
      // awaited must NOT flip the state to `error` or duplicate cleanup.
      const report = makeReport('fail')
      const verifier = makeVerifier(report)
      let stateInsideCallback: string | null = null
      let stateAfterRacedFail: string | null = null
      const onVerificationComplete = vi.fn(async (result: any) => {
        stateInsideCallback = getActiveImport()?.state ?? null
        // Raced failure while the callback is awaited (state: verification-failed).
        await capturedCallbacks.onError(result.sessionId, { code: 'E_LATE', message: 'late renderer error' })
        stateAfterRacedFail = harness.session.state
      })
      const harness = await begin({ verifier, onVerificationComplete })
      const { session, candidate } = harness

      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()

      expect(onVerificationComplete).toHaveBeenCalledTimes(1)
      expect(stateInsideCallback).toBe('verification-failed')
      // The raced fail() preserved the terminal state (never `error`).
      expect(stateAfterRacedFail).toBe('verification-failed')
      expect(session.state).toBe('verification-failed')
      // Cleanup stayed exact-once (dispose is idempotent).
      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(verifier.close).toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
      expect(getVerifiedCandidate()).toBeNull()
    })

    itOnDarwin('async dispose during verifying follows abort → close → run completion → discard', async () => {
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session, candidate } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)

      const disposePromise = session.dispose()
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Parked awaiting the in-flight run; candidate untouched (LOCK-4303).
      expect(verifier.close).toHaveBeenCalled()
      expect(candidate.discard).not.toHaveBeenCalled()

      releaseRun(makeReport('aborted'))
      await disposePromise

      expect(candidate.discard).toHaveBeenCalledTimes(1)
      expect(verifier.close.mock.invocationCallOrder[0]).toBeLessThan(candidate.discard.mock.invocationCallOrder[0])
      expect(getActiveImport()).toBeNull()
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

    itOnDarwin('marks the session disposed after sync cleanup; dispose() never re-enters async cleanup', async () => {
      // Accepted 4.3.3 audit correction: after disposeActiveImport()'s
      // ordered sync cleanup the session must report disposed and a later
      // dispose() must not re-run async resource cleanup.
      const { session, candidate } = await begin()
      await discover(session.id)

      const { dispose: disposeSessionMock } = (await import('../isolatedSession')) as any
      const { disposeAsync: disposeTempMock } = (await import('../tempWorkspace')) as any
      const asyncReaderCallsBefore = disposeSessionMock.mock.calls.length
      const asyncTempCallsBefore = disposeTempMock.mock.calls.length

      disposeActiveImport()

      expect((session as any).isDisposed).toBe(true)
      expect(candidate.discardSync).toHaveBeenCalledTimes(1)

      // A later async dispose() is a strict no-op: no async reader/session
      // disposal, no temp workspace disposal, no second candidate discard.
      await session.dispose()
      await session.dispose() // idempotent twice over

      expect(disposeSessionMock.mock.calls.length).toBe(asyncReaderCallsBefore)
      expect(disposeTempMock.mock.calls.length).toBe(asyncTempCallsBefore)
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(candidate.discardSync).toHaveBeenCalledTimes(1)
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin(
      'sync cleanup during verifying: disposed session ignores the late settle without async re-entry',
      async () => {
        const { verifier, releaseRun } = makeGatedVerifier()
        const { session, candidate, onVerificationComplete } = await begin({ verifier })

        await discover(session.id)
        await runAllPages(session.id)
        expect(session.state).toBe('verifying')

        disposeActiveImport()
        expect((session as any).isDisposed).toBe(true)

        // Verifier-close-before-candidate-discard ordering preserved.
        expect(verifier.close.mock.invocationCallOrder[0]).toBeLessThan(
          candidate.discardSync.mock.invocationCallOrder[0]
        )

        // Late settle is stale: no callback, no state change, no async cleanup.
        releaseRun(makeReport('pass'))
        await flushVerification()
        expect(onVerificationComplete).not.toHaveBeenCalled()
        expect(session.state).toBe('verifying') // no transition after disposal

        await session.dispose()
        expect(candidate.discard).not.toHaveBeenCalled()
      }
    )
  })

  // =========================================================================
  // Promotion protocol foundations (Phase 4.4.0 — LOCK-4401/4405)
  // =========================================================================

  describe('promotion protocol (LOCK-4401)', () => {
    /** Drive a harness to the verified-candidate state. */
    async function toVerified(session: Awaited<ReturnType<typeof startImport>>) {
      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()
      expect(session.state).toBe('verified-candidate')
    }

    it('claimPromotion returns null when no import session is active', () => {
      expect(claimPromotion()).toBeNull()
    })

    itOnDarwin('claimPromotion returns null before verified-candidate (verifying gate)', async () => {
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session } = await begin({ verifier })

      await discover(session.id)
      await runAllPages(session.id)
      expect(session.state).toBe('verifying')

      expect(claimPromotion()).toBeNull()
      expect(session.state).toBe('verifying')

      releaseRun(makeReport('aborted'))
      await flushVerification()
      await session.dispose()
    })

    itOnDarwin('claimPromotion is bounded to getVerifiedCandidate and transitions atomically', async () => {
      const { session } = await begin()
      await toVerified(session)

      const verified = getVerifiedCandidate()
      expect(verified).not.toBeNull()

      const claim = claimPromotion()
      expect(claim).not.toBeNull()
      expect(claim!.sessionId).toBe(verified!.sessionId)
      expect(claim!.candidateId).toBe(verified!.candidateId)
      expect(claim!.dbPath).toBe(verified!.dbPath)
      expect(claim!.report).toBe(verified!.report)
      expect(claim!.token).toMatch(/^promotion-/)
      expect(claim!.token).not.toContain('/')

      // The unique entry is consumed on the same synchronous frame.
      expect(session.state).toBe('promoting')
      expect(getVerifiedCandidate()).toBeNull()

      await session.dispose()
    })

    itOnDarwin('promotion claim is exact-once: every later claim returns null', async () => {
      const { session } = await begin()
      await toVerified(session)

      const first = claimPromotion()
      expect(first).not.toBeNull()
      expect(claimPromotion()).toBeNull()
      expect(claimPromotion()).toBeNull()
      expect(session.state).toBe('promoting')

      await session.dispose()
    })

    itOnDarwin('cancel during promoting is rejected: no state change, no cleanup, no renderer cancel', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)
      mockSendCancel.mockClear()

      expect(claimPromotion()).not.toBeNull()

      await session.cancel()
      await cancelImport(session.id)

      expect(session.state).toBe('promoting')
      expect(mockSendCancel).not.toHaveBeenCalled()
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(candidate.discardSync).not.toHaveBeenCalled()
      expect(getActiveImport()).toBe(session)

      await session.dispose()
    })

    itOnDarwin('completePromotion settles promoted exactly once against the issued token', async () => {
      const { session } = await begin()
      await toVerified(session)

      const claim = claimPromotion()
      expect(claim).not.toBeNull()

      expect(completePromotion('promotion-wrong-token', 'promoted')).toBe(false)
      expect(session.state).toBe('promoting')

      expect(completePromotion(claim!.token, 'promoted')).toBe(true)
      expect(session.state).toBe('promoted')

      // Token consumed — the terminal result can never be settled twice.
      expect(completePromotion(claim!.token, 'promotion-failed')).toBe(false)
      expect(completePromotion(claim!.token, 'promoted')).toBe(false)
      expect(session.state).toBe('promoted')

      await session.dispose()
    })

    itOnDarwin('completePromotion can settle promotion-failed; both results are terminal for cancel', async () => {
      const { session } = await begin()
      await toVerified(session)

      const claim = claimPromotion()
      expect(completePromotion(claim!.token, 'promotion-failed')).toBe(true)
      expect(session.state).toBe('promotion-failed')

      // Terminal: cancel is ignored, state unchanged.
      await session.cancel()
      expect(session.state).toBe('promotion-failed')

      await session.dispose()
    })

    itOnDarwin('completePromotion rejects outcomes outside the terminal result states', async () => {
      const { session } = await begin()
      await toVerified(session)

      const claim = claimPromotion()
      expect(completePromotion(claim!.token, 'verified-candidate' as any)).toBe(false)
      expect(completePromotion(claim!.token, 'error' as any)).toBe(false)
      expect(session.state).toBe('promoting')

      await session.dispose()
    })

    itOnDarwin('async dispose preserves the promotion-owned candidate (promoting + results)', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      expect(claimPromotion()).not.toBeNull()
      await session.dispose()

      // Ordinary disposal ran (reader/temp cleanup) but the candidate files
      // were preserved for the promotion executor / startup recovery.
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(candidate.discardSync).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('async dispose after promoted preserves the candidate too', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      const claim = claimPromotion()
      expect(completePromotion(claim!.token, 'promoted')).toBe(true)
      await session.dispose()

      expect(candidate.discard).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin('sync will-quit during promoting preserves the candidate and recovery assets', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      expect(claimPromotion()).not.toBeNull()
      disposeActiveImport()

      // Non-promotion resources torn down; candidate never discarded.
      const { disposeSync: disposeSessionSyncMock } = (await import('../isolatedSession')) as any
      expect(disposeSessionSyncMock).toHaveBeenCalled()
      expect(candidate.discardSync).not.toHaveBeenCalled()
      expect(candidate.discard).not.toHaveBeenCalled()
      expect((session as any).isDisposed).toBe(true)
      expect(getActiveImport()).toBeNull()

      await session.dispose()
      expect(candidate.discard).not.toHaveBeenCalled()
    })

    itOnDarwin(
      'failure during promoting settles promotion-failed (never error) and preserves the candidate',
      async () => {
        const { session, candidate } = await begin()
        await toVerified(session)

        expect(claimPromotion()).not.toBeNull()

        // A raced renderer error during the promotion window.
        await capturedCallbacks.onError(session.id, { code: 'E_LATE', message: 'late renderer error' })

        expect(session.state).toBe('promotion-failed')
        expect(candidate.discard).not.toHaveBeenCalled()
        expect(getActiveImport()).toBeNull()
      }
    )

    itOnDarwin(
      'late failure after promoted settlement preserves terminal state and disposes session (LOCK-4401)',
      async () => {
        const { session, candidate } = await begin()
        await toVerified(session)

        const claim = claimPromotion()
        expect(completePromotion(claim!.token, 'promoted')).toBe(true)
        expect(session.state).toBe('promoted')

        // Late renderer error arrives after the promoted terminal was settled.
        await capturedCallbacks.onError(session.id, { code: 'E_LATE', message: 'late renderer error' })

        // Terminal state is immutable: promoted survives the late failure.
        expect(session.state).toBe('promoted')
        // Candidate preserved by promotion ownership (LOCK-4401).
        expect(candidate.discard).not.toHaveBeenCalled()
        // Session disposed and inactive — the late error still runs dispose().
        expect((session as any).isDisposed).toBe(true)
        expect(getActiveImport()).toBeNull()
      }
    )

    itOnDarwin('sync will-quit after promoted preserves candidate and disposes session (LOCK-4401)', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      const claim = claimPromotion()
      expect(completePromotion(claim!.token, 'promoted')).toBe(true)
      expect(session.state).toBe('promoted')

      // Simulate the Electron will-quit path (sync).
      disposeActiveImport()

      // Non-promotion resources torn down synchronously.
      const { disposeSync: disposeSessionSyncMock } = (await import('../isolatedSession')) as any
      expect(disposeSessionSyncMock).toHaveBeenCalled()
      // Promotion-owned candidate preserved: neither sync nor async discard ran.
      expect(candidate.discardSync).not.toHaveBeenCalled()
      expect(candidate.discard).not.toHaveBeenCalled()
      // Session fully inactive.
      expect((session as any).isDisposed).toBe(true)
      expect(getActiveImport()).toBeNull()

      await session.dispose()
      expect(candidate.discard).not.toHaveBeenCalled() // idempotent — still preserved
    })

    itOnDarwin('claiming performs no side effects: no live DB, no candidate mutation', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      const sealCallsBefore = candidate.seal.mock.calls.length
      expect(claimPromotion()).not.toBeNull()

      expect(hoisted.liveChatDbCtor).not.toHaveBeenCalled()
      expect(candidate.seal.mock.calls.length).toBe(sealCallsBefore)
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(candidate.discardSync).not.toHaveBeenCalled()

      await session.dispose()
    })

    itOnDarwin('getSealedCandidate does not expose the candidate once promotion owns it', async () => {
      const { session } = await begin()
      await toVerified(session)
      expect(getSealedCandidate()).not.toBeNull()

      const claim = claimPromotion()
      expect(claim).not.toBeNull()
      // After the claim, the ONLY access is the Main-only claim handle.
      expect(getSealedCandidate()).toBeNull()
      expect(getVerifiedCandidate()).toBeNull()

      await session.dispose()
    })
  })

  // =========================================================================
  // Promotion preparation integration (Phase 4.4.1 — LOCK-4411..4417)
  // =========================================================================

  describe('startPromotionPreparation (Phase 4.4.1 integration)', () => {
    /** Drive a harness to the verified-candidate state. */
    async function toVerified(session: Awaited<ReturnType<typeof startImport>>) {
      await discover(session.id)
      await runAllPages(session.id)
      await flushVerification()
      expect(session.state).toBe('verified-candidate')
    }

    /** Prepared-handle double matching the claim (LOCK-O8 injection). */
    function makePreparedHandle(claim: {
      token: string
      sessionId: string
      candidateId: string
      dbPath: string
    }): PreparedPromotionHandle & { dispose: ReturnType<typeof vi.fn> } {
      let disposed = false
      return {
        token: claim.token,
        sessionId: claim.sessionId,
        candidateId: claim.candidateId,
        retainedSnapshotPath: '/mock/data-root/chat.db.rollback',
        candidateDbPath: claim.dbPath,
        dispose: vi.fn(() => {
          disposed = true
        }),
        isDisposed: () => disposed
      }
    }

    const PREPARE_OPTIONS = {
      dbDir: '/mock/data-root',
      getLiveSqlite: () => ({ mock: 'live-sqlite' })
    }

    /** Injected preparation double resolving ok with a matching handle. */
    function makePrepareOk() {
      const handles: Array<ReturnType<typeof makePreparedHandle>> = []
      const prepare = vi.fn(
        async (claim: any, _dbDir: string, _getLiveSqlite: () => unknown): Promise<PromotionPreparationResult> => {
          const handle = makePreparedHandle(claim)
          handles.push(handle)
          return { ok: true, handle }
        }
      )
      return { prepare, handles }
    }

    const PREPARE_FAILURE = {
      phase: 'create-snapshot',
      code: 'SNAPSHOT_FAILED',
      safeCode: 'ONLINE_BACKUP_FAILED'
    } as const

    it('returns not-claimable when no import session is active', async () => {
      const { prepare } = makePrepareOk()
      const outcome = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })

      expect(outcome.status).toBe('not-claimable')
      expect(prepare).not.toHaveBeenCalled()
    })

    itOnDarwin('returns not-claimable before verified-candidate without side effects', async () => {
      const { verifier, releaseRun } = makeGatedVerifier()
      const { session } = await begin({ verifier })
      await discover(session.id)
      await runAllPages(session.id)
      expect(session.state).toBe('verifying')

      const { prepare } = makePrepareOk()
      const outcome = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })

      expect(outcome.status).toBe('not-claimable')
      expect(prepare).not.toHaveBeenCalled()
      expect(session.state).toBe('verifying')

      releaseRun(makeReport('aborted'))
      await flushVerification()
      await session.dispose()
    })

    itOnDarwin('one call claims and prepares exactly once: handle stored, state stays promoting', async () => {
      const { session } = await begin()
      await toVerified(session)

      const { prepare } = makePrepareOk()
      const outcome = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })

      expect(outcome.status).toBe('prepared')
      if (outcome.status !== 'prepared') return

      // Exactly one preparation run, bound to the exact-once claim: the
      // claim carries the session identity, opaque candidate ID, and token.
      expect(prepare).toHaveBeenCalledTimes(1)
      const claimArg = prepare.mock.calls[0][0]
      expect(claimArg.sessionId).toBe(session.id)
      expect(claimArg.candidateId).toBe(`candidate-${session.id}`)
      expect(claimArg.token).toMatch(/^promotion-/)
      expect(prepare.mock.calls[0][1]).toBe(PREPARE_OPTIONS.dbDir)

      // The prepared handle is retained on the session, aligned with the
      // claim token, and the session stays promoting for Phase 4.4.2.
      expect(outcome.handle.token).toBe(claimArg.token)
      expect((session as any).preparedHandle).toBe(outcome.handle)
      expect(session.state).toBe('promoting')
      expect(outcome.handle.isDisposed()).toBe(false)

      await session.dispose()
    })

    itOnDarwin('duplicate calls do not re-prepare: the second call is not-claimable (exact-once)', async () => {
      const { session } = await begin()
      await toVerified(session)

      const { prepare } = makePrepareOk()
      const first = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })
      expect(first.status).toBe('prepared')

      const second = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })
      const third = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })

      // No second snapshot/journal/lease side effect can ever run.
      expect(second.status).toBe('not-claimable')
      expect(third.status).toBe('not-claimable')
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(session.state).toBe('promoting')
      if (first.status === 'prepared') {
        expect((session as any).preparedHandle).toBe(first.handle)
      }

      await session.dispose()
    })

    itOnDarwin('preparation failure settles promotion-failed via the token protocol', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      const prepare = vi.fn(
        async (_claim: any): Promise<PromotionPreparationResult> => ({ ok: false, failure: PREPARE_FAILURE })
      )
      const outcome = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })

      expect(outcome.status).toBe('preparation-failed')
      if (outcome.status === 'preparation-failed') {
        expect(outcome.failure).toBe(PREPARE_FAILURE)
      }
      // Unique transition to the terminal result state; token consumed.
      expect(session.state).toBe('promotion-failed')
      expect((session as any).preparedHandle).toBeNull()
      expect((session as any).promotionToken).toBeNull()
      const claimToken = prepare.mock.calls[0][0].token
      expect(completePromotion(claimToken, 'promoted')).toBe(false)
      // Promotion-owned candidate preserved for startup recovery.
      expect(candidate.discard).not.toHaveBeenCalled()

      await session.dispose()
    })

    itOnDarwin('async dispose releases the stored prepared handle exactly once', async () => {
      const { session } = await begin()
      await toVerified(session)

      const { prepare, handles } = makePrepareOk()
      const outcome = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })
      expect(outcome.status).toBe('prepared')

      await session.dispose()

      expect(handles[0].dispose).toHaveBeenCalledTimes(1)
      expect((session as any).preparedHandle).toBeNull()

      // Idempotent: a second dispose never re-releases.
      await session.dispose()
      expect(handles[0].dispose).toHaveBeenCalledTimes(1)
    })

    itOnDarwin('sync will-quit releases the stored prepared handle and preserves the candidate', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      const { prepare, handles } = makePrepareOk()
      const outcome = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })
      expect(outcome.status).toBe('prepared')

      disposeActiveImport()

      expect(handles[0].dispose).toHaveBeenCalledTimes(1)
      expect((session as any).preparedHandle).toBeNull()
      // Promotion-owned candidate preserved (LOCK-4401).
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(candidate.discardSync).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()

      await session.dispose()
      expect(handles[0].dispose).toHaveBeenCalledTimes(1)
    })

    itOnDarwin('failure during promoting releases the stored handle once and settles promotion-failed', async () => {
      const { session, candidate } = await begin()
      await toVerified(session)

      const { prepare, handles } = makePrepareOk()
      const outcome = await startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })
      expect(outcome.status).toBe('prepared')

      // A raced renderer error during the promotion window.
      await capturedCallbacks.onError(session.id, { code: 'E_LATE', message: 'late renderer error' })

      expect(session.state).toBe('promotion-failed')
      expect(handles[0].dispose).toHaveBeenCalledTimes(1)
      expect((session as any).preparedHandle).toBeNull()
      expect(candidate.discard).not.toHaveBeenCalled()
      expect(getActiveImport()).toBeNull()
    })

    itOnDarwin(
      'raced failure during preparation: late success is stale, handle disposed and never stored',
      async () => {
        const { session } = await begin()
        await toVerified(session)

        let releasePrepare!: (result: PromotionPreparationResult) => void
        const gate = new Promise<PromotionPreparationResult>((resolve) => {
          releasePrepare = resolve
        })
        let capturedClaim: any = null
        const prepare = vi.fn(async (claim: any) => {
          capturedClaim = claim
          return gate
        })

        const outcomePromise = startPromotionPreparation({ ...PREPARE_OPTIONS, prepare })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(session.state).toBe('promoting')

        // The session fails while preparation is in flight (owner settles).
        await capturedCallbacks.onError(session.id, { code: 'E_LATE', message: 'late renderer error' })
        expect(session.state).toBe('promotion-failed')

        // The preparation then resolves ok — but the claim is stale.
        const handle = makePreparedHandle(capturedClaim)
        releasePrepare({ ok: true, handle })
        const outcome = await outcomePromise

        expect(outcome.status).toBe('stale-claim')
        // The stale handle was disposed (lease released), never stored.
        expect(handle.dispose).toHaveBeenCalledTimes(1)
        expect((session as any).preparedHandle).toBeNull()
        expect(session.state).toBe('promotion-failed')
      }
    )
  })
})
