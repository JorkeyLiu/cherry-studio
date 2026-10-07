/**
 * Shared types for the native runtime tool. All I/O goes through the injected
 * `Effects` seam so that the command logic is deterministically testable with
 * fakes (Vitest scripts project) while the real wiring lives in `effects.ts`.
 *
 * There is no rebuild, lock, lease, or restore concept anywhere here: the
 * better-sqlite3 13.0.3 Node-API prebuilt binary is shared and immutable, so
 * checks are read-only diagnostics and the runner only probes before spawn.
 */

/** Which runtime the command targets. */
export type Target = 'node' | 'electron'

/** Runtime facts about the process running the tool. */
export interface RuntimeInfo {
  /** Always `node` — the tool itself runs under the repo Node runtime. */
  runtime: 'node'
  /** `process.versions.node` */
  nodeVersion: string
  /** `process.versions.modules` (informational only, never gating). */
  modulesAbi: number
  platform: string
  arch: string
  execPath: string
}

/** Result of spawning a child process. */
export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
  /**
   * True when the synchronous probe child exceeded the bounded diagnostic
   * timeout (`PROBE_TIMEOUT_MS`) and was terminated. Callers map this to the
   * existing probe-failure path with a timeout cause — never a retry.
   */
  timedOut?: boolean
}

/**
 * Result of the better-sqlite3 runtime SQL probe: create `Database(':memory:')`,
 * run `select 1 as ok`, close. Only `sqlOk === true` proves the binary works
 * for the target runtime.
 */
export interface ProbeResult {
  ok: boolean
  sqlOk: boolean
  error?: string
  /** Database close error preserved alongside the primary probe error. */
  closeError?: string
}

/** Result emitted by the repo-owned probe (`probe.cjs`). */
export interface ElectronProbeOutput {
  ok: boolean
  runtime: string
  version: string
  nodeVersion: string
  abi: number
  platform: string
  arch: string
  sqlOk: boolean
  error?: string
  /** Error raised while closing the Database in `finally`. */
  closeError?: string
}

/** Report produced by `check` for either target. */
export interface CheckReport {
  target: Target
  ok: boolean
  runtimeName: 'node' | 'electron'
  runtimeVersion: string
  /** Observed ABI — informational only, never gates the check. */
  abi: number
  platform: string
  arch: string
  /** Embedded Node version reported by the Electron probe (electron target only). */
  nodeVersion?: string
  packagePath?: string
  /** Resolved better-sqlite3 package version (must equal the locked version). */
  packageVersion?: string
  /** True only after a real `Database(':memory:')` + `select 1` + close. */
  sqlVerified: boolean
  /** Electron probe child exit code (electron target). */
  probeExitCode?: number
  /** Database close error surfaced alongside the primary probe error. */
  probeCloseError?: string
  failures: string[]
}

/**
 * The I/O seam. `check.ts` consumes only this interface; the real
 * implementation is `createEffects()` in `effects.ts`, and unit tests inject
 * faithful fakes.
 */
export interface Effects {
  runtimeInfo(): RuntimeInfo
  readJson(p: string): unknown
  realpath(p: string): string
  exists(p: string): boolean
  /** Resolve `<pkg>/package.json` (undefined when not installed). */
  resolvePackageJsonPath(pkg: string): string | undefined
  /** Runtime probe against the running Node runtime (check:node). */
  probeNodeBinding(): ProbeResult
  /** Path to the installed Electron executable (undefined when absent). */
  electronBinPath(): string | undefined
  /** Installed Electron version from `electron/package.json`. */
  electronVersion(): string | undefined
  /** Spawn the repo-owned probe under the Electron binary (ELECTRON_RUN_AS_NODE=1). */
  spawnElectronProbe(bin: string, probePath: string, timeoutMs?: number): SpawnResult
  /** Absolute path to the repo-owned `probe.cjs`. */
  probePath(): string
}
