import * as fs from 'node:fs'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { BetterSqlite3BackupAdapter, ChatDbBackup } from './backup'
import { runMigrations } from './migration'
import * as schema from './schema'

const logger = loggerService.withContext('ChatDbService')

const DB_FILENAME = 'chat.db'
const RESTORE_MARKER_FILENAME = 'chat.db.restore'
const REPAIR_MARKER_FILENAME = 'chat.db.repair'

// ---------------------------------------------------------------------------
// ChatDbService — singleton wrapper around better-sqlite3 + Drizzle ORM
//
// Lifecycle guarantees:
// - Init is idempotent: concurrent calls share the same promise.
// - Init is recoverable: failure cleans up state, allowing retry.
// - Init is concurrency-safe: only one doInit runs at a time.
// - Close is safe to call multiple times (no-op if already closed).
// - One close failure does not discard a live handle; state remains
//   deterministic (sqlite/db remain non-null on close error so a retry
//   close can be attempted).
// - WAL mode, foreign_keys ON, synchronous NORMAL, busy_timeout configured.
// - Repair marker gates init: while repair marker exists, init refuses.
// - Restore pending: integrity-check runs BEFORE journal_mode=WAL and
//   BEFORE migrations. Failure persists repair state, closes handles,
//   rejects init. App continues but chat DB is unavailable.
// - Generation token ensures close() during init() supersedes the init
//   before handles are published. Superseded init never resolves
//   successfully.
// - Does not expose unrestricted SQL to Renderer (getSqlite is internal-only
//   and will be restricted in Phase 3 when IPC handlers are implemented).
// ---------------------------------------------------------------------------

class ChatDbService {
  private db: BetterSQLite3Database<typeof schema> | null = null
  private sqlite: Database.Database | null = null
  private initPromise: Promise<void> | null = null
  private dbDir: string
  private dbPath: string

  /**
   * Monotonically increasing generation counter. Incremented on every
   * close(). doInit captures the generation at entry; if it has changed
   * by the time handles are ready to publish, the init is superseded
   * and must not publish stale handles.
   */
  private generation = 0

  constructor(dbDir?: string) {
    this.dbDir = dbDir ?? DATA_PATH
    this.dbPath = path.join(this.dbDir, DB_FILENAME)
  }

  // ---------------------------------------------------------------------------
  // Repair guard — centralized check used by all public getters
  // ---------------------------------------------------------------------------

  /**
   * Assert that the service is not in repair-required state.
   * Called by getDatabase(), getSqlite(), getBackup(), and other public
   * entry points that must refuse operation while repair is pending.
   *
   * Throws a descriptive error if the repair marker exists.
   */
  private assertNotRepairing(): void {
    if (this.isRepairRequired()) {
      throw new Error(
        'ChatDbService is in repair-required state. ' +
          'The database is marked as requiring repair. All operations are blocked.'
      )
    }
  }

  /**
   * Initialise the database connection.
   *
   * Guarantees:
   * - Idempotent: concurrent calls share the same promise.
   * - Recoverable: on failure, cleans up state for retry.
   * - Concurrency-safe: only one doInit runs at a time.
   * - WAL mode, foreign_keys ON, synchronous NORMAL, busy_timeout configured.
   * - Refuses init if repair marker exists.
   * - Restore integrity check runs BEFORE journal_mode=WAL and BEFORE
   *   migrations. On failure: persists repair state, closes handles,
   *   rejects init.
   * - Generation token: close() during init supersedes init before
   *   handles are published. Superseded init throws, never publishes.
   * - setRepairRequired propagates marker-write failures (does not swallow).
   */
  async init(): Promise<void> {
    // Refuse init while repair marker exists
    if (this.isRepairRequired()) {
      throw new Error(
        'ChatDbService is in repair-required state. ' +
          'Clear the repair marker (chat.db.repair) and fix the database before initialising.'
      )
    }

    // Fast path: already initialised
    if (this.db) return

    // If init is in progress, wait for it
    if (this.initPromise) return this.initPromise

    this.initPromise = this.doInit()

    try {
      await this.initPromise
    } catch (error) {
      // Clean up on failure so next call can retry
      this.cleanupOnFailure()
      throw error
    }
  }

