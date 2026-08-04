/**
 * Electron E2E fixture with disposable profile and mock provider seeding.
 *
 * LOCK-001: Unique disposable profile; real profiles untouched.
 * LOCK-002: No paid/live external API; mock OpenAI-compatible endpoint.
 * LOCK-003: Minimal selector additions; no i18n changes.
 *
 * Fail-fast diagnostics:
 *   - Asserts ChatDb IPC availability before any test step
 *   - Verifies better-sqlite3 ABI matches Electron before launch
 *   - Post-shutdown SQLite verification via Electron binary (ABI 145)
 *
 * Ownership-safe temp root (per-test):
 *   - Every fixture run creates ONE unique atomic canonical temp root via
 *     mkdtemp under the canonical os.tmpdir() (run-ownership).
 *   - TMPDIR/TMP/TEMP are passed to Electron so production os.tmpdir()
 *     resolves inside the owned root.
 *   - The fixture tracks every exact profile launch token created beneath the
 *     root (main app profile + seed profiles registered by seed utilities).
 *   - Teardown exact-cleans every known profile, then removes the exact root
 *     and verifies absence. On any cleanup failure/remaining PID/validation
 *     failure the root is preserved and the error propagates (fail-closed).
 *   - Never scans or deletes the global os.tmpdir and never deletes another
 *     test's root.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron, test as base } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

import { closeElectronWithExactCleanup } from '../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../utils/process-cleanup'
import { createOwnedTmpRoot, removeOwnedTmpRoot, validateProfileLaunchToken } from '../utils/run-ownership'
import {
  queryChatDbWithBoundedRetry,
  runChatDbQueryAttempt,
  runChatDbVerifyAttempt,
  verifyChatDbWithBoundedRetry,
  type QueryChatDbDependencies,
  type QueryChatDbOutcome,
  type VerifyChatDbOutcome
} from '../utils/query-chat-db-electron'
import {
  clearRequestLog,
  createMockServer,
  findProductRequest,
  findProductRequestAfter,
  getRequestLog,
  getRequestSequence,
  stopMockServer
} from './mock-openai-server'

export type ElectronFixtures = {
  electronApp: ElectronApplication
  mainWindow: Page
  mockPort: number
  userDataDir: string
  /** Ownership-safe temp root: all test-owned temp artifacts live here. */
  ownedTmpRoot: string
}

let _userDataDir: string

// Exposed for post-shutdown SQLite verification
let _chatDbPath: string | null = null

// Runtime appDataPath captured from the running Electron process.
// Set after app launch via probeRuntimeAppDataPath().
let _runtimeAppDataPath: string | null = null

// Owned temp root for this fixture run — production os.tmpdir() resolves here
// via TMPDIR/TMP/TEMP env vars passed to Electron.
let _ownedTmpRoot: string | null = null

// Exact canonical `--user-data-dir` launch tokens created beneath the owned
// root for this fixture run. The root teardown exact-cleans every still-
// registered token before it may remove the root.
const _profileLaunchTokens = new Set<string>()

/**
 * Register an exact profile launch token beneath the current owned root so the
 * fixture root teardown exact-cleans it before root removal. Used by seed
 * utilities that launch their own disposable Electron profiles.
 */
export function registerProfileLaunchToken(launchToken: string): void {
  _profileLaunchTokens.add(launchToken)
}

/** Forget an exact profile launch token after its cleanup succeeded. */
export function unregisterProfileLaunchToken(launchToken: string): void {
  _profileLaunchTokens.delete(launchToken)
}

/**
 * Returns the path to chat.db for the current disposable profile.
 * Computed from the runtime appDataPath captured from the running app,
 * NOT predicted from the fixture's userDataDir.
 */
export function getChatDbPath(): string | null {
  return _chatDbPath
}

/**
 * Returns the runtime appDataPath captured from the running Electron app
 * via getAppInfo(). Returns null if not yet captured.
 */
export function getRuntimeAppDataPath(): string | null {
  return _runtimeAppDataPath
}

/**
 * Returns the disposable base userDataDir passed to Electron via --user-data-dir.
 */
export function getUserDataDir(): string {
  return _userDataDir
}

