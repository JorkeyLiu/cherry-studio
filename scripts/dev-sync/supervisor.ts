/**
 * Supervisor for `pnpm dev:sync` (runs once under the canonical Electron lane).
 *
 * The outer package script (`pnpm native:run electron -- tsx
 * scripts/dev-sync/cli.ts`) holds the checkout lane exactly once for the whole
 * dev session; every child below is spawned directly (no nested `native:run`,
 * no `ELECTRON_RUN_AS_NODE`) and reuses that lane:
 *
 * 1. fixture layout + marker + durable active-pair pointer (one-time adoption
 *    of the latest complete existing pair, then fixed; valid pointers are
 *    ALWAYS reused; corruption/missing/partial targets fail closed) +
 *    supervisor lock (duplicate `dev:sync` fails fast, never kills the old
 *    owner; a live owner blocks pointer adoption — the runner returns the
 *    blocker instead of mutating while live);
 * 2. fixed ports fail-fast (relay + CDP A/B);
 * 3. the SAME durable pair every run: `sessions/<active>/profile-a`,
 *    `profile-b`, `relay-data/relay.db` (+ adjacent attachment blobs). The
 *    app itself persists chat, assets, providers, settings, device auth,
 *    channel, cursor, outbox, and relay state exactly like a normal close.
 *    The runner performs NO settings-seed restore, NO settings snapshot, NO
 *    store injection, and NO sync endpoint/configure/connect override.
 *    Legacy v1 root dirs, retired seed files, and non-adopted sessions stay
 *    on disk untouched and their content is never read;
 * 4. relay runtime mirror + conditional `--prod --frozen-lockfile` install +
 *    an isolated better-sqlite3 probe from the relay runtime's own binding
 *    (ABI-independence proof without touching the root binding), then the
 *    relay child against the REUSED durable DB (address + device-code pairing
 *    only — no shared token exists);
 * 5. ONE canonical `electron-vite dev` child for profile A (owns the single
 *    shared renderer dev server; canonical `electron.vite.config.ts`, no
 *    ad-hoc Vite config), renderer URL discovered from its stdout;
 * 6. profile B launched as an OWNED raw Electron child at one explicit
 *    `--remote-debugging-port=<cdpB>` (`=` form) against the SAME renderer
 *    URL (shares HMR; no second Vite), then attached via
 *    `chromium.connectOverCDP` — never the managed Playwright Electron
 *    launch, which hardcodes `--remote-debugging-port=0` first (so the
 *    requested fixed port never binds) and installs
 *    `handleSIGINT/SIGTERM/SIGHUP` handlers that auto-close B on a
 *    supervisor SIGTERM before graceful detach can run;
 * 7. per-profile DIAGNOSTIC readiness only (persisted identity proof +
 *    window-runtime availability on the current route; no language, store,
 *    navigation, reload, onboarding bypass, or sync mutation). Sync stays
 *    exactly as the user left it in the app;
 * 8. Ctrl-C/TERM detaches CDP, forwards signals to exactly the owned
 *    children, and terminates exact-token profile leftovers — durable
 *    profiles, the relay DB, and the relay-runtime cache are NEVER deleted.
 *    An abnormal owned-child exit still shuts everything down.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import type { Browser, Page } from '@playwright/test'
import { chromium } from '@playwright/test'

import { findProcessesByUserDataDir, killProcess, waitForProcessExit } from '../../tests/e2e/utils/process-cleanup'
import type { DevSyncArgs } from './args'
import {
  DEV_SYNC_DEFAULT_RELAY_HOST,
  DEV_SYNC_LEGACY_PROFILE_A,
  DEV_SYNC_LEGACY_PROFILE_B,
  DEV_SYNC_LEGACY_RELAY_DATA_DIR,
  DEV_SYNC_SETTINGS_SEED_A_FILE,
  DEV_SYNC_SETTINGS_SEED_B_FILE
} from './constants'
import {
  acquireSupervisorLock,
  createSessionId,
  type DevSyncLayout,
  type DevSyncSessionLayout,
  ensureFixtureMarker,
  resolveActiveSessionLayout,
  resolveDevSyncLayout
} from './paths'
import { assertTcpPortFree } from './ports'
import {
  buildProfileBLaunchArgs,
  cdpEndpointUrl,
  describeCleanup,
  hasSingleExplicitCdpPort,
  snapshotAllBeforeTeardown
} from './processes'
import {
  buildRelayServerArgs,
  formatRelayEndpointLine,
  mirrorRelaySources,
  relayDbPath,
  relayEndpointUrl,
  relayServerEntry,
  stampRelayInstall
} from './relay-runtime'
import { formatProfileSummary, setupDevSyncProfile } from './setup-profile'

export interface SupervisorResult {
  exitCode: number
}

function logLine(text: string): void {
  process.stdout.write(`${text}\n`)
}

function logPrefixed(prefix: string, chunk: Buffer | string): void {
  const text = chunk.toString()
  for (const line of text.split('\n')) {
    if (line.length > 0) process.stdout.write(`${prefix} ${line}\n`)
  }
}

async function runOnce(command: string, args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`[dev-sync] ${command} ${args.join(' ')} exited ${code ?? signal}`))
    })
  })
}

/** Isolated SQL probe inside the relay runtime's own dependency cache. */
async function probeRelayBinding(runtimeDir: string): Promise<void> {
  const probe =
    `const Database = require('better-sqlite3');` +
    ` console.log('[dev-sync] relay binding: ' + require.resolve('better-sqlite3'));` +
    ` const db = new Database(':memory:');` +
    ` const row = db.prepare('select 1 as ok').get();` +
    ` if (!row || row.ok !== 1) throw new Error('probe mismatch');` +
    ` db.close(); console.log('[dev-sync] relay isolated SQL probe: PASS');`
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['-e', probe], { cwd: runtimeDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(`[dev-sync] relay binding probe failed: ${stderr.slice(0, 500)}`))
    })
  })
  if (output.includes(join('local', 'dev-sync', 'relay-runtime')) || output.includes('relay-runtime')) {
    for (const line of output.split('\n')) if (line.includes('relay binding:')) logLine(line.trim())
  } else {
    // Fail-closed: the probe must resolve the runtime's own binding, never root's.
    throw new Error('[dev-sync] relay probe did not resolve the isolated runtime binding; refusing relay startup')
  }
  logLine('[dev-sync] relay isolated SQL probe: PASS')
}

