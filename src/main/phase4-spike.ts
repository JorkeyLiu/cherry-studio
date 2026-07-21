/**
 * Phase 4.0-A/B/C1 Spike Main Harness
 *
 * TEST/FEASIBILITY-ONLY. Not referenced by any production entry point.
 * Retained through Phase 4.1 as reproducibility harness.
 *
 * Minimal Electron harness that:
 *  Phase A: one READY → CONFIG/PING → RESULT round trip (preserved)
 *  Phase B: one READY → CONFIG/FIXTURE_GENERATE → RESULT/FIXTURE_DONE round trip
 *  Phase C1: production-Dexie source reader verification against staged fixtures
 *
 * Both modes:
 *  - Create isolated test userData + session.fromPath()
 *  - Open one hidden sandboxed BrowserWindow with the spike preload
 *  - Print machine-readable summary
 *  - Exit via app.quit() (no process.exit)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildFixtureManifest,
  type FixtureDonePayload,
  type FixtureFileEntry,
  type FixtureGeneratePayload,
  type FixtureId,
  type FixtureManifest,
  isValidFixtureId,
  type StagedFixtureManifest,
  validateFixtureDonePayload,
  validateFixtureManifest,
  validateTempPath,
  type VerifyDonePayload
} from '@shared/phase4FixtureManifest'
import {
  generateCaseId,
  generateRequestId,
  generateRunId,
  SPIKE_CHANNELS,
  SPIKE_OPERATIONS,
  type SpikeRequest,
  type SpikeResult,
  validateSpikeResult
} from '@shared/phase4SpikeContract'
import { app, BrowserWindow, ipcMain, session } from 'electron'

import { validateStagingPath } from './phase4-path-validation'

/* ── Constants ── */

const HARNESS_TIMEOUT_MS = 30_000

/* ── Logging ── */

function log(msg: string): void {
  console.log(`[phase4-spike] ${msg}`)
}

/* ── Harness state ── */

interface HarnessState {
  runId: string
  caseId: string
  requestId: string
  userDataDir: string
  sessionDir: string
  window: BrowserWindow | null
  ses: Electron.Session | null
  readyListener: ((event: Electron.IpcMainEvent) => void) | null
  resultListener: ((event: Electron.IpcMainEvent, data: unknown) => void) | null
  settled: boolean
  cleanupDone: boolean
}

/* ── Cleanup: exact listener removal, window destroy, no removeAllListeners ── */

function cleanup(state: HarnessState): void {
  if (state.cleanupDone) return
  state.cleanupDone = true

  if (state.readyListener) {
    ipcMain.removeListener(SPIKE_CHANNELS.READY, state.readyListener)
    state.readyListener = null
  }
  if (state.resultListener) {
    ipcMain.removeListener(SPIKE_CHANNELS.RESULT, state.resultListener)
    state.resultListener = null
  }

  if (state.window && !state.window.isDestroyed()) {
    try {
      state.window.destroy()
    } catch {
      /* best effort */
    }
    state.window = null
  }

  // Session reference released; do NOT delete session roots here.
  // The parent (if any) may clean up after Electron exits.
  state.ses = null
}

/* ── Settle guard ── */

function trySettle(state: HarnessState, timer: ReturnType<typeof setTimeout>, fn: () => void): void {
  if (state.settled) return
  state.settled = true
  clearTimeout(timer)
  fn()
}

/* ── Main harness ── */

