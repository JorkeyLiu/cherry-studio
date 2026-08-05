/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { type Stats } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type { WebDavConfig } from '@types'
import type { S3Config } from '@types'
import archiver from 'archiver'
import { app } from 'electron'
import * as fs from 'fs-extra'
import StreamZip from 'node-stream-zip'
import * as path from 'path'
import type { CreateDirectoryOptions, FileStat } from 'webdav'

import { getDataPath } from '../utils'
import { isPathInside, resolveAndValidatePath } from '../utils/file'
import { chatDbService } from './chatDb'
import { createL3ArchiveMetadata, type L3ArchiveMetadata, validateL3ArchiveMetadata } from './chatDb/l3ArchiveMetadata'
import { getSharedMaintenanceCoordinator, withMaintenanceLease } from './chatDb/maintenanceCoordination'
import { FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME } from './chatDbImport/promotion/filesSnapshot'
import {
  FILES_CATALOG_SNAPSHOT_FILENAME,
  FILES_CATALOG_SNAPSHOT_STAGING_FILENAME,
  FILES_PROMOTE_STAGING_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME,
  PROMOTION_JOURNAL_FILENAME,
  ROLLBACK_SNAPSHOT_FILENAME,
  ROLLBACK_SNAPSHOT_STAGING_FILENAME
} from './chatDbImport/promotion/journal'
import { PROMOTION_JOURNAL_STAGING_FILENAME } from './chatDbImport/promotion/journalStore'
import { validateReadonlyChatDb } from './chatDbImport/promotion/readonlyDbValidation'
import S3Storage from './S3Storage'
import WebDav from './WebDav'
import { windowService } from './WindowService'
import { sanitizeProviderFilename, validateRestoreZipEntries } from './zipSecurityValidation'

const logger = loggerService.withContext('BackupManager')

// ---------------------------------------------------------------------------
// LOCK-6012: Local backup fileName validation
//
// User-selected local backup fileName is untrusted. It must be a single
// safe basename — no path separators, no traversal, no symlinks, and the
// final output path must resolve canonically under the destination.
// ---------------------------------------------------------------------------

/** Maximum length for a local backup file name (reasonable filesystem limit). */
const MAX_BACKUP_FILENAME_LENGTH = 255

/**
 * Validate that a user-selected local backup fileName is a single safe
 * basename suitable for use with path.join(destination, fileName).
 *
 * LOCK-6012: Rejects traversal (../), absolute paths, path separators,
 * NUL bytes, and other dangerous characters.
 *
 * @param fileName  User-selected backup file name.
 * @param destDir   The destination directory (for containment check).
 * @returns         The validated basename (may differ from input after trimming).
 * @throws          Error if the fileName is unsafe.
 */
