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
export async function closeSecondSyncProfile(profile: SecondSyncProfile): Promise<void> {
  await closeElectronWithExactCleanup(profile.userDataDir, {
    close: () => profile.app.close(),
    findExactProcesses: findProcessesByUserDataDir,
    terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
  })
  unregisterProfileLaunchToken(profile.userDataDir)
}
