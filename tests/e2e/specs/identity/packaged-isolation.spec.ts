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
 *   3. Fresh-default first launch (NO history): chat.db has exactly ONE
 *      empty initial topic for the persisted default ordinary assistant
 *      (`id=default`) — topics=1, messages/message_blocks/segments=0, no
 *      extra/recovered/imported topic. Accepted contract: 0fc7448eff Sep 26
 *      fix(chat): initialize fresh topics before loading, exercised by
 *      tests/e2e/specs/startup/fresh-profile-boot.spec.ts lines 61-103
 *      (Redux default assistant/topic + Main row 1). This REPLACES the stale
 *      Aug 7 zero-topic oracle (introduced in 7c33e0389a, topic-0 postclose)
 *      which predates the Sep 26 fresh-bootstrap fix. The Oct 6 branch
 *      commit 2065380b25 (jorkey/feat/multi-device-sync, ensure default
 *      topics for empty assistants) is NOT an ancestor of the current HEAD
 *      and is deliberately NOT merged/cherry-picked/implemented here.
 *   4. Visible main window identity where observable (window present, React
 *      root mounted; title resolves from the build-time identity to the exact
 *      `Cherry Chat` — IDENTITY-002).
 *   5. Same-profile single-instance: a second launch with the SAME token exits
 *      (exit 0) while the first instance stays alive.
 *   5b. Packaged native runtime: better-sqlite3 loads from the ACTUAL
 *      packaged Resources/app.asar context (`:memory:` select 1 + close),
 *      driver version 13.0.3, binding under app.asar.unpacked (not the repo),
 *      and signing-normalized payload provenance: the packaged prebuild is an
 *      adhoc re-sign of the locked repo 13.0.3 Node prebuilt (same Mach-O
 *      UUID, same signature offset), so raw full-file SHA256 differs by the
 *      signature delta while the normalized pre-signature payload SHA256
 *      (generic Mach-O parser, __LINKEDIT/code-signature size fields zeroed)
 *      is exactly equal. Never claims full-byte identity.
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
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
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
  provenanceOfMachOPrebuilt,
  snapshotProfileFingerprint,
  waitForPackagedMainWindow
} from '../../utils/packaged-isolation'
import { findProcessesByUserDataDir, processExists, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { queryChatDbWithBoundedRetry, verifyChatDbWithBoundedRetry } from '../../utils/query-chat-db-electron'
import { createOwnedTmpRoot, removeOwnedTmpRoot, validateProfileLaunchToken } from '../../utils/run-ownership'

const IS_DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64'

test.describe('Cherry Chat packaged isolation (Phase C)', () => {
  test.skip(!IS_DARWIN_ARM64, 'IDENTITY-005: Phase C is macOS arm64 only')

  test('explicit --user-data-dir survives; fresh default topic/no-history first launch; same-profile lock; zero real-profile mutation', async () => {
    test.setTimeout(300_000)

    // --- Preconditions -----------------------------------------------------
    const executablePath = packagedExecutablePath()
    const ownedTmpRoot = createOwnedTmpRoot()

    let profileToken: string
    let app: Awaited<ReturnType<typeof launchPackagedCherryChat>> | null = null
    let firstMainPid: number | null = null
    let runtimeUserData: string | null = null
    let initialTopic: { assistantId: string; topicId: string; topicName: string } | null = null

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

      // --- Fresh-bootstrap readiness: stable initial topic (read-only wait) ---
      // Accepted contract 0fc7448eff (Sep 26): on a truly fresh profile the
      // app creates ONE empty initial topic for the persisted default
      // ordinary assistant (`id=default`) BEFORE the ordinary tree is ready.
      // This oracle WAITS for that bootstrap completion through the stable
      // Main topic availability — it never ensures/creates/mutates topics
      // itself (no ensureTopic, no branch fix 2065380b25 logic).
      await mainWindow.waitForFunction(
        () => {
          const s = (window as any).store?.getState?.()
          const assistant =
            s?.assistants?.assistants?.find?.((a: any) => a.id === 'default') ?? s?.assistants?.assistants?.[0]
          const topic = assistant?.topics?.[0]
          return (
            assistant?.id === 'default' &&
            typeof topic?.id === 'string' &&
            topic.id.length > 0 &&
            typeof topic?.name === 'string' &&
            topic.name.length > 0
          )
        },
        undefined,
        { timeout: 120000 }
      )
      const firstRead = await mainWindow.evaluate(() => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.id === 'default') ?? s.assistants.assistants[0]
        const topic = assistant?.topics?.[0]
        return {
          assistantId: assistant?.id ?? '',
          topicId: topic?.id ?? '',
          topicName: topic?.name ?? ''
        }
      })
      expect(firstRead.assistantId, 'initial assistant is the persisted default ordinary assistant').toBe('default')
      expect(firstRead.topicId.length, 'initial topic ID is present').toBeGreaterThan(0)
      // Translated values — never the raw i18n keys (same contract as the
      // startup fresh-profile-boot spec).
      expect(firstRead.topicName, 'initial topic name is translated').not.toBe('chat.default.topic.name')
      expect(firstRead.topicName.length, 'initial topic name is present').toBeGreaterThan(0)
      // Bounded wait for the stable Main topic availability (readonly
      // topicExists polls only — never mutate/ensure/recreate). Fail-closed:
      // a timeout throws and the test fails, it never polls failure away.
      const bootstrapDeadline = Date.now() + 60000
      let topicReady = false
      while (Date.now() < bootstrapDeadline) {
        const existsResult = await mainWindow.evaluate(
          async ({ topicId }: { topicId: string }) => {
            return (window as any).api.chatDb.topicExists({ topicId })
          },
          { topicId: firstRead.topicId }
        )
        if (existsResult?.ok === true && existsResult?.value === true) {
          topicReady = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(topicReady, 'fresh-bootstrap Main topic is available (topicExists=true within the bounded window)').toBe(
        true
      )
      // Stability: re-read Redux and require the SAME initial topic ID (the
      // captured ID is stable, not a transient render).
      const secondRead = await mainWindow.evaluate(() => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.id === 'default') ?? s.assistants.assistants[0]
        const topic = assistant?.topics?.[0]
        return {
          assistantId: assistant?.id ?? '',
          topicId: topic?.id ?? '',
          topicName: topic?.name ?? ''
        }
      })
      expect(secondRead.topicId, 'stable initial topic ID across the readiness wait').toBe(firstRead.topicId)
      expect(secondRead.assistantId, 'stable initial assistant stays the default').toBe('default')
      // Live Main row proof (readonly, own isolated profile only): the exact
      // initial topic resolves in Main with zero messages.
      const liveRaw = await mainWindow.evaluate(
        async ({ topicId }: { topicId: string }) => {
          return (window as any).api.chatDb.getRawTopic({ topicId })
        },
        { topicId: firstRead.topicId }
      )
      expect(liveRaw?.ok, 'live getRawTopic succeeds for the initial topic').toBe(true)
      expect(liveRaw?.value?.id, 'live Main row matches the stable initial topic ID').toBe(firstRead.topicId)
      expect(liveRaw?.value?.messages?.length ?? -1, 'live initial topic carries no messages').toBe(0)
      initialTopic = { assistantId: firstRead.assistantId, topicId: firstRead.topicId, topicName: firstRead.topicName }

      // --- Packaged native runtime (better-sqlite3 13.0.3 immutable prebuild) --
      // Proves the ACTUAL packaged app loads better-sqlite3 from its own
      // Resources/app.asar package context (never the repo checkout), real
      // `:memory:` SQL succeeds, the driver version is the locked 13.0.3, the
      // binding lives under app.asar.unpacked, and its bytes match the locked
      // repo 13.0.3 Node prebuilt (same SHA256, necessarily different absolute
      // path). `:memory:` only — no prod DB is touched.
      // True packaged-app loader: the actual electron module arrives as the
      // first arg (never globalThis.require, which is undefined in the utility
      // eval world). createRequire is anchored at app.getAppPath() so the
      // default 13.0.3 driver resolves from the ACTUAL packaged Resources/app
      // root. Self-contained (no closure capture, no import.meta.url).
      // Per the actual better-sqlite3 13 source, getPrebuildPath() returns the
      // LOGICAL app.asar path (path.join(__dirname, '..', 'prebuilds', ...));
      // the Electron driver loader maps the .node to app.asar.unpacked
      // transparently at load time — so the probe returns the logical path and
      // the runner maps it to the physical unpacked file for existence/hash.
      // :memory: SQL + close only — no prod DB is touched.
      const packagedNative = (await app.evaluate(({ app: packagedApp }) => {
        const proc = process as unknown as {
          getBuiltinModule?: (id: string) => unknown
        }
        const getBuiltin = proc.getBuiltinModule
        if (typeof getBuiltin !== 'function') {
          throw new Error(
            'packaged-isolation.spec: process.getBuiltinModule is unavailable in the packaged main process'
          )
        }
        const nodePath = getBuiltin.call(proc, 'path') as typeof import('node:path')
        const nodeFs = getBuiltin.call(proc, 'fs') as typeof import('node:fs')
        const nodeCrypto = getBuiltin.call(proc, 'crypto') as typeof import('node:crypto')
        const { createRequire } = getBuiltin.call(proc, 'module') as typeof import('node:module')
        const appPath = packagedApp.getAppPath()
        const isPackaged = packagedApp.isPackaged
        try {
          // True actual app module load anchored at the packaged app root —
          // never the repo NODE_PATH (the launch env sets no NODE_PATH).
          const appRequire = createRequire(nodePath.join(appPath, 'package.json'))
          const pkgPath = appRequire.resolve('better-sqlite3/package.json') as unknown as string
          const pkgRoot = nodePath.dirname(pkgPath)
          const bindingMod = appRequire(nodePath.join(pkgRoot, 'lib', 'binding.js')) as {
            getPrebuildPath(): string | null
          }
          const candidate = bindingMod.getPrebuildPath()
          if (!candidate) {
            return {
              ok: false,
              sqlOk: false,
              version: 'unknown',
              bindingPath: '',
              hash: '',
              appPath,
              isPackaged,
              error: 'no-prebuild-selected'
            }
          }
          const real = nodeFs.realpathSync(candidate)
          const DatabaseCtor = appRequire('better-sqlite3') as new (
            file: string
          ) => {
            prepare(sql: string): { get(): { ok: number } | undefined }
            close(): void
          }
          const pkg = appRequire(pkgPath) as { version: string }
          const db = new DatabaseCtor(':memory:')
          try {
            const row = db.prepare('select 1 as ok').get()
            const sqlOk = !!row && row.ok === 1
            const hash = nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(real)).digest('hex')
            return { ok: sqlOk, sqlOk, version: pkg.version, bindingPath: real, hash, appPath, isPackaged }
          } finally {
            db.close()
          }
        } catch (error) {
          return {
            ok: false,
            sqlOk: false,
            version: 'unknown',
            bindingPath: '',
            hash: '',
            appPath,
            isPackaged,
            error: String(error)
          }
        }
      })) as unknown as {
        ok: boolean
        sqlOk: boolean
        version: string
        bindingPath: string
        hash: string
        appPath: string
        isPackaged: boolean
        error?: string
      }
      // Privacy-safe diagnostic: bounded numerics/booleans only, no paths.
      console.log(
        '[E2E] packaged native runtime:',
        JSON.stringify({
          isPackaged: packagedNative.isPackaged,
          version: packagedNative.version,
          sqlOk: packagedNative.sqlOk,
          ok: packagedNative.ok
        })
      )
      expect(packagedNative.isPackaged, 'packaged native probe runs packaged').toBe(true)
      expect(packagedNative.error ?? null, 'packaged native probe has no error').toBeNull()
      expect(packagedNative.ok, 'packaged `:memory:` select 1 succeeds').toBe(true)
      expect(packagedNative.sqlOk, 'packaged SQL returns ok=1').toBe(true)
      expect(packagedNative.version, 'packaged driver version is the locked 13.0.3').toBe('13.0.3')

      // Locked repo 13.0.3 Node prebuilt baseline (runner-cwd CJS loader —
      // same convention as startup/native-runtime.spec.ts; no import.meta.url).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const runnerRequire = createRequire(path.join(process.cwd(), 'package.json'))
      const repoPkgPath = runnerRequire.resolve('better-sqlite3/package.json') as unknown as string
      const repoRoot = path.dirname(repoPkgPath)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const repoBindingMod = runnerRequire(`${repoRoot}/lib/binding.js`) as {
        getPrebuildPath(): string | null
      }
      const repoCandidate = repoBindingMod.getPrebuildPath()
      expect(repoCandidate, 'repo default loader selects a prebuilt').not.toBeNull()
      const repoReal = fs.realpathSync(repoCandidate!)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const repoPkg = runnerRequire('better-sqlite3/package.json') as { version: string }
      expect(repoPkg.version, 'repo driver version is the locked 13.0.3').toBe('13.0.3')
      const repoHash = createHash('sha256').update(fs.readFileSync(repoReal)).digest('hex')

      // The logical binding lives inside the packaged Resources/app.asar tree
      // (per the actual 13 getPrebuildPath source); the Electron driver loader
      // maps the .node to app.asar.unpacked transparently at load time. So the
      // probe path is asserted LOGICAL (inside app.asar, never the repo), and
      // the physical unpacked mapping is asserted for existence + byte hash.
      const resourcesRoot = path.join(path.dirname(path.dirname(executablePath)), 'Resources')
      const expectedUnpacked = path.join(
        resourcesRoot,
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        'darwin-arm64.node'
      )
      expect(fs.existsSync(expectedUnpacked), 'physical unpacked prebuild exists under app.asar.unpacked').toBe(true)
      expect(
        packagedNative.bindingPath.includes('app.asar'),
        'packaged binding resolves inside the packaged app.asar tree (logical path)'
      ).toBe(true)
      expect(packagedNative.bindingPath, 'packaged binding is not the repo file').not.toBe(repoReal)
      expect(
        packagedNative.bindingPath.startsWith(fs.realpathSync(repoRoot)),
        'packaged binding is not inside the repo checkout'
      ).toBe(false)
      // Map the logical app.asar path to its physical app.asar.unpacked file
      // (already-unpacked form passes through unchanged).
      const physicalBindingPath = packagedNative.bindingPath.includes('app.asar.unpacked')
        ? packagedNative.bindingPath
        : packagedNative.bindingPath.replace('app.asar', 'app.asar.unpacked')
      expect(
        physicalBindingPath.includes('app.asar.unpacked'),
        'physical binding mapping points at the unpacked filesystem'
      ).toBe(true)
      expect(
        canonicalPathsEqual(physicalBindingPath, expectedUnpacked),
        'physical binding is the expected unpacked darwin-arm64 prebuild'
      ).toBe(true)
      expect(fs.existsSync(physicalBindingPath), 'mapped physical unpacked prebuild exists').toBe(true)
      // Byte proof, not filenames alone: re-hash the PHYSICAL unpacked file
      // from the runner (plain Node cannot read the logical asar path) and
      // require equality with the packaged probe hash. The packaged prebuild
      // is an adhoc re-sign of the locked repo 13.0.3 prebuilt (same Mach-O
      // UUID, same LC_CODE_SIGNATURE offset, larger signature blob), so raw
      // full-file SHA256 values DIFFER by exactly the signature delta and
      // must NOT be asserted equal. Provenance is instead the
      // signing-normalized pre-signature payload hash (generic Mach-O
      // load-command parser zeroes only __LINKEDIT vmsize/filesize and
      // LC_CODE_SIGNATURE datasize; no temp copies, no re-signing, no
      // mutation of either binary). A tmp-copy + `codesign
      // --remove-signature` normalization was rejected: it leaves the
      // original __LINKEDIT vmsize pad behind, so unsigned copies still hash
      // differently. Equal normalized hashes prove code/data payload
      // continuity (more than UUID alone) without claiming full-byte
      // identity.
      const packagedBytesHash = createHash('sha256').update(fs.readFileSync(physicalBindingPath)).digest('hex')
      expect(packagedBytesHash, 'physical unpacked bytes match the packaged probe hash').toBe(packagedNative.hash)
      const repoProvenance = provenanceOfMachOPrebuilt(repoReal)
      const packagedProvenance = provenanceOfMachOPrebuilt(physicalBindingPath)
      expect(repoProvenance.rawHash, 'repo provenance raw hash matches the locked prebuilt hash').toBe(repoHash)
      expect(packagedProvenance.rawHash, 'packaged provenance raw hash matches the packaged probe hash').toBe(
        packagedNative.hash
      )
      expect(packagedProvenance.uuid, 'packaged prebuild carries the same Mach-O UUID as the repo prebuild').toBe(
        repoProvenance.uuid
      )
      expect(
        packagedProvenance.dataOff,
        'packaged signature offset matches the repo prebuild (same LC_CODE_SIGNATURE dataoff)'
      ).toBe(repoProvenance.dataOff)
      expect(
        packagedProvenance.fileSize - repoProvenance.fileSize,
        'file-size delta equals the signature-size delta (size growth is signature-only)'
      ).toBe(packagedProvenance.dataSize - repoProvenance.dataSize)
      expect(
        packagedProvenance.normalizedHash,
        'signing-normalized payload matches the locked repo 13.0.3 prebuilt (same code/data bytes)'
      ).toBe(repoProvenance.normalizedHash)
      console.log(
        '[E2E] packaged native runtime bytes:',
        JSON.stringify({
          version: packagedNative.version,
          uuid: packagedProvenance.uuid,
          dataOff: packagedProvenance.dataOff,
          rawMatch: packagedProvenance.rawHash === repoProvenance.rawHash,
          normalizedMatch: packagedProvenance.normalizedHash === repoProvenance.normalizedHash
        })
      )

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

      // --- Fresh-default chat state (post-close, WAL checkpointed) ------------
      // Accepted contract 0fc7448eff: exactly ONE empty initial topic owned
      // by the default ordinary assistant — never zero rows (stale Aug 7
      // oracle), never `<=1`/arbitrary-one, never an extra/recovered/
      // imported topic. chat.db MUST exist: the live readiness wait above
      // already proved Main topic availability, so absence fails closed.
      expect(runtimeUserData, 'runtime userData recorded from the main-process probe').not.toBeNull()
      expect(initialTopic, 'stable initial topic captured live before close').not.toBeNull()
      const chatDbPath = path.join(runtimeUserData!, 'Data', 'chat.db')
      expect(fs.existsSync(chatDbPath), 'chat.db auto-created under the disposable profile').toBe(true)
      const outcome = await verifyChatDbWithBoundedRetry(chatDbPath, ownedTmpRoot, {
        electronPath: require('electron') as string,
        betterSqlitePath: require.resolve('better-sqlite3')
      })
      expect(
        outcome.ok,
        `chat.db verification succeeded (code: ${outcome.ok ? 'ok' : (outcome as { code: string }).code})`
      ).toBe(true)
      if (outcome.ok) {
        // Privacy-safe diagnostic: bounded counts only, no IDs/names/paths.
        console.log('[E2E] post-close chat.db counts:', JSON.stringify(outcome.value.counts))
        expect(outcome.value.counts.topics, 'exactly one fresh-default initial topic').toBe(1)
        expect(outcome.value.counts.messages, 'zero messages on first launch').toBe(0)
        expect(outcome.value.counts.message_blocks, 'zero message_blocks on first launch').toBe(0)
        expect(outcome.value.counts.topic_segments, 'zero topic_segments on first launch').toBe(0)
        expect(outcome.value.counts.topic_segment_messages, 'zero topic_segment_messages on first launch').toBe(0)
        expect(outcome.value.counts.file_references, 'zero file_references on first launch').toBe(0)
        expect(outcome.value.deletedTopics, 'no soft-deleted topics on first launch').toBe(0)
        // Owner/identity proof: the ONLY topic row carries the stable live
        // ID, belongs to the default ordinary assistant, and keeps the
        // translated live name. Selecting ALL rows proves no extra topic.
        const rowOutcome = await queryChatDbWithBoundedRetry(
          chatDbPath,
          'SELECT id, assistant_id, name FROM topics',
          ownedTmpRoot,
          {
            electronPath: require('electron') as string,
            betterSqlitePath: require.resolve('better-sqlite3')
          }
        )
        expect(
          rowOutcome.ok,
          `topic row query succeeded (code: ${rowOutcome.ok ? 'ok' : (rowOutcome as { code: string }).code})`
        ).toBe(true)
        if (rowOutcome.ok) {
          const rows = rowOutcome.rows as Array<{ id: unknown; assistant_id: unknown; name: unknown }>
          expect(rows.length, 'exactly one topic row total (no extra/recovered/imported topic)').toBe(1)
          const idMatch = rows[0]?.id === initialTopic!.topicId
          const ownerMatch = rows[0]?.assistant_id === 'default' && initialTopic!.assistantId === 'default'
          const nameMatch = rows[0]?.name === initialTopic!.topicName
          // Privacy-safe diagnostic: match booleans only, never row content.
          console.log('[E2E] post-close topic owner proof:', JSON.stringify({ idMatch, ownerMatch, nameMatch }))
          expect(idMatch, 'post-close topic row matches the stable live initial topic ID').toBe(true)
          expect(ownerMatch, 'post-close topic row is owned by the default ordinary assistant').toBe(true)
          expect(nameMatch, 'post-close topic row keeps the translated live topic name').toBe(true)
        }
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
