/**
 * Phase C — packaged Cherry Chat macOS arm64 isolation validation (IDENTITY-005/006).
 *
 * Launches the REAL packaged binary (dist/mac-arm64/Cherry Chat.app) via
 * Playwright `_electron.launch({ executablePath })` against an exact disposable
 * `--user-data-dir=<token>` under an ownership-safe temp root, and proves:
 *
 *   1. Packaged runtime identity (app.isPackaged, arch arm64).
 *   2. The explicit CLI `--user-data-dir` survives byte-for-byte (the Phase C
 *      precedence fix) — runtime appDataPath equals the disposable token and
 *      neither contains nor equals the Cherry Studio or default Cherry Chat
 *      profiles.
 *   3. Empty first launch: chat.db (when auto-created) has zero
 *      topics/messages/message_blocks.
 *   4. Visible main window identity where observable (window present, React
 *      root mounted; title resolves from the build-time identity to the exact
 *      `Cherry Chat` — IDENTITY-002).
 *   5. Same-profile single-instance: a second launch with the SAME token exits
 *      (exit 0) while the first instance stays alive.
 *   6. Zero mutation of the real Cherry Studio / default Cherry Chat profiles:
 *      existence + bounded metadata fingerprints are identical before/after
 *      (no content reads, no markers, no writes).
 *   7. Exact-token cleanup: no owned processes or profile leftovers remain.
 *
 * Safety: never invokes `open cherrychat://`, never modifies Launch Services
 * intentionally, never copies into /Applications, never uses broad
 * pkill/killall, never runs L2 import. The app's own `setAsDefaultProtocolClient`
 * registration and rtk-binary extraction are unavoidable packaged-runtime
 * behaviors that are observed but never invoked by this test.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import {
  actualCherryStudioProfilePath,
  canonicalPathsEqual,
  cherryStudioProfilePath,
  defaultCherryChatProfilePath,
  isForbiddenProfilePath,
  launchPackagedCherryChat,
  launchSecondInstance,
  macAppDataRoot,
  packagedExecutablePath,
  profileFingerprintsEqual,
  snapshotProfileFingerprint,
  waitForPackagedMainWindow
} from '../../utils/packaged-isolation'
import { findProcessesByUserDataDir, processExists, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { verifyChatDbWithBoundedRetry } from '../../utils/query-chat-db-electron'
import { createOwnedTmpRoot, removeOwnedTmpRoot, validateProfileLaunchToken } from '../../utils/run-ownership'

const IS_DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64'

test.describe('Cherry Chat packaged isolation (Phase C)', () => {
  test.skip(!IS_DARWIN_ARM64, 'IDENTITY-005: Phase C is macOS arm64 only')

  test('explicit --user-data-dir survives; empty first launch; same-profile lock; zero real-profile mutation', async () => {
    test.setTimeout(300_000)

    // --- Preconditions -----------------------------------------------------
    const executablePath = packagedExecutablePath()
    const ownedTmpRoot = createOwnedTmpRoot()

    let profileToken: string
    let app: Awaited<ReturnType<typeof launchPackagedCherryChat>> | null = null
    let firstMainPid: number | null = null
    let runtimeUserData: string | null = null

    const appSupportRoot = macAppDataRoot()

    // Bounded fingerprints BEFORE (existence + immediate metadata only).
    // Three real profiles are protected: the ADR guard form "Cherry Studio",
    // the ACTUAL Electron-derived "CherryStudio" default (the real Cherry
    // Studio profile on this machine), and the default "Cherry Chat" profile.
    const studioGuardBefore = snapshotProfileFingerprint(cherryStudioProfilePath(appSupportRoot))
    const studioActualBefore = snapshotProfileFingerprint(actualCherryStudioProfilePath(appSupportRoot))
    const chatBefore = snapshotProfileFingerprint(defaultCherryChatProfilePath(appSupportRoot))

    const cleanup = async (): Promise<void> => {
      if (app) {
        try {
          await closeElectronWithExactCleanup(profileToken, {
            close: () => app!.close(),
            findExactProcesses: findProcessesByUserDataDir,
            terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
          })
        } finally {
          app = null
        }
      }
      // Fail-closed owned-root removal: exact-cleans the profile and verifies
      // absence; on any failure the root is preserved and the error propagates.
      await removeOwnedTmpRoot(ownedTmpRoot, [profileToken])
    }

    try {
      // --- Disposable profile ----------------------------------------------
      profileToken = path.join(ownedTmpRoot, 'cherry-chat-packaged-profile')
      validateProfileLaunchToken(ownedTmpRoot, profileToken, true)

      // --- Launch the packaged app -----------------------------------------
      console.log(`[E2E] Launching packaged Cherry Chat with --user-data-dir=${profileToken}`)
      app = await launchPackagedCherryChat({ executablePath, userDataDir: profileToken, ownedTmpRoot })
      firstMainPid = app.process().pid ?? null
      expect(firstMainPid, 'packaged main process PID is observable').not.toBeNull()
      const mainWindow = await waitForPackagedMainWindow(app)

      // --- Runtime identity: renderer getAppInfo() -------------------------
      const appInfo = await mainWindow.evaluate(async () => {
        const api = (window as any).api
        const info = await api.getAppInfo()
        return info
      })
      console.log('[E2E] renderer getAppInfo():', JSON.stringify(appInfo))
      expect(appInfo.isPackaged, 'packaged runtime (isPackaged=true)').toBe(true)
      expect(appInfo.arch, 'arm64 runtime (IDENTITY-005)').toBe('arm64')
      expect(
        canonicalPathsEqual(String(appInfo.appDataPath), profileToken),
        `runtime appDataPath (${appInfo.appDataPath}) equals the exact disposable --user-data-dir token`
      ).toBe(true)
      expect(
        isForbiddenProfilePath(String(appInfo.appDataPath), appSupportRoot),
        'runtime appDataPath is not any real Cherry Studio / default Cherry Chat profile'
      ).toBe(false)
      expect(
        String(appInfo.appDataPath).split(/[\\/]/).includes('Cherry Studio') === false &&
          String(appInfo.appDataPath).split(/[\\/]/).includes('CherryStudio') === false &&
          String(appInfo.appDataPath).split(/[\\/]/).includes('Cherry Chat') === false,
        'runtime appDataPath contains no Cherry Studio / Cherry Chat path segment'
      ).toBe(true)

      // --- Runtime identity: main-process probe ----------------------------
      const mainInfo = await app.evaluate(({ app }) => ({
        isPackaged: app.isPackaged,
        userData: app.getPath('userData'),
        name: app.getName(),
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        hasUserDataDirSwitch: app.commandLine.hasSwitch('user-data-dir'),
        argv: process.argv
      }))
      console.log('[E2E] main-process probe:', JSON.stringify(mainInfo))
      expect(mainInfo.isPackaged, 'main-process isPackaged=true').toBe(true)
      expect(mainInfo.arch, 'main-process arch=arm64').toBe('arm64')
      expect(
        canonicalPathsEqual(mainInfo.userData, profileToken),
        `main-process userData (${mainInfo.userData}) equals the exact disposable token`
      ).toBe(true)
      expect(
        mainInfo.argv.includes(`--user-data-dir=${profileToken}`),
        'main-process argv carries the exact --user-data-dir token'
      ).toBe(true)
      expect(
        mainInfo.userData.includes('Cherry Studio') === false &&
          mainInfo.userData.includes('CherryStudio') === false &&
          mainInfo.userData.includes('Cherry Chat') === false,
        'main-process userData contains no Cherry Studio / Cherry Chat path segment'
      ).toBe(true)
      runtimeUserData = mainInfo.userData

      // --- Visible main window identity (IDENTITY-002) ----------------------
      // waitForPackagedMainWindow already waited for the EXACT identity-derived
      // title `Cherry Chat`, so this re-read is deterministic and asserts the
      // exact value — not a substring match.
      const title = await mainWindow.title()
      console.log(`[E2E] main window title: "${title}"`)
      expect(title, 'main window title is exactly "Cherry Chat" (IDENTITY-002)').toBe('Cherry Chat')
      // The React root is attached before children mount; wait bounded so the
      // assertion is deterministic regardless of first-boot renderer timing.
      await mainWindow.waitForFunction(
        () => {
          const root = document.querySelector('#root')
          return root !== null && root.children.length > 0
        },
        undefined,
        { timeout: 60000 }
      )
      const hasReactRoot = await mainWindow.evaluate(() => {
        const root = document.querySelector('#root')
        return root !== null && root.children.length > 0
      })
      expect(hasReactRoot, 'main window React root is mounted').toBe(true)

      // --- Same-profile single-instance lock --------------------------------
      // The second instance shares the EXACT disposable profile token, so
      // requestSingleInstanceLock() fails and it must exit on its own (0).
      console.log('[E2E] Spawning same-profile second instance...')
      const second = await launchSecondInstance({ executablePath, userDataDir: profileToken, ownedTmpRoot })
      console.log('[E2E] second instance result:', JSON.stringify(second))
      expect(second.spawnError, 'second instance spawned without error').toBeNull()
      expect(second.exitedInTime, 'second instance exited within the bounded window').toBe(true)
      expect(second.exitCode, 'same-profile second launch exits 0 (single-instance lock)').toBe(0)

      // First instance must still be alive and still hold the profile token.
      expect(firstMainPid, 'first instance PID recorded').not.toBeNull()
      expect(processExists(firstMainPid!), 'first instance stays alive after the second exits').toBe(true)
      const stillHolding = findProcessesByUserDataDir(profileToken).some((p) => p.pid === firstMainPid)
      expect(stillHolding, 'first instance still holds the exact profile token').toBe(true)

      // --- Close the first instance (exact-token cleanup) -------------------
      await closeElectronWithExactCleanup(profileToken, {
        close: () => app!.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      app = null

      // --- Empty chat state (post-close, WAL checkpointed) -------------------
      expect(runtimeUserData, 'runtime userData recorded from the main-process probe').not.toBeNull()
      const chatDbPath = path.join(runtimeUserData!, 'Data', 'chat.db')
      if (fs.existsSync(chatDbPath)) {
        const outcome = await verifyChatDbWithBoundedRetry(chatDbPath, ownedTmpRoot, {
          electronPath: require('electron') as string,
          betterSqlitePath: require.resolve('better-sqlite3')
        })
        expect(
          outcome.ok,
          `chat.db verification succeeded (code: ${outcome.ok ? 'ok' : (outcome as { code: string }).code})`
        ).toBe(true)
        if (outcome.ok) {
          console.log('[E2E] post-close chat.db counts:', JSON.stringify(outcome.value.counts))
          expect(outcome.value.counts.topics, 'zero topics on first launch').toBe(0)
          expect(outcome.value.counts.messages, 'zero messages on first launch').toBe(0)
          expect(outcome.value.counts.message_blocks, 'zero message_blocks on first launch').toBe(0)
        }
      } else {
        console.log(
          '[E2E] chat.db was not auto-created under the disposable profile; empty state is vacuously satisfied'
        )
      }

      // --- Real profiles must be untouched ---------------------------------
      const studioGuardAfter = snapshotProfileFingerprint(cherryStudioProfilePath(appSupportRoot))
      const studioActualAfter = snapshotProfileFingerprint(actualCherryStudioProfilePath(appSupportRoot))
      const chatAfter = snapshotProfileFingerprint(defaultCherryChatProfilePath(appSupportRoot))
      console.log(
        '[E2E] Cherry Studio (guard form) profile fingerprint before/after:',
        JSON.stringify({ before: studioGuardBefore, after: studioGuardAfter })
      )
      console.log(
        '[E2E] Cherry Studio (actual Electron-derived) profile fingerprint before/after:',
        JSON.stringify({ before: studioActualBefore, after: studioActualAfter })
      )
      console.log(
        '[E2E] Cherry Chat default profile fingerprint before/after:',
        JSON.stringify({ before: chatBefore, after: chatAfter })
      )
      expect(
        profileFingerprintsEqual(studioGuardBefore, studioGuardAfter),
        'Cherry Studio (guard form) profile is not created, modified, or deleted (fingerprint identical)'
      ).toBe(true)
      expect(
        profileFingerprintsEqual(studioActualBefore, studioActualAfter),
        'actual Cherry Studio profile is not created, modified, or deleted (fingerprint identical)'
      ).toBe(true)
      expect(
        profileFingerprintsEqual(chatBefore, chatAfter),
        'default Cherry Chat profile is not created, modified, or deleted (fingerprint identical)'
      ).toBe(true)

      // --- Final exact cleanup + absence verification ------------------------
      await removeOwnedTmpRoot(ownedTmpRoot, [profileToken])
      console.log('[E2E] owned tmp root removed; no owned process/profile leftovers')
    } catch (error) {
      await cleanup().catch((cleanupError) => {
        throw new AggregateError(
          [error instanceof Error ? error : new Error(String(error)), cleanupError as Error],
          'Packaged isolation test failed AND cleanup failed (owned root preserved)'
        )
      })
      throw error
    }
  })
})
