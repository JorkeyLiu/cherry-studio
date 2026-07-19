import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { loggerService } from '@logger'
import type BetterSqlite3 from 'better-sqlite3'

const logger = loggerService.withContext('ChatDbBackup')

// ---------------------------------------------------------------------------
// ChatDbBackupAdapter — abstraction for SQLite snapshot creation.
//
// Decouples BackupManager from better-sqlite3 internals.
// Future PowerSync integration only requires implementing this interface.
// ---------------------------------------------------------------------------

export interface ChatDbBackupAdapter {
  /**
   * Create a consistent SQLite snapshot at `destPath`.
   * The snapshot MUST be a valid, self-contained SQLite database file.
   * Returns the number of pages copied from the source database.
   * Throws on failure.
   */
  createSnapshot(destPath: string): Promise<number>

  /**
   * Validate that the file at `dbPath` is a valid SQLite database
   * by running PRAGMA integrity_check.
   * Returns 'ok' or an error description string.
   */
  validateSnapshot(dbPath: string): Promise<'ok' | string>
}

// ---------------------------------------------------------------------------
// Default implementation using better-sqlite3 online backup API.
//
// better-sqlite3.backup() returns Promise<BackupMetadata> where
// BackupMetadata = { totalPages: number; remainingPages: number }.
// ---------------------------------------------------------------------------

export class BetterSqlite3BackupAdapter implements ChatDbBackupAdapter {
  private getSqlite: () => BetterSqlite3.Database

  constructor(getSqlite: () => BetterSqlite3.Database) {
    this.getSqlite = getSqlite
  }

  async createSnapshot(destPath: string): Promise<number> {
    const db = this.getSqlite()
    // better-sqlite3 backup API: .backup() returns Promise<BackupMetadata>
    // where BackupMetadata = { totalPages, remainingPages }
    const metadata = await db.backup(destPath)
    return metadata.totalPages
  }

  async validateSnapshot(dbPath: string): Promise<'ok' | string> {
    // Use a separate read-only connection to avoid interfering with the main DB
    const Database = (await import('better-sqlite3')).default
    let tempDb: BetterSqlite3.Database | null = null
    try {
      tempDb = new Database(dbPath, { readonly: true })
      const result = tempDb.pragma('integrity_check', { simple: true }) as string
      if (result === 'ok') {
        return 'ok'
      }
      return result
    } catch (error) {
      return `Integrity check failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      try {
        tempDb?.close()
      } catch {
        // Ignore close errors on validation connection
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ChatDbBackup — coordinates SQLite snapshot creation, validation, and
// atomic publishing. Used by BackupManager to ensure a consistent chat.db
// is included in every backup.
//
// Uses a global async mutex to prevent concurrent backup operations across
// local/WebDAV/S3 entry points.
// ---------------------------------------------------------------------------

export class ChatDbBackup {
  private adapter: ChatDbBackupAdapter
  private tempDir: string

  // Global async mutex — prevents concurrent backup operations
  private static backupMutex: Promise<void> = Promise.resolve()

  constructor(adapter: ChatDbBackupAdapter, _dbDir: string) {
    this.adapter = adapter
    this.tempDir = path.join(os.tmpdir(), 'cherry-studio-chatdb-backup')
  }

  /**
   * Create a validated snapshot at `destPath`.
   *
   * Steps:
   * 1. Ensure temp dir exists.
   * 2. Create snapshot in temp location (async await of backup API).
   * 3. Validate snapshot integrity.
   * 4. Atomic publish: move temp → destPath (same filesystem = rename).
   * 5. Cleanup temp dir.
   *
   * @returns Path to the created snapshot file.
   * @throws If any step fails (temp files are cleaned up on failure).
   */
  async createSnapshot(destPath: string): Promise<string> {
    return ChatDbBackup.withMutex(async () => {
      await fs.promises.mkdir(this.tempDir, { recursive: true })

      const tempSnapshot = path.join(this.tempDir, `chat-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`)

      try {
        // Step 1: Create consistent snapshot via async backup API
        logger.info('Creating chat.db snapshot...')
        const pagesCopied = await this.adapter.createSnapshot(tempSnapshot)
        logger.info(`Snapshot created at ${tempSnapshot} (${pagesCopied} pages)`)

        // Step 2: Validate snapshot integrity
        logger.info('Validating snapshot integrity...')
        const validation = await this.adapter.validateSnapshot(tempSnapshot)
        if (validation !== 'ok') {
          throw new Error(`Snapshot integrity check failed: ${validation}`)
        }
        logger.info('Snapshot integrity validated')

        // Step 3: Atomic publish — rename temp → dest (same filesystem)
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true })

        // Remove existing dest if present (atomic rename requires no existing target)
        try {
          await fs.promises.unlink(destPath)
        } catch {
          // File may not exist — that's fine
        }

        await fs.promises.rename(tempSnapshot, destPath)
        logger.info(`Snapshot published to ${destPath}`)

        return destPath
      } catch (error) {
        // Cleanup failed snapshot
        try {
          await fs.promises.unlink(tempSnapshot)
        } catch {
          // Ignore cleanup errors
        }
        throw error
      } finally {
        // Cleanup temp directory (best-effort)
        try {
          await fs.promises.rm(this.tempDir, { recursive: true, force: true })
        } catch {
          // Ignore cleanup errors
        }
      }
    })
  }

  /**
   * Acquire the global backup mutex and execute `fn`.
   * Only one backup operation runs at a time across the entire application.
   */
  private static async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the existing mutex — ensures serial execution
    const result = ChatDbBackup.backupMutex.then(() => fn())
    // Update the mutex to resolve after this operation completes (success or failure)
    ChatDbBackup.backupMutex = result.then(
      () => {},
      () => {}
    )
    return result
  }

  /**
   * Get the in-memory snapshot path that should be included in the Data
   * backup directory. Returns the path, creating the snapshot first if needed.
   *
   * Used by BackupManager to ensure the Data backup contains a consistent
   * chat.db snapshot rather than a raw copy of chat.db + WAL files.
   *
   * @param dataDir The Data directory being backed up.
   * @returns Path to the snapshot file (inside `dataDir`).
   */
  async ensureSnapshotForBackup(dataDir: string): Promise<string> {
    const snapshotPath = path.join(dataDir, 'chat.db.backup')
    await this.createSnapshot(snapshotPath)
    return snapshotPath
  }

  /**
   * Remove the snapshot file after backup is complete.
   * Must be called after the Data directory has been packaged into the backup.
   */
  async cleanupSnapshot(dataDir: string): Promise<void> {
    const snapshotPath = path.join(dataDir, 'chat.db.backup')
    try {
      await fs.promises.unlink(snapshotPath)
    } catch {
      // File may not exist — that's fine
    }
  }
}