interface OwnedChildren {
  relay: ChildProcess | null
  viteDev: ChildProcess | null
  appBProc: ChildProcess | null
  browserA: Browser | null
  browserB: Browser | null
}

function spawnTracked(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; prefix: string },
  onUnexpectedExit: (name: string, code: number | null) => void,
  shuttingDown: () => boolean
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (chunk: Buffer) => logPrefixed(options.prefix, chunk))
  child.stderr?.on('data', (chunk: Buffer) => logPrefixed(options.prefix, chunk))
  child.once('exit', (code) => {
    if (!shuttingDown()) onUnexpectedExit(options.prefix, code)
  })
  return child
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise()
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      resolvePromise()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

/** Discover the shared renderer URL from the electron-vite dev child output. */
function discoverRendererUrl(child: ChildProcess, timeoutMs = 180000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const pattern = /http:\/\/(localhost|127\.0\.0\.1):(\d+)/
    const timer = setTimeout(
      () => rejectPromise(new Error('[dev-sync] timed out waiting for the dev server URL')),
      timeoutMs
    )
    const onData = (chunk: Buffer): void => {
      const match = pattern.exec(chunk.toString())
      if (match) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        resolvePromise(`http://${match[1]}:${match[2]}`)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(new Error(`[dev-sync] dev server exited before publishing its URL (code ${code})`))
    })
  })
}

async function waitForHttpOk(url: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok || response.status < 500) return
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) throw new Error(`[dev-sync] dev server URL not reachable: ${url}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
}

/** Owned raw Electron binary (the `electron` package entrypoint path). */
function resolveElectronBinary(): string {
  const require = createRequire(import.meta.url)
  const binary = require('electron') as unknown
  if (typeof binary !== 'string' || binary.length === 0) {
    throw new Error('[dev-sync] electron binary not found (expected the electron package entrypoint path)')
  }
  return binary
}

/**
 * Wait until the owned profile-B CDP endpoint serves `/json/version`.
 * Proves the requested fixed port is genuinely bound before attach and
 * before the startup line is printed (no false CDP link).
 */
async function waitForCdpReady(port: number, timeoutMs = 120000): Promise<void> {
  const url = `${cdpEndpointUrl(port)}/json/version`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) throw new Error(`[dev-sync] profile-B CDP not ready on 127.0.0.1:${port}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
}

async function findDevPage(browser: Browser, timeoutMs = 120000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const root = await page.$('#root, body')
          if (root) return page
        } catch {
          // Page not ready yet.
        }
      }
    }
    if (Date.now() >= deadline) throw new Error('[dev-sync] timed out attaching to a profile window')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
}

