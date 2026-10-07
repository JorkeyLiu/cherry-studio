/**
 * Locked native runtime constants for the single better-sqlite3 dependency.
 *
 * better-sqlite3 13.0.3 ships Node-API prebuilt binaries
 * (`prebuilds/<platform>-<arch>.node`) selected by its default loader for the
 * current platform. The same immutable binary loads under both Node 24 and
 * Electron 41: there is no Node/Electron ABI switch, no rebuild, no restore,
 * and no serialized execution — concurrent Node and Electron use is safe.
 *
 * `NODE_ABI` / `ELECTRON_ABI` are informational diagnostics only (the
 * `process.versions.modules` values observed on each runtime). They never gate
 * a check: only a real runtime SQL probe proves success.
 *
 * Any upgrade to Node / Electron / better-sqlite3 must update these constants
 * together.
 */

/** The only native module this repository manages. */
export const NATIVE_PACKAGE = 'better-sqlite3'

/** The exact better-sqlite3 version resolved from the lockfile. */
export const NATIVE_PACKAGE_VERSION = '13.0.3'

/** Repository minimum Node runtime (see `.node-version` / `.nvmrc`). */
export const NODE_MIN_VERSION = '24.11.1'

/** Node 24 `process.versions.modules` — informational only, never gating. */
export const NODE_ABI = 137

/** Exact installed Electron version. */
export const ELECTRON_VERSION = '41.2.1'

/** Electron 41 `process.versions.modules` — informational only, never gating. */
export const ELECTRON_ABI = 145

/**
 * Supported Electron probe platform/arch pairs (mac arm64 first; no new
 * Windows/Linux promises). Checks on other platforms fail closed.
 */
export const ELECTRON_TARGETS = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' }
] as const

export function electronTargetFor(platform: string, arch: string): (typeof ELECTRON_TARGETS)[number] | undefined {
  return ELECTRON_TARGETS.find((target) => target.platform === platform && target.arch === arch)
}

/** Exact pnpm version (see `packageManager`). */
export const PNPM_VERSION = '10.27.0'

/**
 * Bounded diagnostic timeout for synchronous child probes (`spawnSync`).
 *
 * Both the Electron probe (`spawnElectronProbe`) and the Node diagnostic
 * probe (`spawnNodeProbe`) run with this timeout plus a kill signal, so a
 * hung child can never block the tool indefinitely. The bound is generous on
 * purpose: a healthy probe settles in well under a second, and the timeout
 * only guards against a hung runtime. Single attempt, no retry — a timeout
 * fails closed as a probe failure.
 */
export const PROBE_TIMEOUT_MS = 60000

/** Signal used to terminate a probe child that exceeds `PROBE_TIMEOUT_MS`. */
export const PROBE_KILL_SIGNAL: NodeJS.Signals = 'SIGTERM'

/**
 * Marker used by the repo-owned Electron probe (`probe.cjs`) so the parent
 * process can reliably extract the probe JSON from the child stdout.
 */
export const PROBE_MARKER = 'NATIVE_RUNTIME_PROBE_V1'

/**
 * Env var used to pass the marker into the probe child process. Keeping the
 * value in the parent (single source of truth) avoids drift between
 * `constants.ts` and `probe.cjs`.
 */
export const PROBE_MARKER_ENV = 'NATIVE_RUNTIME_PROBE_MARKER'

/**
 * Env var used only by the Vitest scripts project: it points `probe.cjs` at a
 * stub module so the emission contract (SQL-ok, sqlOk=false, close-in-finally,
 * error preservation) is covered by narrow real subprocess tests without
 * depending on the installed native binary.
 *
 * The probe only honors it when `PROBE_TEST_SEAM_ENV` is exactly `'1'`. The
 * production `spawnElectronProbe` child env deletes BOTH this variable and
 * the seam gate, so an inherited malicious environment can never redirect
 * the real runtime SQL proof.
 */
export const PROBE_MODULE_ENV = 'NATIVE_RUNTIME_PROBE_MODULE'

/**
 * Explicit test-seam gate. `probe.cjs` reads `PROBE_MODULE_ENV` only when
 * this is exactly `'1'`; without the gate the probe always requires the real
 * resolved `better-sqlite3` package.
 */
export const PROBE_TEST_SEAM_ENV = 'NATIVE_RUNTIME_PROBE_TEST_SEAM'