/**
 * Returns the ownership-safe temp root for this fixture run.
 * All test-owned temp artifacts live under this root; production os.tmpdir()
 * resolves here via TMPDIR/TMP/TEMP env vars.
 */
export function getOwnedTmpRoot(): string | null {
  return _ownedTmpRoot
}

/**
 * Resolve the fixture-owned Electron binary + native module. Requires the
 * owned temp root (LOCK-001) so every query/verification script lands inside
 * the disposable root for exact cleanup.
 */
function fixtureQueryDependencies(): QueryChatDbDependencies {
  if (!_ownedTmpRoot) throw new Error('ownedTmpRoot fixture is required before querying ChatDb')
  return {
    electronPath: require('electron') as string,
    betterSqlitePath: require.resolve('better-sqlite3')
  }
}

/**
 * Query SQLite via the Electron binary (ABI compatible).
 *
 * LOCK-QDB-1/5: returns a discriminated typed outcome — never null. On
 * success `rows` is a strict array; malformed/missing/non-array rows fail
 * closed with a fixed code. On failure only fixed codes and bounded numerics
 * are surfaced (never stderr/stdout/path/SQL/raw error).
 *
 * Single attempt (generic API retained for existing callers). Peak-pressure
 * post-close paths use `queryChatDbViaElectronWithRetry`.
 */
export function queryChatDbViaElectron(dbPath: string, sql: string): QueryChatDbOutcome {
  return runChatDbQueryAttempt(dbPath, sql, _ownedTmpRoot as string, fixtureQueryDependencies())
}

/**
 * LOCK-QDB-3: run the fixed batched readonly verification plan against a
 * live chat.db in ONE child/connection/snapshot — exact one-row integrity
 * 'ok', exactly empty foreign_key_check, exact one valid non-negative integer
 * count per allowlisted CandidateImportStats table. Returns only fixed
 * booleans/counts. No caller-supplied SQL.
 */
export function verifyChatDbViaElectron(dbPath: string): VerifyChatDbOutcome {
  return runChatDbVerifyAttempt(dbPath, _ownedTmpRoot as string, fixtureQueryDependencies())
}

/**
 * LOCK-QDB-4: bounded-retry generic query. Retries only transient codes
 * (TIMEOUT/SPAWN/SIGNAL/BUSY/LOCKED), max 3 attempts within a <=60s total
 * deadline with short bounded backoff. Permanent codes fail immediately.
 */
export async function queryChatDbViaElectronWithRetry(dbPath: string, sql: string): Promise<QueryChatDbOutcome> {
  return queryChatDbWithBoundedRetry(dbPath, sql, _ownedTmpRoot as string, fixtureQueryDependencies())
}

/**
 * LOCK-QDB-3/4: bounded-retry fixed batched verification plan. Use for the
 * post-close real-backup evidence — ONE child per attempt, transient retries
 * bounded by the 60s deadline instead of a fixed sleep-as-evidence.
 */
export async function verifyChatDbViaElectronWithRetry(dbPath: string): Promise<VerifyChatDbOutcome> {
  return verifyChatDbWithBoundedRetry(dbPath, _ownedTmpRoot as string, fixtureQueryDependencies())
}

/**
 * Probe the running Electron app for its actual runtime userData/appData path.
 * Uses the existing getAppInfo() IPC API (test-neutral, no production changes).
 * Sets _runtimeAppDataPath and derives _chatDbPath from it.
 *
 * LOCK-002: Asserts the actual disposable Dev path before any send/seed.
 */
