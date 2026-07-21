/**
 * Phase 4.0-C1 — Staging Path Validation
 *
 * TEST/FEASIBILITY-ONLY. Used only by spike harness code.
 * Retained through Phase 4.1 as reproducibility harness.
 *
 * Symlink-aware path validation for staging/temp directories.
 * Extracted from phase4-spike.ts for unit testability.
 *
 * Rejects:
 *  - Non-existent paths
 *  - Symlinks (detected via fs.lstatSync before resolving)
 *  - Paths that resolve outside system temp directories
 *
 * POSIX-only: uses '/' separator. Acceptable for spike harness on macOS/Linux.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Validate that a path is an owned test/staging path (under system temp dirs).
 * On macOS, os.tmpdir() returns /var/folders/... while /tmp is a separate directory.
 * Both are accepted as safe staging locations.
 *
 * Uses fs.lstatSync to detect symlinks before resolving.
 * If the path is a symlink, rejects it immediately — staging paths
 * must be real directories, not symlinks that could escape the temp tree.
 *
 * @param p Path to validate
 * @param logFn Optional logging function for rejection diagnostics
 * @returns true if the path is a valid owned staging path
 */
export function validateStagingPath(p: string, logFn?: (msg: string) => void): boolean {
  const log = logFn ?? (() => {})
  try {
    const stat = fs.lstatSync(p)
    if (stat.isSymbolicLink()) {
      log(`validateStagingPath: rejecting symlink: ${p}`)
      return false
    }
  } catch {
    // Path doesn't exist — reject (we need it to exist for copy/mount)
    return false
  }
  const resolved = fs.realpathSync(p)
  const tmpDirs = [os.tmpdir(), '/tmp']
  for (const tmpDir of tmpDirs) {
    const resolvedTmp = fs.realpathSync(tmpDir)
    const prefix = resolvedTmp.endsWith(path.sep) ? resolvedTmp : resolvedTmp + path.sep
    if (resolved === resolvedTmp || resolved.startsWith(prefix)) {
      return true
    }
  }
  return false
}
