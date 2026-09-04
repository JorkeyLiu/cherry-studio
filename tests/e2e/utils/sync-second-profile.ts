/**
 * Second isolated Electron profile for sync E2E.
 *
 * Two profiles are independent children of the same owned temp root, use
 * exact-token cleanup, and do not change production single-instance/profile
 * semantics. Reuses the existing ownership/readiness/cleanup primitives:
 * validateProfileLaunchToken, register/unregisterProfileLaunchToken,
 * launchElectronApp, probeAndAssertRuntimeAppData, bypassOnboarding,
 * seedMockProvider, waitForHomeReady, assertChatDbReady,
 * assertTextareaReady, closeElectronWithExactCleanup.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import * as path from 'path'

import { registerProfileLaunchToken, unregisterProfileLaunchToken } from '../fixtures/electron.fixture'
import { validateProfileLaunchToken } from './run-ownership'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from './process-cleanup'
import { closeElectronWithExactCleanup } from './electron-cleanup'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  launchElectronApp,
  seedMockProvider,
  waitForHomeReady,
  waitForMainElectronWindow
} from './prepare-app'
import { probeAndAssertRuntimeAppData } from './runtime-app-data'

export interface SecondSyncProfile {
  app: ElectronApplication
  page: Page
  userDataDir: string
  runtimeAppDataPath: string
  chatDbPath: string
  /**
   * Ownership marker set by relaunchSecondSyncProfile on the consumed input
   * handle before awaiting its clean close. A consumed handle must not be closed again:
   * closeSecondSyncProfile treats it as a no-op and preserves the launch-token
   * registration for the owned-root teardown.
   */
  consumed?: boolean
}

/**
 * Launch a second isolated profile beneath the same owned temp root.
 * Fail-closed: any readiness failure throws before the handle is returned;
 * the caller must close the returned handle exactly (closeSecondSyncProfile).
 */
export async function launchSecondSyncProfile(ownedTmpRoot: string, mockPort: number): Promise<SecondSyncProfile> {
  if (!ownedTmpRoot || typeof ownedTmpRoot !== 'string') throw new Error('ownedTmpRoot is required')
  if (!Number.isInteger(mockPort) || mockPort <= 0) throw new Error(`mockPort must be positive, got ${mockPort}`)
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const userDataDir = path.join(ownedTmpRoot, `cherry-e2e-sync-b-${token}`)
  validateProfileLaunchToken(ownedTmpRoot, userDataDir, true)
  registerProfileLaunchToken(userDataDir)

  let app: ElectronApplication | null = null
  try {
    app = await launchElectronApp({ userDataDir, ownedTmpRoot })
    const page = await waitForMainElectronWindow(app)
    // Runtime appDataPath assertion BEFORE any mutation (same as fixture).
    const probed = await probeAndAssertRuntimeAppData(page, userDataDir)
    await bypassOnboarding(page)
    await seedMockProvider(page, mockPort)
    await waitForHomeReady(page)
    await assertChatDbReady(page)
    await assertTextareaReady(page)
    return {
      app,
      page,
      userDataDir,
      runtimeAppDataPath: probed.runtimeAppDataPath,
      chatDbPath: probed.chatDbPath
    }
  } catch (error) {
    // Fail-closed: exact-clean the launched profile before propagating.
    try {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => (app ? app.close() : Promise.resolve()),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      unregisterProfileLaunchToken(userDataDir)
    } catch {
      // Preserve the original failure; cleanup errors are recorded via the
      // still-registered token in the owned-root teardown (fail-closed).
    }
    throw error
  }
}

/** Exact-token close + unregister for a second profile. Throws on failure. */
export async function closeSecondSyncProfile(profile: SecondSyncProfile | null | undefined): Promise<void> {
  if (!profile) return
  // Ownership-safe: a handle consumed by relaunchSecondSyncProfile was already
  // clean-closed; closing it again would double-clean a stale handle. Skip
  // process cleanup AND unregistration so the owned-root teardown still owns
  // the token.
  if (profile.consumed === true) return
  await closeElectronWithExactCleanup(profile.userDataDir, {
    close: () => profile.app.close(),
    findExactProcesses: findProcessesByUserDataDir,
    terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
  })
  unregisterProfileLaunchToken(profile.userDataDir)
}

export interface RelaunchSecondSyncProfileOptions {
  /** Expected persisted sync endpoint after relaunch (strict, no repair). */
  expectedEndpoint: string
  /** Expected persisted sync token (strict when supplied; omitted when unknowable). */
  expectedToken?: string
  /** Expected persisted sync enabled flag after relaunch (strict, no repair). */
  expectedEnabled: boolean
}

/**
 * Strict persisted-config assertion for the raw post-relaunch getConfig
 * shape. Fails closed without repairing and without exposing credential
 * values in the thrown message. When expectedToken is supplied, an
 * undefined/empty/non-string/mismatched token fails.
 */
