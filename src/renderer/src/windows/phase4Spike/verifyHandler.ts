/**
 * Phase 4.0-C1 — Renderer Verify Handler
 *
 * Handles the VERIFY operation for pre-populated fixture profiles.
 * Uses indexedDB.databases() for preflight, then conditionally opens
 * the actual production Dexie declaration to verify upgrade behavior.
 *
 * For v12 (native >= 120): rejects without opening production db.
 * For v4 (native 40): opens production db, triggers v5/v7/v8 upgrades, verifies.
 * For v11a/v11b (native 110): opens production db, verifies markers.
 *
 * Imports the actual production db declaration — does NOT fork upgrade semantics.
 */
import { WEB_SEARCH_SOURCE } from '@renderer/types'
import type {
  VerifyDonePayload,
  VerifyOpenResult,
  VerifyPreflight,
  VerifyV4Assertions,
  VerifyV11Assertions
} from '@shared/phase4FixtureManifest'
import type { FixtureId } from '@shared/phase4FixtureManifest'
import type { SpikeRequest, SpikeResult } from '@shared/phase4SpikeContract'
import { SPIKE_OPERATIONS } from '@shared/phase4SpikeContract'
import type Dexie from 'dexie'

/* ── Logging ── */

function log(msg: string): void {
  const el = document.getElementById('log')
  if (el) el.textContent += `[${new Date().toISOString()}] ${msg}\n`
  console.log(`[Phase4Verifier] ${msg}`)
}

/* ── Helpers ── */

async function getNativeVersion(dbName: string): Promise<number | null> {
  const dbs = await indexedDB.databases()
  const found = dbs.find((d) => d.name === dbName)
  return found?.version ?? null
}

/* ── Preflight ── */

async function runPreflight(dbName: string, expectedVersion: number): Promise<VerifyPreflight> {
  const nativeVersion = await getNativeVersion(dbName)
  return {
    locationHref: location.href,
    locationOrigin: location.origin,
    nativeVersion: nativeVersion ?? -1,
    expectedVersion,
    cherryStudioFound: nativeVersion !== null
  }
}

/* ── v4 Upgrade Assertions ── */

async function runV4Assertions(db: Dexie): Promise<VerifyV4Assertions> {
  // v5: Date conversion — file-v4-001 created_at should now be ISO string
  const file1 = await db.table('files').get('file-v4-001')
  const v5DateConversion = typeof file1?.created_at === 'string' && file1.created_at === '2024-01-15T10:30:00.000Z'

  // v5: Tavily → webSearch — after v7, topic messages are restructured into references.
  // The tavily metadata was converted to webSearch by v5, then v7 extracted it into a CitationBlock.
  // Verify: no original tavily metadata remains, and a citation block with webSearch source exists.
  const tavilyTopic = await db.table('topics').get('topic-v4-tavily')
  let v5TavilyToWebSearch = false
  if (tavilyTopic?.messages) {
    const msg = tavilyTopic.messages.find((m: { id: string }) => m.id === 'msg-v4-tavily-001')
    if (msg) {
      // After v7, message references have blocks array, not metadata.
      // The tavily→webSearch conversion (v5) is verified by checking that:
      // 1. A citation block exists for this message
      // 2. The citation block's response source is WEBSEARCH (not TAVILY)
      if (msg.blocks && Array.isArray(msg.blocks)) {
        for (const blockId of msg.blocks) {
          const block = await db.table('message_blocks').get(blockId)
          if (block?.type === 'citation' && block?.response?.source === WEB_SEARCH_SOURCE.WEBSEARCH) {
            v5TavilyToWebSearch = true
            break
          }
        }
      }
      // Also verify no tavily key remains anywhere in the message
      if ('metadata' in msg && msg.metadata?.tavily) {
        v5TavilyToWebSearch = false
      }
    }
  }

  // v7: block types and counts
  const allBlocks = await db.table('message_blocks').toArray()
  const v7BlockTypes = [...new Set(allBlocks.map((b: { type: string }) => b.type))].sort()
  const v7BlockCount = allBlocks.length

  // v7: per-message block mapping from topic messages
  const v7MessageBlockMapping: Record<string, string[]> = {}
  const legacyTopic = await db.table('topics').get('topic-v4-legacy')
  if (legacyTopic?.messages) {
    for (const msg of legacyTopic.messages) {
      if (msg.blocks && Array.isArray(msg.blocks)) {
        v7MessageBlockMapping[msg.id] = [...msg.blocks]
      }
    }
  }
  // Also check tavily topic
  if (tavilyTopic?.messages) {
    for (const msg of tavilyTopic.messages) {
      if (msg.blocks && Array.isArray(msg.blocks)) {
        v7MessageBlockMapping[msg.id] = [...msg.blocks]
      }
    }
  }

  // v7: referential consistency — every blockId in messages exists in message_blocks
  const blockIdSet = new Set(allBlocks.map((b: { id: string }) => b.id))
  let v7ReferentialConsistency = true
  for (const blockIds of Object.values(v7MessageBlockMapping)) {
    for (const bid of blockIds) {
      if (!blockIdSet.has(bid)) {
        v7ReferentialConsistency = false
        break
      }
    }
  }

  // v8: settings language conversion
  const sourceLang = await db.table('settings').get('translate:source:language')
  const targetLang = await db.table('settings').get('translate:target:language')
  const v8SourceLanguage = sourceLang?.value ?? ''
  const v8TargetLanguage = targetLang?.value ?? ''

  // v8: translate_history language conversion
  const histories = await db.table('translate_history').toArray()
  const langCodePattern = /^[a-z]{2}-[a-z]{2}$/
  const v8HistoryLanguageConversion = histories.every(
    (h: { sourceLanguage: string; targetLanguage: string }) =>
      langCodePattern.test(h.sourceLanguage) && langCodePattern.test(h.targetLanguage)
  )

  // topic_segments table existence
  let topicSegmentsTableExists = false
  try {
    const tsTable = db.table('topic_segments')
    // Just accessing the table object proves it exists in the schema
    await tsTable.count()
    topicSegmentsTableExists = true
  } catch {
    topicSegmentsTableExists = false
  }

  return {
    v5DateConversion,
    v5TavilyToWebSearch,
    v7BlockTypes,
    v7BlockCount,
    v7MessageBlockMapping,
    v7ReferentialConsistency,
    v8SourceLanguage,
    v8TargetLanguage,
    v8HistoryLanguageConversion,
    topicSegmentsTableExists
  }
}

