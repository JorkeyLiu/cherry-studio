/**
 * Phase 4.0-C2a — Renderer Isolation Handlers
 *
 * Handles C2a-specific operations for the retained-session isolation verifier:
 *
 *  - ISOLATION_SETUP: Creates a sentinel IndexedDB (C2aSentinel) in the current
 *    session with a deterministic marker. Used by the default-session sentinel
 *    window to prove the session is writable before candidate reads.
 *
 *  - ORIGIN_PROBE: Enumerates all IndexedDB databases via indexedDB.databases()
 *    and reports which named databases exist at the current origin. Used for
 *    wrong-origin absence verification and post-probe re-checks.
 *
 * Neither handler imports production Dexie or opens CherryStudio.
 * The ORIGIN_PROBE handler is safe for wrong-origin use — it only reads
 * the database list, never creates or opens CherryStudio.
 */
import type { SpikeRequest, SpikeResult } from '@shared/phase4SpikeContract'
import { SPIKE_OPERATIONS } from '@shared/phase4SpikeContract'

/* ── Constants ── */

const SENTINEL_DB_NAME = 'C2aSentinel'
const CHERRY_STUDIO_DB_NAME = 'CherryStudio'

/* ── Logging ── */

function log(msg: string): void {
  const el = document.getElementById('log')
  if (el) el.textContent += `[${new Date().toISOString()}] ${msg}\n`
  console.log(`[Phase4C2a] ${msg}`)
}

/* ── ISOLATION_SETUP ── */

/**
 * Create a sentinel IndexedDB in the current session/origin.
 *
 * Uses a raw IndexedDB API (no Dexie dependency) to avoid pulling in
 * production code. Creates a simple object store with a deterministic
 * marker entry.
 *
 * The sentinel proves:
 * 1. The session is writable (IndexedDB open/put succeeded)
 * 2. The marker value can be read back (round-trip integrity)
 * 3. After all candidate reads, the sentinel is still present and unchanged
 */
export async function handleIsolationSetup(config: SpikeRequest): Promise<void> {
  const markerValue = (config.payload?.markerValue as string) || `sentinel-${Date.now()}`

  log(`ISOLATION_SETUP: creating sentinel DB "${SENTINEL_DB_NAME}" with marker="${markerValue}"`)

  let db: IDBDatabase | undefined

  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SENTINEL_DB_NAME, 1)
      request.onerror = () => reject(new Error(`IndexedDB open failed: ${request.error?.message}`))
      request.onupgradeneeded = () => {
        const idb = request.result
        if (!idb.objectStoreNames.contains('markers')) {
          idb.createObjectStore('markers', { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
    })

    // Write marker
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('markers', 'readwrite')
      const store = tx.objectStore('markers')
      const putReq = store.put({ id: 'c2a:sentinel', value: markerValue })
      putReq.onerror = () => reject(new Error(`put failed: ${putReq.error?.message}`))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error(`transaction failed: ${tx.error?.message}`))
    })

    // Read back to verify round-trip
    const readBack = await new Promise<string | null>((resolve, reject) => {
      const tx = db!.transaction('markers', 'readonly')
      const store = tx.objectStore('markers')
      const getReq = store.get('c2a:sentinel')
      getReq.onsuccess = () => resolve(getReq.result?.value ?? null)
      getReq.onerror = () => reject(new Error(`get failed: ${getReq.error?.message}`))
    })

    if (readBack !== markerValue) {
      throw new Error(`Marker round-trip failed: wrote "${markerValue}", read "${readBack}"`)
    }

    // Count entries
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db!.transaction('markers', 'readonly')
      const store = tx.objectStore('markers')
      const countReq = store.count()
      countReq.onsuccess = () => resolve(countReq.result)
      countReq.onerror = () => reject(new Error(`count failed: ${countReq.error?.message}`))
    })

    log(`ISOLATION_SETUP: sentinel created, count=${count}, round-trip verified`)

    const result: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.ISOLATION_SETUP_DONE,
      status: 'ok',
      payload: {
        sentinelDbName: SENTINEL_DB_NAME,
        markerValue,
        recordCount: count,
        roundTripVerified: true
      }
    }
    window.spike.reportResult(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`ISOLATION_SETUP FAILED: ${msg}`)

    const errorResult: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.ISOLATION_SETUP_DONE,
      status: 'error',
      error: msg
    }
    window.spike.reportResult(errorResult)
  } finally {
    if (db) {
      db.close()
      log('ISOLATION_SETUP: sentinel DB closed')
    }
  }
}

/* ── ORIGIN_PROBE ── */

/**
 * Probe the current origin's IndexedDB state.
 *
 * Calls indexedDB.databases() and reports:
 * - Full list of databases (name + version)
 * - Whether CherryStudio is present
 * - Whether the C2aSentinel is present
 * - Current origin and href
 *
 * Does NOT open or create any databases.
 * Safe for wrong-origin use: no production Dexie import, no DB creation.
 */
export async function handleOriginProbe(config: SpikeRequest): Promise<void> {
  log(`ORIGIN_PROBE: probing origin=${location.origin}, href=${location.href}`)

  try {
    const dbs = await indexedDB.databases()
    const dbNames = dbs.map((d) => d.name)

    const cherryStudioFound = dbNames.includes(CHERRY_STUDIO_DB_NAME)
    const sentinelFound = dbNames.includes(SENTINEL_DB_NAME)

    // If CherryStudio is found, capture its version for diagnostics
    const cherryStudioEntry = dbs.find((d) => d.name === CHERRY_STUDIO_DB_NAME)

    log(
      `ORIGIN_PROBE: found ${dbs.length} databases: [${dbNames.join(', ')}] ` +
        `cherryStudio=${cherryStudioFound} sentinel=${sentinelFound}`
    )

    if (cherryStudioFound) {
      log(`  CherryStudio version: ${cherryStudioEntry?.version}`)
    }

    const result: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE_DONE,
      status: 'ok',
      payload: {
        databases: dbs.map((d) => ({ name: d.name, version: d.version })),
        cherryStudioFound,
        cherryStudioVersion: cherryStudioEntry?.version ?? null,
        sentinelFound,
        sentinelDbName: SENTINEL_DB_NAME,
        cherryStudioDbName: CHERRY_STUDIO_DB_NAME,
        origin: location.origin,
        href: location.href
      }
    }
    window.spike.reportResult(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`ORIGIN_PROBE FAILED: ${msg}`)

    const errorResult: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE_DONE,
      status: 'error',
      error: msg
    }
    window.spike.reportResult(errorResult)
  }
}