async function runHarness(): Promise<void> {
  /* ── Identity ── */
  const runId = generateRunId()
  const caseId = generateCaseId()
  const requestId = generateRequestId()

  log('╔══════════════════════════════════════════════════════╗')
  log('║  Phase 4.0-A Spike Harness                          ║')
  log('╚══════════════════════════════════════════════════════╝')
  log(`runId=${runId}`)
  log(`caseId=${caseId}`)
  log(`requestId=${requestId}`)
  log(`Electron ${process.versions.electron}, Node ${process.versions.node}, Chrome ${process.versions.chrome}`)

  /* ── Isolated userData ── */
  const userDataDir = path.join(os.tmpdir(), `phase4-spike-${process.pid}-${Date.now()}`)
  const sessionDir = path.join(userDataDir, 'spike-session')
  fs.mkdirSync(sessionDir, { recursive: true })
  app.setPath('userData', userDataDir)
  log(`userData: ${userDataDir}`)
  log(`sessionDir: ${sessionDir}`)

  await app.whenReady()
  log('app.whenReady() resolved')

  /* ── State ── */
  const state: HarnessState = {
    runId,
    caseId,
    requestId,
    userDataDir,
    sessionDir,
    window: null,
    ses: null,
    readyListener: null,
    resultListener: null,
    settled: false,
    cleanupDone: false
  }

  /* ── Round trip ── */
  const result = await new Promise<SpikeResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`Harness timeout after ${HARNESS_TIMEOUT_MS}ms`))
      })
    }, HARNESS_TIMEOUT_MS)

    /* ── Create isolated session ── */
    state.ses = session.fromPath(sessionDir, { cache: false })
    log(`Session created: ${sessionDir}`)

    /* ── Resolve paths ── */
    const preloadPath = path.join(__dirname, '../preload/phase4-spike-preload.js')
    const rendererHtmlPath = path.join(__dirname, '../renderer/phase4Spike.html')
    log(`preload: ${preloadPath}`)
    log(`renderer: ${rendererHtmlPath}`)

    /* ── Hidden sandboxed window ── */
    state.window = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      webPreferences: {
        session: state.ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: preloadPath
      }
    })
    log('BrowserWindow created (hidden, sandboxed)')

    /* ── Security: deny navigation and new windows ── */
    state.window.webContents.on('will-navigate', (e) => {
      log('Navigation blocked')
      e.preventDefault()
    })
    state.window.webContents.setWindowOpenHandler(() => {
      log('New window blocked')
      return { action: 'deny' }
    })

    /* ── Diagnostics ── */
    state.window.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`did-fail-load: code=${errorCode} desc=${errorDescription}`))
      })
    })

    state.window.webContents.on('render-process-gone', (_e, details) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`))
      })
    })

    state.window.on('unresponsive', () => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error('Window became unresponsive'))
      })
    })

    state.window.on('closed', () => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error('Window closed unexpectedly before result'))
      })
    })

    /* ── Capture renderer console messages ── */
    state.window.webContents.on('console-message', (_e, level, message) => {
      const prefix = ['verbose', 'info', 'warning', 'error'][level] ?? 'unknown'
      log(`[renderer/${prefix}] ${message}`)
    })

    /* ── READY handler: validate sender webContents.id ── */
    state.readyListener = (event) => {
      if (!state.window || event.sender.id !== state.window.webContents.id) {
        log(`READY rejected: unknown sender id=${event.sender.id}`)
        return
      }

      log('READY received (sender validated)')

      /* Send CONFIG/PING */
      const request: SpikeRequest = {
        runId: state.runId,
        caseId: state.caseId,
        requestId: state.requestId,
        operation: SPIKE_OPERATIONS.PING,
        payload: {
          message: 'Phase 4.0-A PING',
          timestamp: Date.now(),
          versions: {
            electron: process.versions.electron,
            node: process.versions.node,
            chrome: process.versions.chrome
          }
        }
      }

      try {
        state.window.webContents.send(SPIKE_CHANNELS.CONFIG, request)
        log('CONFIG/PING sent')
      } catch (err) {
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error(`Failed to send CONFIG: ${(err as Error).message}`))
        })
      }
    }

    /* ── RESULT handler: validate sender + full envelope ── */
    state.resultListener = (event, data) => {
      if (!state.window || event.sender.id !== state.window.webContents.id) {
        log(`RESULT rejected: unknown sender id=${event.sender.id}`)
        return
      }

      const validation = validateSpikeResult(data)
      if (!validation.valid) {
        log(`RESULT rejected: ${validation.error}`)
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error(`Invalid result envelope: ${validation.error}`))
        })
        return
      }

      const res = data as SpikeResult

      /* Verify identity match */
      if (res.runId !== state.runId || res.caseId !== state.caseId || res.requestId !== state.requestId) {
        log('RESULT rejected: identity mismatch')
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error('Result identity mismatch'))
        })
        return
      }

      log(`RESULT received: status=${res.status}, operation=${res.operation}`)
      trySettle(state, timer, () => {
        cleanup(state)
        resolve(res)
      })
    }

    /* ── Install exact listener functions ── */
    ipcMain.on(SPIKE_CHANNELS.READY, state.readyListener)
    ipcMain.on(SPIKE_CHANNELS.RESULT, state.resultListener)

    /* ── Load renderer via file:// URL ── */
    const rendererUrl = pathToFileURL(rendererHtmlPath)
    log(`Loading renderer: ${rendererUrl.toString()}`)

    state.window.loadURL(rendererUrl.toString()).catch((err) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`loadURL failed: ${(err as Error).message}`))
      })
    })
  })

  /* ── Report ── */
  log('')
  log('╔══════════════════════════════════════════════════════╗')
  log('║  Result                                              ║')
  log('╚══════════════════════════════════════════════════════╝')

  const summary = {
    phase: '4.0-A',
    status: result.status,
    runId: result.runId,
    caseId: result.caseId,
    requestId: result.requestId,
    operation: result.operation,
    payload: result.payload ?? null,
    error: result.error ?? null,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    },
    userDataDir: state.userDataDir,
    sessionDir: state.sessionDir
  }

  log(JSON.stringify(summary, null, 2))

  if (result.status === 'ok') {
    log('')
    log('Phase 4.0-A spike: PASS')
    process.exitCode = 0
  } else {
    log('')
    log(`Phase 4.0-A spike: FAIL (status=${result.status})`)
    if (result.error) log(`  error: ${result.error}`)
    process.exitCode = 1
  }

  /* ── Orderly shutdown: close/destroy, then app.quit() ── */
  log('Initiating orderly shutdown...')
  cleanup(state)
  app.quit()
}

/* ── Exported entry ── */

export async function runSpike(): Promise<void> {
  try {
    await runHarness()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Spike FAILED: ${msg}`)

    // Print machine-readable failure summary
    const summary = {
      phase: '4.0-A',
      status: 'FAIL',
      error: msg,
      versions: {
        electron: process.versions.electron ?? 'N/A',
        node: process.versions.node ?? 'N/A',
        chrome: process.versions.chrome ?? 'N/A'
      }
    }
    log(JSON.stringify(summary, null, 2))

    process.exitCode = 1
    // Orderly shutdown — no process.exit()
    app.quit()
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Phase 4.0-B: Fixture Generation Mode
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── File inventory builder ── */

