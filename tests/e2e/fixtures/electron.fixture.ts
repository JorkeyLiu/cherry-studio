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
import { test as base } from '@playwright/test'
import * as path from 'path'

import { closeElectronWithExactCleanup } from '../utils/electron-cleanup'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  launchElectronApp,
  seedMockProvider,
  waitForHomeReady,
  waitForMainElectronWindow
} from '../utils/prepare-app'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../utils/process-cleanup'
import { probeAndAssertRuntimeAppData } from '../utils/runtime-app-data'
import {
  assertNoLiveOwnedRelayChild,
  assertNoUnresolvedOwnedRelayCleanup,
  createOwnedTmpRoot,
  removeOwnedTmpRoot,
  validateProfileLaunchToken
} from '../utils/run-ownership'
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
// Set after app launch via probeAndAssertRuntimeAppData().
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

export const test = base.extend<ElectronFixtures>({
  ownedTmpRoot: async ({}, use) => {
    const root = createOwnedTmpRoot()
    _ownedTmpRoot = root
    try {
      await use(root)
    } finally {
      try {
        // Fail-closed: block root removal while any owned relay handle is
        // unresolved (live child, uncleaned artifacts, or unclosed handle).
        // The gate lives in run-ownership (ABI-neutral, already loaded) so
        // this teardown never imports the relay-process implementation (raw
        // TS cold-load under the fixture module system). The root is
        // preserved for retry/reporting; never delete a relay child's
        // artifacts while ownership is unresolved.
        try {
          assertNoUnresolvedOwnedRelayCleanup('fixture owned root removal')
        } catch (e) {
          throw new AggregateError(
            [e instanceof Error ? e : new Error(String(e))],
            `Fixture owned root preserved (unresolved relay ownership): ${root}`
          )
        }
        assertNoLiveOwnedRelayChild('fixture owned root removal')
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

    // Do NOT pre-compute chatDbPath here — it will be set after app launch by
    // probeAndAssertRuntimeAppData(), using the actual runtime appDataPath
    // from the running Electron process.
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
      electronApp = await launchElectronApp({ userDataDir, ownedTmpRoot })
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
    const probed = await probeAndAssertRuntimeAppData(mainWindow, _userDataDir)
    _runtimeAppDataPath = probed.runtimeAppDataPath
    _chatDbPath = probed.chatDbPath

    console.log(`[E2E] Runtime appDataPath: ${_runtimeAppDataPath}`)
    console.log(`[E2E] Derived chatDb path: ${_chatDbPath}`)

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