/**
 * Terminate leftover exact-token Electron processes for one owned profile
 * dir (the `electron-vite dev` child does not own the Electron app it
 * spawned, so SIGTERM to the vite child alone would orphan it). Exact-token
 * match only — never a substring scan, never a broad kill.
 */
async function terminateExactProfileProcesses(userDataDir: string, timeoutMs = 8000): Promise<number> {
  let stopped = 0
  let entries: { pid: number; args: string }[]
  try {
    entries = findProcessesByUserDataDir(userDataDir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    // Never signal ourselves or the supervisor chain.
    if (entry.pid === process.pid) continue
    const result = killProcess(entry.pid, 'SIGTERM')
    if (result.ok) {
      stopped++
      try {
        await waitForProcessExit(entry.pid, timeoutMs)
      } catch {
        // Best effort; the next start fails fast if the port is still held.
      }
    }
  }
  return stopped
}

export async function runDevSyncSupervisor(repoRoot: string, args: DevSyncArgs): Promise<SupervisorResult> {
  const layout: DevSyncLayout = resolveDevSyncLayout(repoRoot)
  const marker = ensureFixtureMarker(layout.fixtureFile)
  if (marker.migrated) {
    logLine('[dev-sync] fixture marker migrated v1 -> v2 in place (legacy profile/relay dirs left untouched, unused)')
  }
  const lock = acquireSupervisorLock(layout.lockFile)

  // ONE durable adopted pair (one-time adoption, then fixed). The run id is
  // ephemeral logs/ownership context only and never decides app dirs.
  const runId = createSessionId()
  const adopted = resolveActiveSessionLayout(layout)
  const session: DevSyncSessionLayout = adopted.session
  if (adopted.reused) {
    logLine(`[dev-sync] persistent session (reused durable pair): ${session.id}`)
  } else {
    logLine(`[dev-sync] persistent session (adopted durable pair): ${session.id}`)
  }
  logLine(`[dev-sync] run id (ephemeral, logs only): ${runId}`)
  logLine('[dev-sync] natural app persistence: profiles + relay DB reused as-is; no settings/sync injection')
  // Legacy presence is reported WITHOUT reading content (existence only).
  for (const legacy of [
    join(layout.root, DEV_SYNC_LEGACY_PROFILE_A),
    join(layout.root, DEV_SYNC_LEGACY_PROFILE_B),
    join(layout.root, DEV_SYNC_LEGACY_RELAY_DATA_DIR)
  ]) {
    if (existsSync(legacy)) {
      logLine(`[dev-sync] legacy v1 fixture path present and left untouched (content never read): ${legacy}`)
      break
    }
  }
  for (const retired of [
    join(layout.root, DEV_SYNC_SETTINGS_SEED_A_FILE),
    join(layout.root, DEV_SYNC_SETTINGS_SEED_B_FILE)
  ]) {
    if (existsSync(retired)) {
      logLine(`[dev-sync] retired settings seed present and ignored (content never read): ${retired}`)
      break
    }
  }

  const children: OwnedChildren = { relay: null, viteDev: null, appBProc: null, browserA: null, browserB: null }
  let shuttingDown = false
  let shutdownDone: Promise<void> = Promise.resolve()
  let exitCode = 0

  const shutdown = async (code: number, reason: string): Promise<void> => {
    if (shuttingDown) {
      await shutdownDone
      return
    }
    // Set synchronously: disables spawnTracked unexpected-exit callbacks at
    // once, and no Playwright-managed app remains that could auto-close B on
    // this signal (B is an owned child + CDP attach only). The app persists
    // on its own normal close path; the runner snapshots nothing.
    shuttingDown = true
    shutdownDone = (async (): Promise<void> => {
      logLine(`[dev-sync] shutting down (${reason})…`)
      const stops: string[] = []
      const teardownSteps: Array<() => Promise<void>> = [
        // Detach CDP only (never kills the apps).
        async (): Promise<void> => {
          if (children.browserB) {
            try {
              await children.browserB.close()
            } catch {
              // Best effort detach.
            }
            children.browserB = null
          }
        },
        async (): Promise<void> => {
          if (children.browserA) {
            try {
              await children.browserA.close()
            } catch {
              // Best effort detach.
            }
            children.browserA = null
          }
        },
        // Forward SIGTERM to exactly the owned children.
        async (): Promise<void> => {
          for (const child of [children.appBProc, children.viteDev, children.relay] as const) {
            if (child && child.exitCode === null) {
              try {
                child.kill('SIGTERM')
              } catch {
                // Already gone.
              }
            }
          }
        },
        async (): Promise<void> => {
          if (children.appBProc) {
            await waitForExit(children.appBProc, 8000)
            stops.push('profile-B app')
          }
          if (children.viteDev) {
            await waitForExit(children.viteDev, 8000)
            stops.push('dev server')
          }
          if (children.relay) {
            await waitForExit(children.relay, 8000)
            stops.push('relay')
          }
        },
        // The vite child never owns the Electron app it spawned: terminate any
        // exact-token leftovers per adopted profile (plus a B safety net for
        // helper processes). Exact tokens only; durable session data and the
        // relay-runtime cache are untouched.
        async (): Promise<void> => {
          const leftoversA = await terminateExactProfileProcesses(session.profileA)
          if (leftoversA > 0) stops.push(`profile-A leftovers (${leftoversA})`)
          else stops.push('profile-A app')
          const leftoversB = await terminateExactProfileProcesses(session.profileB)
          if (leftoversB > 0) stops.push(`profile-B leftovers (${leftoversB})`)
        }
      ]
      await snapshotAllBeforeTeardown([], teardownSteps)
      logLine(
        describeCleanup(stops, [
          `persistent session ${session.id} (profiles + relay DB preserved, never deleted)`,
          'retired seeds + legacy dirs + non-adopted sessions (untouched, content never read)',
          'relay-runtime cache (reusable)'
        ])
      )
      lock.release()
      exitCode = code
    })()
    await shutdownDone
  }

  const onUnexpectedExit = (name: string, code: number | null): void => {
    logLine(`[dev-sync] owned child exited abnormally (${name}, code ${code}); shutting all owned children down…`)
    void shutdown(1, `abnormal child exit (${name})`)
  }
  const isShuttingDown = (): boolean => shuttingDown
  process.once('SIGINT', () => {
    void shutdown(0, 'SIGINT (Ctrl-C)')
  })
  process.once('SIGTERM', () => {
    void shutdown(0, 'SIGTERM')
  })

  try {
    // Every step below runs under the supervisor lock: any failure funnels
    // through shutdown so the lock is always released (stale locks are only
    // ever reclaimed, never left by a startup failure).
    await assertTcpPortFree(DEV_SYNC_DEFAULT_RELAY_HOST, args.relayPort, 'relay')
    await assertTcpPortFree(DEV_SYNC_DEFAULT_RELAY_HOST, args.cdpA, 'profile-A CDP')
    await assertTcpPortFree(DEV_SYNC_DEFAULT_RELAY_HOST, args.cdpB, 'profile-B CDP')

    // Relay runtime: mirror newer sources every run; the durable relay DB is
    // never rewritten by the mirror step. The cache step touches ONLY the
    // relay runtime dir (mirror + install), never session/profile data.
    const { reinstall } = mirrorRelaySources(layout.repoRoot, layout.relayRuntimeDir)
    if (reinstall) {
      logLine('[dev-sync] installing isolated relay runtime dependencies (relay-runtime cache only)…')
      // --ignore-workspace keeps the relay runtime an independent manifest:
      // without it pnpm would walk up to the repository workspace. CI=true
      // keeps the non-interactive install from prompting on TTY-less runs.
      await runOnce('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-workspace'], layout.relayRuntimeDir, {
        CI: 'true'
      })
      stampRelayInstall(layout.relayRuntimeDir)
    } else {
      logLine('[dev-sync] relay runtime cache is current (manifest/lock match; install skipped)')
    }
    await probeRelayBinding(layout.relayRuntimeDir)

    // Relay child under plain pinned Node with the runtime's own binding,
    // against the REUSED durable DB. No shared token anywhere.
    const tsxCli = join(layout.relayRuntimeDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (!existsSync(tsxCli)) {
      throw new Error('[dev-sync] relay runtime tsx missing; reinstall the relay runtime cache')
    }
    const dbPath = relayDbPath(session.relayDataDir)
    children.relay = spawnTracked(
      process.execPath,
      [
        tsxCli,
        relayServerEntry(layout.relayRuntimeDir),
        ...buildRelayServerArgs(dbPath, DEV_SYNC_DEFAULT_RELAY_HOST, args.relayPort)
      ],
      { cwd: layout.relayRuntimeDir, prefix: '[relay]' },
      onUnexpectedExit,
      isShuttingDown
    )
    await waitForHttpOk(relayEndpointUrl(DEV_SYNC_DEFAULT_RELAY_HOST, args.relayPort), 30000)
    logLine(formatRelayEndpointLine(DEV_SYNC_DEFAULT_RELAY_HOST, args.relayPort))

    // Parity with `pnpm dev:run`: refresh the generated OpenAPI spec first.
    await runOnce('pnpm', ['generate:openapi'], layout.repoRoot)

    // ONE canonical dev server + profile A, owned by electron-vite.
    children.viteDev = spawnTracked(
      'pnpm',
      [
        'exec',
        'electron-vite',
        'dev',
        '--remoteDebuggingPort',
        String(args.cdpA),
        '--',
        `--user-data-dir=${session.profileA}`
      ],
      { cwd: layout.repoRoot, prefix: '[dev-A]' },
      onUnexpectedExit,
      isShuttingDown
    )
    const rendererUrl = await discoverRendererUrl(children.viteDev)
    await waitForHttpOk(rendererUrl, 120000)
    logLine(`[dev-sync] shared renderer URL: ${rendererUrl} (one dev server, two apps)`)

    // Profile B: owned raw Electron child at ONE explicit CDP port against
    // the SAME renderer URL (shares HMR; no second Vite). Fail-closed when
    // the argv would not carry exactly that port (never the managed-launch
    // `--remote-debugging-port=0` prefix, never a split flag/value pair).
    const profileBArgs = buildProfileBLaunchArgs(session.profileB, args.cdpB)
    if (!hasSingleExplicitCdpPort(profileBArgs, args.cdpB)) {
      throw new Error(
        `[dev-sync] refusing profile-B launch: CDP port argv mismatch (expected one --remote-debugging-port=${args.cdpB})`
      )
    }
    children.appBProc = spawnTracked(
      resolveElectronBinary(),
      profileBArgs,
      {
        cwd: layout.repoRoot,
        env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
        prefix: '[app-B]'
      },
      onUnexpectedExit,
      isShuttingDown
    )
    // Genuine fixed-port proof: the endpoint must serve BEFORE attach and
    // before any startup line names it (no false CDP link).
    await waitForCdpReady(args.cdpB, 120000)
    logLine(`[dev-sync] profile-B CDP ready: ${cdpEndpointUrl(args.cdpB)} (verified /json/version)`)
    const browserB = await chromium.connectOverCDP({
      endpointURL: cdpEndpointUrl(args.cdpB),
      timeout: 60000
    })
    children.browserB = browserB
    const pageB = await findDevPage(browserB)

    // Profile A via Playwright CDP attach (owned by the electron-vite child).
    const browserA = await chromium.connectOverCDP({
      endpointURL: cdpEndpointUrl(args.cdpA),
      timeout: 60000
    })
    children.browserA = browserA
    const pageA = await findDevPage(browserA)

    // Per-profile DIAGNOSTIC readiness only: persisted identity proof +
    // window-runtime availability on the current route. No store writes, no
    // navigation, no reload, no sync mutation. Sync stays exactly as the
    // user left it in the app.
    logLine('[dev-sync] verifying profile A (diagnostic readiness only)…')
    const resultA = await setupDevSyncProfile(pageA, {
      sessionId: session.id,
      expectedUserDataDir: session.profileA,
      label: 'A'
    })
    logLine(formatProfileSummary(resultA))
    logLine('[dev-sync] verifying profile B (diagnostic readiness only)…')
    const resultB = await setupDevSyncProfile(pageB, {
      sessionId: session.id,
      expectedUserDataDir: session.profileB,
      label: 'B'
    })
    logLine(formatProfileSummary(resultB))

    logLine('[dev-sync] both profiles live on the persistent pair. Sync/Settings stay as the app left them.')
    logLine(`[dev-sync] A CDP: http://127.0.0.1:${args.cdpA} | B CDP: http://127.0.0.1:${args.cdpB}`)

    // Park until a signal or an abnormal child exit resolves shutdown.
    await new Promise<void>((resolvePromise) => {
      const timer = setInterval(() => {
        if (shuttingDown) {
          clearInterval(timer)
          resolvePromise()
        }
      }, 250)
    })
    await shutdownDone
    return { exitCode }
  } catch (error) {
    logLine(`[dev-sync] failed: ${error instanceof Error ? error.message : String(error)}`)
    await shutdown(1, 'startup failure')
    return { exitCode: 1 }
  }
}