function buildFileInventory(dir: string, prefix = ''): FixtureFileEntry[] {
  const result: FixtureFileEntry[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push(...buildFileInventory(fullPath, relPath))
    } else {
      result.push({ relativePath: relPath, sizeBytes: fs.statSync(fullPath).size })
    }
  }
  return result
}

const FIXTURE_TIMEOUT_MS = 60_000

/* ── Main fixture harness ── */

async function runFixtureHarness(fixtureId: FixtureId): Promise<FixtureManifest> {
  const runId = generateRunId()
  const caseId = generateCaseId()
  const requestId = generateRequestId()

  log('╔══════════════════════════════════════════════════════╗')
  log('║  Phase 4.0-B Fixture Harness                        ║')
  log('╚══════════════════════════════════════════════════════╝')
  log(`fixtureId=${fixtureId}`)
  log(`runId=${runId}`)
  log(`caseId=${caseId}`)
  log(`requestId=${requestId}`)
  log(`Electron ${process.versions.electron}, Node ${process.versions.node}, Chrome ${process.versions.chrome}`)

  /* ── Isolated userData ── */
  const userDataDir = path.join(os.tmpdir(), `phase4-fixture-${fixtureId}-${process.pid}-${Date.now()}`)
  const sessionDir = path.join(userDataDir, 'fixture-session')
  fs.mkdirSync(sessionDir, { recursive: true })
  app.setPath('userData', userDataDir)
  log(`userData: ${userDataDir}`)
  log(`sessionDir: ${sessionDir}`)

  await app.whenReady()
  log('app.whenReady() resolved')

  /* ── State ── */
  const state: HarnessState = {
    runId,
    caseId,
    requestId,
    userDataDir,
    sessionDir,
    window: null,
    ses: null,
    readyListener: null,
    resultListener: null,
    settled: false,
    cleanupDone: false
  }

  /* ── Round trip ── */
  const result = await new Promise<SpikeResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`Fixture harness timeout after ${FIXTURE_TIMEOUT_MS}ms`))
      })
    }, FIXTURE_TIMEOUT_MS)

    /* ── Create isolated session ── */
    state.ses = session.fromPath(sessionDir, { cache: false })
    log(`Session created: ${sessionDir}`)

    /* ── Resolve paths ── */
    const preloadPath = path.join(__dirname, '../preload/phase4-spike-preload.js')
    const rendererHtmlPath = path.join(__dirname, '../renderer/phase4Spike.html')
    log(`preload: ${preloadPath}`)
    log(`renderer: ${rendererHtmlPath}`)

    /* ── Hidden sandboxed window ── */
    state.window = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      webPreferences: {
        session: state.ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: preloadPath
      }
    })
    log('BrowserWindow created (hidden, sandboxed)')

    /* ── Security: deny navigation and new windows ── */
    state.window.webContents.on('will-navigate', (e) => {
      log('Navigation blocked')
      e.preventDefault()
    })
    state.window.webContents.setWindowOpenHandler(() => {
      log('New window blocked')
      return { action: 'deny' }
    })

    /* ── Diagnostics ── */
    state.window.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`did-fail-load: code=${errorCode} desc=${errorDescription}`))
      })
    })

    state.window.webContents.on('render-process-gone', (_e, details) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`))
      })
    })

    state.window.on('unresponsive', () => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error('Window became unresponsive'))
      })
    })

    state.window.on('closed', () => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error('Window closed unexpectedly before result'))
      })
    })

    /* ── Capture renderer console messages ── */
    state.window.webContents.on('console-message', (_e, level, message) => {
      const prefix = ['verbose', 'info', 'warning', 'error'][level] ?? 'unknown'
      log(`[renderer/${prefix}] ${message}`)
    })

    /* ── READY handler ── */
    state.readyListener = (event) => {
      if (!state.window || event.sender.id !== state.window.webContents.id) {
        log(`READY rejected: unknown sender id=${event.sender.id}`)
        return
      }

      log('READY received (sender validated)')

      /* Send CONFIG/FIXTURE_GENERATE */
      const payload: FixtureGeneratePayload = {
        fixtureId,
        databaseName: 'CherryStudio'
      }
      const request: SpikeRequest = {
        runId: state.runId,
        caseId: state.caseId,
        requestId: state.requestId,
        operation: SPIKE_OPERATIONS.FIXTURE_GENERATE,
        payload: payload as unknown as Record<string, unknown>
      }

      try {
        state.window.webContents.send(SPIKE_CHANNELS.CONFIG, request)
        log(`CONFIG/FIXTURE_GENERATE sent (fixtureId=${fixtureId})`)
      } catch (err) {
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error(`Failed to send CONFIG: ${(err as Error).message}`))
        })
      }
    }

    /* ── RESULT handler ── */
    state.resultListener = (event, data) => {
      if (!state.window || event.sender.id !== state.window.webContents.id) {
        log(`RESULT rejected: unknown sender id=${event.sender.id}`)
        return
      }

      const validation = validateSpikeResult(data)
      if (!validation.valid) {
        log(`RESULT rejected: ${validation.error}`)
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error(`Invalid result envelope: ${validation.error}`))
        })
        return
      }

      const res = data as SpikeResult

      /* Verify identity match */
      if (res.runId !== state.runId || res.caseId !== state.caseId || res.requestId !== state.requestId) {
        log('RESULT rejected: identity mismatch')
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error('Result identity mismatch'))
        })
        return
      }

      log(`RESULT received: status=${res.status}, operation=${res.operation}`)
      trySettle(state, timer, () => {
        cleanup(state)
        resolve(res)
      })
    }

    /* ── Install listeners ── */
    ipcMain.on(SPIKE_CHANNELS.READY, state.readyListener)
    ipcMain.on(SPIKE_CHANNELS.RESULT, state.resultListener)

    /* ── Load renderer ── */
    const rendererUrl = pathToFileURL(rendererHtmlPath)
    log(`Loading renderer: ${rendererUrl.toString()}`)

    state.window.loadURL(rendererUrl.toString()).catch((err) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`loadURL failed: ${(err as Error).message}`))
      })
    })
  })

  /* ── Process result ── */
  if (result.status !== 'ok') {
    throw new Error(`Fixture generation failed: ${result.error ?? 'unknown error'}`)
  }

  /* ── Validate renderer payload ── */
  const payloadValidation = validateFixtureDonePayload(result.payload)
  if (!payloadValidation.valid) {
    throw new Error(`Invalid fixture payload: ${payloadValidation.error}`)
  }

  const fixturePayload = result.payload as unknown as FixtureDonePayload

  /* ── Build file inventory ── */
  const tmpValidation = validateTempPath(sessionDir, os.tmpdir())
  if (!tmpValidation.valid) {
    throw new Error(`Session dir not in tmpdir: ${tmpValidation.error}`)
  }

  const fileInventory = buildFileInventory(sessionDir)

  /* ── Build manifest ── */
  const rendererUrl = pathToFileURL(path.join(__dirname, '../renderer/phase4Spike.html'))
  const manifest = buildFixtureManifest(fixturePayload, sessionDir, rendererUrl.toString(), fileInventory)

  /* ── Emit manifest ── */
  log('')
  log('╔══════════════════════════════════════════════════════╗')
  log('║  Fixture Result                                      ║')
  log('╚══════════════════════════════════════════════════════╝')
  log(`fixtureId=${manifest.fixtureId}`)
  log(`logicalDexieVersion=${manifest.logicalDexieVersion}`)
  log(`observedNativeVersion=${manifest.observedNativeVersion}`)
  log(`tables=${manifest.tables.join(', ')}`)
  log(`recordCounts=${JSON.stringify(manifest.recordCounts)}`)
  log(`sourceRoot=${manifest.sourceRoot}`)
  log(`files=${manifest.files.length} entries`)

  return manifest
}

/* ── Exported entry ── */

export async function runFixture(fixtureId: string): Promise<void> {
  if (!isValidFixtureId(fixtureId)) {
    log(`ERROR: Invalid fixtureId: ${fixtureId}`)
    log(`Valid IDs: v4, v11a, v11b, v12`)
    process.exitCode = 1
    app.quit()
    return
  }

  try {
    const manifest = await runFixtureHarness(fixtureId)

    // Print machine-readable manifest DIRECTLY (not through log() which adds prefix).
    // The staging script parses this via grep.
    console.log(`[phase4-spike-manifest] ${JSON.stringify(manifest)}`)
    log('')
    log(`Phase 4.0-B fixture ${fixtureId}: PASS`)

    process.exitCode = 0
    app.quit()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Fixture FAILED: ${msg}`)

    const summary = {
      phase: '4.0-B',
      status: 'FAIL',
      fixtureId,
      error: msg,
      versions: {
        electron: process.versions.electron ?? 'N/A',
        node: process.versions.node ?? 'N/A',
        chrome: process.versions.chrome ?? 'N/A'
      }
    }
    log(JSON.stringify(summary, null, 2))

    process.exitCode = 1
    app.quit()
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Phase 4.0-C1: Verify Mode
 *
 * Reads staged fixture manifests, mounts each profile via session.fromPath(),
 * and verifies production Dexie declaration/upgrades against the pre-populated
 * fixture data. Reports machine-readable per-case results.
 * ══════════════════════════════════════════════════════════════════════════ */