async function probeRuntimeAppDataPath(page: Page): Promise<void> {
  const info = await page.evaluate(async () => {
    try {
      const api = (window as any).api
      const appInfo = await api.getAppInfo()
      if (!appInfo || typeof appInfo !== 'object') {
        return { ok: false, error: 'getAppInfo() returned non-object' }
      }
      if (!appInfo.appDataPath || typeof appInfo.appDataPath !== 'string') {
        return { ok: false, error: `appDataPath is not a string: ${typeof appInfo.appDataPath}` }
      }
      return { ok: true, appDataPath: appInfo.appDataPath }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  if (!info.ok) {
    throw new Error(`Failed to probe runtime appDataPath: ${info.error}`)
  }

  const runtimeAppDataPath = info.appDataPath
  _runtimeAppDataPath = runtimeAppDataPath

  // Derive chatDb path from the ACTUAL runtime path.
  // Use the raw runtime path (Electron may report /private/var/... which is valid).
  _chatDbPath = path.join(runtimeAppDataPath, 'Data', 'chat.db')

  // LOCK-002: Assert the runtime path matches the expected disposable Dev path.
  // This ensures no config.json redirect to live user data.
  // NOTE: macOS resolves /var → /private/var via symlink. We resolve the parent
  // tmpdir (which always exists) and join the child name, since realpathSync
  // fails on non-existent paths.
  const devDirName = path.basename(_userDataDir) + 'Dev'
  const resolvedTmpdir = fs.realpathSync(path.dirname(_userDataDir))
  const expectedDevPath = path.join(resolvedTmpdir, devDirName)
  const resolvedRuntime = fs.realpathSync(path.dirname(runtimeAppDataPath))
  const runtimeChildName = path.basename(runtimeAppDataPath)
  if (resolvedRuntime !== resolvedTmpdir || runtimeChildName !== devDirName) {
    throw new Error(
      `LOCK-002 VIOLATION: Runtime appDataPath "${_runtimeAppDataPath}" ` +
        `(resolved parent: "${resolvedRuntime}", child: "${runtimeChildName}") ` +
        `does not match expected disposable Dev path "${expectedDevPath}" ` +
        `(resolved parent: "${resolvedTmpdir}", child: "${devDirName}"). ` +
        `A config.json override may be redirecting to live data.`
    )
  }

  console.log(`[E2E] Runtime appDataPath: ${_runtimeAppDataPath}`)
  console.log(`[E2E] Derived chatDb path: ${_chatDbPath}`)
}

/**
 * Verify ChatDb IPC is available and the native module loads correctly.
 * Throws immediately if any check fails (fail-fast).
 */
async function assertChatDbReady(page: Page): Promise<void> {
  // 1. Verify IPC chatDb API is exposed
  const apiCheck = await page.evaluate(async () => {
    try {
      const api = (window as any).api
      if (!api?.chatDb) return { ok: false, error: 'window.api.chatDb not found' }
      if (typeof api.chatDb.fetchMessages !== 'function')
        return { ok: false, error: 'chatDb.fetchMessages not a function' }
      if (typeof api.chatDb.appendMessage !== 'function')
        return { ok: false, error: 'chatDb.appendMessage not a function' }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  if (!apiCheck.ok) {
    throw new Error(`ChatDb IPC not ready: ${apiCheck.error}`)
  }

  // 2. Verify ChatDb can execute a probe query and returns a valid ChatDbResult envelope
  //    topicExists returns ChatDbResult<boolean> = { ok: true, value: boolean } | { ok: false, error }
  const probeResult = await page.evaluate(async () => {
    try {
      const api = (window as any).api
      const result = await api.chatDb.topicExists({ topicId: '__e2e_probe__' })
      // Validate ChatDbResult envelope structure
      if (!result || typeof result !== 'object') {
        return { ok: false, error: 'Result is not an object' }
      }
      if (typeof result.ok !== 'boolean') {
        return { ok: false, error: `Result.ok is not boolean: ${typeof result.ok}` }
      }
      if (!result.ok) {
        return { ok: false, error: `ChatDb returned failure: ${JSON.stringify(result.error)}` }
      }
      // For topicExists, value must be a boolean
      if (typeof result.value !== 'boolean') {
        return { ok: false, error: `topicExists value is not boolean: ${typeof result.value}` }
      }
      return { ok: true, value: result.value }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  if (!probeResult.ok) {
    throw new Error(`ChatDb IPC probe failed (possible ABI mismatch): ${probeResult.error}`)
  }

  console.log('[E2E] ChatDb IPC readiness: PASS (envelope ok=true, value=boolean)')
}

async function launchElectron(): Promise<ElectronApplication> {
  // Ownership-safe: pass TMPDIR/TMP/TEMP so production os.tmpdir() resolves
  // inside the owned temp root. This ensures all production temp artifacts
  // (cherry-import-*, etc.) land under our owned root for cleanup.
  const tmpEnv: Record<string, string> = {}
  if (_ownedTmpRoot) {
    tmpEnv.TMPDIR = _ownedTmpRoot
    tmpEnv.TMP = _ownedTmpRoot
    tmpEnv.TEMP = _ownedTmpRoot
  }

  return electron.launch({
    args: ['.', `--user-data-dir=${_userDataDir}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, NODE_ENV: 'development', ELECTRON_RUN_AS_NODE: '', ...tmpEnv },
    timeout: 120000
  })
}

async function waitForMainElectronWindow(electronApp: ElectronApplication): Promise<Page> {
  const mainWindow = await electronApp.waitForEvent('window', {
    predicate: async (window) => {
      try {
        const title = await window.title()
        return title === 'Cherry Studio' || title.includes('Cherry')
      } catch {
        return false
      }
    },
    timeout: 120000
  })
  await mainWindow.waitForSelector('#root', { state: 'attached', timeout: 60000 })
  await mainWindow.waitForLoadState('domcontentloaded')
  return mainWindow
}

/**
 * Bypass onboarding: click "Skip" button on the welcome page, then
 * set localStorage so future loads skip it too.
 */
async function bypassOnboarding(page: Page): Promise<void> {
  try {
    const skipBtn = page.getByText('Skip', { exact: false })
    await skipBtn.waitFor({ state: 'visible', timeout: 10000 })
    await skipBtn.click()
    await page.waitForTimeout(2000)
  } catch {
    // Already past onboarding
  }

  await page.evaluate(() => {
    localStorage.setItem('onboarding-completed', 'true')
  })
}

/**
 * Seed the mock provider and default model into the Redux store.
 * Seeds directly into the running store (no page reload).
 */
async function seedMockProvider(page: Page, port: number): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 30000 })
  await page.waitForFunction(
    () => {
      const s = (window as any).store?.getState()
      return s && s.llm && Array.isArray(s.llm.providers)
    },
    { timeout: 30000 }
  )

  const apiHost = `http://127.0.0.1:${port}/v1/`

  await page.evaluate(
    ({ apiHost }) => {
      const store = (window as any).store
      const state = store.getState()

      const existing = state.llm.providers.find((p: any) => p.id === 'mock-openai')
      if (existing) {
        store.dispatch({
          type: 'llm/updateProvider',
          payload: { id: 'mock-openai', apiKey: 'test-key', apiHost, enabled: true }
        })
      } else {
        store.dispatch({
          type: 'llm/addProvider',
          payload: {
            id: 'mock-openai',
            type: 'openai',
            name: 'Mock OpenAI',
            apiKey: 'test-key',
            apiHost,
            models: [
              {
                id: 'mock-model',
                provider: 'mock-openai',
                name: 'Mock Model',
                group: 'mock',
                description: 'Mock model for E2E'
              }
            ],
            enabled: true,
            isSystem: false
          }
        })
      }

      const mockModel = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' }
      store.dispatch({ type: 'llm/setDefaultModel', payload: { model: mockModel } })
      store.dispatch({ type: 'llm/setQuickModel', payload: { model: mockModel } })
      store.dispatch({ type: 'llm/setTranslateModel', payload: { model: mockModel } })
    },
    { apiHost }
  )

  await page.waitForTimeout(1000)

  const ok = await page.evaluate(() => {
    const s = (window as any).store.getState()
    return s.llm.providers.some((p: any) => p.id === 'mock-openai') && s.llm.defaultModel?.id === 'mock-model'
  })
  if (!ok) throw new Error('Failed to seed mock provider')
}

/**
 * Wait for the home/chat UI to be ready.
 */
async function waitForHomeReady(page: Page, timeout = 60000): Promise<void> {
  await page.waitForSelector('#root', { state: 'attached', timeout })
  await page.waitForSelector(
    ['#chat', '.inputbar-container', '[class*="Inputbar"]', '[class*="Container"]'].join(', '),
    { state: 'visible', timeout }
  )
  await page.waitForTimeout(1000)
}

/**
 * Assert that the textarea is ready for input (real Ant Design TextArea).
 */
async function assertTextareaReady(page: Page): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 30000 })
}

export const test = base.extend<ElectronFixtures>({
  ownedTmpRoot: async ({}, use) => {
    const root = createOwnedTmpRoot()
    _ownedTmpRoot = root
    try {
      await use(root)
    } finally {
      try {
        // Fail-closed: exact-clean every still-registered profile, then remove
        // the exact root. On any failure the root is preserved and the error
        // propagates. There is no global teardown that deletes roots.
        await removeOwnedTmpRoot(root, [..._profileLaunchTokens])
      } finally {
        _profileLaunchTokens.clear()
        _ownedTmpRoot = null
      }
    }
  },

  userDataDir: async ({ ownedTmpRoot }, use) => {
    // Canonical child of the canonical owned root — the exact immutable string
    // passed to Electron as --user-data-dir.
    const profileToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const userDataDir = path.join(ownedTmpRoot, `cherry-e2e-${profileToken}`)
    validateProfileLaunchToken(ownedTmpRoot, userDataDir, true)
    _userDataDir = userDataDir
    registerProfileLaunchToken(userDataDir)

    // Do NOT pre-compute chatDbPath here — it will be set by probeRuntimeAppDataPath()
    // after app launch, using the actual runtime appDataPath from the running Electron process.
    _chatDbPath = null
    _runtimeAppDataPath = null

    await use(userDataDir)

    _chatDbPath = null
    _runtimeAppDataPath = null
  },

  mockPort: async ({}, use) => {
    const server = await createMockServer()
    await use(server.port)
    stopMockServer()
  },

  electronApp: async ({ userDataDir, mockPort, ownedTmpRoot }, use) => {
    _userDataDir = userDataDir
    _ownedTmpRoot = ownedTmpRoot
    // Invariant: the mock server must be up before launch and stay up until
    // this app is closed (fixture dependency keeps the teardown ordering).
    if (!Number.isInteger(mockPort) || mockPort <= 0) {
      throw new Error(`mockPort fixture must provide a positive port, got ${mockPort}`)
    }
    let electronApp: ElectronApplication | null = null
    let fixtureError: Error | null = null
    try {
      electronApp = await launchElectron()
      await use(electronApp)
    } catch (error) {
      fixtureError = error instanceof Error ? error : new Error(String(error))
    } finally {
      try {
        await closeElectronWithExactCleanup(userDataDir, {
          close: () => (electronApp ? electronApp.close() : Promise.resolve()),
          findExactProcesses: findProcessesByUserDataDir,
          terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
        })
        // Exact cleanup succeeded: the profile is quiesced. The root teardown
        // re-cleans only still-registered profiles (idempotent safety net).
        unregisterProfileLaunchToken(userDataDir)
      } catch (error) {
        const cleanupError = error instanceof Error ? error : new Error(String(error))
        // Fail-closed: the owned root is preserved and reported by the
        // ownedTmpRoot teardown. Never swallow a cleanup failure.
        if (fixtureError) throw new AggregateError([fixtureError, cleanupError], 'Fixture and Electron cleanup failed')
        throw cleanupError
      } finally {
        // Allow WAL flush after the process has reached a terminal state.
        await new Promise((resolve) => setTimeout(resolve, 3000))
        clearRequestLog()
      }
    }
    if (fixtureError) throw fixtureError
  },

  mainWindow: async ({ electronApp, mockPort, ownedTmpRoot }, use) => {
    _ownedTmpRoot = ownedTmpRoot
    const mainWindow = await waitForMainElectronWindow(electronApp)

    // LOCK-001: Probe runtime appDataPath IMMEDIATELY after window/root readiness
    // and BEFORE any bypassOnboarding/seedMockProvider/localStorage/Redux mutation.
    // This ensures we detect any config.json redirect to live data before we touch anything.
    await probeRuntimeAppDataPath(mainWindow)

    await bypassOnboarding(mainWindow)
    await seedMockProvider(mainWindow, mockPort)
    await waitForHomeReady(mainWindow)
    await assertChatDbReady(mainWindow)
    await assertTextareaReady(mainWindow)
    await use(mainWindow)
  }
})

export { expect } from '@playwright/test'
export { getRequestLog, clearRequestLog, findProductRequest, findProductRequestAfter, getRequestSequence }
// NOTE: getRuntimeAppDataPath/getUserDataDir are already exported at their
// declarations above — a redundant `export { ... }` list here would be a
// TS2323/TS2484 double-export under strict typechecking.
