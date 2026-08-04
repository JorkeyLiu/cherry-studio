/**
 * ChatImport renderer entry point.
 *
 * This file runs in a hidden sandboxed BrowserWindow with an isolated
 * Electron session pointing at the extracted ZIP's IndexedDB data.
 *
 * Flow:
 * 1. Verify location — accepts file: protocol (existing behavior) OR
 *    exact http://localhost:5173 with exact pathname and no search/hash
 *    (LOCK-DEV-3). If neither, report error, DO NOT touch IDB.
 * 2. Register ChatImport_Discover/ReadPage/Cancel listeners FIRST, then signal
 *    ready to Main (LOCK-Y1: listener-first — Main sends Discover synchronously
 *    from inside its ready handler, so late registration would drop the event).
 * 3. On ChatImport_Discover (main→renderer): run discovery, send result back.
 * 4. On ChatImport_ReadPage (main→renderer): read page, send result back.
 * 5. When all pages consumed: send ChatImport_Complete.
 * 6. Every read request first ensures the DB is open (LOCK-RP3), then closes
 *    it after each page (R-11) — so the first page of the next entity can
 *    always reopen deterministically instead of failing with a stale
 *    "Database not initialized" error. Discovery must complete before any
 *    read is allowed (LOCK-RP4).
 *
 * R-3: verify location protocol before any IDB op.
 * R-4: future version gate (nativeVersion >= 120).
 * R-12: discovery via indexedDB.databases() (authoritative).
 * LOCK-DEV-3: dev-origin gate — exact origin + exact pathname + no search/hash.
 *
 * Protocol: Main orchestrates — renderer responds to commands.
 * Renderer does NOT auto-loop reads; Main drives paged iteration.
 */

import { cloneForWire } from '@renderer/utils/jsonWire'
import type { JsonObject } from '@shared/chatDb/types'
import type {
  ChatImportEnvelope,
  ChatImportProjectionPayload,
  DiscoveryResult,
  ReadPageResponse,
  SourceReadStats
} from '@shared/chatImport/types'
import type { LogLevel } from '@shared/config/logger'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for paged reads. */
const DEFAULT_PAGE_SIZE = 500

/** Per-page timeout in milliseconds. */
const DEFAULT_PAGE_TIMEOUT_MS = 120_000

/**
 * Source redux-persist localStorage key (LOCK-PROD-2). The import renderer
 * runs on the same origin as the source profile, so `localStorage` reads the
 * exact source `persist:cherry-studio` entry (file:// or dev origin).
 */
const PERSISTED_STATE_KEY = 'persist:cherry-studio'

/** Native version threshold for future-version rejection (R-4). */
const FUTURE_NATIVE_VERSION = 120

/**
 * Exact dev origin accepted for HTTP imports (LOCK-DEV-3).
 * Matches the Chromium IndexedDB mapping: http_localhost_5173.indexeddb.leveldb.
 */
const DEV_ORIGIN = 'http://localhost:5173'

/**
 * Exact pathname of the chatImport entry point on the Vite dev server.
 * LOCK-DEV-3: must match exactly; no trailing slash, no variations.
 */
const DEV_PATHNAME = '/src/windows/chatImport/chatImport.html'

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let db: any = null // Dexie instance, dynamically imported
let activeSessionId: string | null = null
let discoveryCompleted = false // set only after a successful discovery (LOCK-RP3/RP4)
const tableReadCounts: Record<string, number> = {}

// ---------------------------------------------------------------------------
// Type declaration for the preload bridge
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    chatImport?: {
      ready: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
      discoverResult: (envelope: ChatImportEnvelope<DiscoveryResult>) => Promise<{ ok: boolean; error?: string }>
      readPageResult: (envelope: ChatImportEnvelope<ReadPageResponse>) => Promise<{ ok: boolean; error?: string }>
      complete: (envelope: ChatImportEnvelope<SourceReadStats>) => void
      error: (envelope: ChatImportEnvelope<{ code: string; message: string }>) => void
      localStorageProjection: (envelope: ChatImportEnvelope<ChatImportProjectionPayload>) => void
      log: (level: LogLevel, message: string, data?: unknown[]) => void
      onDiscover: (callback: (sessionId: string) => void) => () => void
      onReadPage: (
        callback: (request: { sessionId: string; tableName: string; cursor: string | null; pageSize: number }) => void
      ) => () => void
      onCancel: (callback: (sessionId: string) => void) => () => void
    }
  }
}

