/**
 * Shared types for the native ABI tool. All I/O goes through the injected
 * `Effects` seam so that the command logic is deterministically testable with
 * fakes (Vitest scripts project) while the real wiring lives in `effects.ts`.
 */

/** Which runtime the command targets. */
export type Target = 'node' | 'electron'

/** Command selector accepted by the CLI. */
export type Command = 'check' | 'rebuild'

/** Runtime facts about the process running the tool. */
export interface RuntimeInfo {
  /** Always `node` — the tool itself runs under the repo Node runtime. */
  runtime: 'node'
  /** `process.versions.node` */
  nodeVersion: string
  /** `process.versions.modules` */
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
}

/**
 * Result of listing a directory. An absent directory (ENOENT) is deliberately
 * indistinguishable from an empty one (optional stale dirs / marker build dir
 * must never fail solely for absence); every other enumeration failure is an
 * observable error that must reach the rebuild result (LOCK-ABI finding H).
 */
export type DirListing = { ok: true; entries: string[] } | { ok: false; error: string }

/**
 * Result of the better-sqlite3 runtime SQL probe: create `Database(':memory:')`,
 * run `select 1 as ok`, close. Only `sqlOk === true` proves the binding works
 * for the target runtime (LOCK-ABI-2).
 */
export interface ProbeResult {
  ok: boolean
  sqlOk: boolean
  error?: string
  /** Database close error preserved alongside the primary probe error (finding H). */
  closeError?: string
}

/** Result emitted by the repo-owned Electron probe (`probe.cjs`). */
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
  /** Error raised while closing the Database in `finally` (finding D). */
  closeError?: string
}

/** Report produced by `check` for either target. */
export interface CheckReport {
  target: Target
  ok: boolean
  runtimeName: 'node' | 'electron'
  runtimeVersion: string
  abi: number
  platform: string
  arch: string
  /** Embedded Node version reported by the Electron probe (electron target only). */
  nodeVersion?: string
  packagePath?: string
  bindingPath?: string
  /** Checks never read the marker — always `'ignored'`. */
  markerState: 'ignored'
  /** True only after a real `Database(':memory:')` + `select 1` + close. */
  sqlVerified: boolean
  /** Electron probe child exit code (electron target; surfaced explicitly, finding H). */
  probeExitCode?: number
  /** Database close error surfaced alongside the primary probe error (finding H). */
  probeCloseError?: string
  failures: string[]
  repairCommand?: string
}

/** Marker capture used for rebuild reporting and LOCK-ABI-6 bookkeeping. */
export interface MarkerSnapshot {
  path: string
  content?: string
}

/** Report produced by `rebuild` for either target. */
export interface RebuildReport {
  target: Target
  ok: boolean
  /** Runtime facts of the process running the rebuild (diagnostics). */
  nodeVersion: string
  abi: number
  platform: string
  arch: string
  packagePath?: string
  bindingPath?: string
  /** Marker snapshots captured before the rebuild (LOCK-ABI-6). */
  markerBefore: MarkerSnapshot[]
  /** Rebuild tool stdout/stderr lines (node-gyp or @electron/rebuild). */
  toolOutput: string[]
  failures: string[]
  repairCommand?: string
  /** Result of the automatic post-rebuild check. */
  postCheck?: CheckReport
}

/** Result of the injected rebuild execution (node-gyp or @electron/rebuild). */
export interface RebuildRunResult {
  ok: boolean
  logs: string[]
  error?: string
}

/** Options passed to the `@electron/rebuild` API for the Electron target. */
export interface ElectronRebuildApiOptions {
  buildPath: string
  electronVersion: string
  platform: string
  arch: string
  onlyModules: string[]
  force: boolean
  buildFromSource: boolean
  projectRootPath: string
  mode: 'sequential'
}

/** Options passed to the node-gyp source build for the Node target. */
export interface NodeGypRunOptions {
  packagePath: string
  nodeGypJs: string
  execPath: string
  /**
   * Verified Node install dir proven to contain `<prefix>/include/node/node.h`
   * (LOCK-ABI-5/7). Required: the rebuild precondition fails before any child
   * spawn when the local headers cannot be proven — node-gyp never falls back
   * to downloaded headers or an inherited `npm_config_nodedir`.
   */
  nodeDir: string
  arch: string
  platform: string
}

/**
 * The I/O seam. `check.ts` / `rebuild.ts` consume only this interface; the
 * real implementation is `createEffects()` in `effects.ts`, and unit tests
 * inject faithful fakes.
 */
export interface Effects {
  runtimeInfo(): RuntimeInfo
  readJson(p: string): unknown
  /** Read a text file; undefined when missing/unreadable. */
  readFile(p: string): string | undefined
  realpath(p: string): string
  exists(p: string): boolean
  /** List a directory; ENOENT is empty, every other failure is observable (finding H). */
  listDir(p: string): DirListing
  /**
   * Remove a file. `boundary` is the resolved package root (realpath) the
   * removal must stay inside: every parent path component is validated within
   * it (symlink / path-escape protected), while the terminal path may be a
   * regular file. A missing terminal (ENOENT) or a non-directory parent
   * component (ENOTDIR) means there is nothing to remove and is not an error.
   * Directories are never removed here — that is `removeDir`'s job. Returns
   * undefined on success, an error message on failure.
   */
  removeFile(p: string, boundary?: string): string | undefined
  /**
   * Remove a directory tree. `boundary` is the resolved package root
   * (realpath) the removal must stay inside — the same contract as
   * `removeFile`: every parent path component is validated within it
   * (symlink / path-escape protected) and the terminal directory itself must
   * not be a symlink resolving outside the boundary (a dangling link has no
   * target to escape through and is unlinked). A symlinked `bin` resolving
   * outside the package is rejected before any recursive deletion. A missing
   * terminal (ENOENT) or a non-directory parent component (ENOTDIR) means
   * there is nothing to remove and is not an error. Returns undefined on
   * success, an error message on failure.
   */
  removeDir(p: string, boundary?: string): string | undefined
  /** Resolve `<pkg>/package.json` (undefined when not installed). */
  resolvePackageJsonPath(pkg: string): string | undefined
  /** require.resolve a spec (undefined on failure); used for binding paths. */
  resolveFilePath(spec: string): string | undefined
  /** In-process probe against the running Node runtime (check:node). */
  probeNodeBinding(): ProbeResult
  /** Path to the installed Electron executable (undefined when absent). */
  electronBinPath(): string | undefined
  /** Installed Electron version from `electron/package.json`. */
  electronVersion(): string | undefined
  /** Spawn the repo-owned probe under the Electron binary (ELECTRON_RUN_AS_NODE=1). */
  spawnElectronProbe(bin: string, probePath: string): SpawnResult
  /** `pnpm --version` (undefined when pnpm is not on PATH). */
  pnpmVersion(): string | undefined
  /** Path to a usable node-gyp.js entry (undefined when unresolvable). */
  nodeGypJsPath(): string | undefined
  /** Node install dir for node-gyp `--nodedir` (undefined when not derivable). */
  nodeDir(execPath: string): string | undefined
  /** Run `node <nodeGypJs> rebuild` in the package dir (source build). */
  runNodeGyp(opts: NodeGypRunOptions): SpawnResult
  /** Invoke the direct `@electron/rebuild` API. */
  rebuildElectron(opts: ElectronRebuildApiOptions): Promise<RebuildRunResult>
  /** Repository root (used as buildPath/projectRootPath for @electron/rebuild). */
  projectRoot(): string
  /** Absolute path to the repo-owned `probe.cjs`. */
  probePath(): string
}
