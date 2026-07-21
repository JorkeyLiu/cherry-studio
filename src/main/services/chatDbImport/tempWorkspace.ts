/**
 * Temporary workspace management for ChatImport pipeline.
 *
 * Responsibilities:
 * - Create unique temp dirs with `cherry-import-` prefix under os.tmpdir().
 * - Crash-recovery scan on app-ready: find and remove orphaned dirs older than 1 hour.
 * - Sync + async dispose with EBUSY bounded retry (3 attempts, 1s delay).
 *
 * Design notes (R-2):
 * - EBUSY retry handles transient file locks on macOS (and future Windows).
 * - Orphan scan is bounded: iterates tmpdir once, filters by prefix and age.
 * - Cross-platform path usage (path.join, path.resolve) — no POSIX-only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('chatDbImport')

/** Prefix for temp workspace directories. */
const TEMP_PREFIX = 'cherry-import-'

/** Maximum EBUSY retry attempts. */
const MAX_RETRY_ATTEMPTS = 3

/** Delay between retry attempts in milliseconds. */
const RETRY_DELAY_MS = 1000

/** Age threshold for orphan detection (1 hour in ms). */
const ORPHAN_AGE_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a unique temporary workspace directory.
 * Uses `fs.promises.mkdtemp` with the `cherry-import-` prefix.
 *
 * @returns Absolute path to the created directory.
 */
export async function createTempWorkspace(): Promise<string> {
  const tmpRoot = os.tmpdir()
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, TEMP_PREFIX))
  logger.info(`Created temp workspace: ${dir}`)
  return dir
}

/**
 * Dispose (remove) a temp workspace directory.
 * Async variant — uses fs.promises.rm with bounded EBUSY retry.
 *
 * @param dir Absolute path to the directory to remove.
 */
export async function disposeAsync(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true })
      logger.info(`Disposed temp workspace: ${dir} (attempt ${attempt})`)
      return
    } catch (error: any) {
      if (error?.code === 'EBUSY' && attempt < MAX_RETRY_ATTEMPTS) {
        logger.warn(`EBUSY removing ${dir}, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`)
        await delay(RETRY_DELAY_MS)
        continue
      }
      logger.error(`Failed to dispose temp workspace ${dir} after ${attempt} attempts:`, error as Error)
      throw error
    }
  }
}

/**
 * Dispose (remove) a temp workspace directory.
 * Synchronous variant — usable from will-quit handler.
 * Uses fs.rmSync with bounded EBUSY retry.
 *
 * @param dir Absolute path to the directory to remove.
 */
export function dispose(dir: string): void {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      logger.info(`Disposed temp workspace (sync): ${dir} (attempt ${attempt})`)
      return
    } catch (error: any) {
      if (error?.code === 'EBUSY' && attempt < MAX_RETRY_ATTEMPTS) {
        logger.warn(
          `EBUSY removing ${dir} (sync), retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`
        )
        delaySync(RETRY_DELAY_MS)
        continue
      }
      logger.error(`Failed to dispose temp workspace (sync) ${dir} after ${attempt} attempts:`, error as Error)
      throw error
    }
  }
}

/**
 * Scan os.tmpdir() for orphaned `cherry-import-*` directories older than 1 hour.
 * Called on app-ready to clean up after crashes.
 * Non-fatal: errors during individual dir removal are logged and skipped.
 */
export async function recoverOrphanedTempWorkspaces(): Promise<void> {
  const tmpRoot = os.tmpdir()
  let entries: string[]
  try {
    entries = await fs.promises.readdir(tmpRoot)
  } catch (error) {
    logger.error('Failed to scan tmpdir for orphaned import workspaces:', error as Error)
    return
  }

  const now = Date.now()
  let cleaned = 0

  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue

    const fullPath = path.join(tmpRoot, entry)
    try {
      const stat = await fs.promises.stat(fullPath)
      if (!stat.isDirectory()) continue

      const age = now - stat.mtimeMs
      if (age < ORPHAN_AGE_MS) continue

      logger.info(`Removing orphaned import workspace: ${fullPath} (age: ${Math.round(age / 1000)}s)`)
      await disposeAsync(fullPath)
      cleaned++
    } catch (error) {
      // Non-fatal: log and continue scanning
      logger.warn(`Skipping orphaned workspace ${fullPath}:`, error as Error)
    }
  }

  if (cleaned > 0) {
    logger.info(`Cleaned ${cleaned} orphaned import workspace(s)`)
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function delaySync(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Busy-wait — only used in synchronous disposal path (will-quit).
  }
}
