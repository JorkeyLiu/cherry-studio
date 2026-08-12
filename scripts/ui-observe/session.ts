/**
 * Observation session orchestration for `pnpm ui:observe`.
 *
 * Runs ONE scenario against a fresh disposable Cherry Chat profile using the
 * repository's Playwright Electron runtime, reusing the same safe setup
 * obligations as the E2E fixture (shared helpers in `tests/e2e/utils/`):
 *
 *   - unique owned temp root + unique disposable profile (run-ownership)
 *   - in-process mock OpenAI-compatible server (mock-openai-server)
 *   - Electron launch with the disposable profile and owned temp env
 *     (prepare-app.launchElectronApp)
 *   - main-window selection, runtime appDataPath assertion BEFORE any mutation
 *     (prepare-app / runtime-app-data)
 *   - onboarding bypass, mock provider seeding, home/ChatDb/textarea readiness
 *   - ownership-scoped cleanup in a `finally` (electron-cleanup + run-ownership)
 *     even when the scenario fails; the output directory survives for inspection
 *
 * No module-level state: every run is a self-contained call that cleans up
 * exactly what it created. Never uses a fixed CDP port, never kills broad
 * process trees, never touches a real profile.
 */
import type { ElectronApplication } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

import { createMockServer, stopMockServer } from '../../tests/e2e/fixtures/mock-openai-server'
import { closeElectronWithExactCleanup } from '../../tests/e2e/utils/electron-cleanup'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  launchElectronApp,
  seedMockProvider,
  waitForHomeReady,
  waitForMainElectronWindow
} from '../../tests/e2e/utils/prepare-app'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../tests/e2e/utils/process-cleanup'
import { createOwnedTmpRoot, removeOwnedTmpRoot, validateProfileLaunchToken } from '../../tests/e2e/utils/run-ownership'
import { probeAndAssertRuntimeAppData } from '../../tests/e2e/utils/runtime-app-data'
import {
  type ArtifactKind,
  createArtifactPathResolver,
  type ObservationContext,
  type ObservationScenario,
  sanitizeArtifactName
} from './scenario'

/** Default scenario body timeout (launch/prepare are not part of it). */
export const DEFAULT_SCENARIO_TIMEOUT_MS = 120000

/** WAL-flush settle window after the app reaches a terminal state (mirrors the E2E fixture). */
const POST_CLOSE_SETTLE_MS = 3000

export interface ObservationSessionOptions {
  scenario: ObservationScenario
  /** Human-readable source for reporting (`builtin:<name>` or a file path). */
  scenarioSource: string
  /** Unique output directory for artifacts; created and NEVER cleaned by the session. */
  outputDir: string
  /** Scenario body timeout in milliseconds. */
  timeoutMs?: number
  /** Live stdout writer for progress lines; defaults to a no-op. */
  log?: (line: string) => void
}

export interface ObservationArtifactEntry {
  name: string
  kind: ArtifactKind
  path: string
}