// ---------------------------------------------------------------------------
// Logger adapter (LOCK-601/602)
// ---------------------------------------------------------------------------

/**
 * Minimal logging surface used by the import renderer. Implemented as a thin
 * adapter over the narrow chatImport preload `log` bridge — NEVER the ordinary
 * renderer LoggerService (LOCK-602): this hidden sandboxed reader cannot
 * depend on the main window's `window.electron` surface.
 */
export interface ChatImportLogger {
  info(message: string, ...data: unknown[]): void
  error(message: string, ...data: unknown[]): void
}

/**
 * Narrow structural bridge: only the `log` method is needed by the logger.
 * Optional so that partial/absent bridges remain safe at the type level
 * (LOCK-602 — missing bridge/log degrades to a no-op, never a crash).
 */
export interface ChatImportLogBridge {
  log?: (level: LogLevel, message: string, data?: unknown[]) => void
}

/**
 * Create the import logger adapter (LOCK-602): when the preload bridge or its
 * `log` method is absent, the adapter is a strict no-op — CI-safe and safe for
 * any environment where the bridge was not exposed.
 */
export function createChatImportLogger(bridge: ChatImportLogBridge | undefined): ChatImportLogger {
  const log = bridge?.log
  if (typeof log !== 'function') {
    return { info: () => {}, error: () => {} }
  }
  return {
    info: (message, ...data) => {
      log('info', message, data)
    },
    error: (message, ...data) => {
      log('error', message, data)
    }
  }
}

/**
 * Module-scope adapter used by the fatal catch. The preload bridge (when
 * present) is exposed before page scripts run, so this is safe to build at
 * module evaluation time.
 */
const chatImportLogger = createChatImportLogger(window.chatImport)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a native version represents a future (unsupported) version.
 * Native version >= 120 = future (Dexie logical v12+).
 * Native versions 111-119 = current range (logical v11 + patches).
 */
export function isFutureVersion(nativeVersion: number): boolean {
  return nativeVersion >= FUTURE_NATIVE_VERSION
}

/**
 * Compute a cursor for the next page from the last item in a page.
 * Uses the item's 'id' field as the opaque cursor.
 */
export function computeNextCursor(items: JsonObject[]): string | null {
  if (items.length === 0) return null
  const lastItem = items[items.length - 1]
  return typeof lastItem.id === 'string' ? lastItem.id : null
}

/**
 * Race an operation against a timeout with deterministic timer cleanup.
 *
 * Unlike a `sleep(...).then(() => { throw ... })` pattern in `Promise.race`,
 * the timeout timer here is always cleared once the race settles. This
 * guarantees:
 *  - on operation success: the timer is cleared before returning, so the
 *    losing timeout never fires and cannot leak an unhandled rejection;
 *  - on operation failure: the timer is cleared, so no timer/rejection leaks;
 *  - on timeout: the timeout promise rejects exactly once with `message`.
 *
 * The timeout promise only rejects from inside the `setTimeout` callback, which
 * is cleared on every settle path, so the losing timeout can never produce an
 * unhandled rejection or a pending timer.
 */
export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
      timeoutId = undefined
    }
  })
}

/**
 * Build an envelope for the current session.
 */
function makeEnvelope<T>(phase: ChatImportEnvelope<T>['phase'], data: T): ChatImportEnvelope<T> {
  return { sessionId: activeSessionId ?? 'unknown', phase, version: 1, data }
}

// ---------------------------------------------------------------------------
// Location validation (LOCK-DEV-3)
// ---------------------------------------------------------------------------

/**
 * Result of validating the renderer's location against allowed origins.
 * A discriminated union so callers can branch on the specific failure mode.
 */