const VERIFY_CASE_TIMEOUT_MS = 60_000
const VERIFY_EXPECTED_FIXTURES: FixtureId[] = ['v4', 'v11a', 'v11b', 'v12']

/**
 * Read a staged manifest from a fixture directory.
 * Returns null if the manifest is missing or invalid.
 */
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

/**
 * Run a single VERIFY case against a staged fixture.
 * Creates a new temp dir, copies the profile, mounts via session.fromPath(),
 * and runs the full verify round trip.
 */
async function runVerifyCase(fixtureId: FixtureId, manifest: StagedFixtureManifest): Promise<VerifyDonePayload> {
  const runId = generateRunId()
  const caseId = generateCaseId()
  const requestId = generateRequestId()

  log(`  ┌─ Case ${fixtureId}: runId=${runId}`)
  log(`  │  sourceRoot=${manifest.sourceRoot}`)
  log(`  │  expectedNative=${manifest.expectedNativeVersion}`)

  /* ── Validate destinationRoot before using it as copy source ── */
  if (!validateStagingPath(manifest.destinationRoot, log)) {
    throw new Error(`Staged destinationRoot is not a valid owned staging path: ${manifest.destinationRoot}`)
  }

  /* ── Copy profile to a new temp dir (non-destructive) ── */
  const caseTmpDir = path.join(os.tmpdir(), `phase4-verify-${fixtureId}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(caseTmpDir, { recursive: true })

  // Copy the IndexedDB directory from the staged fixture
  const stagedIdbDir = path.join(manifest.destinationRoot, 'IndexedDB')
  if (!fs.existsSync(stagedIdbDir)) {
    throw new Error(`Staged IndexedDB directory not found: ${stagedIdbDir}`)
  }
  fs.cpSync(stagedIdbDir, path.join(caseTmpDir, 'IndexedDB'), { recursive: true })

  // Copy Local Storage if present
  const stagedLsDir = path.join(manifest.destinationRoot, 'Local Storage')
  if (fs.existsSync(stagedLsDir)) {
    fs.cpSync(stagedLsDir, path.join(caseTmpDir, 'Local Storage'), { recursive: true })
  }

  log(`  │  profile copied to ${caseTmpDir}`)

  /* ── Validate temp path ── */
  if (!validateTempPath(caseTmpDir, os.tmpdir())) {
    throw new Error(`Case temp dir not in tmpdir: ${caseTmpDir}`)
  }

  /* ── Harness state for this case ── */
  const state: HarnessState = {
    runId,
    caseId,
    requestId,
    userDataDir: caseTmpDir,
    sessionDir: caseTmpDir,
    window: null,
    ses: null,
    readyListener: null,
    resultListener: null,
    settled: false,
    cleanupDone: false
  }

  /* ── Round trip ── */
  const result = await new Promise<SpikeResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`Case ${fixtureId} timeout after ${VERIFY_CASE_TIMEOUT_MS}ms`))
      })
    }, VERIFY_CASE_TIMEOUT_MS)

    /* ── Create session from the copied profile ── */
    state.ses = session.fromPath(caseTmpDir, { cache: false })
    log(`  │  Session created: ${caseTmpDir}`)

    /* ── Resolve paths ── */
    const preloadPath = path.join(__dirname, '../preload/phase4-spike-preload.js')
    const rendererHtmlPath = path.join(__dirname, '../renderer/phase4Spike.html')

    /* ── Hidden sandboxed window ── */
    state.window = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      webPreferences: {
        session: state.ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: preloadPath
      }
    })

    /* ── Security ── */
    state.window.webContents.on('will-navigate', (e) => e.preventDefault())
    state.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    /* ── Diagnostics ── */
    state.window.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`did-fail-load: code=${errorCode} desc=${errorDescription}`))
      })
    })

    state.window.webContents.on('render-process-gone', (_e, details) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`))
      })
    })

    state.window.on('unresponsive', () => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error('Window became unresponsive'))
      })
    })

    state.window.on('closed', () => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error('Window closed unexpectedly before result'))
      })
    })

    state.window.webContents.on('console-message', (_e, level, message) => {
      const prefix = ['verbose', 'info', 'warning', 'error'][level] ?? 'unknown'
      log(`  │  [renderer/${prefix}] ${message}`)
    })

    /* ── READY handler ── */
    state.readyListener = (event) => {
      if (!state.window || event.sender.id !== state.window.webContents.id) {
        log(`  │  READY rejected: unknown sender id=${event.sender.id}`)
        return
      }

      log('  │  READY received (sender validated)')

      /* Send CONFIG/VERIFY */
      const request: SpikeRequest = {
        runId: state.runId,
        caseId: state.caseId,
        requestId: state.requestId,
        operation: SPIKE_OPERATIONS.VERIFY,
        payload: {
          fixtureId,
          expectedNativeVersion: manifest.expectedNativeVersion
        }
      }

      try {
        state.window.webContents.send(SPIKE_CHANNELS.CONFIG, request)
        log(`  │  CONFIG/VERIFY sent (fixtureId=${fixtureId})`)
      } catch (err) {
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error(`Failed to send CONFIG: ${(err as Error).message}`))
        })
      }
    }

    /* ── RESULT handler ── */
    state.resultListener = (event, data) => {
      if (!state.window || event.sender.id !== state.window.webContents.id) {
        log(`  │  RESULT rejected: unknown sender id=${event.sender.id}`)
        return
      }

      const validation = validateSpikeResult(data)
      if (!validation.valid) {
        log(`  │  RESULT rejected: ${validation.error}`)
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error(`Invalid result envelope: ${validation.error}`))
        })
        return
      }

      const res = data as SpikeResult

      if (res.runId !== state.runId || res.caseId !== state.caseId || res.requestId !== state.requestId) {
        log('  │  RESULT rejected: identity mismatch')
        trySettle(state, timer, () => {
          cleanup(state)
          reject(new Error('Result identity mismatch'))
        })
        return
      }

      log(`  │  RESULT received: status=${res.status}, operation=${res.operation}`)
      trySettle(state, timer, () => {
        cleanup(state)
        resolve(res)
      })
    }

    /* ── Install listeners ── */
    ipcMain.on(SPIKE_CHANNELS.READY, state.readyListener)
    ipcMain.on(SPIKE_CHANNELS.RESULT, state.resultListener)

    /* ── Load renderer ── */
    const rendererUrl = pathToFileURL(rendererHtmlPath)
    log(`  │  Loading renderer: ${rendererUrl.toString()}`)

    state.window.loadURL(rendererUrl.toString()).catch((err) => {
      trySettle(state, timer, () => {
        cleanup(state)
        reject(new Error(`loadURL failed: ${(err as Error).message}`))
      })
    })
  })

  /* ── Clean up temp dir ── */
  try {
    fs.rmSync(caseTmpDir, { recursive: true, force: true })
  } catch {
    // best effort
  }

  /* ── Extract payload ── */
  if (result.status === 'error' && !result.payload) {
    throw new Error(`Case ${fixtureId} error: ${result.error ?? 'unknown'}`)
  }

  const verifyPayload = result.payload as unknown as VerifyDonePayload | undefined
  if (!verifyPayload) {
    throw new Error(`Case ${fixtureId}: no payload in result`)
  }

  log(`  └─ Case ${fixtureId}: status=${result.status}`)
  return verifyPayload
}

