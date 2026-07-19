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
import type { Stats } from 'node:fs'

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
import S3Storage from './S3Storage'
import WebDav from './WebDav'
import { windowService } from './WindowService'

const logger = loggerService.withContext('BackupManager')

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
  private tempDir = path.join(app.getPath('temp'), 'cherry-studio', 'backup', 'temp')
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

      // Restore Data — Finding 1: staged marker creation
      if (hasDataRestore) {
        logger.info('[handleStartupRestore] Found Data.restore directory, completing restoration...')

        // --- Inspect Data.restore/chat.db BEFORE touching live Data ---
        const restoredChatDbPath = path.join(dataRestore, DB_FILENAME)
        const hasChatDb = await fs.pathExists(restoredChatDbPath)

        if (hasChatDb) {
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
                'Aborting restore — live Data is not modified.'
            )
          }
          logger.info('[handleStartupRestore] Restore marker created inside Data.restore')
        } else {
          logger.info('[handleStartupRestore] No chat.db in Data.restore — skipping restore marker')
        }

        // --- Replace live Data with staged Data (marker already inside if needed) ---
        await fs.remove(dataDest).catch(() => {})
        await fs.rename(dataRestore, dataDest)
      }

      logger.info('[handleStartupRestore] Restoration completed successfully')
    } catch (error) {
      logger.error('[handleStartupRestore] Failed to complete restoration:', error as Error)
      // Do NOT delete staged restore directories on failure.
      // dataRestore is retained for retry/diagnosis on next startup.
      // indexedDBRestore/localStorageRestore may hold the only remaining
      // copy of the user's data if their rename did not complete.
      // Only narrow transient artifacts (none exist in this flow) would
      // be safe to remove.
      throw error
    }
  }

  /**
   * Backup metadata for direct backup format (version 6+)
   */
  private createDirectBackupMetadata(): {
    version: number
    timestamp: number
    appName: string
    appVersion: string
    platform: string
    arch: string
  } {
    return {
      version: 6,
      timestamp: Date.now(),
      appName: 'Cherry Studio',
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    }
  }

  // Transient files that must NEVER appear in backup archives.
  // chat.db is replaced by a validated snapshot; WAL/SHM are live-replication
  // artifacts that are meaningless outside a running DB; .backup is a
  // transient snapshot staging file.
  private static readonly EXCLUDED_DATA_ENTRIES = new Set(['chat.db', 'chat.db-wal', 'chat.db-shm', 'chat.db.backup'])

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
      // Unique staging directory per backup operation — eliminates races
      const stagingDir = path.join(
        app.getPath('temp'),
        'cherry-studio',
        'backup',
        `staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      )

      const onProgress = this.onProgress(IpcChannel.BackupProgress, true)

      try {
        await fs.ensureDir(stagingDir)
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
        if (!skipBackupFile) {
          const sourcePath = path.join(userDataPath, 'Data')
          const stagedDataDir = path.join(stagingDir, 'Data')

          if (await fs.pathExists(sourcePath)) {
            const liveDbPath = path.join(sourcePath, 'chat.db')
            const liveDbExists = await fs.pathExists(liveDbPath)

            // 3a: If live chat.db exists, create a validated snapshot and stage it
            if (liveDbExists) {
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
            }

            // 3b: Copy Data directory, EXCLUDING chat.db/WAL/SHM/transient artifacts
            logger.debug('[backupDirect] Copying Data directory (excluding live DB files)...')
            const totalSize = await this.getDirSize(sourcePath, { dereferenceSymlinks: true })

            await this.copyDirWithProgressFiltered(
              sourcePath,
              stagedDataDir,
              BackupManager.EXCLUDED_DATA_ENTRIES,
              this.createCopyProgressHandler(totalSize, 52, 80, 'copying_files', onProgress),
              { dereferenceSymlinks: true }
            )
          }
        } else {
          logger.debug('[backupDirect] Skip the backup of the file')
          await fs.promises.mkdir(path.join(stagingDir, 'Data'))
        }

        onProgress({ stage: 'compressing', progress: 80, total: 100 })

        // Step 4: Create ZIP archive from staging directory
        const backupedFilePath = path.join(destinationPath, fileName)
        const output = fs.createWriteStream(backupedFilePath)
        const archive = archiver('zip', {
          zlib: { level: 1 },
          zip64: true
        })

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
          output.on('error', (err) => settle(() => reject(err)))
          archive.on('error', (err) => settle(() => reject(err)))
          archive.on('warning', (err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') {
              logger.warn('[backupDirect] Archive warning:', err)
            }
          })
          archive.pipe(output)
          archive.directory(stagingDir, false)
          archive.finalize()
        })

        onProgress({ stage: 'completed', progress: 100, total: 100 })

        logger.info('[backupDirect] Backup completed successfully')
        return backupedFilePath
      } catch (error) {
        logger.error('[backupDirect] Backup failed:', error as Error)
        // Clean up partial archive on failure
        const archivePath = path.join(destinationPath, fileName)
        await fs.remove(archivePath).catch(() => {})
        throw error
      } finally {
        // Guarantee cleanup of the unique staging directory
        await fs.remove(stagingDir).catch(() => {})
      }
    })
  }

  /**
   * Process-wide async mutex for backup operations.
   * Ensures only one backup runs at a time across all entry points.
   */
  private static async withBackupMutex<T>(fn: () => Promise<T>): Promise<T> {
    const result = BackupManager.backupMutex.then(
      () => fn(),
      () => fn()
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
      const backupDir = localConfig.localBackupDir || this.backupDir
      await fs.ensureDir(backupDir)
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
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration including server URL, credentials, and options
   * @returns Result from WebDAV upload operation
   */
  async backupToWebdav(_: Electron.IpcMainInvokeEvent, webdavConfig: WebDavConfig) {
    // Finding 5: Serialize entire create+upload+delete through the mutex
    return BackupManager.withBackupMutex(async () => {
      // Finding 5: Unique archive file name per operation
      const uniqueFilename = this.uniqueArchiveName(webdavConfig.fileName || 'cherry-studio.backup.zip')
      const backupedFilePath = path.join(this.backupDir, uniqueFilename)

      try {
        // Create the archive (inside staging dir, using our own staging logic)
        await this.backupInternal(_, uniqueFilename, this.backupDir, webdavConfig.skipBackupFile)

        const webdavClient = this.getWebDavInstance(webdavConfig)
        let result
        if (webdavConfig.disableStream) {
          const fileContent = await fs.readFile(backupedFilePath)
          result = await webdavClient.putFileContents(uniqueFilename, fileContent, { overwrite: true })
        } else {
          const contentLength = (await fs.stat(backupedFilePath)).size
          result = await webdavClient.putFileContents(uniqueFilename, fs.createReadStream(backupedFilePath), {
            overwrite: true,
            contentLength
          })
        }
        return result
      } catch (error) {
        logger.error('[backupToWebdav] WebDAV backup failed:', error as Error)
        throw error
      } finally {
        // Finding 5: Always clean up the local archive file
        await fs.remove(backupedFilePath).catch(() => {})
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
      const backupedFilePath = path.join(this.backupDir, uniqueFilename)

      logger.debug(`[backupToS3] Starting S3 backup to ${uniqueFilename}`)

      try {
        // Create the archive (inside staging dir, using our own staging logic)
        await this.backupInternal(_, uniqueFilename, this.backupDir, s3Config.skipBackupFile)

        const s3Client = this.getS3Storage(s3Config)
        const fileBuffer = await fs.promises.readFile(backupedFilePath)
        const result = await s3Client.putFileContents(uniqueFilename, fileBuffer)
        logger.info(`S3 backup completed: ${uniqueFilename}`)
        return result
      } catch (error) {
        logger.error('[backupToS3] S3 backup failed:', error as Error)
        throw error
      } finally {
        // Finding 5: Always clean up the local archive file
        await fs.remove(backupedFilePath).catch(() => {})
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
    // Unique staging directory per backup operation
    const stagingDir = path.join(
      app.getPath('temp'),
      'cherry-studio',
      'backup',
      `staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    )

    const onProgress = this.onProgress(IpcChannel.BackupProgress, true)

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
      if (!skipBackupFile) {
        const sourcePath = path.join(userDataPath, 'Data')
        const stagedDataDir = path.join(stagingDir, 'Data')

        if (await fs.pathExists(sourcePath)) {
          const liveDbPath = path.join(sourcePath, 'chat.db')
          const liveDbExists = await fs.pathExists(liveDbPath)

          if (liveDbExists) {
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
          }

          logger.debug('[backupInternal] Copying Data directory (excluding live DB files)...')
          const totalSize = await this.getDirSize(sourcePath, { dereferenceSymlinks: true })

          await this.copyDirWithProgressFiltered(
            sourcePath,
            stagedDataDir,
            BackupManager.EXCLUDED_DATA_ENTRIES,
            this.createCopyProgressHandler(totalSize, 52, 80, 'copying_files', onProgress),
            { dereferenceSymlinks: true }
          )
        }
      } else {
        await fs.promises.mkdir(path.join(stagingDir, 'Data'))
      }

      onProgress({ stage: 'compressing', progress: 80, total: 100 })

      // Step 4: Create ZIP archive from staging directory
      const archivePath = path.join(destinationPath, fileName)
      const output = fs.createWriteStream(archivePath)
      const archive = archiver('zip', {
        zlib: { level: 1 },
        zip64: true
      })

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
        output.on('error', (err) => settle(() => reject(err)))
        archive.on('error', (err) => settle(() => reject(err)))
        archive.on('warning', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') {
            logger.warn('[backupInternal] Archive warning:', err)
          }
        })
        archive.pipe(output)
        archive.directory(stagingDir, false)
        archive.finalize()
      })

      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('[backupInternal] Backup completed successfully')
      return archivePath
    } catch (error) {
      logger.error('[backupInternal] Backup failed:', error as Error)
      // Clean up partial archive on failure
      const archivePath = path.join(destinationPath, fileName)
      await fs.remove(archivePath).catch(() => {})
      throw error
    } finally {
      // Guarantee cleanup of the unique staging directory
      await fs.remove(stagingDir).catch(() => {})
    }
  }

  /**
   * Restore from a backup file
   * Automatically detects backup format (direct v6+ or legacy) and restores accordingly.
   * For direct backup: replaces IndexedDB and Local Storage directories, then relaunches app.
   * For legacy backup: restores data from data.json and Data directory.
   * @param _ - Electron IPC event
   * @param backupPath - Path to the backup ZIP file
   * @returns For legacy backup: the data string from data.json. For direct backup: void (app will relaunch)
   */
  async restore(_: Electron.IpcMainInvokeEvent, backupPath: string): Promise<string | void> {
    const onProgress = this.onProgress(IpcChannel.RestoreProgress, true)

    try {
      // Create temp directory
      await fs.ensureDir(this.tempDir)
      onProgress({ stage: 'preparing', progress: 0, total: 100 })

      logger.debug(`step 1: unzip backup file: ${this.tempDir}`)

      const zip = new StreamZip.async({ file: backupPath })
      onProgress({ stage: 'extracting', progress: 15, total: 100 })
      await zip.extract(null, this.tempDir)
      onProgress({ stage: 'extracted', progress: 20, total: 100 })

      // Check for backup type: direct (version 6+) or legacy (version <= 5)
      const metadataPath = path.join(this.tempDir, 'metadata.json')
      const isDirectBackup = await fs.pathExists(metadataPath)

      if (isDirectBackup) {
        // Direct backup format (version 6+)
        logger.debug('Detected direct backup format (version 6+)')
        // Note: tempDir is NOT cleaned up here - restoreDirect will use and clean it
        await this.restoreDirect()
        // Direct restore doesn't return data - app needs to relaunch
        return
      }

      // Legacy backup format (version <= 5)
      logger.debug('Detected legacy backup format (version <= 5)')

      const data = await this.restoreLegacy()

      return data
    } catch (error) {
      logger.error('Restore failed:', error as Error)
      await fs.remove(this.tempDir).catch(() => {})
      throw error
    }
  }

  /**
   * Restore from direct backup format (version 6+).
   * Writes to `*.restore` directories; `handleStartupRestore` performs the atomic
   * swap on next launch, before any DB connection or window opens. Avoids
   * overwriting live IndexedDB / libsql files (issue #14774).
   */
  private async restoreDirect(): Promise<void> {
    const onProgress = this.onProgress(IpcChannel.RestoreProgress, true)

    const userDataPath = app.getPath('userData')
    const indexedDBDest = path.join(userDataPath, 'IndexedDB.restore')
    const localStorageDest = path.join(userDataPath, 'Local Storage.restore')
    const dataDest = path.join(userDataPath, 'Data.restore')

    try {
      // Read and validate metadata
      const metadataPath = path.join(this.tempDir, 'metadata.json')
      const metadata = await fs.readJson(metadataPath)

      // Validate appName to ensure backup is from Cherry Studio
      if (metadata.appName !== 'Cherry Studio') {
        throw new Error('This backup file is not from Cherry Studio and cannot be restored')
      }

      // Warn about cross-platform restore
      if (metadata.platform && metadata.platform !== process.platform) {
        logger.warn(
          `[restoreDirect] Cross-platform restore: backup from ${metadata.platform}, current is ${process.platform}`
        )
      }

      onProgress({ stage: 'validating', progress: 25, total: 100 })

      onProgress({ stage: 'restoring_database', progress: 30, total: 100 })

      // IndexedDB & Local Storage Path
      const indexedDBSource = path.join(this.tempDir, 'IndexedDB')
      const localStorageSource = path.join(this.tempDir, 'Local Storage')

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

      //  Restore Data directory
      const dataSource = path.join(this.tempDir, 'Data')
      const dataExists = await fs.pathExists(dataSource)
      const dataFiles = dataExists ? await fs.readdir(dataSource) : []

      if (dataExists && dataFiles.length > 0) {
        // Validate that the backup contains a chat.db (Finding 5).
        // If the backup archive has Data/ but no chat.db, the restore marker
        // will fail on next launch. Warn early so the user knows.
        const backupChatDbPath = path.join(dataSource, 'chat.db')
        const hasChatDb = await fs.pathExists(backupChatDbPath)
        if (!hasChatDb) {
          logger.warn(
            '[restoreDirect] Backup Data directory does not contain chat.db. ' +
              'Restore marker will not be set on next launch — chat DB will not be available.'
          )
        }

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

      // Clean up
      await fs.remove(this.tempDir)
      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('[restoreDirect] Restore staged successfully, relaunching app to apply...')

      app.relaunch()
      app.exit(0)
    } catch (error) {
      logger.error('[restoreDirect] Restore failed:', error as Error)
      await Promise.all([
        fs.remove(this.tempDir).catch(() => {}),
        fs.remove(indexedDBDest).catch(() => {}),
        fs.remove(localStorageDest).catch(() => {}),
        fs.remove(dataDest).catch(() => {})
      ])
      throw error
    }
  }

  /**
   * Restore from legacy backup format (version <= 5)
   * Restores data from data.json and Data directory.
   * @param onProgress - Callback function to report restore progress
   * @returns The data string read from data.json
   */
  private async restoreLegacy(): Promise<string> {
    const onProgress = this.onProgress(IpcChannel.RestoreProgress, false)

    try {
      logger.debug('[restoreLegacy] read data.json')

      // Read data.json
      const dataPath = path.join(this.tempDir, 'data.json')
      const data = await fs.readFile(dataPath, 'utf-8')
      onProgress({ stage: 'reading_data', progress: 35, total: 100 })

      logger.debug('[restoreLegacy] restore Data directory')

      const userDataPath = app.getPath('userData')
      const dataSourcePath = path.join(this.tempDir, 'Data')
      const dataDestPath = path.join(userDataPath, 'Data.restore')

      const dataExists = await fs.pathExists(dataSourcePath)
      const dataFiles = dataExists ? await fs.readdir(dataSourcePath) : []

      if (dataExists && dataFiles.length > 0) {
        // Get total size of source directory
        const dataTotalSize = await this.getDirSize(dataSourcePath, { dereferenceSymlinks: false })

        await fs.remove(dataDestPath).catch(() => {})

        // Use streaming copy
        await this.copyDirWithProgress(
          dataSourcePath,
          dataDestPath,
          this.createCopyProgressHandler(dataTotalSize, 35, 85, 'copying_files', onProgress),
          { dereferenceSymlinks: false }
        )
      } else {
        logger.debug('[restoreLegacy] skipBackupFile is true, skip restoring Data directory')
      }

      // Clean up temp directory
      logger.debug('[restoreLegacy] clean up temp directory')
      await fs.remove(this.tempDir)

      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('[restoreLegacy] Restore completed successfully')

      return data
    } catch (error) {
      logger.error('[restoreLegacy] Restore failed:', error as Error)
      await fs.remove(this.tempDir).catch(() => {})
      throw error
    }
  }

  /**
   * Restore from a local backup file
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param localBackupDir - Directory where the backup file is located
   * @returns Result from restore operation
   */
  async restoreFromLocalBackup(_: Electron.IpcMainInvokeEvent, fileName: string, localBackupDir: string) {
    try {
      const backupPath = resolveAndValidatePath(localBackupDir, fileName)

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
    const filename = webdavConfig.fileName || 'cherry-studio.backup.zip'
    const webdavClient = this.getWebDavInstance(webdavConfig)
    try {
      const retrievedFile = await webdavClient.getFileContents(filename)
      const backupedFilePath = path.join(this.backupDir, filename)

      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true })
      }

      // Write file using streaming
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(backupedFilePath)
        writeStream.write(retrievedFile as Buffer)
        writeStream.end()

        writeStream.on('finish', () => resolve())
        writeStream.on('error', (error) => reject(error))
      })

      return await this.restore(_, backupedFilePath)
    } catch (error: any) {
      logger.error('Failed to restore from WebDAV:', error)
      throw new Error(error.message || 'Failed to restore backup file')
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
    const filename = s3Config.fileName || 'cherry-studio.backup.zip'

    logger.debug(`Starting restore from S3: ${filename}`)

    const s3Client = this.getS3Storage(s3Config)
    try {
      const retrievedFile = await s3Client.getFileContents(filename)
      const backupedFilePath = path.join(this.backupDir, filename)
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true })
      }
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(backupedFilePath)
        writeStream.write(retrievedFile)
        writeStream.end()
        writeStream.on('finish', () => resolve())
        writeStream.on('error', (error) => reject(error))
      })

      logger.info(`S3 restore file downloaded successfully: ${filename}`)
      return await this.restore(_, backupedFilePath)
    } catch (error: any) {
      logger.error('[BackupManager] Failed to restore from S3:', error)
      throw new Error(error.message || 'Failed to restore backup file')
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
   * Used to copy Data/ while omitting live chat.db, WAL, SHM, and transient
   * backup artifacts — the snapshot is staged separately.
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
   * @param _ - Electron IPC event
   * @param localBackupDir - Directory to list backup files from
   * @returns Array of backup file info (name, modified time, size), sorted by newest first
   */
  async listLocalBackupFiles(_: Electron.IpcMainInvokeEvent, localBackupDir: string) {
    try {
      const files = await fs.readdir(localBackupDir)
      const result: Array<{ fileName: string; modifiedTime: string; size: number }> = []

      for (const file of files) {
        const filePath = path.join(localBackupDir, file)
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
      const filePath = resolveAndValidatePath(localBackupDir, fileName)

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

export { BackupManager }

export default BackupManager