export type LocationValidation =
  | { readonly ok: true; readonly mode: 'file' | 'dev' }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Validate the renderer's location fields against allowed origins.
 *
 * Accepted origins:
 * - `file:` protocol (existing behavior, any file:// path).
 * - `http://localhost:5173` with exact pathname `/src/windows/chatImport/chatImport.html`
 *   and empty search and hash (LOCK-DEV-3).
 *
 * All other protocols, hosts, ports, pathnames, search params, and hash
 * fragments are rejected before any IDB operation or listener registration.
 *
 * @param loc  The location object to validate. In production this is the
 *             real `window.location`; tests inject a structural double.
 * @returns    A `LocationValidation` result.
 */
export function validateLocation(loc: {
  protocol: string
  origin: string
  pathname: string
  search: string
  hash: string
  username: string
  password: string
}): LocationValidation {
  // File origin: accept any file:// URL (existing behavior).
  if (loc.protocol === 'file:') {
    return { ok: true, mode: 'file' }
  }

  // HTTP dev origin: exact origin + exact pathname + no search/hash + no credentials.
  if (loc.protocol === 'http:' && loc.origin === DEV_ORIGIN && loc.pathname === DEV_PATHNAME) {
    if (loc.search !== '' || loc.hash !== '') {
      return {
        ok: false,
        code: 'WRONG_ORIGIN',
        message:
          `Unexpected search/hash on dev origin: search="${loc.search}", hash="${loc.hash}". ` +
          'Dev-origin imports must use the exact URL with no query parameters or hash fragments.'
      }
    }
    // Reject credential-bearing URLs (username or password present).
    // This prevents SSRF via http://user:pass@localhost:5173/...
    //
    // NOTE: window.location.username / window.location.password are
    // deprecated and return incorrect (non-empty) values in some
    // Electron contexts even for plain URLs without credentials.  We
    // reconstruct a URL from the validated components and use the URL
    // constructor to detect credentials reliably.
    try {
      const checkUrl = new URL(loc.origin + loc.pathname + loc.search + loc.hash)
      if (checkUrl.username !== '' || checkUrl.password !== '') {
        return {
          ok: false,
          code: 'WRONG_ORIGIN',
          message: 'Dev-origin imports must not use credential-bearing URLs.'
        }
      }
    } catch {
      // URL parse failure — skip credential check (defense-in-depth);
      // the exact origin + pathname validation above already constrains
      // the URL to the hardcoded constant.
    }
    return { ok: true, mode: 'dev' }
  }

  // Everything else is rejected.
  return {
    ok: false,
    code: 'WRONG_ORIGIN',
    message:
      `Unexpected origin: protocol="${loc.protocol}", origin="${loc.origin}", pathname="${loc.pathname}". ` +
      `Expected file: or exact dev origin ${DEV_ORIGIN}${DEV_PATHNAME}. Aborting to prevent IDB corruption.`
  }
}

// ---------------------------------------------------------------------------
// DB IO seam (LOCK-RP2/RP3)
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of the source Dexie table consumed by
 * {@link handleReadPage} — only the query surface used for paged reads.
 */
interface ChatImportReadTable {
  where(index: string): { above(cursor: string): { limit(count: number): { toArray(): Promise<JsonObject[]> } } }
  toCollection(): { limit(count: number): { toArray(): Promise<JsonObject[]> } }
}

/**
 * Minimal structural shape of the source Dexie instance consumed by
 * {@link handleReadPage}. `table()` returns `undefined` for unregistered
 * names (Dexie behavior), which preserves the existing table-not-found error.
 */
interface ChatImportReadDb {
  table(tableName: string): ChatImportReadTable | undefined
}

/**
 * Renderer-local DB IO seam: `openDb` returns a live Dexie instance (opening
 * it if needed), `closeDb` closes it to release LevelDB locks (R-11).
 *
 * Production uses the module-level implementations; the focused renderer
 * regression tests inject fakes through {@link ChatImportBootOptions} — the
 * only seam allowed by LOCK-RP2 (no production mocks for the import pipeline).
 */
export interface ChatImportDbIO {
  openDb: () => Promise<unknown>
  closeDb: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Structural type for the narrow chatImport preload bridge consumed by
 * {@link boot}. Matches the `window.chatImport` surface declared above.
 */
export type ChatImportBridge = NonNullable<Window['chatImport']>

/**
 * Optional production-neutral overrides for {@link boot}. Every field defaults
 * to the real runtime dependency, so production behavior is unchanged; the
 * overrides exist solely as a test seam for the renderer-focused regression
 * tests (LOCK-Y1/Y2/Y4).
 */
export interface ChatImportBootOptions {
  /**
   * Location override for the protocol/origin/pathname gate test seam.
   * Defaults to the real `location` global. Tests inject a structural
   * double with `{ protocol, origin, pathname, search, hash }`.
   */
  location?: {
    protocol: string
    origin: string
    pathname: string
    search: string
    hash: string
    username: string
    password: string
  }
  /** Discovery implementation. Defaults to the real {@link runDiscovery}. */
  discover?: () => Promise<DiscoveryResult>
  /** DB-open implementation used by every read request. Defaults to {@link openDb}. */
  openDb?: () => Promise<unknown>
  /** DB closure used by per-page close and the shared cleanup path. Defaults to {@link closeDb}. */
  closeDb?: () => Promise<void>
  /**
   * Source Local Storage `persist:cherry-studio` reader (LOCK-PROD-2).
   * Defaults to the real `localStorage.getItem`; tests inject a double.
   * Returns null when absent/unavailable.
   */
  readPersistedState?: () => string | null
}

/**
 * Boot the import renderer with an explicit bridge (test seam; production
 * calls this from {@link main} with `window.chatImport`).
 *
 * Ordering contract (LOCK-Y1): the three main→renderer listeners are
 * registered BEFORE `api.ready('pending')` is invoked. Main's ready handler
 * sends `ChatImport_Discover` synchronously from inside the ready IPC handler
 * (before its `{ ok: true }` reply), so a listener registered after
 * `await api.ready(...)` resolves would be too late and drop the event,
 * stalling genuine imports at `discovering`. Listener-first registration is
 * deterministic and keeps Main's dispatch untouched.
 *
 * Cleanup contract (LOCK-Y2): on a `!ok` ready result and on a ready rejection
 * the shared idempotent cleanup path unsubscribes all three listeners and
 * closes any DB state before returning/rethrowing. The same path is reused by
 * discovery failure, read failure, and cancel — repeated calls never
 * double-unsubscribe or throw.
 */
export async function boot(api: ChatImportBridge, options: ChatImportBootOptions = {}): Promise<void> {
  const loc = options.location ?? (location as Location & { username: string; password: string })
  const discoverImpl = options.discover ?? runDiscovery
  const openDbImpl = options.openDb ?? openDb
  const closeDbImpl = options.closeDb ?? closeDb
  const readPersistedStateImpl =
    options.readPersistedState ??
    ((): string | null => {
      try {
        return localStorage.getItem(PERSISTED_STATE_KEY)
      } catch {
        return null
      }
    })

  // R-3/LOCK-DEV-3: Verify origin before any IDB operation.
  // Accepts file: (existing) or exact http://localhost:5173 dev origin.
  // All other protocols, origins, pathnames, search, hash are rejected.
  const validation = validateLocation(loc)
  if (!validation.ok) {
    chatImportLogger.error(`[chatImport] ${validation.message}`)
    api.error(makeEnvelope('error', { code: validation.code, message: validation.message }))
    return
  }

  // LOCK-RP3/RP4: a fresh session begins with no completed discovery and no
  // open DB. Reads are only allowed after a successful discovery marks the
  // lifecycle discovery-complete; until then they keep failing with the
  // existing database-not-initialized error.
  discoveryCompleted = false
  db = null

  // DB IO seam consumed by every paged read (LOCK-RP3): ensure-open before
  // each read request, close after each page (R-11).
  const readIo: ChatImportDbIO = {
    openDb: openDbImpl,
    closeDb: closeDbImpl
  }

  let cleanupDiscover: (() => void) | null = null
  let cleanupReadPage: (() => void) | null = null
  let cleanupCancel: (() => void) | null = null
  let cleanupPromise: Promise<void> | null = null

  /**
   * Shared idempotent single-flight cleanup (LOCK-Y2/LOCK-S2): the first
   * caller unsubscribes every listener exactly once (refs are nulled after the
   * first call) and starts {@link closeDb}, memoizing the resulting promise.
   * Concurrent/later callers (ready failure/rejection, discovery/read failure,
   * cancel) await or reuse the same promise and never re-unsubscribe or call
   * closeDb again. If closeDb rejects, every caller observes the identical
   * rejection.
   */
  async function cleanup(): Promise<void> {
    if (cleanupPromise !== null) {
      return cleanupPromise
    }
    cleanupPromise = (async () => {
      cleanupDiscover?.()
      cleanupReadPage?.()
      cleanupCancel?.()
      cleanupDiscover = null
      cleanupReadPage = null
      cleanupCancel = null
      await closeDbImpl()
    })()
    return cleanupPromise
  }

  // Step 1: Set up listeners BEFORE signaling ready (LOCK-Y1) — Main drives the flow
  cleanupDiscover = api.onDiscover(async (sessionId) => {
    activeSessionId = sessionId
    try {
      // LOCK-PROD-2: report the source Local Storage navigation metadata
      // before (or in parallel with) discovery. Fire-and-forget — Main
      // parses/validates it; a missing bridge method degrades to no-op.
      try {
        const persist = readPersistedStateImpl()
        api.localStorageProjection(makeEnvelope('discovery', { persist }))
      } catch (error) {
        chatImportLogger.error(`[chatImport] Local Storage projection read failed: ${String(error)}`)
      }

      const result = await discoverImpl()
      // LOCK-RP3/RP4: discovery succeeded — subsequent read requests are
      // allowed to (re)open the DB. When discovery fails (missing DB, future
      // version gate) this stays false and reads keep failing with the
      // database-not-initialized error, preserving the version-gate semantics.
      discoveryCompleted = true
      const ack = await api.discoverResult(makeEnvelope('discovery', result))
      if (!ack.ok) {
        chatImportLogger.error(`[chatImport] discoverResult rejected by Main: ${ack.error}`)
        api.error(makeEnvelope('error', { code: 'DISCOVERY_REJECTED', message: ack.error ?? 'Unknown rejection' }))
        await cleanup()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      chatImportLogger.error(`[chatImport] Discovery failed: ${message}`)
      api.error(makeEnvelope('error', { code: 'DISCOVERY_FAILED', message }))
      await cleanup()
    }
  })

  cleanupReadPage = api.onReadPage(async (request) => {
    activeSessionId = request.sessionId
    try {
      const response = await handleReadPage(request.tableName, request.cursor, request.pageSize, readIo)
      const ack = await api.readPageResult(makeEnvelope('reading', response))
      if (!ack.ok) {
        chatImportLogger.error(`[chatImport] readPageResult rejected by Main: ${ack.error}`)
        api.error(makeEnvelope('error', { code: 'READPAGE_REJECTED', message: ack.error ?? 'Unknown rejection' }))
        await cleanup()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      chatImportLogger.error(`[chatImport] Read page failed: ${message}`)
      api.error(makeEnvelope('error', { code: 'READ_FAILED', message }))
      await cleanup()
    }
  })

  cleanupCancel = api.onCancel(async (sessionId) => {
    chatImportLogger.info(`[chatImport] Cancel received for session ${sessionId}`)
    await cleanup()
  })

  // Step 2: Signal ready and wait for commands from Main
  let readyResult: { ok: boolean; error?: string }
  try {
    readyResult = await api.ready('pending')
  } catch (error) {
    // LOCK-Y2: a ready rejection must still remove listeners and close DB state.
    await cleanup()
    throw error
  }
  if (!readyResult.ok) {
    chatImportLogger.error(`[chatImport] Ready signal failed: ${readyResult.error}`)
    // LOCK-Y2: a refused ready must not leave listeners or DB state behind.
    await cleanup()
    return
  }
}

async function main(): Promise<void> {
  const api = window.chatImport
  if (!api) {
    chatImportLogger.error('[chatImport] Preload bridge not available')
    return
  }
  await boot(api)
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function runDiscovery(): Promise<DiscoveryResult> {
  // R-12: Use indexedDB.databases() for discovery (authoritative)
  const databases = await withTimeout(indexedDB.databases(), 15_000, 'indexedDB.databases() timed out after 15s')
  const cherryDb = databases.find((d) => d.name === 'CherryStudio')

  if (!cherryDb) {
    throw new Error('CherryStudio database not found in isolated IndexedDB')
  }

  const nativeVersion = cherryDb.version ?? 0
  chatImportLogger.info(`[chatImport] Found CherryStudio: native version ${nativeVersion}`)

  // R-4: Future version gate
  if (isFutureVersion(nativeVersion)) {
    throw new Error(
      `Source database version (${nativeVersion}) is from a future Cherry Studio version. ` +
        `Maximum supported native version is ${FUTURE_NATIVE_VERSION - 1}.`
    )
  }

  // Compute logical version (native / 10)
  const logicalVersion = Math.floor(nativeVersion / 10)

  // Open the database using production Dexie to trigger upgrades
  db = await openDb()

  const tableNames = db.tables.map((t: any) => t.name)
  chatImportLogger.info(`[chatImport] Database opened with tables: ${tableNames.join(', ')}`)
  chatImportLogger.info(`[chatImport] Discovery complete: logical ${logicalVersion} (native ${nativeVersion})`)

  // Reset read counts for new discovery
  for (const key of Object.keys(tableReadCounts)) {
    delete tableReadCounts[key]
  }

  return {
    databaseName: 'CherryStudio',
    nativeVersion,
    logicalVersion,
    tableNames
  }
}

// ---------------------------------------------------------------------------
// Paged read
// ---------------------------------------------------------------------------

async function handleReadPage(
  tableName: string,
  cursor: string | null,
  pageSize: number,
  io: ChatImportDbIO
): Promise<ReadPageResponse> {
  // LOCK-RP4: a read before successful discovery keeps failing with the
  // existing database-not-initialized error — never attempt to open.
  if (!discoveryCompleted) {
    throw new Error('Database not initialized. Run discovery first.')
  }

  // LOCK-RP3: ensure the DB is open before every read. A prior page's
  // close-after-each-page (R-11) left it closed, and the old hasMore-only
  // reopen could not reopen once a single-page entity was consumed — so the
  // first page of the next entity failed with READ_FAILED. Opening here makes
  // every read request self-sufficient.
  const dbInstance = (await io.openDb()) as ChatImportReadDb | null
  if (!dbInstance) {
    throw new Error('Database not initialized. Run discovery first.')
  }

  const table = dbInstance.table(tableName)
  if (!table) {
    throw new Error(`Table "${tableName}" not found in database`)
  }

  const effectivePageSize = pageSize || DEFAULT_PAGE_SIZE

  const readPromise = async (): Promise<ReadPageResponse> => {
    let collection: { toArray(): Promise<JsonObject[]> }

    if (cursor) {
      // Read after the cursor (keyset pagination using primary key 'id')
      collection = table.where('id').above(cursor).limit(effectivePageSize)
    } else {
      // First page
      collection = table.toCollection().limit(effectivePageSize)
    }

    const rawItems: JsonObject[] = await collection.toArray()
    // LOCK-N2/N6: Recursively strip explicit undefined object properties
    // (created by upgradeToV7 Dexie structured-clone rows) before IPC.
    // Rejects undefined array elements and every other non-JSON value.
    const items: JsonObject[] = rawItems.map((item) => cloneForWire(item))
    const nextCursor = computeNextCursor(items)
    const hasMore = rawItems.length === effectivePageSize

    // Track counts for completion stats
    tableReadCounts[tableName] = (tableReadCounts[tableName] || 0) + rawItems.length

    return {
      tableName,
      items,
      cursor: nextCursor,
      hasMore
    }
  }

  // Race against timeout with deterministic timer cleanup (no leaked timer/rejection)
  const response = await withTimeout(
    readPromise(),
    DEFAULT_PAGE_TIMEOUT_MS,
    `Page read timed out after ${DEFAULT_PAGE_TIMEOUT_MS}ms`
  )

  // Close DB after each page to release LevelDB locks (R-11)
  await io.closeDb()

  chatImportLogger.info(
    `[chatImport] Read ${response.items.length} items from ${tableName}, hasMore=${response.hasMore}`
  )

  return response
}

/**
 * Build SourceReadStats from accumulated table read counts.
 * Counts are source records actually paged — nothing else. Messages are
 * embedded in topics and never paged as their own table, so there is no
 * message counter; `files` rows are counted as source file records, not
 * target file references.
 */
export function buildSourceReadStats(): SourceReadStats {
  return {
    topicRecordCount: tableReadCounts['topics'] || 0,
    blockRecordCount: tableReadCounts['message_blocks'] || 0,
    segmentRecordCount: tableReadCounts['topic_segments'] || 0,
    sourceFileRecordCount: tableReadCounts['files'] || 0
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Open the source Dexie instance for reading (dynamic import of the singleton
 * module). When a prior page closed it (R-11) or discovery has not run yet,
 * this re-imports and reopens so the next read always holds a live handle
 * (LOCK-RP3 — ensure-open-before-read).
 */
async function openDb(): Promise<unknown> {
  if (db) return db
  const { db: cherryDbInstance } = await withTimeout(
    import('@renderer/databases/index'),
    60_000,
    'dynamic import of databases/index timed out after 60s'
  )
  db = cherryDbInstance
  await withTimeout(db.open(), 30_000, 'db.open() timed out after 30s')
  return db
}

async function closeDb(): Promise<void> {
  if (db) {
    try {
      db.close()
    } catch {
      // Ignore close errors
    }
    db = null
  }
}

// Start
main().catch((error) => {
  chatImportLogger.error('[chatImport] Fatal error:', error)
})
