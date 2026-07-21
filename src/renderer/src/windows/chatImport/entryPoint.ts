/**
 * ChatImport renderer entry point.
 *
 * This file runs in a hidden sandboxed BrowserWindow with an isolated
 * Electron session pointing at the extracted ZIP's IndexedDB data.
 *
 * Flow on receipt of chatImport.ready(sessionId):
 * 1. Verify location.protocol === 'file:' — if not, report error, DO NOT touch IDB.
 * 2. Signal ready to Main. Main drives subsequent flow via IPC commands.
 * 3. On ChatImport_Discover (main→renderer): run discovery, send result back.
 * 4. On ChatImport_ReadPage (main→renderer): read page, send result back.
 * 5. When all pages consumed: send ChatImport_Complete.
 * 6. db.close() in finally on every page and on session end.
 *
 * R-3: verify location.protocol === 'file:' before any IDB op.
 * R-4: future version gate (nativeVersion >= 120).
 * R-12: discovery via indexedDB.databases() (authoritative).
 *
 * Protocol: Main orchestrates — renderer responds to commands.
 * Renderer does NOT auto-loop reads; Main drives paged iteration.
 */

import type { JsonObject } from '@shared/chatDb/types'
import type { ChatImportEnvelope, DiscoveryResult, ReadPageResponse, SourceStats } from '@shared/chatImport/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for paged reads. */
const DEFAULT_PAGE_SIZE = 500

/** Per-page timeout in milliseconds. */
const DEFAULT_PAGE_TIMEOUT_MS = 120_000

/** Native version threshold for future-version rejection (R-4). */
const FUTURE_NATIVE_VERSION = 120

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let db: any = null // Dexie instance, dynamically imported
let activeSessionId: string | null = null
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
      complete: (envelope: ChatImportEnvelope<SourceStats>) => void
      error: (envelope: ChatImportEnvelope<{ code: string; message: string }>) => void
      onDiscover: (callback: (sessionId: string) => void) => () => void
      onReadPage: (
        callback: (request: { sessionId: string; tableName: string; cursor: string | null; pageSize: number }) => void
      ) => () => void
      onCancel: (callback: (sessionId: string) => void) => () => void
    }
  }
}

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
 * Sleep helper for timeouts.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build an envelope for the current session.
 */
