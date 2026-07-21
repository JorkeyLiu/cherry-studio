/**
 * Phase 4.0-C2a: Retained-Session Isolation Verifier
 *
 * TEST/FEASIBILITY-ONLY. Not referenced by any production entry point.
 * Retained through Phase 4.1 as reproducibility harness.
 *
 * Proves in ONE Electron process that:
 *  1. Multiple absolute-path session.fromPath() profiles remain isolated
 *  2. The default test Session is not impacted by candidate profile reads
 *  3. v11-A and v11-B do not cross-contaminate
 *  4. A wrong-origin probe confirms CherryStudio absent at a different origin
 *     within the same session, and the correct origin remains intact afterward
 *
 * Architecture: retained sessions and windows — all candidate windows are
 * created and kept alive simultaneously. No timing-based destroy/recreate
 * orchestration. No 2-second sleeps.
 *
 * Does NOT implement:
 *  - Local Storage copy comparison (deferred to C2b)
 *  - Post-exit deletion timing (deferred to C2b)
 *  - Repeated ≥10-run matrix (deferred to C2b)
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { FixtureId, StagedFixtureManifest } from '@shared/phase4FixtureManifest'
import { validateFixtureManifest } from '@shared/phase4FixtureManifest'
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

const C2A_CASE_TIMEOUT_MS = 60_000
const SENTINEL_MARKER_PREFIX = 'c2a-sentinel-'
const CHERRY_STUDIO_DB_NAME = 'CherryStudio'

/* ══════════════════════════════════════════════════════════════════════════
 * Types
 * ══════════════════════════════════════════════════════════════════════════ */

/** Pending IPC case: maps webContents.id → expected operation + promise resolvers */
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

/** Retained window entry */
interface RetainedWindow {
  label: string
  window: BrowserWindow
  ses: Electron.Session | null
  rootPath: string
  originUrl: string
}

/** C2a case result */
interface C2aCaseResult {
  label: string
  status: 'PASS' | 'FAIL'
  operation: string
  result?: SpikeResult
  error?: string
  diagnostics?: Record<string, unknown>
}

/** Full C2a summary */
interface C2aSummary {
  phase: '4.0-C2a'
  runId: string
  manifestRoot: string
  versions: { electron: string; node: string; chrome: string }
  storagePaths: Record<string, string>
  originUrls: Record<string, string>
  cases: Record<string, C2aCaseResult>
  allPassed: boolean
  ownedRoots: string[]
  timestamp: string
}

/* ══════════════════════════════════════════════════════════════════════════
 * Logging
 * ══════════════════════════════════════════════════════════════════════════ */

function log(msg: string): void {
  console.log(`[phase4-c2a] ${msg}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * Manifest reading (reuses C1 validation)
 * ══════════════════════════════════════════════════════════════════════════ */

function readStagedManifest(fixtureDir: string): StagedFixtureManifest | null {
  const manifestPath = path.join(fixtureDir, 'staged-manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    const data = JSON.parse(raw) as unknown
    const validation = validateFixtureManifest(data)
    if (!validation.valid) return null
    return data as StagedFixtureManifest
  } catch {
    return null
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * HTTP server for wrong-origin probe
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Minimal HTML page for the wrong-origin probe.
 *
 * The preload (loaded from file path by BrowserWindow config) has already
 * injected window.spike before this inline script runs. The page uses
 * window.spike.onConfig / window.spike.reportResult for IPC.
 *
 * CSP allows only inline scripts (no external resources, no eval).
 * This is safe because:
 *  - Content is self-contained (no external dependencies)
 *  - Served only from 127.0.0.1 on a random port
 *  - Window is sandboxed (no Node.js, no filesystem)
 */
const WRONG_ORIGIN_HTML = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
  <title>C2a Wrong-Origin Probe</title>
  <style>body{margin:0;font:12px/1.4 monospace;background:#1a1a1a;color:#ccc}#log{padding:8px;white-space:pre-wrap}</style>
</head>
<body>
<pre id="log"></pre>
<script>
(function() {
  var CHERRY_STUDIO_DB = '${CHERRY_STUDIO_DB_NAME}';
  var logEl = document.getElementById('log');
  function log(msg) {
    var ts = new Date().toISOString();
    if (logEl) logEl.textContent += '[' + ts + '] ' + msg + '\\n';
    console.log('[C2aWrongOrigin] ' + msg);
  }

  window.spike.onConfig(function(config) {
    log('CONFIG received: operation=' + config.operation);

    if (config.operation === 'ORIGIN_PROBE') {
      var dbsReq = indexedDB.databases();
      if (dbsReq && typeof dbsReq.then === 'function') {
        dbsReq.then(function(dbs) {
          var dbNames = dbs.map(function(d) { return d.name; });
          var cherryFound = dbNames.indexOf(CHERRY_STUDIO_DB) !== -1;
          log('Probed ' + dbs.length + ' databases: [' + dbNames.join(', ') + ']');
          log('CherryStudio found: ' + cherryFound);
          if (cherryFound) {
            var csEntry = dbs.find(function(d) { return d.name === CHERRY_STUDIO_DB; });
            log('  CherryStudio version: ' + (csEntry ? csEntry.version : 'unknown'));
          }
          window.spike.reportResult({
            runId: config.runId,
            caseId: config.caseId,
            requestId: config.requestId,
            operation: 'ORIGIN_PROBE_DONE',
            status: 'ok',
            payload: {
              databases: dbs.map(function(d) { return { name: d.name, version: d.version }; }),
              cherryStudioFound: cherryFound,
              cherryStudioVersion: cherryFound ? (dbs.find(function(d) { return d.name === CHERRY_STUDIO_DB; }) || {}).version || null : null,
              sentinelFound: false,
              cherryStudioDbName: CHERRY_STUDIO_DB,
              origin: location.origin,
              href: location.href
            }
          });
        }).catch(function(e) {
          log('ERROR: ' + String(e));
          window.spike.reportResult({
            runId: config.runId,
            caseId: config.caseId,
            requestId: config.requestId,
            operation: 'ORIGIN_PROBE_DONE',
            status: 'error',
            error: String(e)
          });
        });
      } else {
        log('ERROR: indexedDB.databases() not available');
        window.spike.reportResult({
          runId: config.runId,
          caseId: config.caseId,
          requestId: config.requestId,
          operation: 'ORIGIN_PROBE_DONE',
          status: 'error',
          error: 'indexedDB.databases() not available in this context'
        });
      }
    } else {
      log('ERROR: Unhandled operation: ' + config.operation);
      window.spike.reportResult({
        runId: config.runId,
        caseId: config.caseId,
        requestId: config.requestId,
        operation: config.operation,
        status: 'error',
        error: 'Wrong-origin probe page only handles ORIGIN_PROBE, got: ' + config.operation
      });
    }
  });

  log('Wrong-origin probe page loaded. origin=' + location.origin + ' href=' + location.href);
  window.spike.ready();
  log('READY sent.');
})();
</script>
</body>
</html>`

interface WrongOriginServer {
  server: http.Server
  port: number
  origin: string
}

function startWrongOriginServer(): Promise<WrongOriginServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
      })
      res.end(WRONG_ORIGIN_HTML)
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      const origin = `http://127.0.0.1:${port}`
      log(`Wrong-origin HTTP server listening on ${origin}`)
      resolve({ server, port, origin })
    })

    server.on('error', (err) => {
      reject(new Error(`HTTP server error: ${err.message}`))
    })
  })
}

