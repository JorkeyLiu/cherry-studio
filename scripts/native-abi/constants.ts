/**
 * Locked native ABI constants for the single better-sqlite3 binding.
 *
 * The repository has exactly one native module, `better-sqlite3`, whose
 * compiled binding is either the Node ABI or the Electron ABI at any moment.
 * This module is the single source of truth for the supported versions and
 * ABIs. Any upgrade to Node / Electron / better-sqlite3 must update these
 * constants together with the docs (`AGENTS.md`, `tests/e2e/README.md`,
 * `docs/sqlite-migration.md`).
 */

/** The only native module whose ABI the repository manages. */
export const NATIVE_PACKAGE = 'better-sqlite3'

/** The compiled binding file name inside the package (bindings try-order). */
export const NATIVE_BINDING_NAME = 'better_sqlite3.node'

/** The exact better-sqlite3 version resolved from the lockfile. */
export const NATIVE_PACKAGE_VERSION = '12.11.1'

/** Repository minimum Node runtime (see `.node-version` / `.nvmrc`). */
export const NODE_MIN_VERSION = '24.11.1'

/** Node 24 module ABI (process.versions.modules). */
export const NODE_ABI = 137

/** Exact installed Electron version. */
export const ELECTRON_VERSION = '41.2.1'

/** Electron 41 module ABI. */
export const ELECTRON_ABI = 145

/**
 * Currently supported Electron rebuild platform/arch (LOCK-ABI-5). The
 * electron-builder / better-sqlite3 prebuilt scope is darwin arm64 today;
 * checks on other platforms fail with the repair command instead of guessing.
 */
export const ELECTRON_PLATFORM = 'darwin'
export const ELECTRON_ARCH = 'arm64'

/** Exact pnpm version (see `packageManager`). */
export const PNPM_VERSION = '10.27.0'

/**
 * Marker used by the repo-owned Electron probe (`probe.cjs`) so the parent
 * process can reliably extract the probe JSON from the child stdout.
 */
export const PROBE_MARKER = 'NATIVE_ABI_PROBE_V1'

/**
 * Env var used to pass the marker into the probe child process. Keeping the
 * value in the parent (single source of truth) avoids drift between
 * `constants.ts` and `probe.cjs`.
 */
export const PROBE_MARKER_ENV = 'NATIVE_ABI_PROBE_MARKER'

/**
 * Env var used only by the Vitest scripts project: it points `probe.cjs` at a
 * stub module so the emission contract (SQL-ok, sqlOk=false, close-in-finally,
 * error preservation) is covered by narrow real subprocess tests without
 * depending on the current native ABI.
 *
 * The probe only honors it when `PROBE_TEST_SEAM_ENV` is explicitly set to
 * `1` (LOCK-ABI-2): production mode hardcodes the real `better-sqlite3`
 * module contract, and the production `spawnElectronProbe` child env
 * deletes BOTH this variable and the seam gate, so an inherited malicious
 * environment can never redirect the real runtime SQL proof.
 */
export const PROBE_MODULE_ENV = 'NATIVE_ABI_PROBE_MODULE'

/**
 * Explicit test-seam gate (LOCK-ABI-2). `probe.cjs` reads
 * `PROBE_MODULE_ENV` only when this is exactly `'1'`; without the gate the
 * probe always requires the real resolved `better-sqlite3` package. The
 * Vitest helper that spawns the probe sets both; the production
 * `spawnElectronProbe` deletes both, so the direct subprocess test seam is
 * reachable only by an explicit test invocation and never inherited by the
 * production CLI path.
 */
export const PROBE_TEST_SEAM_ENV = 'NATIVE_ABI_PROBE_TEST_SEAM'

/**
 * Marker file written by `@electron/rebuild` after a successful rebuild
 * (`build/<buildType>/.forge-meta`). It is **never** trusted by the checks
 * (LOCK-ABI-2): only a real runtime SQL probe proves success.
 */
export const FORGE_META = '.forge-meta'