function makeEnvelope<T>(phase: ChatImportEnvelope<T>['phase'], data: T): ChatImportEnvelope<T> {
  return { sessionId: activeSessionId ?? 'unknown', phase, version: 1, data }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const api = window.chatImport
  if (!api) {
    console.error('[chatImport] Preload bridge not available')
    return
  }

  // R-3: Verify origin before any IDB operation.
  // Use location.protocol (not location.origin) because for file:// URLs,
  // location.origin is the opaque-origin string "null" per the HTML Living Standard.
  if (location.protocol !== 'file:') {
    const msg = `Unexpected protocol: ${location.protocol}. Expected file:. Aborting to prevent IDB corruption.`
    console.error(`[chatImport] ${msg}`)
    api.error(makeEnvelope('error', { code: 'WRONG_ORIGIN', message: msg }))
    return
  }

  // Step 1: Signal ready and wait for commands from Main
  const readyResult = await api.ready('pending')
  if (!readyResult.ok) {
    console.error(`[chatImport] Ready signal failed: ${readyResult.error}`)
    return
  }

  // Step 2: Set up listeners — Main drives the flow
  const cleanupDiscover = api.onDiscover(async (sessionId) => {
    activeSessionId = sessionId
    try {
      const result = await runDiscovery()
      const ack = await api.discoverResult(makeEnvelope('discovery', result))
      if (!ack.ok) {
        console.error(`[chatImport] discoverResult rejected by Main: ${ack.error}`)
        api.error(makeEnvelope('error', { code: 'DISCOVERY_REJECTED', message: ack.error ?? 'Unknown rejection' }))
        await cleanup()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[chatImport] Discovery failed: ${message}`)
      api.error(makeEnvelope('error', { code: 'DISCOVERY_FAILED', message }))
      await cleanup()
    }
  })

  const cleanupReadPage = api.onReadPage(async (request) => {
    activeSessionId = request.sessionId
    try {
      const response = await handleReadPage(request.tableName, request.cursor, request.pageSize)
      const ack = await api.readPageResult(makeEnvelope('reading', response))
      if (!ack.ok) {
        console.error(`[chatImport] readPageResult rejected by Main: ${ack.error}`)
        api.error(makeEnvelope('error', { code: 'READPAGE_REJECTED', message: ack.error ?? 'Unknown rejection' }))
        await cleanup()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[chatImport] Read page failed: ${message}`)
      api.error(makeEnvelope('error', { code: 'READ_FAILED', message }))
      await cleanup()
    }
  })

  const cleanupCancel = api.onCancel(async (sessionId) => {
    console.log(`[chatImport] Cancel received for session ${sessionId}`)
    await cleanup()
  })

  async function cleanup(): Promise<void> {
    cleanupDiscover()
    cleanupReadPage()
    cleanupCancel()
    await closeDb()
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function runDiscovery(): Promise<DiscoveryResult> {
  // R-12: Use indexedDB.databases() for discovery (authoritative)
  const databases = await indexedDB.databases()
  const cherryDb = databases.find((d) => d.name === 'CherryStudio')

  if (!cherryDb) {
    throw new Error('CherryStudio database not found in isolated IndexedDB')
  }

  const nativeVersion = cherryDb.version ?? 0
  console.log(`[chatImport] Found CherryStudio: native version ${nativeVersion}`)

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
  const { db: cherryDbInstance } = await import('@renderer/databases/index')
  db = cherryDbInstance

  // Wait for the DB to be ready (Dexie handles upgrades automatically)
  await db.open()

  const tableNames = db.tables.map((t: any) => t.name)
  console.log(`[chatImport] Database opened with tables: ${tableNames.join(', ')}`)
  console.log(`[chatImport] Discovery complete: logical ${logicalVersion} (native ${nativeVersion})`)

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

async function handleReadPage(tableName: string, cursor: string | null, pageSize: number): Promise<ReadPageResponse> {
  if (!db) {
    throw new Error('Database not initialized. Run discovery first.')
  }

  const table = db.table(tableName)
  if (!table) {
    throw new Error(`Table "${tableName}" not found in database`)
  }

  const effectivePageSize = pageSize || DEFAULT_PAGE_SIZE

  // Set up a timeout for the page read
  const timeoutPromise = sleep(DEFAULT_PAGE_TIMEOUT_MS).then(() => {
    throw new Error(`Page read timed out after ${DEFAULT_PAGE_TIMEOUT_MS}ms`)
  })

  const readPromise = async (): Promise<ReadPageResponse> => {
    let collection

    if (cursor) {
      // Read after the cursor (keyset pagination using primary key 'id')
      collection = table.where('id').above(cursor).limit(effectivePageSize)
    } else {
      // First page
      collection = table.toCollection().limit(effectivePageSize)
    }

    const items: JsonObject[] = await collection.toArray()
    const nextCursor = computeNextCursor(items)
    const hasMore = items.length === effectivePageSize

    // Track counts for completion stats
    tableReadCounts[tableName] = (tableReadCounts[tableName] || 0) + items.length

    return {
      tableName,
      items,
      cursor: nextCursor,
      hasMore
    }
  }

  // Race against timeout
  const response = await Promise.race([readPromise(), timeoutPromise])

  // Close DB after each page to release LevelDB locks (R-11)
  await closeDb()

  // Re-open for next page (if needed)
  if (response.hasMore) {
    const { db: cherryDbInstance } = await import('@renderer/databases/index')
    db = cherryDbInstance
    await db.open()
  }

  console.log(`[chatImport] Read ${response.items.length} items from ${tableName}, hasMore=${response.hasMore}`)

  return response
}

/**
 * Build SourceStats from accumulated table read counts.
 */
export function buildSourceStats(): SourceStats {
  return {
    topicCount: tableReadCounts['topics'] || 0,
    messageCount: tableReadCounts['messages'] || 0,
    blockCount: tableReadCounts['message_blocks'] || 0,
    segmentCount: tableReadCounts['topic_segments'] || 0,
    fileRefCount: tableReadCounts['files'] || 0
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

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
  console.error('[chatImport] Fatal error:', error)
})