function stopWrongOriginServer(wrongOrigin: WrongOriginServer | null): void {
  if (wrongOrigin) {
    try {
      wrongOrigin.server.close()
      log(`Wrong-origin HTTP server stopped (port ${wrongOrigin.port})`)
    } catch {
      /* best effort */
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * IPC multiplexer: single set of listeners, demux by sender.id
 * ══════════════════════════════════════════════════════════════════════════ */

const pendingCases = new Map<number, PendingCase>()
const retainedWindows: RetainedWindow[] = []

let globalRunId = ''
let readyListener: ((event: Electron.IpcMainEvent) => void) | null = null
let resultListener: ((event: Electron.IpcMainEvent, data: unknown) => void) | null = null

function installIpcListeners(): void {
  /* ── READY handler: validate sender, send CONFIG for the registered case ── */
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

  /* ── RESULT handler: validate sender + envelope, resolve case promise ── */
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

    /* Verify identity match */
    if (res.runId !== globalRunId || res.caseId !== caseInfo.caseId || res.requestId !== caseInfo.requestId) {
      log(`RESULT identity mismatch for ${caseInfo.label}`)
      caseInfo.reject(new Error(`Result identity mismatch for ${caseInfo.label}`))
      return
    }

    /* Verify operation matches expected response for the pending request */
    const expectedResponseOp = getExpectedResponseOperation(caseInfo.operation as SpikeOperation)
    if (!expectedResponseOp) {
      log(`RESULT rejected for ${caseInfo.label}: no expected response for request operation "${caseInfo.operation}"`)
      caseInfo.reject(
        new Error(`No expected response operation for request "${caseInfo.operation}" on ${caseInfo.label}`)
      )
      return
    }
    if (res.operation !== expectedResponseOp) {
      log(
        `RESULT operation mismatch for ${caseInfo.label}: ` + `expected "${expectedResponseOp}", got "${res.operation}"`
      )
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
  log('IPC listeners installed (READY + RESULT)')
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
  /* Reject any remaining pending cases */
  for (const [_wcId, caseInfo] of pendingCases) {
    caseInfo.reject(new Error(`Cleanup: case ${caseInfo.label} not settled before shutdown`))
  }
  pendingCases.clear()
  log('IPC listeners removed')
}

/**
 * Register a case for a BrowserWindow. The case promise resolves when
 * the renderer sends a matching RESULT.
 *
 * For READY-triggered cases (first operation on a window):
 *   - Call registerCase BEFORE loadURL
 *   - The READY handler sends CONFIG automatically
 *
 * For direct-send cases (subsequent operations on a retained window):
 *   - Call registerCase, then sendConfigDirectly
 *
 * Uses a single settled guard: timeout, result, and error paths all go
 * through the same settle helper. Only the first settlement wins; the
 * others are silently dropped. The map entry is always cleaned up.
 */
function registerCase(
  win: BrowserWindow,
  label: string,
  operation: string,
  payload?: Record<string, unknown>,
  timeoutMs: number = C2A_CASE_TIMEOUT_MS
): Promise<SpikeResult> {
  return new Promise((resolve, reject) => {
    const caseId = generateCaseId()
    const requestId = generateRequestId()

    /* ── Single settled guard ── */
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

/**
 * Send a CONFIG message directly to a retained window (for subsequent operations).
 * The window must already have an active config listener from the renderer.
 */
function sendConfigDirectly(win: BrowserWindow, operation: string): void {
  const caseInfo = pendingCases.get(win.webContents.id)
  if (!caseInfo) {
    throw new Error(`No pending case for window ${win.webContents.id} when sending ${operation}`)
  }

  const request: SpikeRequest = {
    runId: globalRunId,
    caseId: caseInfo.caseId,
    requestId: caseInfo.requestId,
    operation: operation as SpikeRequest['operation'],
    ...(caseInfo.payload ? { payload: caseInfo.payload } : {})
  }

  win.webContents.send(SPIKE_CHANNELS.CONFIG, request)
  log(`  CONFIG/${operation} sent directly to ${caseInfo.label}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * BrowserWindow factory (retained)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Create a hidden sandboxed BrowserWindow bound to the given session.
 * Installs security restrictions (no navigation, no new windows) and
 * diagnostic handlers (did-fail-load, render-process-gone, unresponsive).
 *
 * Does NOT load a URL — the caller is responsible for loadURL.
 */
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

  /* Security: deny navigation and new windows */
  win.webContents.on('will-navigate', (e) => {
    log(`[${label}] Navigation blocked`)
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => {
    log(`[${label}] New window blocked`)
    return { action: 'deny' }
  })

  /* Diagnostics (will crash the case promise via settle guard if triggered) */
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    log(`[${label}] did-fail-load: code=${errorCode} desc=${errorDescription}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`[${label}] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.on('unresponsive', () => {
    log(`[${label}] Window became unresponsive`)
  })

  /* Capture renderer console messages */
  win.webContents.on('console-message', (_e, level, message) => {
    const prefix = ['verbose', 'info', 'warning', 'error'][level] ?? 'unknown'
    log(`[${label}/${prefix}] ${message}`)
  })

  return win
}

/* ══════════════════════════════════════════════════════════════════════════
 * Profile copy (same as C1)
 * ══════════════════════════════════════════════════════════════════════════ */

function copyProfile(manifest: StagedFixtureManifest, label: string): string {
  if (!validateStagingPath(manifest.destinationRoot, log)) {
    throw new Error(`[${label}] Staged destinationRoot is not a valid owned staging path: ${manifest.destinationRoot}`)
  }

  const caseTmpDir = path.join(os.tmpdir(), `phase4-c2a-${label}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(caseTmpDir, { recursive: true })

  /* Copy IndexedDB directory */
  const stagedIdbDir = path.join(manifest.destinationRoot, 'IndexedDB')
  if (!fs.existsSync(stagedIdbDir)) {
    throw new Error(`[${label}] Staged IndexedDB directory not found: ${stagedIdbDir}`)
  }
  fs.cpSync(stagedIdbDir, path.join(caseTmpDir, 'IndexedDB'), { recursive: true })

  /* Copy Local Storage if present */
  const stagedLsDir = path.join(manifest.destinationRoot, 'Local Storage')
  if (fs.existsSync(stagedLsDir)) {
    fs.cpSync(stagedLsDir, path.join(caseTmpDir, 'Local Storage'), { recursive: true })
  }

  log(`[${label}] Profile copied to ${caseTmpDir}`)
  return caseTmpDir
}

/* ══════════════════════════════════════════════════════════════════════════
 * Main C2a harness
 * ══════════════════════════════════════════════════════════════════════════ */

export async function runC2aVerifier(manifestRootArg: string): Promise<void> {
  globalRunId = generateRunId()

  const ownedRoots: string[] = []

  log('╔══════════════════════════════════════════════════════════════╗')
  log('║  Phase 4.0-C2a Retained-Session Isolation Verifier          ║')
  log('╚══════════════════════════════════════════════════════════════╝')
  log(`runId=${globalRunId}`)
  log(`Electron ${process.versions.electron}, Node ${process.versions.node}, Chrome ${process.versions.chrome}`)

  const manifestRoot = path.resolve(manifestRootArg)
  log(`manifestRoot: ${manifestRoot}`)

  /* ── Validate manifest root ── */
  if (!validateStagingPath(manifestRoot, log)) {
    log(`ERROR: manifestRoot is not under system temp dir: ${manifestRoot}`)
    process.exitCode = 1
    app.quit()
    return
  }
  if (!fs.existsSync(manifestRoot)) {
    log(`ERROR: manifestRoot does not exist: ${manifestRoot}`)
    process.exitCode = 1
    app.quit()
    return
  }

  /* ── Spike-owned userData: unique temp dir, set before app.whenReady ── */
  const spikeUserDataDir = path.join(os.tmpdir(), `phase4-c2a-userdata-${process.pid}-${Date.now()}`)
  fs.mkdirSync(spikeUserDataDir, { recursive: true })
  app.setPath('userData', spikeUserDataDir)
  ownedRoots.push(spikeUserDataDir)
  log(`Spike-owned userData: ${spikeUserDataDir}`)

  /* ── Suppress auto-quit ── */
  await app.whenReady()
  log('app.whenReady() resolved')

  app.on('window-all-closed', () => {
    log('window-all-closed (suppressed for C2a multi-window lifecycle)')
  })

  /* ── Install IPC listeners ── */
  installIpcListeners()

  /* ── Resolve preload path ── */
  const preloadPath = path.join(__dirname, '../preload/phase4-spike-preload.js')
  log(`preload: ${preloadPath}`)

  /* ── Build-time renderer URL ── */
  const rendererHtmlPath = path.join(__dirname, '../renderer/phase4Spike.html')
  const rendererFileUrl = pathToFileURL(rendererHtmlPath).toString()
  log(`renderer (file): ${rendererFileUrl}`)

  /* ── Result tracking ── */
  const caseResults: Record<string, C2aCaseResult> = {}
  let wrongOrigin: WrongOriginServer | null = null

  try {
    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 0: Default-session precheck
     * Verify CherryStudio is absent in the fresh default test profile
     * before any sentinel setup occurs.
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 0: Default-session precheck (CherryStudio absence) ──')

    const precheckWin = createSandboxedWindow(session.defaultSession, preloadPath, 'default-precheck')
    retainedWindows.push({
      label: 'default-precheck',
      window: precheckWin,
      ses: session.defaultSession,
      rootPath: spikeUserDataDir,
      originUrl: rendererFileUrl
    })

    const precheckPromise = registerCase(precheckWin, 'default-precheck', SPIKE_OPERATIONS.ORIGIN_PROBE)
    precheckWin.loadURL(rendererFileUrl).catch((err) => {
      log(`default-precheck loadURL failed: ${(err as Error).message}`)
    })

    const precheckResult = await precheckPromise

    if (precheckResult.status === 'error') {
      throw new Error(`Default-session precheck failed: ${precheckResult.error}`)
    }

    const precheckPayload = precheckResult.payload
    if (precheckPayload?.cherryStudioFound) {
      throw new Error(
        'Default-session precheck FAILED: CherryStudio already present in fresh default test profile. ' +
          `Version: ${precheckPayload.cherryStudioVersion}. Origin: ${precheckPayload.origin}`
      )
    }

    caseResults['default-precheck'] = {
      label: 'default-precheck',
      status: 'PASS',
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
      result: precheckResult,
      diagnostics: {
        cherryStudioFound: precheckPayload?.cherryStudioFound,
        databases: precheckPayload?.databases,
        origin: precheckPayload?.origin
      }
    }
    log(`Default-session precheck PASS: CherryStudio absent (databases: ${JSON.stringify(precheckPayload?.databases)})`)

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 1: Default sentinel setup
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 1: Default sentinel setup ──')

    const sentinelMarker = `${SENTINEL_MARKER_PREFIX}${Date.now()}`
    const sentinelWin = createSandboxedWindow(session.defaultSession, preloadPath, 'sentinel')
    retainedWindows.push({
      label: 'sentinel',
      window: sentinelWin,
      ses: session.defaultSession,
      rootPath: spikeUserDataDir,
      originUrl: rendererFileUrl
    })

    /* Register ISOLATION_SETUP case BEFORE loadURL */
    const sentinelSetupPromise = registerCase(sentinelWin, 'sentinel-setup', SPIKE_OPERATIONS.ISOLATION_SETUP, {
      markerValue: sentinelMarker
    })
    sentinelWin.loadURL(rendererFileUrl).catch((err) => {
      log(`sentinel loadURL failed: ${(err as Error).message}`)
    })

    /* Wait for ISOLATION_SETUP_DONE */
    const sentinelSetupResult = await sentinelSetupPromise

    if (sentinelSetupResult.status !== 'ok') {
      caseResults['sentinel-setup'] = {
        label: 'sentinel-setup',
        status: 'FAIL',
        operation: SPIKE_OPERATIONS.ISOLATION_SETUP,
        result: sentinelSetupResult,
        error: sentinelSetupResult.error ?? 'Sentinel setup returned non-ok status'
      }
      throw new Error(`Sentinel setup failed: ${sentinelSetupResult.error}`)
    }

    caseResults['sentinel-setup'] = {
      label: 'sentinel-setup',
      status: 'PASS',
      operation: SPIKE_OPERATIONS.ISOLATION_SETUP,
      result: sentinelSetupResult,
      diagnostics: {
        sentinelDbName: sentinelSetupResult.payload?.sentinelDbName,
        markerValue: sentinelSetupResult.payload?.markerValue,
        recordCount: sentinelSetupResult.payload?.recordCount,
        roundTripVerified: sentinelSetupResult.payload?.roundTripVerified
      }
    }
    log(
      `Sentinel setup PASS: marker="${sentinelSetupResult.payload?.markerValue}", count=${sentinelSetupResult.payload?.recordCount}`
    )

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 2: Prepare candidate roots and create retained sessions/windows
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 2: Prepare candidates and create retained windows ──')

    /* Read staged manifests for v11a, v11b */
    const requiredFixtures: FixtureId[] = ['v11a', 'v11b']
    const manifests = new Map<FixtureId, StagedFixtureManifest>()

    for (const fixtureId of requiredFixtures) {
      const fixtureDir = path.join(manifestRoot, fixtureId)
      const manifest = readStagedManifest(fixtureDir)
      if (!manifest) {
        throw new Error(`Missing or invalid staged manifest for ${fixtureId} at ${fixtureDir}`)
      }
      manifests.set(fixtureId, manifest)
      log(`  Loaded manifest for ${fixtureId}: native=${manifest.expectedNativeVersion}`)
    }

    /* Copy profiles to new temp dirs */
    const rootA = copyProfile(manifests.get('v11a')!, 'v11a')
    const rootB = copyProfile(manifests.get('v11b')!, 'v11b')
    ownedRoots.push(rootA, rootB)

    /* Create sessions from absolute paths */
    const sesA = session.fromPath(rootA, { cache: false })
    const sesB = session.fromPath(rootB, { cache: false })
    log(`  sessionA created from ${rootA}`)
    log(`  sessionB created from ${rootB}`)

    /* ── Require actual non-empty storage paths from Electron ── */
    /* Canonicalize via fs.realpathSync to resolve any . or .. components */
    const rawStoragePathA = sesA.storagePath
    const rawStoragePathB = sesB.storagePath
    const rawStoragePathDefault = session.defaultSession.storagePath

    if (!rawStoragePathA || rawStoragePathA.length === 0) {
      throw new Error('sessionA.storagePath is empty or undefined — Electron did not return a storage path')
    }
    if (!rawStoragePathB || rawStoragePathB.length === 0) {
      throw new Error('sessionB.storagePath is empty or undefined — Electron did not return a storage path')
    }
    if (!rawStoragePathDefault || rawStoragePathDefault.length === 0) {
      throw new Error('defaultSession.storagePath is empty or undefined — Electron did not return a storage path')
    }

    const storagePathA = path.resolve(rawStoragePathA)
    const storagePathB = path.resolve(rawStoragePathB)
    const storagePathDefault = path.resolve(rawStoragePathDefault)
    const canonicalRootA = path.resolve(rootA)
    const canonicalRootB = path.resolve(rootB)
    const canonicalSpikeUserData = path.resolve(spikeUserDataDir)

    log(`  sessionA.storagePath = ${storagePathA}`)
    log(`  sessionB.storagePath = ${storagePathB}`)
    log(`  defaultSession.storagePath = ${storagePathDefault}`)

    /* ── Assert isPersistent() === true for all sessions ── */
    if (!sesA.isPersistent()) throw new Error('sessionA.isPersistent() returned false — expected true')
    if (!sesB.isPersistent()) throw new Error('sessionB.isPersistent() returned false — expected true')
    if (!session.defaultSession.isPersistent()) {
      throw new Error('defaultSession.isPersistent() returned false — expected true')
    }
    log('  isPersistent(): all sessions report true')

    /* Start HTTP server for wrong-origin */
    wrongOrigin = await startWrongOriginServer()

    /* Create retained windows */
    const windowA = createSandboxedWindow(sesA, preloadPath, 'v11a-correct')
    const windowB = createSandboxedWindow(sesB, preloadPath, 'v11b-correct')
    const windowWrong = createSandboxedWindow(sesA, preloadPath, 'v11a-wrong-origin')

    retainedWindows.push(
      { label: 'v11a-correct', window: windowA, ses: sesA, rootPath: rootA, originUrl: rendererFileUrl },
      { label: 'v11b-correct', window: windowB, ses: sesB, rootPath: rootB, originUrl: rendererFileUrl },
      { label: 'v11a-wrong-origin', window: windowWrong, ses: sesA, rootPath: rootA, originUrl: wrongOrigin.origin }
    )

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 3: Run isolation assertions (all windows alive simultaneously)
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 3: Run isolation assertions (retained, parallel) ──')

    /* Register VERIFY cases for correct-origin windows */
    const verifyA_Promise = registerCase(windowA, 'v11a-correct-verify', SPIKE_OPERATIONS.VERIFY, {
      fixtureId: 'v11a',
      expectedNativeVersion: 110
    })
    const verifyB_Promise = registerCase(windowB, 'v11b-correct-verify', SPIKE_OPERATIONS.VERIFY, {
      fixtureId: 'v11b',
      expectedNativeVersion: 110
    })

    /* Register ORIGIN_PROBE case for wrong-origin window */
    const wrongOriginProbePromise = registerCase(windowWrong, 'v11a-wrong-origin-probe', SPIKE_OPERATIONS.ORIGIN_PROBE)

    /* Load all three simultaneously */
    windowA.loadURL(rendererFileUrl).catch((err) => {
      log(`v11a-correct loadURL failed: ${(err as Error).message}`)
    })
    windowB.loadURL(rendererFileUrl).catch((err) => {
      log(`v11b-correct loadURL failed: ${(err as Error).message}`)
    })
    windowWrong.loadURL(`${wrongOrigin.origin}/`).catch((err) => {
      log(`v11a-wrong-origin loadURL failed: ${(err as Error).message}`)
    })

    /* Wait for all three to complete */
    const [verifyAResult, verifyBResult, wrongOriginProbeResult] = await Promise.all([
      verifyA_Promise,
      verifyB_Promise,
      wrongOriginProbePromise
    ])

    /* ── Validate v11a correct-origin VERIFY ── */
    caseResults['v11a-correct-verify'] = validateV11Verify('v11a-correct-verify', 'v11a', 'A', verifyAResult)
    caseResults['v11b-correct-verify'] = validateV11Verify('v11b-correct-verify', 'v11b', 'B', verifyBResult)

    /* ── Validate wrong-origin ORIGIN_PROBE ── */
    caseResults['v11a-wrong-origin-probe'] = validateWrongOriginProbe(wrongOriginProbeResult)

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 4: Post-probe verification
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 4: Post-probe re-checks ──')

    /* 4a: ORIGIN_PROBE on correct-origin windowA → CherryStudio should still be present */
    const recheckA_Promise = registerCase(windowA, 'v11a-correct-recheck', SPIKE_OPERATIONS.ORIGIN_PROBE)
    sendConfigDirectly(windowA, SPIKE_OPERATIONS.ORIGIN_PROBE)
    const recheckAResult = await recheckA_Promise
    caseResults['v11a-correct-recheck'] = validateCorrectOriginRecheck('v11a-correct-recheck', recheckAResult)

    /* 4b: ORIGIN_PROBE on wrong-origin window → CherryStudio should STILL be absent */
    const recheckWrongPromise = registerCase(windowWrong, 'v11a-wrong-origin-recheck', SPIKE_OPERATIONS.ORIGIN_PROBE)
    sendConfigDirectly(windowWrong, SPIKE_OPERATIONS.ORIGIN_PROBE)
    const recheckWrongResult = await recheckWrongPromise
    caseResults['v11a-wrong-origin-recheck'] = validateWrongOriginRecheck(recheckWrongResult)

    /* 4c: ORIGIN_PROBE on sentinel → sentinel present, CherryStudio absent */
    const sentinelCheckPromise = registerCase(sentinelWin, 'sentinel-check', SPIKE_OPERATIONS.ORIGIN_PROBE)
    sendConfigDirectly(sentinelWin, SPIKE_OPERATIONS.ORIGIN_PROBE)
    const sentinelCheckResult = await sentinelCheckPromise
    caseResults['sentinel-check'] = validateSentinelCheck(sentinelCheckResult, sentinelMarker)

    /* ═══════════════════════════════════════════════════════════════════
     * PHASE 5: Storage path assertions
     * ═══════════════════════════════════════════════════════════════════ */
    log('')
    log('── PHASE 5: Storage path assertions ──')

    const storagePaths: Record<string, string> = {
      defaultSession: storagePathDefault,
      sessionA: storagePathA,
      sessionB: storagePathB
    }

    const pathValidations: string[] = []

    /* Each session must have a distinct storage path */
    const uniquePaths = new Set(Object.values(storagePaths))
    if (uniquePaths.size !== Object.keys(storagePaths).length) {
      pathValidations.push(`Storage paths are not all distinct: ${JSON.stringify(storagePaths)}`)
    }

    /* sessionA storage path must match the copied root (canonicalized) */
    if (storagePathA !== canonicalRootA) {
      pathValidations.push(`sessionA storagePath mismatch: expected ${canonicalRootA}, got ${storagePathA}`)
    }

    /* sessionB storage path must match the copied root (canonicalized) */
    if (storagePathB !== canonicalRootB) {
      pathValidations.push(`sessionB storagePath mismatch: expected ${canonicalRootB}, got ${storagePathB}`)
    }

    /* defaultSession storage path must match spike-owned userData (canonicalized) */
    if (storagePathDefault !== canonicalSpikeUserData) {
      pathValidations.push(
        `defaultSession storagePath mismatch: expected ${canonicalSpikeUserData}, got ${storagePathDefault}`
      )
    }

    /* Candidate sessions must be distinct from defaultSession */
    if (storagePathA === storagePathDefault) {
      pathValidations.push('sessionA storagePath equals defaultSession')
    }
    if (storagePathB === storagePathDefault) {
      pathValidations.push('sessionB storagePath equals defaultSession')
    }

    caseResults['storage-paths'] = {
      label: 'storage-paths',
      status: pathValidations.length === 0 ? 'PASS' : 'FAIL',
      operation: 'ASSERTION',
      diagnostics: { storagePaths, uniquePathCount: uniquePaths.size },
      error: pathValidations.length > 0 ? pathValidations.join('; ') : undefined
    }

    for (const [key, sp] of Object.entries(storagePaths)) {
      log(`  ${key}: ${sp}`)
    }
    if (pathValidations.length > 0) {
      for (const v of pathValidations) {
        log(`  VALIDATION FAIL: ${v}`)
      }
    } else {
      log('  Storage path assertions: PASS')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`C2a HARNESS ERROR: ${msg}`)
    caseResults['harness-error'] = {
      label: 'harness-error',
      status: 'FAIL',
      operation: 'HARNESS',
      error: msg
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * PHASE 6: Emit summary
   * ═══════════════════════════════════════════════════════════════════ */
  log('')
  log('── PHASE 6: Summary ──')

  const allPassed = Object.values(caseResults).every((r) => r.status === 'PASS')

  const summary: C2aSummary = {
    phase: '4.0-C2a',
    runId: globalRunId,
    manifestRoot,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    },
    storagePaths: {},
    originUrls: {},
    cases: caseResults,
    allPassed,
    ownedRoots,
    timestamp: new Date().toISOString()
  }

  /* Collect storage paths and origin URLs from retained windows */
  for (const rw of retainedWindows) {
    const sp = rw.ses?.storagePath
    if (sp && sp.length > 0) {
      summary.storagePaths[rw.label] = path.resolve(sp)
    } else {
      summary.storagePaths[rw.label] = `[UNAVAILABLE: session has no storagePath]`
    }
    summary.originUrls[rw.label] = rw.originUrl
  }

  log('')
  log(JSON.stringify(summary, null, 2))

  if (allPassed) {
    log('')
    log('Phase 4.0-C2a verification: ALL PASS')
    process.exitCode = 0
  } else {
    log('')
    log('Phase 4.0-C2a verification: FAILURES DETECTED')
    process.exitCode = 1
  }

  /* ═══════════════════════════════════════════════════════════════════
   * PHASE 7: Cleanup
   * ═══════════════════════════════════════════════════════════════════ */
  log('')
  log('── PHASE 7: Cleanup ──')

  /* Stop HTTP server */
  stopWrongOriginServer(wrongOrigin)

  /* Close all retained windows (order: candidates first, sentinel last) */
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

  /* Remove IPC listeners */
  removeIpcListeners()

  /* Release session references (do NOT delete roots — parent/C2b handles cleanup) */
  log('')
  log('Owned roots (NOT deleted — parent/C2b handles cleanup):')
  for (const root of ownedRoots) {
    log(`  ${root}`)
  }

  log('')
  log('Initiating orderly shutdown...')
  app.quit()
}

/* ══════════════════════════════════════════════════════════════════════════
 * Validation helpers
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Validate a v11 VERIFY result for isolation.
 * Checks: correct marker present, wrong marker absent, correct fixtureId present,
 * wrong fixtureId absent, production open succeeded.
 *
 * Uses both independent settings values (phase4:marker and phase4:fixtureId)
 * to strengthen A/B isolation assertions.
 */
function validateV11Verify(
  label: string,
  fixtureId: FixtureId,
  expectedMarker: string,
  result: SpikeResult
): C2aCaseResult {
  const errors: string[] = []

  if (result.status === 'error') {
    return {
      label,
      status: 'FAIL',
      operation: SPIKE_OPERATIONS.VERIFY,
      result,
      error: result.error ?? 'VERIFY returned error status'
    }
  }

  const payload = result.payload
  if (!payload) {
    return { label, status: 'FAIL', operation: SPIKE_OPERATIONS.VERIFY, result, error: 'No payload' }
  }

  const preflight = payload.preflight as Record<string, unknown> | undefined
  if (!preflight) errors.push('Missing preflight')
  if (preflight && !preflight.cherryStudioFound) errors.push('CherryStudio not found in preflight')
  if (preflight && preflight.nativeVersion !== 110) errors.push(`Expected native 110, got ${preflight.nativeVersion}`)
  if (!payload.productionOpenerStarted) errors.push('productionOpenerStarted should be true')
  if (!payload.productionOpenerCompleted) errors.push('productionOpenerCompleted should be true')

  const openResult = payload.openResult as Record<string, unknown> | undefined
  if (openResult && openResult.logicalVerno !== 11) errors.push(`Expected logical 11, got ${openResult.logicalVerno}`)

  const v11Assertions = payload.v11Assertions as Record<string, unknown> | undefined
  if (!v11Assertions) {
    errors.push('Missing v11Assertions')
  } else {
    /* ── Assert phase4:marker ── */
    if (v11Assertions.markerValue !== expectedMarker) {
      errors.push(`Expected marker "${expectedMarker}", got "${v11Assertions.markerValue}"`)
    }
    /* ── Assert phase4:fixtureId ── */
    if (v11Assertions.fixtureIdValue !== fixtureId) {
      errors.push(`Expected fixtureId "${fixtureId}", got "${v11Assertions.fixtureIdValue}"`)
    }

    /* ── Cross-contamination: explicit wrong-identifier assertions ── */
    const wrongMarker = expectedMarker === 'A' ? 'B' : 'A'
    const wrongFixtureId = fixtureId === 'v11a' ? 'v11b' : 'v11a'

    /* A must NOT observe B's marker, and B must NOT observe A's marker */
    if (v11Assertions.markerValue === wrongMarker) {
      errors.push(`Cross-contamination: ${label} observed wrong marker "${wrongMarker}" (expected "${expectedMarker}")`)
    }
    /* A must NOT observe B's fixtureId, and B must NOT observe A's fixtureId */
    if (v11Assertions.fixtureIdValue === wrongFixtureId) {
      errors.push(
        `Cross-contamination: ${label} observed wrong fixtureId "${wrongFixtureId}" (expected "${fixtureId}")`
      )
    }
  }

  const status = errors.length === 0 ? 'PASS' : 'FAIL'
  log(
    `  ${label}: ${status} (marker=${expectedMarker}, fixtureId=${fixtureId})${errors.length > 0 ? ' — ' + errors.join('; ') : ''}`
  )

  return {
    label,
    status,
    operation: SPIKE_OPERATIONS.VERIFY,
    result,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    diagnostics: {
      fixtureId,
      expectedMarker,
      wrongMarker: expectedMarker === 'A' ? 'B' : 'A',
      wrongFixtureId: fixtureId === 'v11a' ? 'v11b' : 'v11a',
      markerValue: v11Assertions?.markerValue,
      fixtureIdValue: v11Assertions?.fixtureIdValue,
      nativeVersion: preflight?.nativeVersion,
      logicalVerno: openResult?.logicalVerno
    }
  }
}

/**
 * Validate wrong-origin ORIGIN_PROBE: CherryStudio must be ABSENT.
 */
function validateWrongOriginProbe(result: SpikeResult): C2aCaseResult {
  const errors: string[] = []

  if (result.status === 'error') {
    return {
      label: 'v11a-wrong-origin-probe',
      status: 'FAIL',
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
      result,
      error: `Wrong-origin probe failed: ${result.error}`
    }
  }

  const payload = result.payload
  if (!payload) {
    return {
      label: 'v11a-wrong-origin-probe',
      status: 'FAIL',
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
      result,
      error: 'No payload'
    }
  }

  if (payload.cherryStudioFound) {
    errors.push(
      `CherryStudio unexpectedly FOUND at wrong origin. ` +
        `Version: ${payload.cherryStudioVersion}. Origin: ${payload.origin}`
    )
  }

  /* The origin must NOT be file:// (must be the HTTP origin) */
  if (payload.origin === 'file://') {
    errors.push(`Wrong-origin window loaded from file:// instead of HTTP origin`)
  }

  const status = errors.length === 0 ? 'PASS' : 'FAIL'
  log(`  v11a-wrong-origin-probe: ${status} (cherryStudio=${payload.cherryStudioFound}, origin=${payload.origin})`)

  return {
    label: 'v11a-wrong-origin-probe',
    status,
    operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
    result,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    diagnostics: {
      cherryStudioFound: payload.cherryStudioFound,
      origin: payload.origin,
      href: payload.href,
      databases: payload.databases
    }
  }
}

/**
 * Validate correct-origin re-check: CherryStudio must be PRESENT.
 */
function validateCorrectOriginRecheck(label: string, result: SpikeResult): C2aCaseResult {
  const errors: string[] = []

  if (result.status === 'error') {
    return {
      label,
      status: 'FAIL',
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
      result,
      error: `Re-check failed: ${result.error}`
    }
  }

  const payload = result.payload
  if (!payload) {
    return { label, status: 'FAIL', operation: SPIKE_OPERATIONS.ORIGIN_PROBE, result, error: 'No payload' }
  }

  if (!payload.cherryStudioFound) {
    errors.push('CherryStudio NOT found at correct origin after wrong-origin probe')
  }

  if (payload.origin !== 'file://') {
    errors.push(`Expected file:// origin, got ${payload.origin}`)
  }

  const status = errors.length === 0 ? 'PASS' : 'FAIL'
  log(`  ${label}: ${status} (cherryStudio=${payload.cherryStudioFound}, origin=${payload.origin})`)

  return {
    label,
    status,
    operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
    result,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    diagnostics: {
      cherryStudioFound: payload.cherryStudioFound,
      cherryStudioVersion: payload.cherryStudioVersion,
      origin: payload.origin
    }
  }
}

/**
 * Validate wrong-origin re-check: CherryStudio must STILL be ABSENT.
 */
function validateWrongOriginRecheck(result: SpikeResult): C2aCaseResult {
  const label = 'v11a-wrong-origin-recheck'
  const errors: string[] = []

  if (result.status === 'error') {
    return {
      label,
      status: 'FAIL',
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
      result,
      error: `Wrong-origin re-check failed: ${result.error}`
    }
  }

  const payload = result.payload
  if (!payload) {
    return { label, status: 'FAIL', operation: SPIKE_OPERATIONS.ORIGIN_PROBE, result, error: 'No payload' }
  }

  if (payload.cherryStudioFound) {
    errors.push(
      `CherryStudio found at wrong origin after re-check. ` +
        `Version: ${payload.cherryStudioVersion}. This indicates the probe created an empty DB.`
    )
  }

  const status = errors.length === 0 ? 'PASS' : 'FAIL'
  log(`  ${label}: ${status} (cherryStudio=${payload.cherryStudioFound})`)

  return {
    label,
    status,
    operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
    result,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    diagnostics: { cherryStudioFound: payload.cherryStudioFound, origin: payload.origin }
  }
}

/**
 * Validate sentinel check: sentinel present, CherryStudio absent.
 */
function validateSentinelCheck(result: SpikeResult, _expectedMarker: string): C2aCaseResult {
  const label = 'sentinel-check'
  const errors: string[] = []

  if (result.status === 'error') {
    return {
      label,
      status: 'FAIL',
      operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
      result,
      error: `Sentinel check failed: ${result.error}`
    }
  }

  const payload = result.payload
  if (!payload) {
    return { label, status: 'FAIL', operation: SPIKE_OPERATIONS.ORIGIN_PROBE, result, error: 'No payload' }
  }

  if (!payload.sentinelFound) {
    errors.push('Sentinel DB NOT found in default session after all cases')
  }
  if (payload.cherryStudioFound) {
    errors.push(
      `CherryStudio found in default session — contamination detected. Version: ${payload.cherryStudioVersion}`
    )
  }

  const status = errors.length === 0 ? 'PASS' : 'FAIL'
  log(`  ${label}: ${status} (sentinel=${payload.sentinelFound}, cherryStudio=${payload.cherryStudioFound})`)

  return {
    label,
    status,
    operation: SPIKE_OPERATIONS.ORIGIN_PROBE,
    result,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    diagnostics: {
      sentinelFound: payload.sentinelFound,
      cherryStudioFound: payload.cherryStudioFound,
      origin: payload.origin
    }
  }
}