  private async doInit(): Promise<void> {
    // Capture generation at entry. If close() is called during init,
    // generation will have advanced and we must not publish handles.
    const gen = this.generation

    // Ensure directory exists
    if (!fs.existsSync(this.dbDir)) {
      fs.mkdirSync(this.dbDir, { recursive: true })
    }

    logger.info(`Opening database at ${this.dbPath}`)

    // --- Open raw better-sqlite3 connection ---
    // Use a local variable so we can clean up on supersede without
    // touching the instance field (which close() may have nulled).
    const sqlite = new Database(this.dbPath)

    // --- Generation check after open (close may have run before open) ---
    if (gen !== this.generation) {
      try {
        sqlite.close()
      } catch {
        // Best-effort cleanup of superseded handle
      }
      throw new Error('ChatDbService init was superseded by close()')
    }

    // --- Restore validation BEFORE journal_mode=WAL ---
    // If a restore marker exists, integrity-check MUST run before any
    // pragma or mutation (WAL creation could mask corruption). Failure
    // persists repair state, closes handles, rejects init. Propagates
    // marker-write failures (setRepairRequired does NOT suppress them).
    const restorePending = this.isRestorePending()
    if (restorePending) {
      logger.info('Restore marker detected — running pre-pragma integrity check...')

      let integrity: { ok: boolean; error?: string }
      try {
        const result = sqlite.pragma('integrity_check', { simple: true }) as string
        integrity = result === 'ok' ? { ok: true } : { ok: false, error: result }
      } catch (error) {
        integrity = {
          ok: false,
          error: `Integrity check threw: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      if (!integrity.ok) {
        logger.error(`Pre-pragma integrity check FAILED: ${integrity.error}`)

        // Persist repair state — propagate marker-write failures
        this.setRepairRequired()

        // Close handles (best-effort)
        try {
          sqlite.close()
        } catch {
          // Best-effort during error recovery
        }

        throw new Error(
          `Post-restore integrity check failed: ${integrity.error}. ` + 'Database marked as repair-required.'
        )
      }

      logger.info('Pre-pragma integrity check passed — clearing restore marker')
      const markerPath = path.join(this.dbDir, RESTORE_MARKER_FILENAME)
      try {
        fs.unlinkSync(markerPath)
      } catch {
        logger.warn('Failed to remove restore marker (non-fatal)')
      }
    }

    // --- Generation check before pragma mutation ---
    if (gen !== this.generation) {
      try {
        sqlite.close()
      } catch {
        // Best-effort cleanup of superseded handle
      }
      throw new Error('ChatDbService init was superseded by close()')
    }

    // --- Pragmas for performance and correctness ---
    // These run AFTER restore validation so a corrupt restored DB
    // never reaches WAL creation.
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')

    // --- Wrap with Drizzle ORM ---
    const db = drizzle(sqlite, { schema })

    // --- Generation check before publishing handles ---
    if (gen !== this.generation) {
      try {
        sqlite.close()
      } catch {
        // Best-effort cleanup of superseded handle
      }
      throw new Error('ChatDbService init was superseded by close()')
    }

    // --- Publish handles (atomic from this point) ---
    this.sqlite = sqlite
    this.db = db

    // --- Run pending migrations ---
    const appliedCount = runMigrations(this.db, sqlite)
    if (appliedCount > 0) {
      logger.info(`Applied ${appliedCount} migration(s)`)
    }

    logger.info('ChatDbService initialised')
  }

  /**
   * Run PRAGMA integrity_check against the current database.
   * Returns structured result for programmatic consumption.
   */
  runIntegrityCheck(): { ok: boolean; error?: string } {
    if (!this.sqlite) {
      return { ok: false, error: 'Database not initialised' }
    }

    try {
      const result = this.sqlite.pragma('integrity_check', { simple: true }) as string

      if (result === 'ok') {
        return { ok: true }
      }

      return { ok: false, error: result }
    } catch (error) {
      return {
        ok: false,
        error: `Integrity check threw: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /**
   * Return the Drizzle database instance.
   * Throws if not initialised or if repair state is active.
   */
  getDatabase(): BetterSQLite3Database<typeof schema> {
    this.assertNotRepairing()
    if (!this.db) {
      throw new Error('ChatDbService has not been initialised. Call init() first.')
    }
    return this.db
  }

  /**
   * Return the raw better-sqlite3 instance.
   * Throws if not initialised or if repair state is active.
   *
   * WARNING: This is an internal API. It will be restricted in Phase 3
   * when IPC handlers are implemented. Renderers should NOT call this
   * directly — they should use typed IPC commands.
   *
   * @internal
   */
  getSqlite(): Database.Database {
    this.assertNotRepairing()
    if (!this.sqlite) {
      throw new Error('ChatDbService has not been initialised. Call init() first.')
    }
    return this.sqlite
  }

  /** Get the database directory path. */
  getDbDir(): string {
    return this.dbDir
  }

  /** Get the database file path. */
  getDbPath(): string {
    return this.dbPath
  }

  /**
   * Check if the database is currently initialised and usable.
   * Returns false if repair state is active, even if handles exist.
   */
  isInitialised(): boolean {
    if (this.isRepairRequired()) return false
    return this.db !== null
  }

  /**
   * Close the database connection.
   *
   * Synchronous — safe to call from Electron's will-quit handler.
   * Safe to call multiple times (no-op if already closed).
   *
   * Increments the generation counter so any in-flight init is
   * superseded before handles are published.
   *
   * On close failure: the handles are NOT discarded. The sqlite/db
   * references remain non-null so that a subsequent close() retry
   * can attempt to close the same handle. This preserves deterministic
   * state: if close throws, the caller knows the handle is still live
   * and can handle accordingly.
   *
   * WARNING: Do NOT put any `await` before this call in will-quit.
   * Electron does not await async will-quit listeners; close() must
   * run synchronously and immediately.
   */
  close(): void {
    // Invalidate any in-flight init before touching handles.
    // This ensures doInit's generation check will detect the supersede.
    this.generation++

    if (!this.sqlite) {
      return
    }

    try {
      this.sqlite.close()
      logger.info('ChatDbService closed')
    } catch (error) {
      logger.error('Error closing ChatDbService', error as Error)
      // Do NOT discard the handle on close failure — preserve it for retry.
      // The caller can call close() again to retry.
      return
    }

    // Only null out handles on SUCCESS
    this.sqlite = null
    this.db = null
    this.initPromise = null
  }

  /**
   * Close raw handles without nullifying references.
   * Used internally when we need to close the DB (e.g., after integrity
   * failure) but want to manage state separately.
   */
  private closeHandles(): void {
    if (!this.sqlite) {
      return
    }
    try {
      this.sqlite.close()
    } catch {
      // Best-effort close during error recovery
    }
  }

  /**
   * Clean up state on init failure.
   * Ensures next init call can retry cleanly.
   */
  private cleanupOnFailure(): void {
    this.closeHandles()
    this.sqlite = null
    this.db = null
    this.initPromise = null
  }

  // ---------------------------------------------------------------------------
  // Restore / Repair state management
  // ---------------------------------------------------------------------------

  /**
   * Mark that a restore has been performed and the next init must run
   * integrity validation. Called by BackupManager after restoring Data.
   *
   * CRITICAL: Only call this if Data/chat.db actually exists (after the
   * Data.restore → Data rename). Throws on marker write failure — do NOT swallow.
   */
  setRestorePending(): void {
    // After handleStartupRestore renames Data.restore → Data, the restored
    // chat.db should be at the live Data path. Verify it exists.
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(
        `Cannot set restore pending: restored chat.db not found at ${this.dbPath}. ` +
          'Refusing to create restore marker without a valid restored database.'
      )
    }

    const markerPath = path.join(this.dbDir, RESTORE_MARKER_FILENAME)
    try {
      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8')
      logger.info('Restore pending marker set')
    } catch (error) {
      // Marker write failure must fail restore — propagate
      throw new Error(`Failed to write restore marker: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Check if a restore is pending (marker exists).
   */
  isRestorePending(): boolean {
    const markerPath = path.join(this.dbDir, RESTORE_MARKER_FILENAME)
    return fs.existsSync(markerPath)
  }

  /**
   * Mark the database as repair-required. The application may continue
   * startup, but chat DB operations must not be available.
   *
   * CRITICAL: Does NOT suppress marker-write failures. Propagates them
   * so callers can handle the failure (e.g., abort init before publishing
   * handles).
   */
  private setRepairRequired(): void {
    const markerPath = path.join(this.dbDir, REPAIR_MARKER_FILENAME)
    // Propagate — do NOT wrap in try/catch that swallows the error
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8')
    logger.warn('Chat DB marked as repair-required')
  }

  /**
   * Check if the database is in repair-required state.
   */
  isRepairRequired(): boolean {
    const markerPath = path.join(this.dbDir, REPAIR_MARKER_FILENAME)
    return fs.existsSync(markerPath)
  }

  /**
   * Clear the repair-required marker (e.g., after manual repair).
   */
  clearRepairRequired(): void {
    const markerPath = path.join(this.dbDir, REPAIR_MARKER_FILENAME)
    try {
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath)
      }
    } catch (error) {
      logger.error('Failed to clear repair-required marker', error as Error)
    }
  }

  /**
   * Get a ChatDbBackup instance for backup coordination.
   * Throws if not initialised or if repair state is active.
   */
  getBackup(): ChatDbBackup {
    this.assertNotRepairing()
    if (!this.sqlite) {
      throw new Error('ChatDbService has not been initialised. Call init() first.')
    }
    const adapter = new BetterSqlite3BackupAdapter(() => this.getSqlite())
    return new ChatDbBackup(adapter, this.dbDir)
  }
}

/** Singleton instance */
export const chatDbService = new ChatDbService()

// Named class export for testing with explicit dbDir.
// Production code should use the chatDbService singleton.
export { ChatDbService }
