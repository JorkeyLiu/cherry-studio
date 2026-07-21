/**
 * Phase 4.0-C2b: Local Storage Necessity Verifier
 *
 * TEST/FEASIBILITY-ONLY. Not referenced by any production entry point.
 * Retained through Phase 4.1 as reproducibility harness.
 *
 * Proves in ONE Electron process that:
 *  1. A full-profile (IndexedDB + Local Storage) and an IDB-only profile
 *     (IndexedDB only) from the same v11 fixture produce identical
 *     CherryStudio IndexedDB discovery and read results.
 *  2. Only the full-profile session exposes the Local Storage control marker.
 *  3. The IDB-only session does NOT expose the marker, proving Local Storage
 *     is unnecessary for CherryStudio Dexie discovery/read.
 *
 * Architecture: two retained sessions and windows — full-profile and IDB-only
 * windows are created and kept alive simultaneously (same pattern as C2a).
 * Sequential VERIFY → LS_CHECK operations on each window via the IPC
 * multiplexer.
 *
 * Does NOT implement:
 *  - Production ZIP intake/security UX
 *  - Actual import IPC/paging
 *  - SQLite bulk writer
 *  - Windows/Linux claims
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { VerifyOpenResult, VerifyPreflight, VerifyV11Assertions } from '@shared/phase4FixtureManifest'
import {
  generateCaseId,
  generateRequestId,
  generateRunId,
  getExpectedResponseOperation,
  SPIKE_CHANNELS,
  SPIKE_OPERATIONS,
  type SpikeOperation,
  type SpikeRequest,
  type SpikeResult,
  validateSpikeResult
} from '@shared/phase4SpikeContract'
import { app, BrowserWindow, ipcMain, session } from 'electron'

import { validateStagingPath } from './phase4-path-validation'

/* ══════════════════════════════════════════════════════════════════════════
 * Constants
 * ══════════════════════════════════════════════════════════════════════════ */

const C2B_CASE_TIMEOUT_MS = 60_000
const EXPECTED_MARKER = 'A'
const EXPECTED_FIXTURE_ID = 'v11a'
const EXPECTED_NATIVE_VERSION = 110
const EXPECTED_LOGICAL_VERSION = 11

/* ══════════════════════════════════════════════════════════════════════════
 * Types
 * ══════════════════════════════════════════════════════════════════════════ */

