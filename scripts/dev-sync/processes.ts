/**
 * Owned-process selection for `pnpm dev:sync` cleanup.
 *
 * Cleanup stops exactly the children this supervisor started (tracked PIDs
 * plus exact `--user-data-dir=<dir>` argv tokens) and NEVER deletes
 * persistent fixture state (profiles, relay DB/token, runtime cache).
 * Matching is exact-token only: a substring scan would risk touching a real
 * user profile whose path merely shares a prefix.
 *
 * Profile B launches as an OWNED raw Electron child at one explicit
 * `--remote-debugging-port=<port>` (`=` form, never `=0`, never a split
 * flag/value pair) and attaches via `chromium.connectOverCDP`: the managed
 * Playwright Electron launch hardcodes `--remote-debugging-port=0` first
 * (playwright-core `electron/electron.js`), so a requested fixed port is
 * never actually bound, and its `handleSIGINT/SIGTERM/SIGHUP` process
 * handlers auto-close the app on a supervisor SIGTERM before the settings
 * snapshot can run. The helpers below keep that launch contract unit-pinned,
 * plus the snapshot-before-teardown ordering the graceful stop relies on.
 */

export function userDataDirArg(dir: string): string {
  return `--user-data-dir=${dir}`
}

/** True only when argv carries the exact `--user-data-dir=<dir>` token. */
export function argvHasExactUserDataDir(argv: readonly string[], dir: string): boolean {
  return argv.includes(userDataDirArg(dir))
}

export interface ProcessEntry {
  pid: number
  argv: string[]
}

/**
 * Select exactly the processes belonging to the owned profile dirs.
 * PID tracking is preferred; argv exact-token match is the fallback probe.
 * Never matches by substring.
 */
export function selectOwnedProcesses(processes: readonly ProcessEntry[], ownedDirs: readonly string[]): ProcessEntry[] {
  return processes.filter((proc) => ownedDirs.some((dir) => argvHasExactUserDataDir(proc.argv, dir)))
}

/**
 * Terminal-safe cleanup summary: names exactly what is stopped and exactly
 * what is preserved. Carries no secret and no real-user path.
 */
export function describeCleanup(stopped: readonly string[], preservedLabels: readonly string[]): string {
  return [
    `[dev-sync] stopped owned children: ${stopped.length > 0 ? stopped.join(', ') : '(none)'}`,
    `[dev-sync] preserved persistent fixture state (never deleted): ${preservedLabels.join(', ')}`
  ].join('\n')
}

/**
 * Owned profile-B Electron argv: app root + exact profile token + ONE
 * explicit `=`-form remote-debugging port. Never includes the Playwright
 * managed-launch `--remote-debugging-port=0` prefix and never uses the
 * split `--remote-debugging-port <port>` pair (Chromium keeps the first
 * occurrence, so a leading `=0` would win and the requested fixed port
 * would never bind).
 */
export function buildProfileBLaunchArgs(profileBDir: string, cdpPort: number): string[] {
  return ['.', userDataDirArg(profileBDir), `--remote-debugging-port=${cdpPort}`]
}

/** Loopback CDP endpoint for a fixed port (probed before attach, then logged). */
export function cdpEndpointUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * True only when argv carries exactly one explicit `=`-form CDP port token
 * for the expected port: no `=0` auto-port, no split flag/value pair, no
 * duplicate port flags. Guards the B launch contract above.
 */
export function hasSingleExplicitCdpPort(args: readonly string[], expectedPort: number): boolean {
  const expected = `--remote-debugging-port=${expectedPort}`
  let count = 0
  for (const arg of args) {
    if (arg === '--remote-debugging-port=0') return false
    if (arg === '--remote-debugging-port') return false
    if (arg.startsWith('--remote-debugging-port')) count += 1
  }
  return count === 1 && args.includes(expected)
}

/**
 * Run every snapshot step first (sequentially, best-effort: a throwing step
 * is swallowed so the remaining profiles still snapshot), then every
 * teardown step (sequentially, best-effort). The supervisor builds its
 * graceful stop from this so settings for BOTH profiles are captured BEFORE
 * any browser detach, signal forward, or process termination.
 */
export async function snapshotAllBeforeTeardown(
  snapshots: readonly (() => Promise<void>)[],
  teardown: readonly (() => Promise<void>)[]
): Promise<void> {
  for (const snap of snapshots) {
    try {
      await snap()
    } catch {
      // Best effort per profile: remaining snapshots still run.
    }
  }
  for (const step of teardown) {
    try {
      await step()
    } catch {
      // Best effort per teardown step: remaining closes still run.
    }
  }
}