function validateLocalBackupFileName(fileName: string, destDir: string): string {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error(
      '[backup] Backup file name is empty or invalid. ' +
        'LOCK-6012: A valid file name is required for safe output containment.'
    )
  }

  // Strip any directory components — we only want the basename
  let safeName = path.basename(fileName)

  // Remove NUL bytes
  // oxlint-disable-next-line no-control-regex -- Intentional: sanitizing NUL bytes from filenames
  safeName = safeName.replace(/\x00/g, '')

  // Trim leading/trailing dots and spaces (Windows reserved)
  safeName = safeName.replace(/^[.\s]+|[.\s]+$/g, '')

  // Collapse any ".." sequences that might have survived basename extraction
  safeName = safeName.replace(/\.\./g, '__')

  // Remove characters that are problematic across platforms
  // oxlint-disable-next-line no-control-regex -- Intentional: sanitizing control chars from filenames
  safeName = safeName.replace(/[<>:"|?*\x00-\x1f]/g, '_')

  // Fallback if everything was stripped
  if (!safeName || safeName.length === 0) {
    safeName = `cherry-studio-backup-${Date.now()}.zip`
  }

  // Enforce length limit
  if (safeName.length > MAX_BACKUP_FILENAME_LENGTH) {
    safeName = safeName.slice(0, MAX_BACKUP_FILENAME_LENGTH)
  }

  // Final containment check: must be a single path segment
  if (safeName.includes('/') || safeName.includes('\\') || safeName === '..' || safeName === '.') {
    throw new Error(
      `[backup] Backup file name cannot be safely sanitized: "${fileName}". ` +
        `Owned destination: "${destDir}". Use a generated file name instead.`
    )
  }

  return safeName
}

// ---------------------------------------------------------------------------
// LOCK-6012/6028: Local backup directory canonical/symlink validation
//
// User-selected local backup directories are untrusted. Every component of
// the path must be validated without following symlinks. Symlinks are
// REJECTED unless they match an exact, evidence-backed macOS system alias.
// After validation, the canonical (realpath-resolved) path is returned for
// safe use.
//
// This prevents:
// - Symlinked parent directories redirecting writes to attacker-controlled
//   locations
// - Canonical escape via symlink chains
// - TOCTOU races via immediate revalidation before critical operations
// ---------------------------------------------------------------------------

// LOCK-6028: Only exact OS-owned aliases needed for normal paths are permitted.
// Arbitrary symlinks are always rejected. These are the APFS boot-level symlinks
// that macOS creates at startup. The mapping is exact: source must be the full
// path (e.g. "/var") and target must be the full canonical path (e.g. "/private/var").
// On non-macOS platforms this map is empty — no symlinks are ever permitted.
const KNOWN_SYSTEM_ALIASES: ReadonlyMap<string, string> =
  process.platform === 'darwin'
    ? new Map([
        ['/var', '/private/var'],
        ['/tmp', '/private/tmp'],
        ['/etc', '/private/etc'],
        ['/usr', '/private/usr']
      ])
    : new Map()

interface LocalBackupDestinationIdentity {
  readonly inputPath: string
  readonly canonicalPath: string
  readonly dev: number
  readonly ino: number
  readonly components: readonly LocalBackupComponentIdentity[]
}

interface LocalBackupComponentIdentity {
  readonly path: string
  readonly dev: number
  readonly ino: number
}

interface LocalBackupDirectoryWalk {
  readonly resolvedPath: string
  readonly canonicalPath: string
  readonly exists: boolean
  readonly components: readonly LocalBackupComponentIdentity[]
}

// ---------------------------------------------------------------------------
// LOCK-6034/6035/6036: Workspace identity tracking and safe cleanup
//
// After mkdtemp creates a publication workspace, we record its dev/ino
// identity. Before cleanup, we revalidate both the full destination chain
// AND the workspace identity. Cleanup only proceeds if both still match.
// This prevents fs.remove(publicationWorkspace) from recursively deleting
// a replacement pathname after an ancestor/workspace swap.
//
// LOCK-6036: The residual TOCTOU between final validation and the actual
// syscall (fs.remove) is documented and accepted because Node lacks
// openat/linkat descriptor-relative APIs. We do not claim complete
// elimination of this race.
// ---------------------------------------------------------------------------

interface WorkspaceIdentity {
  readonly workspacePath: string
  readonly dev: number
  readonly ino: number
}

/**
 * LOCK-6034: Capture workspace identity (dev/ino) immediately after mkdtemp.
 * Uses no-follow lstat to record the actual directory inode, not a symlink target.
 */
async function captureWorkspaceIdentity(workspacePath: string): Promise<WorkspaceIdentity> {
  const stat = await fs.lstat(workspacePath)
  if (!stat.isDirectory()) {
    throw new Error(
      `[backup] Workspace path "${workspacePath}" is not a directory. ` +
        'LOCK-6034: Publication workspace must be a real directory.'
    )
  }
  return { workspacePath, dev: stat.dev, ino: stat.ino }
}

/**
 * LOCK-6034: Identity-checked workspace cleanup.
 *
 * Before recursive removal, rewalks the full accepted destination identity
 * and lstat's the workspace. Only removes if BOTH:
 *   1. The destination chain still matches the accepted identity (no ancestor swap)
 *   2. The workspace dev/ino still match (no replacement by file/dir/symlink)
 *
 * On mismatch: skips cleanup, logs a safe path-free warning, leaves orphan.
 *
 * LOCK-6036: The TOCTOU between this validation and the fs.remove syscall
 * is acknowledged and accepted — Node lacks descriptor-relative APIs
 * (openat/linkat) that would eliminate it.
 */
async function safeCleanupWorkspace(
  workspaceIdentity: WorkspaceIdentity,
  acceptedDestination: LocalBackupDestinationIdentity,
  context: string
): Promise<void> {
  try {
    // Step 1: Revalidate the full destination chain identity
    await revalidateLocalBackupDestination(acceptedDestination, `${context}/cleanup-destination`)

    // Step 2: Revalidate workspace identity (dev/ino + still a directory)
    const currentStat = await fs.lstat(workspaceIdentity.workspacePath)
    if (
      !currentStat.isDirectory() ||
      currentStat.dev !== workspaceIdentity.dev ||
      currentStat.ino !== workspaceIdentity.ino
    ) {
      // Workspace was replaced by file/dir/symlink or moved to different device
      logger.warn(
        `[safeCleanupWorkspace] Workspace identity changed — skipping cleanup to avoid deleting a ` +
          'replacement object. Orphan left at workspace path. ' +
          'LOCK-6034: This prevents deletion of a replacement file/dir/symlink.'
      )
      return
    }

    // Step 3: Identity matches — safe to remove
    // LOCK-6036: Residual TOCTOU acknowledged — between this point and
    // the fs.remove syscall, a race could theoretically swap the workspace.
    // Node lacks openat/linkat to eliminate this.
    await fs.remove(workspaceIdentity.workspacePath)
  } catch (error) {
    // Any error during identity validation: skip cleanup, leave orphan
    logger.warn(
      `[safeCleanupWorkspace] ${context}: Identity check failed — skipping cleanup. ` +
        'Orphan left at workspace path. ' +
        'LOCK-6034: Identity mismatch prevents deletion. ' +
        `Error: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Walk every destination component with lstat, accepting only exact OS aliases. */
async function walkLocalBackupDir(localBackupDir: string, allowMissing: boolean): Promise<LocalBackupDirectoryWalk> {
  if (!localBackupDir || typeof localBackupDir !== 'string') {
    throw new Error(
      '[backup] Local backup directory is empty or invalid. ' +
        'LOCK-6012: A valid directory path is required for safe local backup.'
    )
  }

  const resolved = path.resolve(localBackupDir)

  const root = path.parse(resolved).root
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean)
  let canonicalBase = root
  const components: LocalBackupComponentIdentity[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    const current = path.join(canonicalBase, part)

    try {
      const lstatResult = await fs.lstat(current)
      if (lstatResult.isSymbolicLink()) {
        const target = await fs.realpath(current).catch(() => null)
        if (!target) {
          throw new Error(
            `[backup] Path component "${current}" is a symlink that cannot be resolved. ` +
              'LOCK-6012: Local backup directory must contain only resolvable paths.'
          )
        }

        // LOCK-6028: Only accept if this exact source→target is a known OS alias.
        const expectedTarget = KNOWN_SYSTEM_ALIASES.get(current)
        if (expectedTarget === undefined || path.resolve(target) !== path.resolve(expectedTarget)) {
          throw new Error(
            `[backup] Path component "${current}" is a symlink pointing to "${target}". ` +
              'LOCK-6028: Arbitrary symlinks are rejected. Only known OS system aliases ' +
              '(e.g., /var→/private/var on macOS) are permitted. ' +
              'Replace the symlink with a real directory.'
          )
        }

        canonicalBase = path.resolve(target)
      } else if (!lstatResult.isDirectory()) {
        throw new Error(
          `[backup] Path component "${current}" is not a directory (type: ${lstatResult.isFile() ? 'file' : 'other'}). ` +
            'LOCK-6012: Every component of the local backup directory must be a real directory.'
        )
      } else {
        canonicalBase = current
      }
      components.push({ path: current, dev: lstatResult.dev, ino: lstatResult.ino })
    } catch (err) {
      if (err instanceof Error && (err.message.includes('LOCK-6012') || err.message.includes('LOCK-6028'))) {
        throw err
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
        return {
          resolvedPath: resolved,
          canonicalPath: path.join(canonicalBase, ...parts.slice(index)),
          exists: false,
          components
        }
      }
      throw new Error(
        `[backup] Failed to inspect local backup path component "${current}": ${err instanceof Error ? err.message : String(err)}. ` +
          'LOCK-6028: Every destination component must be revalidated without following symlinks.'
      )
    }
  }

  const realPath = path.resolve(await fs.realpath(resolved))
  if (realPath !== path.resolve(canonicalBase)) {
    throw new Error(
      `[backup] Local backup directory "${localBackupDir}" resolves to "${realPath}", ` +
        `but the no-follow component walk resolved to "${canonicalBase}". ` +
        'LOCK-6012: Destination identity changed during validation.'
    )
  }

  return { resolvedPath: resolved, canonicalPath: realPath, exists: true, components }
}

async function validateLocalBackupDir(localBackupDir: string): Promise<string> {
  return (await walkLocalBackupDir(localBackupDir, true)).resolvedPath
}

async function captureLocalBackupDestination(localBackupDir: string): Promise<LocalBackupDestinationIdentity> {
  const walked = await walkLocalBackupDir(localBackupDir, false)
  const destinationStat = await fs.lstat(walked.canonicalPath)
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
    throw new Error(
      `[backup] Local backup destination "${walked.canonicalPath}" is not a real directory. ` +
        'LOCK-6028: Refusing to capture an unstable destination identity.'
    )
  }
  return {
    inputPath: walked.resolvedPath,
    canonicalPath: walked.canonicalPath,
    dev: destinationStat.dev,
    ino: destinationStat.ino,
    components: walked.components
  }
}

async function revalidateLocalBackupDestination(
  accepted: LocalBackupDestinationIdentity,
  context: string
): Promise<void> {
  const current = await captureLocalBackupDestination(accepted.inputPath)
  const componentsMatch =
    current.components.length === accepted.components.length &&
    current.components.every(
      (component, index) =>
        component.path === accepted.components[index].path &&
        component.dev === accepted.components[index].dev &&
        component.ino === accepted.components[index].ino
    )
  if (
    current.canonicalPath !== accepted.canonicalPath ||
    current.dev !== accepted.dev ||
    current.ino !== accepted.ino ||
    !componentsMatch
  ) {
    throw new Error(
      `[backup] ${context}: Local backup destination identity changed from ` +
        `"${accepted.canonicalPath}" (${accepted.dev}:${accepted.ino}) to ` +
        `"${current.canonicalPath}" (${current.dev}:${current.ino}). ` +
        'LOCK-6012: Refusing publication after a destination or ancestor swap.'
    )
  }
}

async function revalidateParentDir(dirPath: string, context: string): Promise<void> {
  const parentDir = path.dirname(dirPath)
  try {
    await walkLocalBackupDir(parentDir, false)
  } catch (err) {
    throw new Error(
      `[backup] ${context}: Parent path "${parentDir}" failed full component revalidation. ` +
        `LOCK-6012: ${err instanceof Error ? err.message : String(err)}${
          err instanceof Error && err.message.includes('is a symlink') ? ' (became a symlink)' : ''
        }`
    )
  }
}

/**
 * Atomically publish a complete archive without clobbering a final file or
 * symlink. The staged file is in the destination filesystem, so `link` is a
 * same-filesystem atomic no-clobber operation. Unsupported filesystems fail
 * publication without exposing a partial archive at the final path.
 */
async function publishLocalBackupArchive(
  stagedArchivePath: string,
  finalArchivePath: string,
  acceptedDestination: LocalBackupDestinationIdentity
): Promise<void> {
  await revalidateLocalBackupDestination(acceptedDestination, 'publishLocalBackupArchive')
  await fs.link(stagedArchivePath, finalArchivePath)
  await fs.unlink(stagedArchivePath).catch((error) => {
    logger.warn('[publishLocalBackupArchive] Published archive but could not unlink staging file', error as Error)
  })
}

interface CopyDirOptions {
  dereferenceSymlinks: boolean
  sourceRootRealPath?: string
}

interface EffectiveEntryStats {
  isSymlink: boolean
  stats: Stats
}

interface ProgressData {
  stage: string
  progress: number
  total: number
}

class BackupManager {
  private backupDir = path.join(app.getPath('temp'), 'cherry-studio', 'backup')

  // Process-wide async mutex — serialises full backup operations across
  // local/WebDAV/S3 entry points. Prevents staging directory collisions,
  // concurrent snapshot/archive races, and archive file overwrites.
  private static backupMutex: Promise<unknown> = Promise.resolve()

  // Cached instance to avoid recreating
  private s3Storage: S3Storage | null = null
  private webdavInstance: WebDav | null = null

  // Cached core connection config, used to detect if connection config has changed
  private cachedS3ConnectionConfig: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    root?: string
  } | null = null

  private cachedWebdavConnectionConfig: {
    webdavHost: string
    webdavUser?: string
    webdavPass?: string
    webdavPath?: string
  } | null = null

  // ---------------------------------------------------------------------------
  // Finding 1: Restore marker staging
  //
  // handleStartupRestore inspects Data.restore/chat.db before replacing live
  // Data. If chat.db exists, a restore marker is created INSIDE Data.restore
  // BEFORE any live Data replacement. Marker creation failure aborts before
  // touching live Data and is NOT swallowed as a successful restore.
  // ---------------------------------------------------------------------------

  /**
   * Handle backup restoration on app startup.
   *
   * Called after window is created but before renderer is loaded.
   *
   * Finding 1 — marker staging:
   *   When Data.restore exists and contains chat.db, the restore marker
   *   (chat.db.restore) is created INSIDE Data.restore BEFORE the
   *   Data.restore → Data rename. This ensures the marker is atomically
   *   in place when the live Data directory is replaced.
   *
   *   If marker creation fails, the operation aborts BEFORE touching
   *   live Data. The failure is propagated (not swallowed).
   *
   *   If Data.restore has no chat.db, no marker is created — the
   *   restore only covers non-DB files.
   *
   * Finding 2 — no silent usable DB:
   *   If the rename succeeds but chatDbService.init() later fails
   *   (e.g., integrity check), ChatDbService persists chat.db.repair
   *   and refuses all operations. No uninitialized/unchecked DB is
   *   silently usable.
   */
  static async handleStartupRestore(): Promise<void> {
    // Phase 4.4.1 (LOCK-4416): restore activation holds the shared chat DB
    // maintenance lease ('restore') so the live-Data swap can never overlap
    // backup, promotion, or live ChatDbService init/close.
    return withMaintenanceLease(getSharedMaintenanceCoordinator(), 'restore', 'startup-restore-activation', async () =>
      BackupManager.doHandleStartupRestore()
    )
  }

  private static async doHandleStartupRestore(): Promise<void> {
    const userDataPath = app.getPath('userData')

    // Define restore paths
    const indexedDBRestore = path.join(userDataPath, 'IndexedDB.restore')
    const localStorageRestore = path.join(userDataPath, 'Local Storage.restore')
    const dataRestore = getDataPath() + '.restore'

    // Define target paths
    const indexedDBDest = path.join(userDataPath, 'IndexedDB')
    const localStorageDest = path.join(userDataPath, 'Local Storage')
    const dataDest = getDataPath()

    // DB filename constant (must match ChatDbService)
    const DB_FILENAME = 'chat.db'
    const RESTORE_MARKER_FILENAME = 'chat.db.restore'

    try {
      // Check if any restore markers exist
      const hasIndexedDBRestore = await fs.pathExists(indexedDBRestore)
      const hasLocalStorageRestore = await fs.pathExists(localStorageRestore)
      const hasDataRestore = await fs.pathExists(dataRestore)

      if (!hasIndexedDBRestore && !hasLocalStorageRestore && !hasDataRestore) {
        return
      }

      // --- LOCK-6010: Phase 1 — Validate Data.chat.db preconditions BEFORE ---
      // --- consuming any IndexedDB/Local Storage staging.                   ---
      // If Data.restore exists but has no chat.db, the entire restore is
      // aborted before any staging directory is consumed. This prevents
      // stale .restore dirs from being accidentally consumed on a rejected
      // restore and ensures retriable startup failures leave a safe state.
      if (hasDataRestore) {
        const restoredChatDbPath = path.join(dataRestore, DB_FILENAME)
        const hasChatDb = await fs.pathExists(restoredChatDbPath)

        if (!hasChatDb) {
          // Data.restore exists but has no chat.db — abort before consuming any staging.
          logger.error(
            '[handleStartupRestore] Data.restore exists but chat.db is missing — aborting restore. ' +
              'No staging directories consumed.'
          )
          throw new Error(
            '[handleStartupRestore] Data.restore exists but does not contain chat.db. ' +
              'LOCK-6008 requires every restore to include authoritative Data/chat.db. ' +
              'No staging directories consumed — all .restore dirs retained for retry.'
          )
        }

        // Create restore marker INSIDE Data.restore BEFORE replacing live Data.
        // This ensures the marker is atomically present when the rename completes.
        logger.info('[handleStartupRestore] Restored chat.db found — creating restore marker inside Data.restore')
        const markerPath = path.join(dataRestore, RESTORE_MARKER_FILENAME)
        try {
          await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8')
        } catch (error) {
          // Marker creation failure — abort before touching live Data.
          // Do NOT swallow as a successful restore.
          logger.error('[handleStartupRestore] Failed to create restore marker inside Data.restore:', error as Error)
          throw new Error(
            `Failed to create restore marker in Data.restore: ${error instanceof Error ? error.message : String(error)}. ` +
              'Aborting restore — no staging directories consumed.'
          )
        }
        logger.info('[handleStartupRestore] Restore marker created inside Data.restore')
      }

      // --- LOCK-6010: Phase 2 — Consume staging (only after Data.chat.db ---
      // --- preconditions succeed). If Data.restore was absent, no Data     ---
      // --- marker preconditions applied and staging can proceed.           ---

      // Restore IndexedDB
      if (hasIndexedDBRestore) {
        logger.info('[handleStartupRestore] Found IndexedDB.restore directories, completing restoration...')
        await fs.remove(indexedDBDest).catch(() => {})
        await fs.rename(indexedDBRestore, indexedDBDest)
      }

      // Restore Local Storage
      if (hasLocalStorageRestore) {
        logger.info('[handleStartupRestore] Found Local Storage.restore directories, completing restoration...')
        await fs.remove(localStorageDest).catch(() => {})
        await fs.rename(localStorageRestore, localStorageDest)
      }

      // Restore Data — marker already created inside Data.restore (Phase 1) if needed
      if (hasDataRestore) {
        logger.info('[handleStartupRestore] Found Data.restore directory, completing restoration...')
        await fs.remove(dataDest).catch(() => {})
        await fs.rename(dataRestore, dataDest)
      }

      logger.info('[handleStartupRestore] Restoration completed successfully')
    } catch (error) {
      logger.error('[handleStartupRestore] Failed to complete restoration:', error as Error)
      // Do NOT delete staged restore directories on failure.
      // All .restore dirs are retained for retry/diagnosis on next startup.
      throw error
    }
  }

  /**
   * Backup metadata for direct backup format (version 7+ L3).
   * LOCK-6004: New archives use a versioned discriminator with product/purpose.
   */
  private createDirectBackupMetadata(): L3ArchiveMetadata {
    return createL3ArchiveMetadata()
  }

  // ---------------------------------------------------------------------------
  // LOCK-L3-1 / LOCK-L3-2: Entries that must NEVER appear in L3 backup
  // archives.
  //
  // Live chat DB coordination files (historical behavior): chat.db is
  // replaced by a validated snapshot (LOCK-6008); WAL/SHM are live-replication
  // artifacts that are meaningless outside a running DB; chat.db.backup is a
  // transient snapshot staging file (LOCK-6020).
  //
  // L2 promotion internals at the Data root (LOCK-L3-2): the owned candidate
  // root, the promotion journal (+ staging), the chat.db rollback snapshot
  // (+ staging), the Files rollback snapshots (retained / old / staging),
  // the Files promote-staging dir, and the Dexie files-catalog snapshot
  // (+ staging). These are stale-state artifacts that must never round-trip
  // through a backup/restore. Names are imported from the L2 module constants
  // to avoid drift; the candidate root is pinned below (must equal
  // candidateDb.CANDIDATE_ROOT_DIRNAME) and cross-checked in
  // backupManager.production.test.ts.
  //
  // Exclusions apply by basename at every level of the Data subtree,
  // matching the historical filter semantics of copyDirWithProgressFiltered.
  // ---------------------------------------------------------------------------
  private static readonly EXCLUDED_DATA_ENTRIES: Set<string> = new Set([
    // Live chat DB coordination files
    'chat.db',
    'chat.db-wal',
    'chat.db-shm',
    'chat.db.backup',
    // L2 promotion internals at the Data root (LOCK-L3-2)
    'chat-import-candidates', // == candidateDb.CANDIDATE_ROOT_DIRNAME
    PROMOTION_JOURNAL_FILENAME,
    PROMOTION_JOURNAL_STAGING_FILENAME,
    ROLLBACK_SNAPSHOT_FILENAME,
    ROLLBACK_SNAPSHOT_STAGING_FILENAME,
    FILES_ROLLBACK_SNAPSHOT_DIRNAME,
    FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME,
    FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME,
    FILES_PROMOTE_STAGING_DIRNAME,
    FILES_CATALOG_SNAPSHOT_FILENAME,
    FILES_CATALOG_SNAPSHOT_STAGING_FILENAME
  ])

  // ---------------------------------------------------------------------------
  // LOCK-6012/6013/6019: Stream lifecycle helpers
  // ---------------------------------------------------------------------------

  /**
   * Await a Node.js stream's completion using `stream.finished`.
   * Resolves when the stream has successfully finished (emitted 'finish' or 'end'),
   * and rejects on error or premature close.
   *
   * LOCK-6013: Stream success/error paths settle closure before cleanup.
   * LOCK-6019: Read streams must complete before upload source cleanup.
   */
  static async awaitStreamFinished(stream: NodeJS.ReadableStream | NodeJS.WritableStream): Promise<void> {
    await finished(stream)
  }

  // ---------------------------------------------------------------------------
  // LOCK-6012/6013: Exclusive temp root/file ownership helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure the cherry-studio temp base directory exists before mkdtemp.
   * LOCK-6013: Provider operation roots must exist before mkdtemp to
   * prevent ENOENT on fresh installs.
   *
   * LOCK-6013/6012: After creation, verify the cherry-studio directory
   * is NOT a symlink and resolves canonically under the OS temp root.
   * A symlinked base could redirect extraction to an attacker-controlled
   * directory. If the cherry-studio path is a symlink (race condition:
   * attacker creates symlink between ensureDir calls), we REJECT it
   * rather than removing it — removing a raced symlink could delete a
   * legitimate directory that replaced it in the race window.
   */
  private static async ensureTempBase(): Promise<string> {
    // LOCK-6012: Canonicalize the OS temp directory to resolve legitimate
    // canonical aliases (e.g. /var → /private/var on macOS) while preserving
    // symlink-escape defense.  fs.realpath on the parent gives us the true
    // canonical root; we then build cherry-studio under it.
    const rawTemp = app.getPath('temp')
    await fs.ensureDir(rawTemp)
    const canonicalTemp = await fs.realpath(rawTemp)
    const basePath = path.join(canonicalTemp, 'cherry-studio')
    await fs.ensureDir(basePath)

    // LOCK-6013: Verify the cherry-studio directory is a real directory,
    // not a symlink. An attacker could race-create a symlink at this path
    // between ensureDir and our check.  We REJECT rather than remove —
    // removing a symlink that was swapped for a real directory by a
    // concurrent operation would delete the legitimate directory.
    const baseLstat = await fs.lstat(basePath)
    if (baseLstat.isSymbolicLink()) {
      const target = await fs.realpath(basePath).catch(() => 'unknown')
      throw new Error(
        `[ensureTempBase] cherry-studio temp base "${basePath}" is a symlink pointing to "${target}". ` +
          'LOCK-6013: Refusing to use a symlinked temp base. Remove the symlink manually if ' +
          'it was created by a race condition.'
      )
    }

    // Defense-in-depth: verify canonical containment
    const realBasePath = await fs.realpath(basePath)
    if (!realBasePath.startsWith(canonicalTemp + path.sep) && realBasePath !== canonicalTemp) {
      throw new Error(
        `[ensureTempBase] Temp base "${basePath}" resolves to "${realBasePath}" ` +
          `which escapes canonical temp root "${canonicalTemp}". LOCK-6012: Refusing to use.`
      )
    }

    return realBasePath
  }

  /**
   * Create a WriteStream that atomically claims a file via O_CREAT|O_EXCL.
   * LOCK-6012: Existing files/symlinks are never followed or truncated.
   * On macOS/Linux, O_CREAT|O_EXCL fails with EEXIST if the path already
   * exists or is a symlink — this prevents both truncation and symlink
   * following. On Windows, the 'wx' flag achieves the same via
   * CREATE_NEW disposition.
   *
   * Portability note: O_NOFOLLOW is not exposed as a Node.js flag constant.
   * On macOS, O_EXCL alone rejects symlinks (POSIX semantics). On Linux,
   * O_EXCL|O_CREAT also rejects symlinks. Windows CREATE_NEW does not
   * follow symlinks for the final component. This is sufficient for all
   * three platforms.
   */
  private static createExclusiveWriteStream(filePath: string): ReturnType<typeof createWriteStream> {
    return createWriteStream(filePath, { flags: 'wx' })
  }

  /**
   * Direct backup method — copies IndexedDB, Local Storage, and Data
   * directories into a ZIP archive with a consistent chat.db snapshot.
   *
   * Staging design (Finding 2):
   * - Each backup operation gets its own unique staging directory (no shared tempDir).
   * - Data/ is copied EXCLUDING chat.db, chat.db-wal, chat.db-shm, and
   *   transient backup artifacts (.backup files).
   * - If a live chat.db exists, a validated online-backup snapshot is created
   *   and staged as Data/chat.db in the staging directory.
   * - If the snapshot fails, the entire backup FAILS (no raw-copy fallback).
   * - The archive contains exactly one Data/chat.db (the snapshot) and no
   *   WAL/SHM/transient artifacts.
   *
   * Mutex design (Finding 4):
   * - The entire backup operation is serialised across local/WebDAV/S3
   *   entry points via a process-wide async mutex.
   * - Staging directory is cleaned up in `finally` to guarantee cleanup.
   *
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param destinationPath - Path to save the backup (defaults to this.backupDir)
   * @param skipBackupFile - Whether to skip backing up the Data directory
   * @returns Path to the created backup file
   */
  async backup(
    _: Electron.IpcMainInvokeEvent,
    fileName: string,
    destinationPath: string = this.backupDir,
    skipBackupFile: boolean = false
  ): Promise<string> {
    // Serialise the entire backup operation across all entry points
    return BackupManager.withBackupMutex(async () => {
      // LOCK-6012: Validate destination directory for symlink-free path
      // integrity. Every user-controlled local destination uses the same
      // canonical validation and immediate revalidation (LOCK-6028).
      const validatedDestDir = await validateLocalBackupDir(destinationPath)
      await fs.ensureDir(validatedDestDir)
      const acceptedDestination = await captureLocalBackupDestination(validatedDestDir)

      // LOCK-6012: Validate fileName as a single safe basename before
      // using it in path.join. Prevents traversal, absolute paths, and
      // other dangerous characters from escaping the destination.
      const validatedFileName = validateLocalBackupFileName(fileName, acceptedDestination.canonicalPath)

      let stagingDir: string | undefined
      let publicationWorkspace: string | undefined
      let capturedWorkspaceIdentity: WorkspaceIdentity | undefined

      const onProgress = this.onProgress(IpcChannel.BackupProgress, true)

      try {
        // LOCK-6035: Revalidate full destination chain identity immediately
        // before workspace creation (boundary 1 of 3). Prevents using a
        // stale destination after an ancestor swap.
        await revalidateLocalBackupDestination(acceptedDestination, 'backup-before-workspace-creation')

        // LOCK-6029: Stream only to an exclusive operation workspace inside
        // the accepted destination filesystem. The final name remains absent
        // until complete stream close and atomic publication.
        publicationWorkspace = await fs.mkdtemp(path.join(acceptedDestination.canonicalPath, '.cherry-studio-backup-'))

        // LOCK-6034: Capture workspace identity (dev/ino) immediately after
        // creation. Used by safeCleanupWorkspace to verify the workspace is
        // still the same object before cleanup.
        capturedWorkspaceIdentity = await captureWorkspaceIdentity(publicationWorkspace)

        const stagedArchivePath = path.join(publicationWorkspace, 'archive.tmp')

        const stagingBase = path.join(await BackupManager.ensureTempBase(), 'backup')
        await fs.ensureDir(stagingBase)
        stagingDir = await fs.mkdtemp(path.join(stagingBase, 'staging-'))
        onProgress({ stage: 'preparing', progress: 0, total: 100 })

        const userDataPath = app.getPath('userData')

        // Step 1: Copy IndexedDB and Local Storage directories
        onProgress({ stage: 'copying_database', progress: 15, total: 100 })
        logger.debug('[backupDirect] Copying database directories...')

        const indexedDBSource = path.join(userDataPath, 'IndexedDB')
        const indexedDBDest = path.join(stagingDir, 'IndexedDB')
        if (await fs.pathExists(indexedDBSource)) {
          await fs.copy(indexedDBSource, indexedDBDest)
        } else {
          logger.debug('[backupDirect] IndexedDB directory not found, skipping')
        }

        const localStorageSource = path.join(userDataPath, 'Local Storage')
        const localStorageDest = path.join(stagingDir, 'Local Storage')
        if (await fs.pathExists(localStorageSource)) {
          await fs.copy(localStorageSource, localStorageDest)
        } else {
          logger.debug('[backupDirect] Local Storage directory not found, skipping')
        }

        onProgress({ stage: 'copying_database', progress: 50, total: 100 })

        // Step 2: Write metadata.json
        const metadata = this.createDirectBackupMetadata()
        await fs.writeJson(path.join(stagingDir, 'metadata.json'), metadata, { spaces: 2 })
        onProgress({ stage: 'copying_database', progress: 52, total: 100 })

        // Step 3: Create consistent chat.db snapshot and copy Data directory
        // LOCK-6008: Every emitted L3 archive must contain authoritative
        // Data/chat.db. Absent/unavailable DB makes backup fail before
        // archive publication/upload.
        const sourcePath = path.join(userDataPath, 'Data')
        const liveDbPath = path.join(sourcePath, 'chat.db')

        // LOCK-6008: Pre-flight — chat.db must exist for a valid L3 archive
        const liveDbExists = await fs.pathExists(liveDbPath)
        if (!liveDbExists) {
          throw new Error(
            '[backupDirect] Data/chat.db not found. ' +
              'LOCK-6008 requires every L3 archive to contain authoritative Data/chat.db. ' +
              'Backup aborted.'
          )
        }

        // Data dir must exist (since chat.db exists inside it)
        const stagedDataDir = path.join(stagingDir, 'Data')

        // 3a: Create validated snapshot and stage it
        if (!chatDbService.isInitialised()) {
          throw new Error(
            '[backupDirect] Live chat.db exists but ChatDbService is not initialised. ' +
              'Cannot create consistent snapshot — backup aborted.'
          )
        }

        logger.debug('[backupDirect] Creating validated chat.db snapshot...')
        const chatDbBackup = chatDbService.getBackup()
        const stagedDbPath = path.join(stagedDataDir, 'chat.db')

        // Ensure staged Data/ exists before snapshot creation
        await fs.ensureDir(stagedDataDir)

        try {
          await chatDbBackup.createSnapshot(stagedDbPath)
          logger.debug('[backupDirect] Validated chat.db snapshot staged')
        } catch (snapshotError) {
          // Snapshot failure is FATAL — no raw-copy fallback
          logger.error('[backupDirect] Chat DB snapshot creation FAILED', snapshotError as Error)
          throw new Error(
            `[backupDirect] chat.db snapshot failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}. ` +
              'Backup aborted — raw copy of a live WAL database is not safe.'
          )
        }

        // 3b: Copy remaining Data directory files (excluding chat.db/WAL/SHM/transient artifacts)
        // SKIP when skipBackupFile=true — only chat.db is mandatory per LOCK-6008
        if (!skipBackupFile) {
          logger.debug('[backupDirect] Copying Data directory (excluding live DB files)...')
          const totalSize = await this.getDirSize(sourcePath, { dereferenceSymlinks: true })

          await this.copyDirWithProgressFiltered(
            sourcePath,
            stagedDataDir,
            BackupManager.EXCLUDED_DATA_ENTRIES,
            this.createCopyProgressHandler(totalSize, 52, 80, 'copying_files', onProgress),
            { dereferenceSymlinks: true }
          )
        } else {
          logger.debug('[backupDirect] skipBackupFile=true — chat.db snapshot included, other Data files skipped')
        }

        onProgress({ stage: 'compressing', progress: 80, total: 100 })

        // LOCK-6035: Revalidate full destination chain identity immediately
        // before staged archive open (boundary 2 of 3). Prevents writing to
        // a workspace that is no longer under the accepted destination.
        await revalidateLocalBackupDestination(acceptedDestination, 'backup-before-staged-archive-open')

        // Step 4: Create the ZIP only at the operation-owned staging path.
        // Preserve the user's accepted destination spelling (including the
        // narrow macOS aliases) for the public return value and final path.
        // The operation workspace remains under the canonical destination.
        const backupedFilePath = path.join(validatedDestDir, validatedFileName)
        const output = BackupManager.createExclusiveWriteStream(stagedArchivePath)
        const archive = archiver('zip', {
          zlib: { level: 1 },
          zip64: true
        })

        // LOCK-6013: Use stream.finished to await writable completion before
        // declaring the archive complete. This guarantees the output file is
        // fully flushed and closed before any subsequent operations.
        let archiveError: unknown = undefined
        await new Promise<void>((resolve, reject) => {
          // Settled flag prevents double resolve/reject when both
          // output error and archive error fire.
          let settled = false
          const settle = (fn: () => void) => {
            if (!settled) {
              settled = true
              fn()
            }
          }

          output.on('close', () => settle(resolve))
          output.on('error', (err) => {
            // LOCK-6013: On output error, abort archive to prevent it from
            // continuing to write to a broken pipe.
            try {
              archive.abort()
            } catch {
              /* best-effort — archive may already be finalised */
            }
            settle(() => reject(err))
          })
          archive.on('error', (err) => {
            // LOCK-6013: On archive error, abort the archive and destroy
            // the output to release the file descriptor before cleanup.
            try {
              archive.abort()
            } catch {
              /* best-effort — archive may already be finalised */
            }
            output.destroy(err instanceof Error ? err : new Error(String(err)))
            settle(() => reject(err))
          })
          archive.on('warning', (err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') {
              logger.warn('[backupDirect] Archive warning:', err)
            }
          })
          archive.pipe(output)
          archive.directory(stagingDir, false)
          archive.finalize()
        }).catch((err) => {
          archiveError = err
        })

        if (archiveError) {
          // LOCK-6013: Await terminal settlement of output before path cleanup.
          // output.destroy() was already called in the error handler.
          await BackupManager.awaitStreamFinished(output).catch(() => {})
          throw archiveError
        }

        // LOCK-6013: Explicitly await stream finished AFTER the Promise resolves
        // to guarantee the writable stream's underlying file descriptor is closed.
        await BackupManager.awaitStreamFinished(output)

        // Full component no-follow rewalk and dev/ino identity match occurs
        // immediately before same-filesystem atomic no-clobber publication.
        await publishLocalBackupArchive(stagedArchivePath, backupedFilePath, acceptedDestination)

        onProgress({ stage: 'completed', progress: 100, total: 100 })

        logger.info('[backupDirect] Backup completed successfully')
        return backupedFilePath
      } catch (error) {
        logger.error('[backupDirect] Backup failed:', error as Error)
        throw error
      } finally {
        // Never remove by final pathname. Cleanup is restricted to exclusive,
        // operation-owned workspaces.
        if (stagingDir) {
          await fs.remove(stagingDir).catch(() => {})
        }
        // LOCK-6034: Identity-checked workspace cleanup. Rewalks full
        // destination chain and workspace dev/ino before removal. If either
        // changed (ancestor swap, workspace replacement), cleanup is skipped,
        // an orphan is left, and a safe path-free warning is logged.
        // LOCK-6036: Residual TOCTOU between identity check and fs.remove
        // syscall is acknowledged — Node lacks openat/linkat APIs.
        if (publicationWorkspace && capturedWorkspaceIdentity) {
          await safeCleanupWorkspace(capturedWorkspaceIdentity, acceptedDestination, 'backup')
        } else if (publicationWorkspace) {
          // Fallback: workspace identity was never captured (should not happen)
          await fs.remove(publicationWorkspace).catch(() => {})
        }
      }
    })
  }

  /**
   * Process-wide async mutex for backup operations.
   * Ensures only one backup runs at a time across all entry points.
   *
   * Phase 4.4.1 (LOCK-4416): each outer complete backup operation also
   * holds the shared chat DB maintenance lease ('backup') for its full
   * duration, making it mutually exclusive with restore, promotion, and
   * live ChatDbService init/close. Acquisition is non-blocking: if another
   * maintenance operation holds the lease, the backup fails with a
   * structured MaintenanceBusyError. The lease wraps fn() inside the
   * internal mutex, so ChatDbBackup's fine-grained snapshot mutex (called
   * within fn) never nests a second shared-lease acquisition — no implicit
   * nested live lock.
   */
  private static async withBackupMutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => withMaintenanceLease(getSharedMaintenanceCoordinator(), 'backup', 'backup-manager', fn)
    const result = BackupManager.backupMutex.then(
      () => run(),
      () => run()
    )
    BackupManager.backupMutex = result.then(
      () => {},
      () => {}
    )
    return result
  }

  // ---------------------------------------------------------------------------
  // Finding 5: Full backup operation semantics
  //
  // Local/WebDAV/S3 operations serialise the ENTIRE create+upload+delete
  // cycle through withBackupMutex. This prevents:
  // - Two remote backups reading/writing the same archive file
  // - Staging directory collisions
  // - Partial archive leftovers on failure
  //
  // Each operation generates a unique archive file name to avoid
  // collisions even if the mutex were somehow bypassed.
  //
  // All failure paths clean up staged directories AND partial archives.
  // ---------------------------------------------------------------------------

  /**
   * Direct backup to local directory.
   * Creates a backup and saves it to a local directory.
   * Finding 5: Full operation serialised via backup() which holds the mutex.
   *
   * LOCK-6012: Validates every component of localBackupDir for symlink-free
   * path integrity before any write. Revalidates the parent directory
   * immediately before the exclusive write to narrow the TOCTOU race window.
   *
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param localConfig - Local backup configuration (directory path and options)
   * @returns Path to the created backup file
   */
  async backupToLocalDir(
    _: Electron.IpcMainInvokeEvent,
    fileName: string,
    localConfig: { localBackupDir?: string; skipBackupFile?: boolean }
  ) {
    try {
      let backupDir = localConfig.localBackupDir || this.backupDir
      // LOCK-6012: Validate every component of the local backup directory
      // for symlink-free path integrity. Rejects symlinked parents/dirs
      // and canonical escapes.
      if (localConfig.localBackupDir) {
        backupDir = await validateLocalBackupDir(localConfig.localBackupDir)
      }
      await fs.ensureDir(backupDir)
      // LOCK-6012: Revalidate parent directory immediately before backup()
      // opens the exclusive write stream. This narrows the TOCTOU race
      // window where a symlink could be inserted between validation and write.
      await revalidateParentDir(path.join(backupDir, 'placeholder'), 'backupToLocalDir')
      return await this.backup(_, fileName, backupDir, localConfig.skipBackupFile)
    } catch (error) {
      logger.error('[backupToLocalDir] Local backup failed:', error as Error)
      throw error
    }
  }

  /**
   * Direct backup to WebDAV.
   * Creates a backup and uploads it to a WebDAV server.
   *
   * Finding 5: The ENTIRE create+upload+delete cycle is serialised
   * through the backup mutex to prevent archive file races.
   *
   * Finding 5: Uses a unique archive file name per operation to avoid
   * overwriting an active archive from a concurrent operation.
   *
   * LOCK-6019: Intermediate archives are written to an exclusive
   * per-operation temp directory (not shared backupDir). This prevents
   * symlink following/truncation even if the mutex were bypassed.
   *
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration including server URL, credentials, and options
   * @returns Result from WebDAV upload operation
   */
  async backupToWebdav(_: Electron.IpcMainInvokeEvent, webdavConfig: WebDavConfig) {
    // Finding 5: Serialize entire create+upload+delete through the mutex
    return BackupManager.withBackupMutex(async () => {
      // Finding 5: Unique archive file name per operation
      const uniqueFilename = this.uniqueArchiveName(webdavConfig.fileName || 'cherry-studio.backup.zip')

      // LOCK-6019: Exclusive per-operation root for intermediate archives.
      // The archive is created inside an mkdtemp directory that no other
      // operation can collide with. Cleaned in finally.
      const basePath = await BackupManager.ensureTempBase()
      const opDir = await fs.mkdtemp(path.join(basePath, 'upload-'))
      const backupedFilePath = path.join(opDir, uniqueFilename)

      try {
        // Create the archive inside the exclusive per-operation temp dir
        await this.backupInternal(_, uniqueFilename, opDir, webdavConfig.skipBackupFile)

        const webdavClient = this.getWebDavInstance(webdavConfig)
        let result
        if (webdavConfig.disableStream) {
          const fileContent = await fs.readFile(backupedFilePath)
          result = await webdavClient.putFileContents(uniqueFilename, fileContent, { overwrite: true })
        } else {
          const contentLength = (await fs.stat(backupedFilePath)).size
          // LOCK-6019: Create and manage the read stream lifecycle explicitly.
          // The stream must be closed after upload completes/fails to ensure
          // the source file's file descriptor is released before cleanup.
          const readStream = fs.createReadStream(backupedFilePath)
          try {
            result = await webdavClient.putFileContents(uniqueFilename, readStream, {
              overwrite: true,
              contentLength
            })
          } finally {
            // LOCK-6019: Ensure read stream is closed after upload returns/throws.
            // This guarantees the source file's file descriptor is released
            // before the operation root is cleaned up in the outer finally block.
            readStream.destroy()
            await BackupManager.awaitStreamFinished(readStream).catch(() => {})
          }
        }
        return result
      } catch (error) {
        logger.error('[backupToWebdav] WebDAV backup failed:', error as Error)
        throw error
      } finally {
        // LOCK-6019: Always clean up the exclusive per-operation temp directory.
        await fs.remove(opDir).catch(() => {})
      }
    })
  }

  /**
   * Direct backup to S3.
   * Creates a backup and uploads it to an S3-compatible storage.
   *
   * Finding 5: The ENTIRE create+upload+delete cycle is serialised
   * through the backup mutex to prevent archive file races.
   *
   * Finding 5: Uses a unique archive file name per operation to avoid
   * overwriting an active archive from a concurrent operation.
   *
   * LOCK-6019: Intermediate archives are written to an exclusive
   * per-operation temp directory (not shared backupDir).
   *
   * @param _ - Electron IPC event
   * @param s3Config - S3 configuration including endpoint, bucket, credentials, and options
   * @returns Result from S3 upload operation
   */
  async backupToS3(_: Electron.IpcMainInvokeEvent, s3Config: S3Config) {
    // Finding 5: Serialize entire create+upload+delete through the mutex
    return BackupManager.withBackupMutex(async () => {
      const os = require('os')
      const deviceName = os.hostname ? os.hostname() : 'device'
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T.Z]/g, '')
        .slice(0, 14)
      // Finding 5: Unique archive file name per operation
      const baseFilename = s3Config.fileName || `cherry-studio.backup.${deviceName}.${timestamp}.zip`
      const uniqueFilename = this.uniqueArchiveName(baseFilename)

      // LOCK-6019: Exclusive per-operation root for intermediate archives.
      const basePath = await BackupManager.ensureTempBase()
      const opDir = await fs.mkdtemp(path.join(basePath, 'upload-'))
      const backupedFilePath = path.join(opDir, uniqueFilename)

      logger.debug(`[backupToS3] Starting S3 backup to ${uniqueFilename}`)

      try {
        // Create the archive inside the exclusive per-operation temp dir
        await this.backupInternal(_, uniqueFilename, opDir, s3Config.skipBackupFile)

        const s3Client = this.getS3Storage(s3Config)
        const fileBuffer = await fs.promises.readFile(backupedFilePath)
        const result = await s3Client.putFileContents(uniqueFilename, fileBuffer)
        logger.info(`S3 backup completed: ${uniqueFilename}`)
        return result
      } catch (error) {
        logger.error('[backupToS3] S3 backup failed:', error as Error)
        throw error
      } finally {
        // LOCK-6019: Always clean up the exclusive per-operation temp directory.
        await fs.remove(opDir).catch(() => {})
      }
    })
  }

  /**
   * Generate a unique archive file name by appending a timestamp+random
   * suffix before the extension. Prevents collisions between concurrent
   * operations even if the mutex were somehow bypassed.
   */
  private uniqueArchiveName(baseName: string): string {
    const ext = path.extname(baseName)
    const base = path.basename(baseName, ext)
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return `${base}.${suffix}${ext}`
  }

  /**
   * Internal backup implementation — creates the archive file at the
   * specified path. Used by backupToWebdav/backupToS3 which manage
   * their own mutex and cleanup.
   *
   * This is the same logic as backup() but writes to an explicit path
   * rather than constructing the path from fileName + destinationPath.
   */
  private async backupInternal(
    _: Electron.IpcMainInvokeEvent,
    fileName: string,
    destinationPath: string,
    skipBackupFile: boolean = false
  ): Promise<string> {
    // Unique staging directory per backup operation — fs.mkdtemp for atomic exclusive creation
    const stagingBase = path.join(await BackupManager.ensureTempBase(), 'backup')
    await fs.ensureDir(stagingBase)
    const stagingDir = await fs.mkdtemp(path.join(stagingBase, 'staging-'))

    const onProgress = this.onProgress(IpcChannel.BackupProgress, true)

    // LOCK-6012: Track whether we successfully created the archive file.
    // Declared outside try/catch so it's accessible in both blocks.
    let archiveCreated = false

    try {
      await fs.ensureDir(stagingDir)
      onProgress({ stage: 'preparing', progress: 0, total: 100 })

      const userDataPath = app.getPath('userData')

      // Step 1: Copy IndexedDB and Local Storage directories
      onProgress({ stage: 'copying_database', progress: 15, total: 100 })
      logger.debug('[backupInternal] Copying database directories...')

      const indexedDBSource = path.join(userDataPath, 'IndexedDB')
      const indexedDBDest = path.join(stagingDir, 'IndexedDB')
      if (await fs.pathExists(indexedDBSource)) {
        await fs.copy(indexedDBSource, indexedDBDest)
      }

      const localStorageSource = path.join(userDataPath, 'Local Storage')
      const localStorageDest = path.join(stagingDir, 'Local Storage')
      if (await fs.pathExists(localStorageSource)) {
        await fs.copy(localStorageSource, localStorageDest)
      }

      onProgress({ stage: 'copying_database', progress: 50, total: 100 })

      // Step 2: Write metadata.json
      const metadata = this.createDirectBackupMetadata()
      await fs.writeJson(path.join(stagingDir, 'metadata.json'), metadata, { spaces: 2 })
      onProgress({ stage: 'copying_database', progress: 52, total: 100 })

      // Step 3: Create consistent chat.db snapshot and copy Data directory
      // LOCK-6008: Every emitted L3 archive must contain authoritative
      // Data/chat.db. Absent/unavailable DB makes backup fail before
      // archive publication/upload.
      const sourcePath = path.join(userDataPath, 'Data')
      const liveDbPath = path.join(sourcePath, 'chat.db')

      // LOCK-6008: Pre-flight — chat.db must exist for a valid L3 archive
      const liveDbExists = await fs.pathExists(liveDbPath)
      if (!liveDbExists) {
        throw new Error(
          '[backupInternal] Data/chat.db not found. ' +
            'LOCK-6008 requires every L3 archive to contain authoritative Data/chat.db. ' +
            'Backup aborted.'
        )
      }

      // Data dir must exist (since chat.db exists inside it)
      const stagedDataDir = path.join(stagingDir, 'Data')

      // 3a: Create validated snapshot and stage it
      if (!chatDbService.isInitialised()) {
        throw new Error(
          '[backupInternal] Live chat.db exists but ChatDbService is not initialised. ' +
            'Cannot create consistent snapshot — backup aborted.'
        )
      }

      logger.debug('[backupInternal] Creating validated chat.db snapshot...')
      const chatDbBackup = chatDbService.getBackup()
      const stagedDbPath = path.join(stagedDataDir, 'chat.db')

      await fs.ensureDir(stagedDataDir)

      try {
        await chatDbBackup.createSnapshot(stagedDbPath)
        logger.debug('[backupInternal] Validated chat.db snapshot staged')
      } catch (snapshotError) {
        logger.error('[backupInternal] Chat DB snapshot creation FAILED', snapshotError as Error)
        throw new Error(
          `[backupInternal] chat.db snapshot failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}. ` +
            'Backup aborted — raw copy of a live WAL database is not safe.'
        )
      }

      // Copy remaining Data directory files (excluding chat.db/WAL/SHM/transient artifacts)
      // SKIP when skipBackupFile=true — only chat.db is mandatory per LOCK-6008
      if (!skipBackupFile) {
        logger.debug('[backupInternal] Copying Data directory (excluding live DB files)...')
        const totalSize = await this.getDirSize(sourcePath, { dereferenceSymlinks: true })

        await this.copyDirWithProgressFiltered(
          sourcePath,
          stagedDataDir,
          BackupManager.EXCLUDED_DATA_ENTRIES,
          this.createCopyProgressHandler(totalSize, 52, 80, 'copying_files', onProgress),
          { dereferenceSymlinks: true }
        )
      } else {
        logger.debug('[backupInternal] skipBackupFile=true — chat.db snapshot included, other Data files skipped')
      }

      onProgress({ stage: 'compressing', progress: 80, total: 100 })

      // Step 4: Create ZIP archive from staging directory
      // LOCK-6019: backupInternal is only called by remote backup paths
      // (backupToWebdav/backupToS3) which always pass exclusive per-operation
      // temp dirs. Use O_EXCL for defense-in-depth — prevents truncation of
      // any existing file at the archive path.
      const archivePath = path.join(destinationPath, fileName)
      const output = BackupManager.createExclusiveWriteStream(archivePath)
      // LOCK-6029: Ownership starts when exclusive output open succeeds.
      // Any later failure removes only that owned partial file; wx failure
      // before open never removes a pre-existing file.
      output.on('open', () => {
        archiveCreated = true
      })
      const archive = archiver('zip', {
        zlib: { level: 1 },
        zip64: true
      })

      // LOCK-6013: Use stream.finished to await writable completion before
      // declaring the archive complete. This guarantees the output file is
      // fully flushed and closed before any subsequent operations.
      let archiveError: unknown = undefined
      await new Promise<void>((resolve, reject) => {
        // Settled flag prevents double resolve/reject when both
        // output error and archive error fire.
        let settled = false
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true
            fn()
          }
        }

        output.on('close', () => settle(resolve))
        output.on('error', (err) => {
          // LOCK-6013: On output error, abort archive to prevent it from
          // continuing to write to a broken pipe.
          try {
            archive.abort()
          } catch {
            /* best-effort — archive may already be finalised */
          }
          settle(() => reject(err))
        })
        archive.on('error', (err) => {
          // LOCK-6013: On archive error, abort the archive and destroy
          // the output to release the file descriptor before cleanup.
          try {
            archive.abort()
          } catch {
            /* best-effort — archive may already be finalised */
          }
          output.destroy(err instanceof Error ? err : new Error(String(err)))
          settle(() => reject(err))
        })
        archive.on('warning', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') {
            logger.warn('[backupInternal] Archive warning:', err)
          }
        })
        archive.pipe(output)
        archive.directory(stagingDir, false)
        archive.finalize()
      }).catch((err) => {
        archiveError = err
      })

      if (archiveError) {
        // LOCK-6013: Await terminal settlement of output before path cleanup.
        // output.destroy() was already called in the error handler.
        await BackupManager.awaitStreamFinished(output).catch(() => {})
        throw archiveError
      }

      // LOCK-6013: Explicitly await stream finished AFTER the Promise resolves
      // to guarantee the writable stream's underlying file descriptor is closed.
      await BackupManager.awaitStreamFinished(output)

      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('[backupInternal] Backup completed successfully')
      return archivePath
    } catch (error) {
      logger.error('[backupInternal] Backup failed:', error as Error)
      // LOCK-6012: Only remove the file if WE created it (O_EXCL succeeded).
      // If O_EXCL failed or archive creation failed, the file either doesn't
      // exist or belongs to someone else — never remove it.
      if (archiveCreated) {
        const archivePath = path.join(destinationPath, fileName)
        await fs.remove(archivePath).catch(() => {})
      }
      throw error
    } finally {
      // Guarantee cleanup of the unique staging directory
      await fs.remove(stagingDir).catch(() => {})
    }
  }

  /**
   * Restore from a backup file.
   *
   * LOCK-6009: All L3 restore paths require metadata.json. Archives without
   * metadata (legacy data.json format) are rejected — legacy logical restore
   * is no longer reachable from any L3 path.
   *
   * For direct backup: replaces IndexedDB and Local Storage directories, then relaunches app.
   * @param _ - Electron IPC event
   * @param backupPath - Path to the backup ZIP file
   * @param options - Optional restore options
   * @param options.preExitCleanup - LOCK-6014: Provider-owned resources to clean
   *   before app.exit. For remote restores (WebDAV/S3), this cleans the
   *   download directory. For local user-selected backups, this is omitted.
   * @returns void (app will relaunch on success)
   */
  async restore(
    _: Electron.IpcMainInvokeEvent,
    backupPath: string,
    options?: { preExitCleanup?: () => Promise<void> }
  ): Promise<void> {
    // Phase 4.4.1 (LOCK-4416): restore staging holds the shared chat DB
    // maintenance lease ('restore') for its full duration — mutually
    // exclusive with backup, promotion, and live init/close. Fails with a
    // structured MaintenanceBusyError when another operation holds the
    // lease. The lease is released in withMaintenanceLease's finally, even
    // on failure (owner-safe).
    return withMaintenanceLease(getSharedMaintenanceCoordinator(), 'restore', 'backup-manager-restore', async () => {
      const onProgress = this.onProgress(IpcChannel.RestoreProgress, true)

      // LOCK-6013: Each restore uses a unique clean extraction workspace.
      // Abandoned roots are cleaned with bounded recovery/cleanup and
      // cannot influence later restore classification.
      const basePath = await BackupManager.ensureTempBase()
      const restoreBase = path.join(basePath, 'restore')

      // LOCK-6012: Validate the restore base is not a symlink before creating
      // the extraction workspace under it. A symlinked base could redirect
      // extraction to an attacker-controlled directory.  Canonical containment:
      // the realpath of restoreBase must be canonically under basePath, which
      // is itself the canonical (realpath-resolved) temp root.
      await fs.ensureDir(restoreBase)
      try {
        const baseReal = await fs.realpath(restoreBase)
        if (!baseReal.startsWith(basePath + path.sep) && baseReal !== basePath) {
          throw new Error(
            `[restore] Restore base directory "${restoreBase}" resolves to "${baseReal}" ` +
              `which escapes canonical temp root "${basePath}". LOCK-6012: Refusing to create extraction workspace.`
          )
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('LOCK-6012')) {
          throw err
        }
        // realpath can fail if dir doesn't exist yet (ensureDir may create it) — that's safe
      }

      // LOCK-6013: Use fs.mkdtemp for atomic exclusive directory creation.
      // The OS guarantees the returned path is unique and created atomically;
      // no pre-existing symlink or path can collide.
      // LOCK-6012: Immediately revalidate restoreBase before mkdtemp to narrow
      // the TOCTOU window where a symlink could be inserted after canonical
      // validation above.
      await revalidateParentDir(path.join(restoreBase, 'extraction-'), 'restore')
      const extractionDir = await fs.mkdtemp(path.join(restoreBase, 'extraction-'))

      let zip: StreamZip.StreamZipAsync | null = null

      try {
        onProgress({ stage: 'preparing', progress: 0, total: 100 })

        logger.debug(`step 1: validate and unzip backup file: ${extractionDir}`)

        zip = new StreamZip.async({ file: backupPath })

        // LOCK-6012: Validate ALL entries before extraction.
        // Every entry name is untrusted; reject traversal, absolute paths,
        // NUL bytes, ambiguous separators, symlink/special entries,
        // encrypted entries, and canonical containment violations.
        onProgress({ stage: 'validating', progress: 5, total: 100 })
        const validation = await validateRestoreZipEntries(zip, extractionDir)
        logger.debug(`ZIP entry validation passed: ${validation.entryCount} entries`)
        onProgress({ stage: 'validated', progress: 10, total: 100 })

        // LOCK-6012: Only after validation passes, extract to unique workspace
        onProgress({ stage: 'extracting', progress: 15, total: 100 })
        await zip.extract(null, extractionDir)
        await zip.close()
        zip = null
        onProgress({ stage: 'extracted', progress: 20, total: 100 })

        // LOCK-6009: All L3 restore paths must have metadata.json.
        // Archives without metadata are not supported L3 format.
        // Historical legacy formats are unreachable from L3 restore.
        const metadataPath = path.join(extractionDir, 'metadata.json')
        const isDirectBackup = await fs.pathExists(metadataPath)

        if (isDirectBackup) {
          // Direct backup format (version 6+)
          logger.debug('Detected direct backup format (version 6+)')
          // Pass the unique extractionDir so restoreDirect uses it
          // LOCK-6014: Pass preExitCleanup so provider-owned resources are
          // cleaned before app.exit. For local user-selected backups, this
          // is undefined (no cleanup needed).
          await this.restoreDirect(extractionDir, options?.preExitCleanup)
          // Direct restore doesn't return data - app needs to relaunch
          return
        }

        // LOCK-6009: Metadata-less archives are rejected.
        // Legacy data.json/Dexie logical restore is no longer reachable
        // from any L3 restore path (local/WebDAV/S3/Nutstore/file picker).
        throw new Error(
          '[restore] Archive does not contain metadata.json. ' +
            'This is not a supported L3 backup format. Legacy logical restore is not supported.'
        )
      } catch (error) {
        logger.error('Restore failed:', error as Error)
        // Bounded cleanup: remove the unique extraction directory on failure.
        // LOCK-6013: Abandoned roots cannot influence later restore classification.
        await fs.remove(extractionDir).catch((cleanupError) => {
          logger.warn('[restore] Failed to clean extraction directory', { extractionDir, error: cleanupError })
        })
        throw error
      } finally {
        // Ensure zip is always closed even if validation or extraction fails
        if (zip) {
          await zip.close().catch(() => {})
        }
      }
    })
  }

  /**
   * Restore from direct backup format (version 6+).
   *
   * LOCK-6005: Validates metadata and Data/chat.db BEFORE staging or
   * destructive replacement. Rejects unsupported future versions, wrong
   * purpose/product, missing DB, malformed DB, and failed integrity.
   *
   * LOCK-6004: Existing v6 direct archives remain restorable as bounded
   * backward-compatible format (no product/purpose required).
   *
   * LOCK-6013: Accepts extractionDir as parameter — each restore uses a
   * unique clean extraction workspace, not a shared stale directory.
   *
   * LOCK-6014: Accepts optional preExitCleanup for provider-owned resources
   * (e.g., download directory) that must be cleaned before app.exit. Local
   * user-selected backups do not provide this callback.
   *
   * Writes to `*.restore` directories; `handleStartupRestore` performs the atomic
   * swap on next launch, before any DB connection or window opens. Avoids
   * overwriting live IndexedDB / libsql files (issue #14774).
   *
   * @param extractionDir  Unique extraction workspace (LOCK-6013)
   * @param preExitCleanup Optional provider-owned resource cleanup (LOCK-6014)
   */
  private async restoreDirect(extractionDir: string, preExitCleanup?: () => Promise<void>): Promise<void> {
    const onProgress = this.onProgress(IpcChannel.RestoreProgress, true)

    const userDataPath = app.getPath('userData')
    const indexedDBDest = path.join(userDataPath, 'IndexedDB.restore')
    const localStorageDest = path.join(userDataPath, 'Local Storage.restore')
    const dataDest = path.join(userDataPath, 'Data.restore')

    // --- Phase 1-3: Validate metadata, validate DB, stage restore dirs ---
    // LOCK-6013/6014: Staging failure is the only case that undoes staged
    // directories. Post-staging failures (extraction cleanup, preExitCleanup)
    // propagate without undoing staging — the staged .restore dirs are ready
    // for handleStartupRestore on next launch.
    try {
      // --- Phase 1: Validate metadata (LOCK-6005) ---
      const metadataPath = path.join(extractionDir, 'metadata.json')
      const metadata = await fs.readJson(metadataPath)

      const validation = validateL3ArchiveMetadata(metadata)
      if (validation !== null) {
        throw new Error(
          `[restoreDirect] Archive metadata rejected: ${validation.reason}. ` +
            'This backup file is not a supported Cherry Chat L3 archive.'
        )
      }

      // Warn about cross-platform restore
      if (metadata.platform && metadata.platform !== process.platform) {
        logger.warn(
          `[restoreDirect] Cross-platform restore: backup from ${metadata.platform}, current is ${process.platform}`
        )
      }

      onProgress({ stage: 'validating', progress: 25, total: 100 })

      // --- Phase 2: Validate extracted Data/chat.db (LOCK-6005/6008) ---
      const dataSource = path.join(extractionDir, 'Data')
      const dataExists = await fs.pathExists(dataSource)
      const hasChatDbInArchive = dataExists && (await fs.pathExists(path.join(dataSource, 'chat.db')))

      if (hasChatDbInArchive) {
        logger.debug('[restoreDirect] Validating extracted chat.db before staging...')
        const extractedChatDbPath = path.join(dataSource, 'chat.db')

        // Use the shared readonly validation gate from the promotion module.
        // sampleCount=2: minimal reads to verify basic structure without
        // spending excessive time on large databases.
        const dbValidation = validateReadonlyChatDb(extractedChatDbPath, 2)
        if (dbValidation !== null) {
          throw new Error(
            `[restoreDirect] Extracted chat.db validation failed at gate '${dbValidation.gate}' ` +
              `(code: ${dbValidation.safeCode}). Archive contains an invalid, incompatible, or corrupt database.`
          )
        }
        logger.debug('[restoreDirect] Extracted chat.db validation passed')
      } else {
        // LOCK-6008: Data dir absent OR Data has files but no chat.db — reject.
        // A valid L3 archive must always contain authoritative Data/chat.db.
        throw new Error(
          '[restoreDirect] Archive does not contain authoritative Data/chat.db. ' +
            'LOCK-6008 requires every L3 archive to include Data/chat.db. ' +
            'Restore aborted — no .restore staging performed.'
        )
      }

      onProgress({ stage: 'restoring_database', progress: 30, total: 100 })

      // --- Phase 3: Stage restore directories (only after validation passes) ---
      const indexedDBSource = path.join(extractionDir, 'IndexedDB')
      const localStorageSource = path.join(extractionDir, 'Local Storage')

      logger.debug('[restoreDirect] Staging database directories...')

      if (await fs.pathExists(indexedDBSource)) {
        await fs.remove(indexedDBDest).catch(() => {})
        await fs.copy(indexedDBSource, indexedDBDest)
      }

      if (await fs.pathExists(localStorageSource)) {
        await fs.remove(localStorageDest).catch(() => {})
        await fs.copy(localStorageSource, localStorageDest)
      }

      onProgress({ stage: 'restoring_database', progress: 65, total: 100 })

      // Stage Data directory (validated above — Data/chat.db always present)
      if (dataExists) {
        logger.debug('[restoreDirect] Staging Data directory...')

        const totalSize = await this.getDirSize(dataSource, { dereferenceSymlinks: false })

        await fs.remove(dataDest).catch(() => {})

        await this.copyDirWithProgress(
          dataSource,
          dataDest,
          this.createCopyProgressHandler(totalSize, 65, 95, 'restoring_data', onProgress),
          { dereferenceSymlinks: false }
        )
      } else {
        logger.debug('[restoreDirect] No Data directory to restore')
      }
    } catch (error) {
      logger.error('[restoreDirect] Restore failed:', error as Error)
      // Staging failed — undo all staged directories
      await Promise.all([
        fs.remove(extractionDir).catch(() => {}),
        fs.remove(indexedDBDest).catch(() => {}),
        fs.remove(localStorageDest).catch(() => {}),
        fs.remove(dataDest).catch(() => {})
      ])
      throw error
    }

    // --- Post-staging: cleanup and relaunch (LOCK-6013/6014) ---
    // These are part of the pre-exit gate. Failure here does NOT undo staging
    // — the staged .restore dirs are ready for handleStartupRestore on next launch.

    // LOCK-6013: Clean up the unique extraction directory after successful staging.
    // Failure prevents relaunch per LOCK-6014 — the error propagates.
    await fs.remove(extractionDir)

    // LOCK-6014: Clean provider-owned resources before app.exit.
    // For remote restores (WebDAV/S3), this cleans the download directory
    // containing the downloaded backup file. For local user-selected backups,
    // preExitCleanup is undefined — the user's backup file is untouched.
    // This runs before app.relaunch/app.exit because those calls terminate
    // the process without running finally blocks.
    //
    // LOCK-6014: preExitCleanup failure is a restore failure and must
    // prevent relaunch/exit. The error propagates to the caller.
    if (preExitCleanup) {
      await preExitCleanup()
    }

    onProgress({ stage: 'completed', progress: 100, total: 100 })

    logger.info('[restoreDirect] Restore staged successfully, relaunching app to apply...')

    app.relaunch()
    app.exit(0)
  }

  // LOCK-6009: restoreLegacy() removed. Metadata-less data.json/Dexie logical
  // restore is no longer reachable from any L3 restore path. Historical formats
  // remain only behind this unreachable migration boundary — no existing code
  // requires them.

  /**
   * Restore from a local backup file
   * LOCK-6012: Validates localBackupDir for symlink-free path integrity.
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param localBackupDir - Directory where the backup file is located
   * @returns Result from restore operation
   */
  async restoreFromLocalBackup(_: Electron.IpcMainInvokeEvent, fileName: string, localBackupDir: string) {
    try {
      // LOCK-6012: Validate directory components for symlink-free integrity
      const validatedDir = await validateLocalBackupDir(localBackupDir)
      const backupPath = resolveAndValidatePath(validatedDir, fileName)

      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`)
      }

      return await this.restore(_, backupPath)
    } catch (error) {
      logger.error('[BackupManager] Local restore failed:', error as Error)
      throw error
    }
  }

  /**
   * Restore from a WebDAV backup
   * Downloads the backup file from WebDAV server and restores it.
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration including server URL, credentials, and file name
   * @returns Result from restore operation
   */
  async restoreFromWebdav(_: Electron.IpcMainInvokeEvent, webdavConfig: WebDavConfig) {
    const rawFilename = webdavConfig.fileName || 'cherry-studio.backup.zip'
    const webdavClient = this.getWebDavInstance(webdavConfig)
    // LOCK-6013: Ensure the cherry-studio temp base exists before mkdtemp.
    // On fresh installs the parent directory may not exist yet, causing
    // ENOENT from mkdtemp.
    const basePath = await BackupManager.ensureTempBase()
    // LOCK-6012: Create an exclusive operation-owned temp directory for the
    // downloaded file. mkdtemp guarantees atomic unique creation; the
    // downloaded content never touches a shared or pre-existing path.
    const downloadDir = await fs.mkdtemp(path.join(basePath, 'download-'))
    try {
      const retrievedFile = await webdavClient.getFileContents(rawFilename)

      // LOCK-6012: Provider-controlled filenames must never be used directly
      // in path.join() for local file writes. Sanitize to a safe basename
      // and write inside the exclusive operation-owned temp directory.
      const safeFilename = sanitizeProviderFilename(rawFilename, downloadDir)
      const backupedFilePath = path.join(downloadDir, safeFilename)

      // LOCK-6012: Atomically claim the file with O_CREAT|O_EXCL.
      // The 'wx' flag creates a new file and fails if it already exists
      // or is a symlink — preventing truncation and symlink following.
      // LOCK-6013: Use stream.finished to await writable completion before
      // calling restore. This guarantees the downloaded content is fully
      // flushed and the file descriptor is closed before restore reads the file.
      const writeStream = BackupManager.createExclusiveWriteStream(backupedFilePath)
      // LOCK-6013: Wrap in try/finally to guarantee write stream settlement
      // on both success and error before proceeding to restore or cleanup.
      try {
        await new Promise<void>((resolve, reject) => {
          writeStream.on('finish', () => resolve())
          writeStream.on('error', (error) => reject(error))
          writeStream.write(retrievedFile as Buffer)
          writeStream.end()
        })
      } finally {
        // LOCK-6013: Ensure write stream is fully settled (FD released)
        // before proceeding to restore or cleanup.
        await BackupManager.awaitStreamFinished(writeStream).catch(() => {})
      }

      // LOCK-6014: preExitCleanup failure propagates and prevents relaunch.
      // The .catch(() => {}) was removed so cleanup rejection is not swallowed.
      return await this.restore(_, backupedFilePath, {
        preExitCleanup: () => fs.remove(downloadDir)
      })
    } catch (error: any) {
      logger.error('Failed to restore from WebDAV:', error)
      throw new Error(error.message || 'Failed to restore backup file')
    } finally {
      // LOCK-6012: Guaranteed cleanup of the exclusive download directory.
      // If restore succeeded, the app relaunches and the dir is gone.
      // If restore failed, the dir is cleaned here.
      await fs.remove(downloadDir).catch(() => {})
    }
  }

  /**
   * Restore from an S3 backup
   * Downloads the backup file from S3 storage and restores it.
   * @param _ - Electron IPC event
   * @param s3Config - S3 configuration including bucket, credentials, and file name
   * @returns Result from restore operation
   */
  async restoreFromS3(_: Electron.IpcMainInvokeEvent, s3Config: S3Config) {
    const rawFilename = s3Config.fileName || 'cherry-studio.backup.zip'

    logger.debug(`Starting restore from S3: ${rawFilename}`)

    const s3Client = this.getS3Storage(s3Config)
    // LOCK-6013: Ensure the cherry-studio temp base exists before mkdtemp.
    const basePath = await BackupManager.ensureTempBase()
    // LOCK-6012: Create an exclusive operation-owned temp directory for the
    // downloaded file. mkdtemp guarantees atomic unique creation; the
    // downloaded content never touches a shared or pre-existing path.
    const downloadDir = await fs.mkdtemp(path.join(basePath, 'download-'))
    try {
      const retrievedFile = await s3Client.getFileContents(rawFilename)

      // LOCK-6012: Provider-controlled filenames must never be used directly
      // in path.join() for local file writes. Sanitize to a safe basename
      // and write inside the exclusive operation-owned temp directory.
      const safeFilename = sanitizeProviderFilename(rawFilename, downloadDir)
      const backupedFilePath = path.join(downloadDir, safeFilename)

      // LOCK-6012: Atomically claim the file with O_CREAT|O_EXCL.
      // LOCK-6013: Use stream.finished to await writable completion before
      // calling restore. This guarantees the downloaded content is fully
      // flushed and the file descriptor is closed before restore reads the file.
      const writeStream = BackupManager.createExclusiveWriteStream(backupedFilePath)
      // LOCK-6013: Wrap in try/finally to guarantee write stream settlement
      // on both success and error before proceeding to restore or cleanup.
      try {
        await new Promise<void>((resolve, reject) => {
          writeStream.on('finish', () => resolve())
          writeStream.on('error', (error) => reject(error))
          writeStream.write(retrievedFile)
          writeStream.end()
        })
      } finally {
        // LOCK-6013: Ensure write stream is fully settled (FD released)
        // before proceeding to restore or cleanup.
        await BackupManager.awaitStreamFinished(writeStream).catch(() => {})
      }

      logger.info(`S3 restore file downloaded successfully: ${safeFilename}`)
      // LOCK-6014: preExitCleanup failure propagates and prevents relaunch.
      // The .catch(() => {}) was removed so cleanup rejection is not swallowed.
      return await this.restore(_, backupedFilePath, {
        preExitCleanup: () => fs.remove(downloadDir)
      })
    } catch (error: any) {
      logger.error('[BackupManager] Failed to restore from S3:', error)
      throw new Error(error.message || 'Failed to restore backup file')
    } finally {
      // LOCK-6012: Guaranteed cleanup of the exclusive download directory.
      await fs.remove(downloadDir).catch(() => {})
    }
  }

  // ==================== File Utility Methods ====================
  // These are helper methods for file operations like size calculation,
  // directory copying with progress, and permission management.

  /**
   * Create a progress callback that sends IPC message and optionally logs.
   * copying_files stage is never logged as it generates too many logs.
   */
  private onProgress = (channel: IpcChannel, shouldLog: boolean) => {
    return (processData: ProgressData) => {
      const mainWindow = windowService.getMainWindow()
      mainWindow?.webContents.send(channel, processData)
      // Never log copying_files as it generates too many log entries
      if (shouldLog && processData.stage !== 'copying_files') {
        logger.info('Backup progress', processData)
      }
    }
  }

  private createCopyProgressHandler(
    totalSize: number,
    startProgress: number,
    endProgress: number,
    stage: string,
    onProgress: (processData: ProgressData) => void
  ) {
    let copiedSize = 0
    let lastReported = startProgress

    return (size: number) => {
      copiedSize += size
      const progress =
        totalSize > 0
          ? Math.min(endProgress, startProgress + Math.floor((copiedSize / totalSize) * (endProgress - startProgress)))
          : endProgress
      if (progress === lastReported && copiedSize < totalSize) {
        return
      }
      lastReported = progress
      onProgress({ stage, progress, total: 100 })
    }
  }

  /**
   * Calculate total size of a directory recursively
   * @param dirPath - Directory path to calculate size
   * @returns Total size in bytes
   */
  private async getDirSize(
    dirPath: string,
    options: CopyDirOptions,
    activeDirectoryRealPaths = new Set<string>()
  ): Promise<number> {
    const copyOptions = {
      ...options,
      sourceRootRealPath: options.sourceRootRealPath ?? (await fs.realpath(dirPath))
    }
    const directoryRealPath = await this.enterDirectory(dirPath, activeDirectoryRealPaths)

    if (!directoryRealPath) {
      return 0
    }

    let size = 0

    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true })

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name)
        const entry = await this.getEffectiveEntryStats(fullPath, copyOptions)

        if (!entry) {
          continue
        }

        if (entry.stats.isDirectory()) {
          if (entry.isSymlink) {
            try {
              size += await this.getDirSize(fullPath, copyOptions, activeDirectoryRealPaths)
            } catch (error) {
              this.logSkippedSymlink(fullPath, error)
            }
          } else {
            size += await this.getDirSize(fullPath, copyOptions, activeDirectoryRealPaths)
          }
        } else if (entry.stats.isFile()) {
          size += entry.stats.size
        }
      }
    } finally {
      activeDirectoryRealPaths.delete(directoryRealPath)
    }

    return size
  }

  /**
   * Stage an empty Data directory; handleStartupRestore swaps it in on next launch.
   * Avoids races with libsql / MemoryService / KnowledgeService recreating files
   * before relaunch.
   */
  public async resetData() {
    const dataRestorePath = getDataPath() + '.restore'
    await fs.remove(dataRestorePath).catch(() => {})
    await fs.ensureDir(dataRestorePath)
  }

  // ---------------------------------------------------------------------------
  // LOCK-6013/6019: Orphan temp directory cleanup
  //
  // On startup, clean up stale temp directories left behind by crashed
  // restores or backup uploads. These directories are created with
  // predictable prefix patterns under the system temp directory:
  //   - extraction-* (restore extraction workspaces)
  //   - download-*  (provider restore downloaded files)
  //   - upload-*    (remote backup intermediate archives)
  //
  // Only directories older than a threshold (default: 1 hour) are cleaned
  // to avoid deleting active operations.
  // ---------------------------------------------------------------------------

  /**
   * Clean up orphaned temp directories from crashed restores and backup uploads.
   *
   * LOCK-6013: Abandoned extraction/download roots must not influence later
   * restore classification.
   * LOCK-6019: Abandoned upload roots must not leave intermediate archives.
   *
   * Scans all known operation-owned prefixes:
   *   - cherry-studio/restore/extraction-*
   *   - cherry-studio/download-*
   *   - cherry-studio/upload-*
   *
   * Called once at app startup, after handleStartupRestore, before
   * chatDbService.init().
   *
   * @param maxAgeMs  Maximum age in milliseconds (default: 1 hour)
   */
  static async cleanupOrphanedExtractions(maxAgeMs: number = 60 * 60 * 1000): Promise<void> {
    const basePath = await BackupManager.ensureTempBase()
    const now = Date.now()

    try {
      const baseExists = await fs.pathExists(basePath)
      if (!baseExists) return

      // Collect all directories to scan: restore/extraction-*, download-*, upload-*
      const scanTargets: Array<{ dir: string; prefixes: readonly string[] }> = [
        { dir: path.join(basePath, 'restore'), prefixes: ['extraction-'] },
        { dir: basePath, prefixes: ['download-', 'upload-'] }
      ]

      for (const { dir: scanDir, prefixes } of scanTargets) {
        const exists = await fs.pathExists(scanDir)
        if (!exists) continue

        const entries = await fs.readdir(scanDir, { withFileTypes: true })

        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const matchesPrefix = prefixes.some((p) => entry.name.startsWith(p))
          if (!matchesPrefix) continue

          const dirPath = path.join(scanDir, entry.name)
          try {
            const stat = await fs.stat(dirPath)
            const age = now - stat.mtimeMs
            if (age > maxAgeMs) {
              logger.info(
                `[cleanupOrphanedExtractions] Removing stale temp directory: ` +
                  `${path.relative(basePath, dirPath)} (age: ${Math.round(age / 1000)}s)`
              )
              await fs.remove(dirPath).catch((removeError) => {
                logger.warn(`[cleanupOrphanedExtractions] Failed to remove ${entry.name}`, { error: removeError })
              })
            }
          } catch {
            // stat failure — skip this entry
          }
        }
      }
    } catch (error) {
      logger.warn('[cleanupOrphanedExtractions] Orphan cleanup failed (non-fatal)', { error })
    }
  }

  /**
   * Deep compare two WebDAV config objects for equality
   * Only compares core fields that affect client connection, ignores volatile fields like fileName
   * @param cachedConfig - The cached WebDAV configuration
   * @param config - The new WebDAV configuration to compare
   * @returns True if the configs are equal (connection-related fields only)
   */
  private isWebDavConfigEqual(cachedConfig: typeof this.cachedWebdavConnectionConfig, config: WebDavConfig): boolean {
    if (!cachedConfig) return false

    return (
      cachedConfig.webdavHost === config.webdavHost &&
      cachedConfig.webdavUser === config.webdavUser &&
      cachedConfig.webdavPass === config.webdavPass &&
      cachedConfig.webdavPath === config.webdavPath
    )
  }

  /**
   * Get WebDav instance, reuses existing instance if connection config hasn't changed
   * Note: Only connection-related config changes will recreate the instance
   * Other config changes don't affect instance reuse
   * @param config - WebDAV configuration
   * @returns WebDav instance
   */
  private getWebDavInstance(config: WebDavConfig): WebDav {
    // Check if core connection config has changed
    const configChanged = !this.isWebDavConfigEqual(this.cachedWebdavConnectionConfig, config)

    if (configChanged || !this.webdavInstance) {
      this.webdavInstance = new WebDav(config)
      // Only cache connection-related config fields
      this.cachedWebdavConnectionConfig = {
        webdavHost: config.webdavHost,
        webdavUser: config.webdavUser,
        webdavPass: config.webdavPass,
        webdavPath: config.webdavPath
      }
      logger.debug('[BackupManager] Created new WebDav instance')
    } else {
      logger.debug('[BackupManager] Reusing existing WebDav instance')
    }

    return this.webdavInstance
  }

  // ==================== WebDAV Methods ====================
  // These methods handle backup operations with WebDAV servers.

  /**
   * List backup files on WebDAV server
   * @param _ - Electron IPC event
   * @param config - WebDAV configuration
   * @returns Array of backup file info (name, modified time, size), sorted by newest first
   */
  listWebdavFiles = async (_: Electron.IpcMainInvokeEvent, config: WebDavConfig) => {
    try {
      const client = this.getWebDavInstance(config)
      const files = await client.getDirectoryContents()

      return files
        .filter((file: FileStat) => file.type === 'file' && file.basename.endsWith('.zip'))
        .map((file: FileStat) => ({
          fileName: file.basename,
          modifiedTime: file.lastmod,
          size: file.size
        }))
        .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
    } catch (error: any) {
      logger.error('Failed to list WebDAV files:', error)
      throw new Error(error.message || 'Failed to list backup files')
    }
  }

  /**
   * Copy directory with progress reporting
   * Recursively copies files from source to destination while reporting progress
   * @param source - Source directory path
   * @param destination - Destination directory path
   * @param onProgress - Callback function called with size of each copied file
   */
  private async copyDirWithProgress(
    source: string,
    destination: string,
    onProgress: (size: number) => void,
    options: CopyDirOptions
  ): Promise<void> {
    const copyOptions = {
      ...options,
      sourceRootRealPath: options.sourceRootRealPath ?? (await fs.realpath(source))
    }
    const activeDirectoryRealPaths = new Set<string>()

    const copyDir = async (src: string, dest: string): Promise<void> => {
      const directoryRealPath = await this.enterDirectory(src, activeDirectoryRealPaths)

      if (!directoryRealPath) {
        return
      }

      try {
        await fs.ensureDir(dest)

        const items = await fs.readdir(src, { withFileTypes: true })

        for (const item of items) {
          const sourcePath = path.join(src, item.name)
          const destPath = path.join(dest, item.name)
          const entry = await this.getEffectiveEntryStats(sourcePath, copyOptions)

          if (!entry) {
            continue
          }

          if (entry.stats.isDirectory()) {
            try {
              await copyDir(sourcePath, destPath)
            } catch (error) {
              if (!entry.isSymlink) {
                throw error
              }
              await fs.remove(destPath).catch(() => {})
              this.logSkippedSymlink(sourcePath, error)
            }
          } else if (entry.stats.isFile()) {
            if (entry.isSymlink) {
              await fs.copy(sourcePath, destPath, { dereference: true })
            } else {
              await fs.copy(sourcePath, destPath)
            }
            onProgress(entry.stats.size)
          } else if (entry.isSymlink) {
            logger.warn('[BackupManager] Skipping symlink to unsupported target', { path: sourcePath })
          }
        }
      } finally {
        activeDirectoryRealPaths.delete(directoryRealPath)
      }
    }

    await copyDir(source, destination)
  }

  /**
   * Copy directory with progress reporting, EXCLUDING specific filenames.
   * Used to copy Data/ while omitting live chat.db, WAL, SHM, transient
   * backup artifacts, and L2 promotion internals (candidate root, journal,
   * rollback snapshots/staging, Files promote-staging, catalog snapshots —
   * see EXCLUDED_DATA_ENTRIES). The chat.db snapshot is staged separately.
   *
   * @param source - Source directory path
   * @param destination - Destination directory path
   * @param excludedNames - Set of filenames to skip (e.g., chat.db, chat.db-wal)
   * @param onProgress - Callback function called with size of each copied file
   */
  private async copyDirWithProgressFiltered(
    source: string,
    destination: string,
    excludedNames: Set<string>,
    onProgress: (size: number) => void,
    options: CopyDirOptions
  ): Promise<void> {
    const copyOptions = {
      ...options,
      sourceRootRealPath: options.sourceRootRealPath ?? (await fs.realpath(source))
    }
    const activeDirectoryRealPaths = new Set<string>()

    const copyDir = async (src: string, dest: string): Promise<void> => {
      const directoryRealPath = await this.enterDirectory(src, activeDirectoryRealPaths)

      if (!directoryRealPath) {
        return
      }

      try {
        await fs.ensureDir(dest)

        const items = await fs.readdir(src, { withFileTypes: true })

        for (const item of items) {
          // Skip excluded entries (chat.db, WAL, SHM, transients)
          if (excludedNames.has(item.name)) {
            continue
          }

          const sourcePath = path.join(src, item.name)
          const destPath = path.join(dest, item.name)
          const entry = await this.getEffectiveEntryStats(sourcePath, copyOptions)

          if (!entry) {
            continue
          }

          if (entry.stats.isDirectory()) {
            try {
              await copyDir(sourcePath, destPath)
            } catch (error) {
              if (!entry.isSymlink) {
                throw error
              }
              await fs.remove(destPath).catch(() => {})
              this.logSkippedSymlink(sourcePath, error)
            }
          } else if (entry.stats.isFile()) {
            if (entry.isSymlink) {
              await fs.copy(sourcePath, destPath, { dereference: true })
            } else {
              await fs.copy(sourcePath, destPath)
            }
            onProgress(entry.stats.size)
          } else if (entry.isSymlink) {
            logger.warn('[BackupManager] Skipping symlink to unsupported target', { path: sourcePath })
          }
        }
      } finally {
        activeDirectoryRealPaths.delete(directoryRealPath)
      }
    }

    await copyDir(source, destination)
  }

  private async enterDirectory(dirPath: string, activeDirectoryRealPaths: Set<string>): Promise<string | null> {
    const realPath = await fs.realpath(dirPath)

    if (activeDirectoryRealPaths.has(realPath)) {
      logger.warn('[BackupManager] Skipping circular symlink directory', { path: dirPath, realPath })
      return null
    }

    activeDirectoryRealPaths.add(realPath)
    return realPath
  }

  private async getEffectiveEntryStats(
    sourcePath: string,
    options: CopyDirOptions
  ): Promise<EffectiveEntryStats | null> {
    const stats = await fs.lstat(sourcePath)

    if (!stats.isSymbolicLink()) {
      return { isSymlink: false, stats }
    }

    const targetStats = await this.getSymlinkTargetStats(sourcePath, options)
    return targetStats ? { isSymlink: true, stats: targetStats } : null
  }

  private async getSymlinkTargetStats(sourcePath: string, options: CopyDirOptions): Promise<Stats | null> {
    if (!options.dereferenceSymlinks) {
      logger.warn('[BackupManager] Skipping symlink (dereferenceSymlinks=false)', { path: sourcePath })
      return null
    }

    try {
      const [targetStats, targetRealPath] = await Promise.all([fs.stat(sourcePath), fs.realpath(sourcePath)])
      const context = {
        path: sourcePath,
        sourceRootRealPath: options.sourceRootRealPath,
        targetRealPath
      }

      if (options.sourceRootRealPath && !isPathInside(targetRealPath, options.sourceRootRealPath)) {
        logger.warn('[BackupManager] Dereferencing symlink outside source root during backup copy', context)
      } else {
        logger.info('[BackupManager] Dereferencing symlink during backup copy', context)
      }
      return targetStats
    } catch (error) {
      this.logSkippedSymlink(sourcePath, error)
      return null
    }
  }

  private logSkippedSymlink(sourcePath: string, error: unknown) {
    logger.warn('[BackupManager] Skipping broken or unreadable symlink', { path: sourcePath, error })
  }

  /**
   * Check WebDAV connection
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration to test
   * @returns True if connection is successful
   */
  async checkConnection(_: Electron.IpcMainInvokeEvent, webdavConfig: WebDavConfig) {
    const webdavClient = this.getWebDavInstance(webdavConfig)
    return await webdavClient.checkConnection()
  }

  /**
   * Create a directory on WebDAV server
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration
   * @param path - Directory path to create
   * @param options - Optional directory creation options
   * @returns Result from WebDAV operation
   */
  async createDirectory(
    _: Electron.IpcMainInvokeEvent,
    webdavConfig: WebDavConfig,
    path: string,
    options?: CreateDirectoryOptions
  ) {
    const webdavClient = this.getWebDavInstance(webdavConfig)
    return await webdavClient.createDirectory(path, options)
  }

  /**
   * Delete a backup file from WebDAV server
   * @param _ - Electron IPC event
   * @param fileName - Name of the file to delete
   * @param webdavConfig - WebDAV configuration
   * @returns Result from WebDAV operation
   */
  async deleteWebdavFile(_: Electron.IpcMainInvokeEvent, fileName: string, webdavConfig: WebDavConfig) {
    try {
      const webdavClient = this.getWebDavInstance(webdavConfig)
      return await webdavClient.deleteFile(fileName)
    } catch (error: any) {
      logger.error('Failed to delete WebDAV file:', error)
      throw new Error(error.message || 'Failed to delete backup file')
    }
  }

  // ==================== Local Backup Methods ====================
  // These methods handle backup operations with local directories.

  /**
   * List backup files in a local directory
   * LOCK-6012: Validates localBackupDir for symlink-free path integrity.
   * @param _ - Electron IPC event
   * @param localBackupDir - Directory to list backup files from
   * @returns Array of backup file info (name, modified time, size), sorted by newest first
   */
  async listLocalBackupFiles(_: Electron.IpcMainInvokeEvent, localBackupDir: string) {
    try {
      // LOCK-6012: Validate directory components for symlink-free integrity
      const validatedDir = await validateLocalBackupDir(localBackupDir)
      const files = await fs.readdir(validatedDir)
      const result: Array<{ fileName: string; modifiedTime: string; size: number }> = []

      for (const file of files) {
        const filePath = path.join(validatedDir, file)
        const stat = await fs.stat(filePath)

        if (stat.isFile() && file.endsWith('.zip')) {
          result.push({
            fileName: file,
            modifiedTime: stat.mtime.toISOString(),
            size: stat.size
          })
        }
      }

      // Sort by modified time, newest first
      return result.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
    } catch (error) {
      logger.error('[BackupManager] List local backup files failed:', error as Error)
      throw error
    }
  }

  /**
   * Delete a local backup file
   * @param _ - Electron IPC event
   * @param fileName - Name of the file to delete
   * @param localBackupDir - Directory where the backup file is located
   * @returns True if deletion was successful
   */
  async deleteLocalBackupFile(_: Electron.IpcMainInvokeEvent, fileName: string, localBackupDir: string) {
    try {
      // LOCK-6012: Validate directory components for symlink-free integrity
      const validatedDir = await validateLocalBackupDir(localBackupDir)
      const filePath = resolveAndValidatePath(validatedDir, fileName)

      if (!fs.existsSync(filePath)) {
        throw new Error(`Backup file not found: ${filePath}`)
      }

      await fs.remove(filePath)
      return true
    } catch (error) {
      logger.error('[BackupManager] Delete local backup file failed:', error as Error)
      throw error
    }
  }

  // ==================== Legacy & Temp Methods ====================
  // These methods are for legacy backup format and temporary file operations.

  // ==================== S3 Methods ====================
  // These methods handle backup operations with S3-compatible storage.

  /**
   * Get S3Storage instance, reuses existing instance if connection config hasn't changed
   * Note: Only connection-related config changes will recreate the instance
   * Other config changes don't affect instance reuse
   * @param config - S3 configuration
   * @returns S3Storage instance
   */
  private getS3Storage(config: S3Config): S3Storage {
    // Check if core connection config has changed
    const configChanged = !this.isS3ConfigEqual(this.cachedS3ConnectionConfig, config)

    if (configChanged || !this.s3Storage) {
      this.s3Storage = new S3Storage(config)
      // Only cache connection-related config fields
      this.cachedS3ConnectionConfig = {
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        root: config.root
      }
      logger.debug('[BackupManager] Created new S3Storage instance')
    } else {
      logger.debug('[BackupManager] Reusing existing S3Storage instance')
    }

    return this.s3Storage
  }

  /**
   * Compare two S3 config objects for equality
   * Only compares core fields that affect client connection, ignores volatile fields like fileName
   * @param cachedConfig - The cached S3 configuration
   * @param config - The new S3 configuration to compare
   * @returns True if the configs are equal (connection-related fields only)
   */
  private isS3ConfigEqual(cachedConfig: typeof this.cachedS3ConnectionConfig, config: S3Config): boolean {
    if (!cachedConfig) return false

    return (
      cachedConfig.endpoint === config.endpoint &&
      cachedConfig.region === config.region &&
      cachedConfig.bucket === config.bucket &&
      cachedConfig.accessKeyId === config.accessKeyId &&
      cachedConfig.secretAccessKey === config.secretAccessKey &&
      cachedConfig.root === config.root
    )
  }

  /**
   * Check S3 connection
   * @param _ - Electron IPC event
   * @param s3Config - S3 configuration to test
   * @returns True if connection is successful
   */
  async checkS3Connection(_: Electron.IpcMainInvokeEvent, s3Config: S3Config) {
    const s3Client = this.getS3Storage(s3Config)
    return await s3Client.checkConnection()
  }

  /**
   * List backup files in S3 storage
   * @param _ - Electron IPC event
   * @param s3Config - S3 configuration
   * @returns Array of backup file info (name, modified time, size), sorted by newest first
   */
  listS3Files = async (_: Electron.IpcMainInvokeEvent, s3Config: S3Config) => {
    try {
      const s3Client = this.getS3Storage(s3Config)

      const objects = await s3Client.listFiles()
      const files = objects
        .filter((obj) => obj.key.endsWith('.zip'))
        .map((obj) => {
          const segments = obj.key.split('/')
          const fileName = segments[segments.length - 1]
          return {
            fileName,
            modifiedTime: obj.lastModified || '',
            size: obj.size
          }
        })

      return files.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
    } catch (error: any) {
      logger.error('Failed to list S3 files:', error)
      throw new Error(error.message || 'Failed to list backup files')
    }
  }

  /**
   * Delete a backup file from S3 storage
   * @param _ - Electron IPC event
   * @param fileName - Name of the file to delete
   * @param s3Config - S3 configuration
   * @returns Result from S3 operation
   */
  async deleteS3File(_: Electron.IpcMainInvokeEvent, fileName: string, s3Config: S3Config) {
    try {
      const s3Client = this.getS3Storage(s3Config)
      return await s3Client.deleteFile(fileName)
    } catch (error: any) {
      logger.error('Failed to delete S3 file:', error)
      throw new Error(error.message || 'Failed to delete backup file')
    }
  }
}

export {
  BackupManager,
  captureLocalBackupDestination,
  captureWorkspaceIdentity,
  publishLocalBackupArchive,
  revalidateLocalBackupDestination,
  revalidateParentDir,
  safeCleanupWorkspace,
  validateLocalBackupDir
}
export type { LocalBackupDestinationIdentity, WorkspaceIdentity }

export default BackupManager
