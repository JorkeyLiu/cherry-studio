/**
 * Practical E2E ownership lifecycle (frozen contract).
 *
 * Each test owns EXACTLY ONE atomic canonical temp root created by mkdtemp
 * under the canonical OS temp dir. Every test-owned child temp path/profile
 * lives beneath that root. Cleanup is exact-token process cleanup plus
 * fail-closed root removal; there is no global registry, no cross-run or
 * global deletion, and no formal proof/tombstone machinery.
 *
 * Accepted residual: a hard runner SIGKILL, machine loss, or cleanup-code
 * failure may leave the uniquely prefixed disposable root behind for manual
 * cleanup. This is accepted and documented; there is no global cross-process
 * recovery.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  findProcessesByUserDataDir,
  terminateProcessesByUserDataDir,
  type ProcessEntry,
  type TerminationResult
} from './process-cleanup'

export const OWNED_TMPROOT_PREFIX = 'cherry-e2e-owned-'

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Create one unique atomic canonical test-owned temp root. Uniqueness comes from mkdtemp. */
export function createOwnedTmpRoot(tmpDir = os.tmpdir()): string {
  const canonicalParent = fs.realpathSync(tmpDir)
  const created = fs.mkdtempSync(path.join(canonicalParent, OWNED_TMPROOT_PREFIX))
  const root = fs.realpathSync(created)
  // Sanity-check the exact shape we just created before handing it out.
  validateOwnedRoot(root, canonicalParent)
  return root
}

/**
 * Validate an exact owned root: absolute, real non-symlink directory, direct
 * canonical temp child, expected prefix. Returns the canonical root.
 */