interface PendingCase {
  label: string
  caseId: string
  requestId: string
  operation: string
  payload?: Record<string, unknown>
  resolve: (result: SpikeResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  settled: boolean
}

interface RetainedWindow {
  label: string
  window: BrowserWindow
  ses: Electron.Session | null
  rootPath: string
  originUrl: string
}

/** Per-profile verification data collected from VERIFY + LS_CHECK */
interface ProfileVerification {
  label: string
  verifyResult?: SpikeResult
  lsCheckResult?: SpikeResult
  verifyError?: string
  lsCheckError?: string
}

/** C2b comparison result */
interface C2bComparison {
  preflightMatch: boolean
  nativeVersionMatch: boolean
  logicalVersionMatch: boolean
  openResultMatch: boolean
  recordCountsMatch: boolean
  v11MarkerMatch: boolean
  v11FixtureIdMatch: boolean
  v11RecordCountsMatch: boolean
  fullLsMarkerFound: boolean
  idbLsMarkerAbsent: boolean
  fullLsMarkerValue: string | null
  idbLsMarkerValue: string | null
  allChecksPass: boolean
  errors: string[]
}

/** Machine-readable C2b summary */
interface C2bSummary {
  phase: '4.0-C2b'
  runId: string
  iterations: number
  versions: { electron: string; node: string; chrome: string; platform: string; arch: string }
  workspace: string
  fixtureId: string
  fullProfilePath: string
  idbOnlyPath: string
  fullProfile?: ProfileVerification
  idbOnly?: ProfileVerification
  comparison?: C2bComparison
  allPassed: boolean
  ownedRoots: string[]
  timestamp: string
  error?: string
}

/* ══════════════════════════════════════════════════════════════════════════
 * Logging
 * ══════════════════════════════════════════════════════════════════════════ */

function log(msg: string): void {
  console.log(`[phase4-c2b] ${msg}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * IPC multiplexer (same pattern as C2a)
 * ══════════════════════════════════════════════════════════════════════════ */

const pendingCases = new Map<number, PendingCase>()
const retainedWindows: RetainedWindow[] = []

let globalRunId = ''
let readyListener: ((event: Electron.IpcMainEvent) => void) | null = null
let resultListener: ((event: Electron.IpcMainEvent, data: unknown) => void) | null = null

function installIpcListeners(): void {
  readyListener = (event) => {
    const caseInfo = pendingCases.get(event.sender.id)
    if (!caseInfo) {
      log(`READY from unregistered sender id=${event.sender.id}, ignoring`)
      return
    }
    log(`READY from ${caseInfo.label} (sender=${event.sender.id})`)

    const request: SpikeRequest = {
      runId: globalRunId,
      caseId: caseInfo.caseId,
      requestId: caseInfo.requestId,
      operation: caseInfo.operation as SpikeRequest['operation'],
      ...(caseInfo.payload ? { payload: caseInfo.payload } : {})
    }

    try {
      event.sender.send(SPIKE_CHANNELS.CONFIG, request)
      log(`  CONFIG/${caseInfo.operation} sent to ${caseInfo.label}`)
    } catch (err) {
      caseInfo.reject(new Error(`Failed to send CONFIG to ${caseInfo.label}: ${(err as Error).message}`))
    }
  }

  resultListener = (event, data) => {
    const caseInfo = pendingCases.get(event.sender.id)
    if (!caseInfo) {
      log(`RESULT from unregistered sender id=${event.sender.id}, ignoring`)
      return
    }

    const validation = validateSpikeResult(data)
    if (!validation.valid) {
      log(`RESULT rejected for ${caseInfo.label}: ${validation.error}`)
      caseInfo.reject(new Error(`Invalid result envelope for ${caseInfo.label}: ${validation.error}`))
      return
    }

    const res = data as SpikeResult

    if (res.runId !== globalRunId || res.caseId !== caseInfo.caseId || res.requestId !== caseInfo.requestId) {
      log(`RESULT identity mismatch for ${caseInfo.label}`)
      caseInfo.reject(new Error(`Result identity mismatch for ${caseInfo.label}`))
      return
    }

    const expectedResponseOp = getExpectedResponseOperation(caseInfo.operation as SpikeOperation)
    if (!expectedResponseOp) {
      caseInfo.reject(
        new Error(`No expected response operation for request "${caseInfo.operation}" on ${caseInfo.label}`)
      )
      return
    }
    if (res.operation !== expectedResponseOp) {
      caseInfo.reject(
        new Error(`Operation mismatch for ${caseInfo.label}: expected "${expectedResponseOp}", got "${res.operation}"`)
      )
      return
    }

    log(`RESULT from ${caseInfo.label}: status=${res.status}, operation=${res.operation}`)
    caseInfo.resolve(res)
  }

  ipcMain.on(SPIKE_CHANNELS.READY, readyListener)
  ipcMain.on(SPIKE_CHANNELS.RESULT, resultListener)
  log('IPC listeners installed')
}

function removeIpcListeners(): void {
  if (readyListener) {
    ipcMain.removeListener(SPIKE_CHANNELS.READY, readyListener)
    readyListener = null
  }
  if (resultListener) {
    ipcMain.removeListener(SPIKE_CHANNELS.RESULT, resultListener)
    resultListener = null
  }
  for (const [_wcId, caseInfo] of pendingCases) {
    caseInfo.reject(new Error(`Cleanup: case ${caseInfo.label} not settled before shutdown`))
  }
  pendingCases.clear()
  log('IPC listeners removed')
}

function registerCase(
  win: BrowserWindow,
  label: string,
  operation: string,
  payload?: Record<string, unknown>,
  timeoutMs: number = C2B_CASE_TIMEOUT_MS
): Promise<SpikeResult> {
  return new Promise((resolve, reject) => {
    const caseId = generateCaseId()
    const requestId = generateRequestId()

    const settle = (result: SpikeResult) => {
      if (caseInfo.settled) return
      caseInfo.settled = true
      clearTimeout(caseInfo.timer)
      pendingCases.delete(win.webContents.id)
      resolve(result)
    }
    const settleReject = (error: Error) => {
      if (caseInfo.settled) return
      caseInfo.settled = true
      clearTimeout(caseInfo.timer)
      pendingCases.delete(win.webContents.id)
      reject(error)
    }

    const timer = setTimeout(() => {
      settleReject(new Error(`Timeout (${timeoutMs}ms) for ${label} [${operation}]`))
    }, timeoutMs)

    const caseInfo: PendingCase = {
      label,
      caseId,
      requestId,
      operation,
      payload,
      resolve: (result) => settle(result),
      reject: (error) => settleReject(error),
      timer,
      settled: false
    }

    pendingCases.set(win.webContents.id, caseInfo)
  })
}

function sendConfigDirectly(win: BrowserWindow, operation: string, payload?: Record<string, unknown>): void {
  const caseInfo = pendingCases.get(win.webContents.id)
  if (!caseInfo) {
    throw new Error(`No pending case for window ${win.webContents.id} when sending ${operation}`)
  }

  const request: SpikeRequest = {
    runId: globalRunId,
    caseId: caseInfo.caseId,
    requestId: caseInfo.requestId,
    operation: operation as SpikeRequest['operation'],
    ...(payload ? { payload } : caseInfo.payload ? { payload: caseInfo.payload } : {})
  }

  win.webContents.send(SPIKE_CHANNELS.CONFIG, request)
  log(`  CONFIG/${operation} sent directly to ${caseInfo.label}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * BrowserWindow factory (retained) — identical to C2a
 * ══════════════════════════════════════════════════════════════════════════ */

function createSandboxedWindow(ses: Electron.Session, preloadPath: string, label: string): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 100,
    height: 100,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: preloadPath
    }
  })

  win.webContents.on('will-navigate', (e) => {
    log(`[${label}] Navigation blocked`)
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => {
    log(`[${label}] New window blocked`)
    return { action: 'deny' }
  })

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    log(`[${label}] did-fail-load: code=${errorCode} desc=${errorDescription}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`[${label}] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.on('unresponsive', () => {
    log(`[${label}] Window became unresponsive`)
  })

  win.webContents.on('console-message', (_e, level, message) => {
    const prefix = ['verbose', 'info', 'warning', 'error'][level] ?? 'unknown'
    log(`[${label}/${prefix}] ${message}`)
  })

  return win
}

/* ══════════════════════════════════════════════════════════════════════════
 * Profile path validation
 * ══════════════════════════════════════════════════════════════════════════ */

function validateProfilePath(profilePath: string, label: string): void {
  if (!validateStagingPath(profilePath, log)) {
    throw new Error(`[${label}] Profile path is not a valid owned staging path: ${profilePath}`)
  }
  const idbDir = path.join(profilePath, 'IndexedDB')
  if (!fs.existsSync(idbDir)) {
    throw new Error(`[${label}] IndexedDB directory not found: ${idbDir}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Comparison logic
 * ══════════════════════════════════════════════════════════════════════════ */

function compareProfiles(full: ProfileVerification, idb: ProfileVerification): C2bComparison {
  const errors: string[] = []

  /* Extract VERIFY payloads */
  const fullVerify = full.verifyResult?.payload
  const idbVerify = idb.verifyResult?.payload

  /* Extract LS_CHECK payloads */
  const fullLs = full.lsCheckResult?.payload
  const idbLs = idb.lsCheckResult?.payload

  /* ── Preflight comparison ── */
  const fullPreflight = fullVerify?.preflight as VerifyPreflight | undefined
  const idbPreflight = idbVerify?.preflight as VerifyPreflight | undefined

  const preflightMatch =
    fullPreflight?.cherryStudioFound === true &&
    idbPreflight?.cherryStudioFound === true &&
    fullPreflight?.nativeVersion === idbPreflight?.nativeVersion

  if (!preflightMatch) {
    errors.push(
      `Preflight mismatch: full(cherryStudio=${fullPreflight?.cherryStudioFound}, native=${fullPreflight?.nativeVersion}) ` +
        `vs idb(cherryStudio=${idbPreflight?.cherryStudioFound}, native=${idbPreflight?.nativeVersion})`
    )
  }

  /* ── Native version ── */
  const nativeVersionMatch =
    fullPreflight?.nativeVersion === EXPECTED_NATIVE_VERSION && idbPreflight?.nativeVersion === EXPECTED_NATIVE_VERSION
  if (!nativeVersionMatch) {
    errors.push(
      `Native version: expected ${EXPECTED_NATIVE_VERSION}, ` +
        `got full=${fullPreflight?.nativeVersion} idb=${idbPreflight?.nativeVersion}`
    )
  }

  /* ── Production opener ── */
  const fullOpenerStarted = fullVerify?.productionOpenerStarted === true
  const idbOpenerStarted = idbVerify?.productionOpenerStarted === true
  const fullOpenerCompleted = fullVerify?.productionOpenerCompleted === true
  const idbOpenerCompleted = idbVerify?.productionOpenerCompleted === true

  if (!fullOpenerStarted || !idbOpenerStarted) {
    errors.push('Production opener not started on one or both profiles')
  }
  if (!fullOpenerCompleted || !idbOpenerCompleted) {
    errors.push('Production opener not completed on one or both profiles')
  }

  /* ── Open result comparison ── */
  const fullOpen = fullVerify?.openResult as VerifyOpenResult | undefined
  const idbOpen = idbVerify?.openResult as VerifyOpenResult | undefined

  const logicalVersionMatch =
    fullOpen?.logicalVerno === EXPECTED_LOGICAL_VERSION && idbOpen?.logicalVerno === EXPECTED_LOGICAL_VERSION
  if (!logicalVersionMatch) {
    errors.push(
      `Logical version: expected ${EXPECTED_LOGICAL_VERSION}, ` +
        `got full=${fullOpen?.logicalVerno} idb=${idbOpen?.logicalVerno}`
    )
  }

  const openResultMatch =
    fullOpen?.logicalVerno === idbOpen?.logicalVerno &&
    fullOpen?.nativeVersion === idbOpen?.nativeVersion &&
    JSON.stringify(fullOpen?.tables) === JSON.stringify(idbOpen?.tables)

  if (!openResultMatch) {
    errors.push(
      `Open result mismatch: full(logical=${fullOpen?.logicalVerno}, native=${fullOpen?.nativeVersion}) ` +
        `vs idb(logical=${idbOpen?.logicalVerno}, native=${idbOpen?.nativeVersion})`
    )
  }

  /* ── Record counts comparison ── */
  const fullCounts = fullOpen?.recordCounts ?? {}
  const idbCounts = idbOpen?.recordCounts ?? {}
  const recordCountsMatch = JSON.stringify(fullCounts) === JSON.stringify(idbCounts)
  if (!recordCountsMatch) {
    errors.push(`Record counts differ: full=${JSON.stringify(fullCounts)} vs idb=${JSON.stringify(idbCounts)}`)
  }

  /* ── v11 assertions comparison ── */
  const fullV11 = fullVerify?.v11Assertions as VerifyV11Assertions | undefined
  const idbV11 = idbVerify?.v11Assertions as VerifyV11Assertions | undefined

  const v11MarkerMatch = fullV11?.markerValue === EXPECTED_MARKER && idbV11?.markerValue === EXPECTED_MARKER
  if (!v11MarkerMatch) {
    errors.push(
      `v11 marker: expected "${EXPECTED_MARKER}", ` + `got full="${fullV11?.markerValue}" idb="${idbV11?.markerValue}"`
    )
  }

  const v11FixtureIdMatch =
    fullV11?.fixtureIdValue === EXPECTED_FIXTURE_ID && idbV11?.fixtureIdValue === EXPECTED_FIXTURE_ID
  if (!v11FixtureIdMatch) {
    errors.push(
      `v11 fixtureId: expected "${EXPECTED_FIXTURE_ID}", ` +
        `got full="${fullV11?.fixtureIdValue}" idb="${idbV11?.fixtureIdValue}"`
    )
  }

  const v11RecordCountsMatch = JSON.stringify(fullV11?.recordCounts) === JSON.stringify(idbV11?.recordCounts)
  if (!v11RecordCountsMatch) {
    errors.push('v11 recordCounts differ between profiles')
  }

  /* ── Local Storage comparison ── */
  const fullLsMarkerFound = fullLs?.markerFound === true
  const fullLsMarkerValue = (fullLs?.markerValue as string | null) ?? null
  const idbLsMarkerAbsent = idbLs?.markerFound === false
  const idbLsMarkerValue = (idbLs?.markerValue as string | null) ?? null

  if (!fullLsMarkerFound) {
    errors.push(`Full profile: Local Storage marker NOT found (expected present)`)
  }
  if (fullLsMarkerValue !== EXPECTED_MARKER) {
    errors.push(`Full profile: LS marker value "${fullLsMarkerValue}" != expected "${EXPECTED_MARKER}"`)
  }
  if (!idbLsMarkerAbsent) {
    errors.push(`IDB-only profile: Local Storage marker unexpectedly FOUND (value="${idbLsMarkerValue}")`)
  }

  const allChecksPass =
    preflightMatch &&
    nativeVersionMatch &&
    fullOpenerStarted &&
    idbOpenerStarted &&
    fullOpenerCompleted &&
    idbOpenerCompleted &&
    logicalVersionMatch &&
    openResultMatch &&
    recordCountsMatch &&
    v11MarkerMatch &&
    v11FixtureIdMatch &&
    v11RecordCountsMatch &&
    fullLsMarkerFound &&
    idbLsMarkerAbsent

  return {
    preflightMatch,
    nativeVersionMatch,
    logicalVersionMatch,
    openResultMatch,
    recordCountsMatch,
    v11MarkerMatch,
    v11FixtureIdMatch,
    v11RecordCountsMatch,
    fullLsMarkerFound,
    idbLsMarkerAbsent,
    fullLsMarkerValue,
    idbLsMarkerValue,
    allChecksPass,
    errors
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Main C2b harness
 * ══════════════════════════════════════════════════════════════════════════ */

export async function runC2bVerifier(workspaceArg: string): Promise<void> {
  globalRunId = generateRunId()

  const ownedRoots: string[] = []

  log('╔══════════════════════════════════════════════════════════════╗')
  log('║  Phase 4.0-C2b Local Storage Necessity Verifier             ║')
  log('╚══════════════════════════════════════════════════════════════╝')
  log(`runId=${globalRunId}`)
  log(`Electron ${process.versions.electron}, Node ${process.versions.node}, Chrome ${process.versions.chrome}`)
  log(`platform=${process.platform}, arch=${process.arch}`)

  const workspace = path.resolve(workspaceArg)
  const fullProfilePath = path.join(workspace, 'full-profile')
  const idbOnlyPath = path.join(workspace, 'idb-only')

  log(`workspace: ${workspace}`)
  log(`full-profile: ${fullProfilePath}`)
  log(`idb-only: ${idbOnlyPath}`)

  /* ── Validate workspace ── */
  if (!validateStagingPath(workspace, log)) {
    log(`ERROR: workspace is not under system temp dir: ${workspace}`)
    process.exitCode = 1
    app.quit()
    return
  }

  /* ── Spike-owned userData ── */
  const spikeUserDataDir = path.join(workspace, 'userdata')
  fs.mkdirSync(spikeUserDataDir, { recursive: true })
  app.setPath('userData', spikeUserDataDir)
  ownedRoots.push(spikeUserDataDir)
  log(`Spike-owned userData: ${spikeUserDataDir}`)

  await app.whenReady()
  log('app.whenReady() resolved')

  app.on('window-all-closed', () => {
    log('window-all-closed (suppressed for C2b multi-window lifecycle)')
  })

  installIpcListeners()

  const preloadPath = path.join(__dirname, '../preload/phase4-spike-preload.js')
  const rendererHtmlPath = path.join(__dirname, '../renderer/phase4Spike.html')
  const rendererFileUrl = pathToFileURL(rendererHtmlPath).toString()
  log(`preload: ${preloadPath}`)
  log(`renderer: ${rendererFileUrl}`)

  const fullProfile: ProfileVerification = { label: 'full-profile' }
  const idbOnly: ProfileVerification = { label: 'idb-only' }
  let allPassed = false
  let comparison: C2bComparison | undefined
  let harnessError: string | undefined

  try {
    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 0: Validate profile paths
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 0: Validate profile paths ──')

    validateProfilePath(fullProfilePath, 'full-profile')
    validateProfilePath(idbOnlyPath, 'idb-only')

    /* Verify IDB-only does NOT have Local Storage */
    const idbLsDir = path.join(idbOnlyPath, 'Local Storage')
    if (fs.existsSync(idbLsDir)) {
      throw new Error(`IDB-only profile unexpectedly contains Local Storage directory: ${idbLsDir}`)
    }

    /* Verify full profile DOES have Local Storage */
    const fullLsDir = path.join(fullProfilePath, 'Local Storage')
    if (!fs.existsSync(fullLsDir)) {
      throw new Error(`Full profile missing Local Storage directory: ${fullLsDir}`)
    }

    log('Profile path validation: PASS')
    log(`  Full profile: IndexedDB + Local Storage present`)
    log(`  IDB-only profile: IndexedDB present, Local Storage absent`)

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 1: Create retained sessions and windows
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 1: Create retained sessions and windows ──')

    const sesFull = session.fromPath(fullProfilePath, { cache: false })
    const sesIdb = session.fromPath(idbOnlyPath, { cache: false })

    const storagePathFull = path.resolve(sesFull.storagePath ?? '')
    const storagePathIdb = path.resolve(sesIdb.storagePath ?? '')
    const storagePathDefault = path.resolve(session.defaultSession.storagePath ?? '')

    log(`  sesFull.storagePath = ${storagePathFull}`)
    log(`  sesIdb.storagePath = ${storagePathIdb}`)
    log(`  defaultSession.storagePath = ${storagePathDefault}`)

    if (!sesFull.isPersistent()) throw new Error('sesFull.isPersistent() returned false')
    if (!sesIdb.isPersistent()) throw new Error('sesIdb.isPersistent() returned false')
    log('  isPersistent(): all sessions report true')

    /* Validate storage paths match */
    const canonicalFull = path.resolve(fullProfilePath)
    const canonicalIdb = path.resolve(idbOnlyPath)
    if (storagePathFull !== canonicalFull) {
      throw new Error(`sesFull storagePath mismatch: expected ${canonicalFull}, got ${storagePathFull}`)
    }
    if (storagePathIdb !== canonicalIdb) {
      throw new Error(`sesIdb storagePath mismatch: expected ${canonicalIdb}, got ${storagePathIdb}`)
    }

    const windowFull = createSandboxedWindow(sesFull, preloadPath, 'full-profile')
    const windowIdb = createSandboxedWindow(sesIdb, preloadPath, 'idb-only')

    retainedWindows.push(
      {
        label: 'full-profile',
        window: windowFull,
        ses: sesFull,
        rootPath: fullProfilePath,
        originUrl: rendererFileUrl
      },
      { label: 'idb-only', window: windowIdb, ses: sesIdb, rootPath: idbOnlyPath, originUrl: rendererFileUrl }
    )

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 2: VERIFY on both windows (parallel)
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 2: VERIFY on both windows (parallel) ──')

    const verifyFullPromise = registerCase(windowFull, 'full-verify', SPIKE_OPERATIONS.VERIFY, {
      fixtureId: EXPECTED_FIXTURE_ID,
      expectedNativeVersion: EXPECTED_NATIVE_VERSION
    })
    const verifyIdbPromise = registerCase(windowIdb, 'idb-verify', SPIKE_OPERATIONS.VERIFY, {
      fixtureId: EXPECTED_FIXTURE_ID,
      expectedNativeVersion: EXPECTED_NATIVE_VERSION
    })

    windowFull.loadURL(rendererFileUrl).catch((err) => {
      log(`full-profile loadURL failed: ${(err as Error).message}`)
    })
    windowIdb.loadURL(rendererFileUrl).catch((err) => {
      log(`idb-only loadURL failed: ${(err as Error).message}`)
    })

    const [verifyFullResult, verifyIdbResult] = await Promise.all([verifyFullPromise, verifyIdbPromise])

    fullProfile.verifyResult = verifyFullResult
    idbOnly.verifyResult = verifyIdbResult

    log(`  Full VERIFY: status=${verifyFullResult.status}`)
    log(`  IDB  VERIFY: status=${verifyIdbResult.status}`)

    if (verifyFullResult.status === 'error') {
      fullProfile.verifyError = verifyFullResult.error ?? 'unknown'
    }
    if (verifyIdbResult.status === 'error') {
      idbOnly.verifyError = verifyIdbResult.error ?? 'unknown'
    }

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 3: LS_CHECK on both windows (parallel)
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 3: LS_CHECK on both windows (parallel) ──')

    const lsFullPromise = registerCase(windowFull, 'full-ls', SPIKE_OPERATIONS.LS_CHECK)
    const lsIdbPromise = registerCase(windowIdb, 'idb-ls', SPIKE_OPERATIONS.LS_CHECK)

    sendConfigDirectly(windowFull, SPIKE_OPERATIONS.LS_CHECK)
    sendConfigDirectly(windowIdb, SPIKE_OPERATIONS.LS_CHECK)

    const [lsFullResult, lsIdbResult] = await Promise.all([lsFullPromise, lsIdbPromise])

    fullProfile.lsCheckResult = lsFullResult
    idbOnly.lsCheckResult = lsIdbResult

    log(`  Full LS_CHECK: status=${lsFullResult.status}`)
    log(`  IDB  LS_CHECK: status=${lsIdbResult.status}`)

    if (lsFullResult.status === 'error') {
      fullProfile.lsCheckError = lsFullResult.error ?? 'unknown'
    }
    if (lsIdbResult.status === 'error') {
      idbOnly.lsCheckError = lsIdbResult.error ?? 'unknown'
    }

    const fullLsPayload = lsFullResult.payload
    const idbLsPayload = lsIdbResult.payload
    log(
      `  Full LS: marker=${fullLsPayload?.markerFound ? `"${fullLsPayload.markerValue}"` : 'ABSENT'}, keys=${JSON.stringify(fullLsPayload?.allKeys)}`
    )
    log(
      `  IDB  LS: marker=${idbLsPayload?.markerFound ? `"${idbLsPayload.markerValue}"` : 'ABSENT'}, keys=${JSON.stringify(idbLsPayload?.allKeys)}`
    )

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 4: Comparison
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 4: Comparison ──')

    comparison = compareProfiles(fullProfile, idbOnly)
    allPassed = comparison.allChecksPass && !fullProfile.verifyError && !idbOnly.verifyError

    log(`  preflightMatch: ${comparison.preflightMatch}`)
    log(`  nativeVersionMatch: ${comparison.nativeVersionMatch}`)
    log(`  logicalVersionMatch: ${comparison.logicalVersionMatch}`)
    log(`  openResultMatch: ${comparison.openResultMatch}`)
    log(`  recordCountsMatch: ${comparison.recordCountsMatch}`)
    log(`  v11MarkerMatch: ${comparison.v11MarkerMatch}`)
    log(`  v11FixtureIdMatch: ${comparison.v11FixtureIdMatch}`)
    log(`  v11RecordCountsMatch: ${comparison.v11RecordCountsMatch}`)
    log(`  fullLsMarkerFound: ${comparison.fullLsMarkerFound} (value="${comparison.fullLsMarkerValue}")`)
    log(`  idbLsMarkerAbsent: ${comparison.idbLsMarkerAbsent} (value="${comparison.idbLsMarkerValue}")`)
    log(`  allChecksPass: ${comparison.allChecksPass}`)

    if (comparison.errors.length > 0) {
      for (const err of comparison.errors) {
        log(`  ERROR: ${err}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`C2b HARNESS ERROR: ${msg}`)
    harnessError = msg
    allPassed = false
  }

  /* ═══════════════════════════════════════════════════════════════════
   * PHASE 5: Emit summary
   * ═══════════════════════════════════════════════════════════════════ */
  log('')
  log('── PHASE 5: Summary ──')

  const summary: C2bSummary = {
    phase: '4.0-C2b',
    runId: globalRunId,
    iterations: 1,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      arch: process.arch
    },
    workspace,
    fixtureId: EXPECTED_FIXTURE_ID,
    fullProfilePath,
    idbOnlyPath,
    fullProfile: fullProfile.verifyResult || fullProfile.lsCheckResult ? fullProfile : undefined,
    idbOnly: idbOnly.verifyResult || idbOnly.lsCheckResult ? idbOnly : undefined,
    comparison,
    allPassed,
    ownedRoots,
    timestamp: new Date().toISOString(),
    error: harnessError
  }

  log('')
  /* Print tagged summary line for the parent runner to parse */
  console.log(`[phase4-c2b-summary] ${JSON.stringify(summary)}`)
  log(JSON.stringify(summary, null, 2))

  if (allPassed) {
    log('')
    log('Phase 4.0-C2b verification: ALL PASS')
    log('Local Storage is NOT required for CherryStudio IndexedDB discovery/read.')
    process.exitCode = 0
  } else {
    log('')
    log('Phase 4.0-C2b verification: FAILURES DETECTED')
    process.exitCode = 1
  }

  /* ═══════════════════════════════════════════════════════════════════
   * PHASE 6: Cleanup
   * ═══════════════════════════════════════════════════════════════════ */
  log('')
  log('── PHASE 6: Cleanup ──')

  for (const rw of retainedWindows) {
    if (rw.window && !rw.window.isDestroyed()) {
      try {
        rw.window.destroy()
        log(`  Window ${rw.label} destroyed`)
      } catch {
        /* best effort */
      }
    }
  }
  retainedWindows.length = 0

  removeIpcListeners()

  log('')
  log('Owned roots (parent handles cleanup):')
  for (const root of ownedRoots) {
    log(`  ${root}`)
  }

  log('')
  log('Initiating orderly shutdown...')
  app.quit()
}