export function assertPersistedSyncConfigStrict(raw: unknown, expected: RelaunchSecondSyncProfileOptions): void {
  if (!raw || typeof raw !== 'object') throw new Error('persisted sync config missing after relaunch')
  const current = raw as Record<string, unknown>
  if (typeof current.endpoint !== 'string' || current.endpoint !== expected.expectedEndpoint) {
    throw new Error('persisted sync endpoint mismatch after relaunch')
  }
  if (typeof current.enabled !== 'boolean' || current.enabled !== expected.expectedEnabled) {
    throw new Error('persisted sync enabled mismatch after relaunch')
  }
  if (expected.expectedToken !== undefined) {
    if (typeof current.token !== 'string' || current.token.length === 0) {
      throw new Error('persisted sync token missing or empty after relaunch')
    }
    if (current.token !== expected.expectedToken) throw new Error('persisted sync token mismatch after relaunch')
  }
}

/** Raw post-relaunch getConfig read (no normalization, no repair). */
export async function readRawSyncConfig(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    return await (window as any).api.sync.getConfig()
  })
}

/**
 * Explicit test-only repair path for sync config (setup use only; never part
 * of the clean-close recovery proof). The recovery spec must assert the raw
 * persisted config BEFORE calling this.
 */
export async function repairSecondSyncConfig(page: Page, expected: RelaunchSecondSyncProfileOptions): Promise<void> {
  await page.evaluate(
    async (cfg: { endpoint: string; token?: string; enabled: boolean }) => {
      return await (window as any).api.sync.setConfig(cfg)
    },
    {
      endpoint: expected.expectedEndpoint,
      token: expected.expectedToken,
      enabled: expected.expectedEnabled
    }
  )
}

/**
 * Test-only same-profile relaunch for the second disposable sync profile.
 *
 * Clean-close recovery scope only (never crash/SIGKILL/WAL durability): closes
 * the app with exact-token cleanup WITHOUT unregistering the profile launch
 * token (ownership stays registered so the fixture root teardown still owns
 * it), marks the input handle consumed so the caller cannot double-close the
 * stale handle, waits for safe close quiescence, relaunches the SAME
 * userDataDir, re-verifies runtime appData/ChatDb readiness, then strictly
 * verifies the persisted sync config with NO repair (any drift throws). The
 * caller must replace its handle with the returned profile on success and
 * still close it exactly once at the end; on failure the caller must not
 * close the stale input handle (it is already consumed) and must preserve
 * the original error. The relay instance is untouched and must stay alive
 * across this relaunch. Credential values are never logged.
 */
export async function relaunchSecondSyncProfile(
  profile: SecondSyncProfile,
  ownedTmpRoot: string,
  mockPort: number,
  expected: RelaunchSecondSyncProfileOptions
): Promise<SecondSyncProfile> {
  if (!profile?.userDataDir) throw new Error('relaunchSecondSyncProfile requires a profile userDataDir')
  if (!ownedTmpRoot || typeof ownedTmpRoot !== 'string') throw new Error('ownedTmpRoot is required')
  if (!Number.isInteger(mockPort) || mockPort <= 0) throw new Error(`mockPort must be positive, got ${mockPort}`)
  if (profile.consumed === true) throw new Error('relaunchSecondSyncProfile: input handle already consumed')
  const userDataDir = profile.userDataDir
  // Ownership transfer is published BEFORE awaiting the initial close so a
  // close failure cannot leave the caller holding a stale closable handle.
  // The input handle is consumed from this point: the caller must not close
  // it again even if the close or the relaunch below fails. The launch token
  // stays registered so the owned-root teardown still owns it.
  profile.consumed = true
  // Clean close with exact-token process cleanup; token stays registered.
  await closeElectronWithExactCleanup(userDataDir, {
    close: () => profile.app.close(),
    findExactProcesses: findProcessesByUserDataDir,
    terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
  })
  // Safe-close quiescence consistent with the fixture post-close delay.
  await new Promise((resolve) => setTimeout(resolve, 3000))

  let app = null as SecondSyncProfile['app'] | null
  try {
    app = await launchElectronApp({ userDataDir, ownedTmpRoot })
    const page = await waitForMainElectronWindow(app)
    const probed = await probeAndAssertRuntimeAppData(page, userDataDir)
    await bypassOnboarding(page)
    await seedMockProvider(page, mockPort)
    await waitForHomeReady(page)
    await assertChatDbReady(page)
    await assertTextareaReady(page)
    const relaunched: SecondSyncProfile = {
      app,
      page,
      userDataDir,
      runtimeAppDataPath: probed.runtimeAppDataPath,
      chatDbPath: probed.chatDbPath
    }
    // Strict verification BEFORE any repair: persisted config must match
    // exactly. No setConfig is invoked on this path.
    const current = await readRawSyncConfig(relaunched.page)
    assertPersistedSyncConfigStrict(current, expected)
    return relaunched
  } catch (error) {
    // Fail-closed: exact-clean the relaunched app; the launch token stays
    // registered so the owned-root teardown still owns it. The original error
    // is preserved (cleanup errors never mask it).
    try {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => (app ? app.close() : Promise.resolve()),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
    } catch {
      // Preserve the original failure; cleanup errors surface via the
      // still-registered token in the owned-root teardown.
    }
    throw error
  }
}