/* ── v11 Assertions ── */

async function runV11Assertions(db: Dexie): Promise<VerifyV11Assertions> {
  const markerSetting = await db.table('settings').get('phase4:marker')
  const fixtureIdSetting = await db.table('settings').get('phase4:fixtureId')

  const recordCounts: Record<string, number> = {}
  for (const table of db.tables) {
    recordCounts[table.name] = await table.count()
  }

  return {
    markerValue: markerSetting?.value ?? '',
    fixtureIdValue: fixtureIdSetting?.value ?? '',
    recordCounts
  }
}

/* ── Main verify handler ── */

export async function handleVerify(config: SpikeRequest): Promise<void> {
  const fixtureId = config.payload?.fixtureId as FixtureId | undefined
  const expectedNativeVersion = config.payload?.expectedNativeVersion as number | undefined

  if (!fixtureId || typeof expectedNativeVersion !== 'number') {
    log('ERROR: VERIFY payload missing fixtureId or expectedNativeVersion')
    const errorResult: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.VERIFY_DONE,
      status: 'error',
      error: 'Missing fixtureId or expectedNativeVersion in payload'
    }
    window.spike.reportResult(errorResult)
    return
  }

  const DB_NAME = 'CherryStudio'
  log(`VERIFY: fixtureId=${fixtureId}, expectedNative=${expectedNativeVersion}`)

  // ── Preflight ──
  const preflight = await runPreflight(DB_NAME, expectedNativeVersion)
  log(`Preflight: cherryStudioFound=${preflight.cherryStudioFound}, nativeVersion=${preflight.nativeVersion}`)

  if (!preflight.cherryStudioFound) {
    log('FAIL: CherryStudio not found via indexedDB.databases()')
    const payload: VerifyDonePayload = {
      fixtureId,
      preflight,
      productionOpenerStarted: false,
      productionOpenerCompleted: false,
      error: 'CherryStudio database not found in indexedDB.databases()'
    }
    const result: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.VERIFY_DONE,
      status: 'error',
      payload: payload as unknown as Record<string, unknown>
    }
    window.spike.reportResult(result)
    return
  }

  // ── Gate: native >= 120 → future_version_rejected ──
  if (preflight.nativeVersion >= 120) {
    log(`REJECTED: native version ${preflight.nativeVersion} >= 120 (future version)`)
    const payload: VerifyDonePayload = {
      fixtureId,
      preflight,
      productionOpenerStarted: false,
      productionOpenerCompleted: false,
      futureVersionRejected: true
    }
    const result: SpikeResult = {
      runId: config.runId,
      caseId: config.caseId,
      requestId: config.requestId,
      operation: SPIKE_OPERATIONS.VERIFY_DONE,
      status: 'rejected',
      payload: payload as unknown as Record<string, unknown>
    }
    window.spike.reportResult(result)
    return
  }

  // ── Production open: import actual production Dexie declaration ──
  log('Importing production Dexie declaration...')
  let productionOpenerStarted = false
  let productionOpenerCompleted = false
  let openResult: VerifyOpenResult | undefined
  let v4Assertions: VerifyV4Assertions | undefined
  let v11Assertions: VerifyV11Assertions | undefined
  let errorMsg: string | undefined

  // Declare db reference in outer scope so finally can always close it.
  // This avoids re-importing the production DB module in catch solely for cleanup.
  let db: Dexie | undefined

  try {
    // Dynamic import of the actual production db module.
    // This imports databases/index.ts which declares all versions 1-11
    // with the actual production upgrade functions (v5, v7, v8).
    // The module-level side effects (Dexie version declarations) are
    // harmless — they only register schema/upgrade metadata in memory.
    // No IndexedDB interaction occurs until db.open().
    const mod = await import('@renderer/databases/index')
    db = mod.db

    productionOpenerStarted = true
    log('Opening production db (will trigger upgrades for v4)...')
    await db.open()
    productionOpenerCompleted = true

    // Capture post-open state
    const logicalVerno = db.verno
    let nativeVersion = -1
    try {
      nativeVersion = db.backendDB().version
    } catch {
      // fallback: query again
      const fallback = await getNativeVersion(DB_NAME)
      nativeVersion = fallback ?? -1
    }

    const tables = db.tables.map((t) => t.name)
    const recordCounts: Record<string, number> = {}
    for (const table of db.tables) {
      recordCounts[table.name] = await table.count()
    }

    openResult = { logicalVerno, nativeVersion, tables, recordCounts }
    log(`Post-open: logical=${logicalVerno}, native=${nativeVersion}, tables=[${tables.join(', ')}]`)
    log(`Record counts: ${JSON.stringify(recordCounts)}`)

    // ── Case-specific assertions ──
    if (fixtureId === 'v4') {
      log('Running v4 upgrade assertions...')
      v4Assertions = await runV4Assertions(db)
      log(`v4 assertions: v5Date=${v4Assertions.v5DateConversion}, v5Tavily=${v4Assertions.v5TavilyToWebSearch}`)
      log(`  v7 blockTypes=[${v4Assertions.v7BlockTypes.join(', ')}], count=${v4Assertions.v7BlockCount}`)
      log(`  v7 referential=${v4Assertions.v7ReferentialConsistency}`)
      log(`  v8 source=${v4Assertions.v8SourceLanguage}, target=${v4Assertions.v8TargetLanguage}`)
      log(`  v8 historyConversion=${v4Assertions.v8HistoryLanguageConversion}`)
      log(`  topicSegmentsExists=${v4Assertions.topicSegmentsTableExists}`)
    }

    if (fixtureId === 'v11a' || fixtureId === 'v11b') {
      log('Running v11 assertions...')
      v11Assertions = await runV11Assertions(db)
      log(`v11 assertions: marker=${v11Assertions.markerValue}, fixtureId=${v11Assertions.fixtureIdValue}`)
      log(`  recordCounts: ${JSON.stringify(v11Assertions.recordCounts)}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`ERROR during production open/verify: ${msg}`)
    errorMsg = msg
  } finally {
    // Single cleanup point: close the db reference if it was opened.
    // No re-import needed — db is captured in the outer scope.
    if (db && db.isOpen()) {
      db.close()
      log('Production db closed.')
    }
  }

  // ── Emit result ──
  const payload: VerifyDonePayload = {
    fixtureId,
    preflight,
    productionOpenerStarted,
    productionOpenerCompleted,
    futureVersionRejected: false,
    openResult,
    v4Assertions,
    v11Assertions,
    error: errorMsg
  }

  const result: SpikeResult = {
    runId: config.runId,
    caseId: config.caseId,
    requestId: config.requestId,
    operation: SPIKE_OPERATIONS.VERIFY_DONE,
    status: errorMsg ? 'error' : 'ok',
    payload: payload as unknown as Record<string, unknown>
  }

  log(`VERIFY_DONE: status=${result.status}, fixtureId=${fixtureId}`)
  window.spike.reportResult(result)
}