export interface ObservationRunResult {
  ok: boolean
  scenarioName: string
  scenarioSource: string
  outputDir: string
  profileDir: string
  runtimeAppDataPath: string
  chatDbPath: string
  durationMs: number
  artifacts: ObservationArtifactEntry[]
  /** Scenario/setup failure message (null on success). */
  error: string | null
  /** Cleanup failure message (null when cleanup fully succeeded). */
  cleanupError: string | null
  /**
   * True when the scenario body was still pending AFTER cleanup completed —
   * a timed-out wait that never settles even with the app closed (a promise
   * holding event-loop handles outside Playwright). Cleanup-before-exit is
   * preserved: the CLI force-exits in this case instead of hanging, but only
   * after the session fully cleaned up.
   */
  scenarioPending: boolean
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bound a promise with a rejection timer; the timer is always cleared. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export async function runObservationSession(options: ObservationSessionOptions): Promise<ObservationRunResult> {
  const startedAt = Date.now()
  const log = options.log ?? (() => undefined)
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS
  const scenarioName = options.scenario.name ?? path.basename(options.scenarioSource)

  const result: ObservationRunResult = {
    ok: false,
    scenarioName,
    scenarioSource: options.scenarioSource,
    outputDir: options.outputDir,
    profileDir: '',
    runtimeAppDataPath: '',
    chatDbPath: '',
    durationMs: 0,
    artifacts: [],
    error: null,
    cleanupError: null,
    scenarioPending: false
  }

  let ownedTmpRoot: string | null = null
  let profileDir: string | null = null
  let electronApp: ElectronApplication | null = null
  let runError: unknown = null
  let cleanupError: unknown = null
  // Set once the scenario body settles (fulfilled or rejected); false when the
  // bounded timeout abandoned a body that never settles.
  let scenarioSettled = false

  try {
    // 1. Unique owned temp root (frozen E2E ownership contract).
    ownedTmpRoot = createOwnedTmpRoot()
    log(`owned temp root: ${ownedTmpRoot}`)

    // 2. Unique disposable profile beneath the owned root (exact launch token).
    const profileToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    profileDir = path.join(ownedTmpRoot, `cherry-e2e-${profileToken}`)
    validateProfileLaunchToken(ownedTmpRoot, profileDir, true)
    result.profileDir = profileDir
    log(`disposable profile: ${profileDir}`)

    // 3. In-process mock OpenAI-compatible server (no live APIs; LOCK-OBS-004
    //    no external dependencies).
    const mockServer = await createMockServer()
    const mockPort = mockServer.port
    if (!Number.isInteger(mockPort) || mockPort <= 0) {
      throw new Error(`mock server must provide a positive port, got ${mockPort}`)
    }
    log(`mock provider port: ${mockPort}`)

    // 4. Launch the built app with the disposable profile and owned temp env.
    electronApp = await launchElectronApp({ userDataDir: profileDir, ownedTmpRoot })

    // 5. Main-window selection + runtime appDataPath assertion BEFORE any
    //    mutation (LOCK-OBS-003: detects a config.json redirect to live data).
    const mainWindow = await waitForMainElectronWindow(electronApp)
    const probed = await probeAndAssertRuntimeAppData(mainWindow, profileDir)
    result.runtimeAppDataPath = probed.runtimeAppDataPath
    result.chatDbPath = probed.chatDbPath
    log(`runtime appDataPath verified: ${probed.runtimeAppDataPath}`)

    // 6. Onboarding bypass, mock provider seeding, and fail-fast readiness.
    await bypassOnboarding(mainWindow)
    await seedMockProvider(mainWindow, mockPort)
    await waitForHomeReady(mainWindow)
    await assertChatDbReady(mainWindow)
    await assertTextareaReady(mainWindow)
    log('app readiness: PASS (home, ChatDb IPC, textarea)')

    // 7. Output directory (survives cleanup for inspection).
    fs.mkdirSync(options.outputDir, { recursive: true })

    // 8. Run exactly one scenario with a bounded timeout.
    const artifactResolver = createArtifactPathResolver(options.outputDir)
    const context: ObservationContext = {
      page: mainWindow,
      electronApp,
      session: {
        userDataDir: profileDir,
        runtimeAppDataPath: probed.runtimeAppDataPath,
        chatDbPath: probed.chatDbPath,
        ownedTmpRoot,
        mockPort,
        outputDir: options.outputDir
      },
      capture: async (name) => {
        const artifactPath = artifactResolver('png', name)
        await mainWindow.screenshot({ path: artifactPath })
        result.artifacts.push({ name: sanitizeArtifactName(name), kind: 'png', path: artifactPath })
        log(`screenshot: ${artifactPath}`)
        return artifactPath
      },
      writeText: async (name, content) => {
        const artifactPath = artifactResolver('txt', name)
        fs.writeFileSync(artifactPath, content, 'utf8')
        result.artifacts.push({ name: sanitizeArtifactName(name), kind: 'txt', path: artifactPath })
        log(`artifact: ${artifactPath}`)
        return artifactPath
      }
    }

    // Run exactly one scenario with a bounded timeout. Track settlement so
    // the CLI can detect a body that is still pending after cleanup (it may
    // hold event-loop handles that would otherwise keep the process alive).
    const scenarioPromise = Promise.resolve(options.scenario.run(context)).then(
      () => {
        scenarioSettled = true
      },
      () => {
        scenarioSettled = true
      }
    )
    await withTimeout(scenarioPromise, timeoutMs, `scenario '${scenarioName}' timed out after ${timeoutMs}ms`)
  } catch (error) {
    runError = error
  } finally {
    // Ownership-scoped cleanup: exact profile + mock server + owned root.
    // Always runs, even when the scenario or setup failed.
    try {
      if (profileDir !== null) {
        const closeApp = electronApp !== null ? () => electronApp!.close() : () => Promise.resolve()
        await closeElectronWithExactCleanup(profileDir, {
          close: closeApp,
          findExactProcesses: findProcessesByUserDataDir,
          terminateExactProcesses: (dir) => terminateProcessesByUserDataDir(dir, null)
        })
        // Allow SQLite WAL flush after the process reached a terminal state.
        await new Promise((resolve) => setTimeout(resolve, POST_CLOSE_SETTLE_MS))
      }
    } catch (error) {
      cleanupError = error
    }

    try {
      stopMockServer()
    } catch (error) {
      cleanupError = cleanupError ?? error
    }

    try {
      if (ownedTmpRoot !== null && profileDir !== null) {
        // Fail-closed: remove the exact root only when cleanup succeeded;
        // otherwise re-attempt exact profile cleanup and preserve the root.
        await removeOwnedTmpRoot(ownedTmpRoot, cleanupError === null ? [] : [profileDir])
      }
    } catch (error) {
      cleanupError = cleanupError ?? error
    }
  }

  result.durationMs = Date.now() - startedAt
  result.error = runError === null ? null : asMessage(runError)
  result.cleanupError = cleanupError === null ? null : asMessage(cleanupError)
  result.ok = runError === null && cleanupError === null
  // Computed AFTER cleanup: closing the app during cleanup often settles a
  // pending Playwright wait; only a body still pending here can hang the CLI.
  result.scenarioPending = !scenarioSettled

  writeManifest(result)
  return result
}

/** Write `manifest.json` into the output directory describing the run (best-effort). */
function writeManifest(result: ObservationRunResult): void {
  try {
    fs.mkdirSync(result.outputDir, { recursive: true })
    const manifest = {
      tool: 'ui-observe',
      scenario: result.scenarioName,
      source: result.scenarioSource,
      ok: result.ok,
      durationMs: result.durationMs,
      outputDir: result.outputDir,
      profileDir: result.profileDir,
      runtimeAppDataPath: result.runtimeAppDataPath,
      chatDbPath: result.chatDbPath,
      artifacts: result.artifacts,
      ...(result.error !== null ? { error: result.error } : {}),
      ...(result.cleanupError !== null ? { cleanupError: result.cleanupError } : {}),
      ...(result.scenarioPending ? { scenarioPending: true } : {})
    }
    fs.writeFileSync(path.join(result.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch {
    // The manifest is diagnostic metadata; a failure to write it must not
    // change the run outcome already reported to stdout.
  }
}