export function validateOwnedRoot(root: string, tmpDir = os.tmpdir()): string {
  if (!path.isAbsolute(root)) throw new Error(`Owned root must be absolute: ${root}`)
  const absoluteRoot = path.resolve(root)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(absoluteRoot)
  } catch (error) {
    if (isEnoent(error)) throw new Error(`Owned root does not exist: ${root}`)
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Owned root is not a real non-symlink directory: ${root}`)
  }
  const canonicalRoot = fs.realpathSync(absoluteRoot)
  if (path.dirname(canonicalRoot) !== fs.realpathSync(tmpDir)) {
    throw new Error(`Owned root is not a direct child of the canonical temp directory: ${root}`)
  }
  if (!path.basename(canonicalRoot).startsWith(OWNED_TMPROOT_PREFIX)) {
    throw new Error(`Owned root does not carry the expected "${OWNED_TMPROOT_PREFIX}" prefix: ${root}`)
  }
  return canonicalRoot
}

/**
 * Validate (optionally create) an exact canonical profile launch token that
 * lives beneath the owned root. Returns the canonical token — the exact
 * string passed to Electron as `--user-data-dir=<token>`.
 */
export function validateProfileLaunchToken(
  root: string,
  launchToken: string,
  createIfMissing = false,
  tmpDir = os.tmpdir()
): string {
  if (!path.isAbsolute(launchToken)) throw new Error(`Profile launch token must be absolute: ${launchToken}`)
  if (launchToken.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new Error(`Profile launch token may not contain "..": ${launchToken}`)
  }
  const canonicalRoot = validateOwnedRoot(root, tmpDir)
  const lexical = path.resolve(launchToken)
  const relative = path.relative(canonicalRoot, lexical)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Profile launch token must resolve inside the owned root: ${launchToken}`)
  }
  if (!fs.existsSync(lexical)) {
    if (!createIfMissing) throw new Error(`Profile launch token does not exist: ${launchToken}`)
    fs.mkdirSync(lexical, { recursive: true })
  }
  const stat = fs.lstatSync(lexical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Profile launch token must be a real non-symlink directory: ${launchToken}`)
  }
  const canonical = fs.realpathSync(lexical)
  const canonicalRelative = path.relative(canonicalRoot, canonical)
  if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    throw new Error(`Profile launch token resolves outside the owned root: ${launchToken}`)
  }
  return canonical
}

export interface ExactProfileCleanupDependencies {
  terminate?: (launchToken: string) => Promise<TerminationResult>
  find?: (launchToken: string) => ProcessEntry[]
}

/**
 * Exact-token process cleanup + final absence verification for one profile.
 * Throws (never silently passes) when any scan/termination/probe fails or any
 * exact-token process remains.
 */
export async function cleanupExactProfile(
  launchToken: string,
  dependencies: ExactProfileCleanupDependencies = {}
): Promise<void> {
  const terminate = dependencies.terminate ?? ((token) => terminateProcessesByUserDataDir(token, null))
  const find = dependencies.find ?? findProcessesByUserDataDir
  const errors: string[] = []
  let termination: TerminationResult | null = null
  try {
    termination = await terminate(launchToken)
  } catch (error) {
    errors.push(`terminate failed: ${asMessage(error)}`)
  }
  if (termination) {
    errors.push(...termination.errors)
    if (termination.remainingPids.length > 0) {
      errors.push(`processes remained after cleanup: ${termination.remainingPids.join(', ')}`)
    }
  }
  try {
    const remaining = find(launchToken)
    if (remaining.length > 0) {
      errors.push(`processes remained after verification: ${remaining.map((p) => p.pid).join(', ')}`)
    }
  } catch (error) {
    errors.push(`final verification failed: ${asMessage(error)}`)
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors.map((message) => new Error(message)),
      `Exact-profile cleanup failed for "${launchToken}"`
    )
  }
}

/**
 * Fail-closed teardown for one owned tmp root. Exact-cleans every known
 * profile; only when ALL clean and the exact root still validates does it
 * recursively remove the root and verify absence. On any error, remaining
 * PID, or path-validation failure the root is preserved and the preserved
 * path is reported in the thrown AggregateError. Never scans or deletes the
 * global temp dir and never deletes any other root.
 */
export async function removeOwnedTmpRoot(
  root: string,
  launchTokens: readonly string[],
  dependencies: ExactProfileCleanupDependencies = {},
  tmpDir = os.tmpdir()
): Promise<void> {
  const errors: string[] = []
  for (const launchToken of launchTokens) {
    try {
      await cleanupExactProfile(launchToken, dependencies)
    } catch (error) {
      errors.push(asMessage(error))
    }
  }

  let rootStat: fs.Stats | null = null
  try {
    rootStat = fs.lstatSync(path.resolve(root))
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  // The root is already absent — nothing to remove (all known profiles above
  // were exact-cleaned or cleanup already failed).
  if (!rootStat) return

  let canonicalRoot: string | null = null
  try {
    canonicalRoot = validateOwnedRoot(root, tmpDir)
  } catch (error) {
    errors.push(`root validation failed: ${asMessage(error)}`)
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors.map((message) => new Error(message)),
      `Owned tmp root preserved (cleanup incomplete): ${canonicalRoot ?? path.resolve(root)}`
    )
  }

  fs.rmSync(canonicalRoot!, { recursive: true, force: true })
  if (fs.existsSync(canonicalRoot!)) {
    throw new Error(`Owned tmp root still exists after cleanup: ${canonicalRoot}`)
  }
}

/** Remove exact owned seed dirs and the seed ZIP, verifying absence. Never touches anything outside the given paths. */
export function removeOwnedSeedArtifacts(dirs: readonly string[], zipPath?: string): void {
  const errors: string[] = []
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      errors.push(`Failed to remove seed dir ${dir}: ${asMessage(error)}`)
    }
  }
  for (const dir of dirs) {
    if (fs.existsSync(dir)) errors.push(`Seed dir still exists after cleanup: ${dir}`)
  }
  if (zipPath && fs.existsSync(zipPath)) errors.push(`Seed artifact still exists after cleanup: ${zipPath}`)
  if (errors.length > 0) {
    throw new Error(`Disposable seed cleanup failed (${errors.length}): ${errors.join('; ')}`)
  }
}