/**
 * Run the full C1 verifier against staged fixtures.
 *
 * Accepts a manifest root path containing fixture subdirectories.
 * Reads staged-manifest.json from each, runs VERIFY round trips,
 * and emits machine-readable summary.
 */
export async function runVerifier(manifestRootArg: string): Promise<void> {
  log('╔══════════════════════════════════════════════════════════╗')
  log('║  Phase 4.0-C1 Verification Harness                      ║')
  log('╚══════════════════════════════════════════════════════════╝')

  const manifestRoot = path.resolve(manifestRootArg)
  log(`manifestRoot: ${manifestRoot}`)

  /* ── Validate manifest root is a staging path ── */
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

  await app.whenReady()
  log('app.whenReady() resolved')

  /* ── Prevent auto-quit when all windows are destroyed between cases ── */
  app.on('window-all-closed', () => {
    // Do NOT auto-quit. The verifier manages lifecycle manually.
    // app.quit() is called explicitly after all cases complete.
    log('window-all-closed (suppressed for multi-case lifecycle)')
  })

  /* ── Load manifests for all expected fixtures ── */
  const manifests: Map<FixtureId, StagedFixtureManifest> = new Map()
  for (const fixtureId of VERIFY_EXPECTED_FIXTURES) {
    const fixtureDir = path.join(manifestRoot, fixtureId)
    const manifest = readStagedManifest(fixtureDir)
    if (!manifest) {
      log(`ERROR: Missing or invalid staged manifest for ${fixtureId} at ${fixtureDir}`)
      process.exitCode = 1
      app.quit()
      return
    }
    manifests.set(fixtureId, manifest)
    log(`  Loaded manifest for ${fixtureId}: native=${manifest.expectedNativeVersion}`)
  }

  /* ── Run each case sequentially ── */
  const results: Map<FixtureId, VerifyDonePayload> = new Map()
  const errors: Map<FixtureId, string> = new Map()

  for (let i = 0; i < VERIFY_EXPECTED_FIXTURES.length; i++) {
    const fixtureId = VERIFY_EXPECTED_FIXTURES[i]
    const manifest = manifests.get(fixtureId)!

    // Inter-case delay for session/renderer cleanup (skip for first case)
    if (i > 0) {
      log(`  Waiting for session cleanup before next case...`)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    try {
      const payload = await runVerifyCase(fixtureId, manifest)
      results.set(fixtureId, payload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`  ERROR: Case ${fixtureId} failed: ${msg}`)
      errors.set(fixtureId, msg)
    }
  }

  /* ── Emit summary ── */
  log('')
  log('╔══════════════════════════════════════════════════════════╗')
  log('║  C1 Verification Results                                ║')
  log('╚══════════════════════════════════════════════════════════╝')

  const summary: Record<string, unknown> = {
    phase: '4.0-C1',
    manifestRoot,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    },
    cases: {}
  }

  const cases: Record<string, unknown> = {}
  let allPassed = true

  for (const fixtureId of VERIFY_EXPECTED_FIXTURES) {
    const error = errors.get(fixtureId)
    const result = results.get(fixtureId)

    if (error) {
      cases[fixtureId] = { status: 'FAIL', error }
      allPassed = false
      continue
    }

    if (!result) {
      cases[fixtureId] = { status: 'FAIL', error: 'No result' }
      allPassed = false
      continue
    }

    const caseResult: Record<string, unknown> = {
      status: 'PASS',
      preflight: result.preflight,
      productionOpenerStarted: result.productionOpenerStarted,
      productionOpenerCompleted: result.productionOpenerCompleted,
      futureVersionRejected: result.futureVersionRejected ?? false
    }

    if (result.openResult) {
      caseResult.openResult = result.openResult
    }
    if (result.v4Assertions) {
      caseResult.v4Assertions = result.v4Assertions
    }
    if (result.v11Assertions) {
      caseResult.v11Assertions = result.v11Assertions
    }
    if (result.error) {
      caseResult.error = result.error
      caseResult.status = 'FAIL'
      allPassed = false
    }

    // ── Validate expected outcomes ──
    const validations: string[] = []

    if (fixtureId === 'v4') {
      if (result.preflight.nativeVersion !== 40)
        validations.push(`preflight native expected 40, got ${result.preflight.nativeVersion}`)
      if (!result.productionOpenerStarted) validations.push('productionOpenerStarted should be true')
      if (!result.productionOpenerCompleted) validations.push('productionOpenerCompleted should be true')
      if (result.openResult?.logicalVerno !== 11)
        validations.push(`logicalVerno expected 11, got ${result.openResult?.logicalVerno}`)
      if (result.openResult?.nativeVersion !== 110)
        validations.push(`nativeVersion expected 110, got ${result.openResult?.nativeVersion}`)
      if (result.v4Assertions) {
        if (!result.v4Assertions.v5DateConversion) validations.push('v5 date conversion failed')
        if (!result.v4Assertions.v5TavilyToWebSearch) validations.push('v5 tavily→webSearch failed')
        if (!result.v4Assertions.v7ReferentialConsistency) validations.push('v7 referential consistency failed')
        if (result.v4Assertions.v8SourceLanguage !== 'en-us')
          validations.push(`v8 source lang: expected en-us, got ${result.v4Assertions.v8SourceLanguage}`)
        if (result.v4Assertions.v8TargetLanguage !== 'zh-cn')
          validations.push(`v8 target lang: expected zh-cn, got ${result.v4Assertions.v8TargetLanguage}`)
        if (!result.v4Assertions.v8HistoryLanguageConversion) validations.push('v8 history language conversion failed')
        if (!result.v4Assertions.topicSegmentsTableExists) validations.push('topic_segments table missing')
      } else {
        validations.push('missing v4Assertions')
      }
    }

    if (fixtureId === 'v11a') {
      if (result.preflight.nativeVersion !== 110)
        validations.push(`preflight native expected 110, got ${result.preflight.nativeVersion}`)
      if (!result.productionOpenerStarted) validations.push('productionOpenerStarted should be true')
      if (!result.productionOpenerCompleted) validations.push('productionOpenerCompleted should be true')
      if (result.openResult?.logicalVerno !== 11)
        validations.push(`logicalVerno expected 11, got ${result.openResult?.logicalVerno}`)
      if (result.v11Assertions?.markerValue !== 'A')
        validations.push(`marker expected A, got ${result.v11Assertions?.markerValue}`)
    }

    if (fixtureId === 'v11b') {
      if (result.preflight.nativeVersion !== 110)
        validations.push(`preflight native expected 110, got ${result.preflight.nativeVersion}`)
      if (!result.productionOpenerStarted) validations.push('productionOpenerStarted should be true')
      if (!result.productionOpenerCompleted) validations.push('productionOpenerCompleted should be true')
      if (result.openResult?.logicalVerno !== 11)
        validations.push(`logicalVerno expected 11, got ${result.openResult?.logicalVerno}`)
      if (result.v11Assertions?.markerValue !== 'B')
        validations.push(`marker expected B, got ${result.v11Assertions?.markerValue}`)
    }

    if (fixtureId === 'v12') {
      if (result.preflight.nativeVersion !== 120)
        validations.push(`preflight native expected 120, got ${result.preflight.nativeVersion}`)
      if (result.productionOpenerStarted) validations.push('productionOpenerStarted should be false for v12')
      if (!result.futureVersionRejected) validations.push('futureVersionRejected should be true')
    }

    if (validations.length > 0) {
      caseResult.validations = validations
      caseResult.status = 'FAIL'
      allPassed = false
    }

    cases[fixtureId] = caseResult
  }

  summary.cases = cases
  summary.allPassed = allPassed

  log(JSON.stringify(summary, null, 2))

  if (allPassed) {
    log('')
    log('Phase 4.0-C1 verification: ALL PASS')
    process.exitCode = 0
  } else {
    log('')
    log('Phase 4.0-C1 verification: FAILURES DETECTED')
    process.exitCode = 1
  }

  log('Initiating orderly shutdown...')
  app.quit()
}
