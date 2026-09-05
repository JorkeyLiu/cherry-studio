import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import type {
  SyncConfig,
  SyncOperation,
  SyncPairingRequest,
  SyncPairingStatus,
  SyncPushRequest,
  SyncStatus,
  SyncTrustedDevice
} from '@shared/sync'
import {
  filterBlockPayload,
  filterMessagePayload,
  filterTopicPayload,
  isValidSyncDeviceAuth,
  isValidSyncDeviceId,
  normalizePairingCode,
  SYNC_BLOCK_PATCH_FIELDS,
  SYNC_CONFLICT_LOG_MAX,
  SYNC_MESSAGE_PATCH_FIELDS,
  SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH,
  SYNC_TOPIC_PATCH_FIELDS,
  validatePairingCode,
  validateSyncDeviceName,
  validateSyncOperationStrict,
  validateSyncPayloadAllowlist
} from '@shared/sync'
import { SYNC_MAX_OPERATIONS_PER_PULL, SYNC_MAX_OPERATIONS_PER_PUSH } from '@shared/sync'
import type Database from 'better-sqlite3'
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { chatDbService } from '../chatDb'
import * as schema from '../chatDb/schema'
import { syncClient, validateEndpointUrl } from './SyncClient'

const logger = loggerService.withContext('SyncService')

const STATE_LAST_SYNC_AT = 'lastSyncAt'
const STATE_LAST_ERROR = 'lastError'
const STATE_CURSOR = 'cursor'
const STATE_DEVICE_ID = 'deviceId'
const STATE_CAPTURE_ERROR = 'lastCaptureError'
const STATE_DEVICE_AUTH = 'sync:deviceAuth'
// Unambiguous missing sentinel for config device identity: passed as the
// electron-store default so a truly absent key is the ONLY case that returns
// this reference. Present null/empty/whitespace/non-string values are returned
// as-is and fail closed via isValidDeviceId.
const CONFIG_DEVICE_ID_MISSING: unique symbol = Symbol('sync-device-id-missing')
const TOMBSTONE_TOPIC_PREFIX = 'tombstone:topic:'
const TOMBSTONE_MESSAGE_PREFIX = 'tombstone:message:'
const TOMBSTONE_BLOCK_PREFIX = 'tombstone:message_block:'
// Bounded cross-page orphan buffer: a single sync() cycle never buffers more
// than this many retryable orphans in memory. Past the budget the cycle fails
// closed with a durable blocked error (cursor unmoved, no skip).
const MAX_DEFERRED_ORPHANS = 500

// Outbox push priority: parents before children so relay seq preserves
// dependency order (topic < message < block). Within the same priority,
// timestamp then id order applies.
const ENTITY_PUSH_PRIORITY: Record<string, number> = { topic: 0, message: 1, message_block: 2 }

export class SyncOrphanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncOrphanError'
  }
}

export class SyncTombstoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncTombstoneError'
  }
}

export class SyncShutdownError extends Error {
  constructor(message = 'sync cancelled (shutdown)') {
    super(message)
    this.name = 'SyncShutdownError'
  }
}

export class SyncStaleConfigError extends Error {
  constructor(message = 'sync cancelled: configuration changed') {
    super(message)
    this.name = 'SyncStaleConfigError'
  }
}

export class SyncCaptureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncCaptureError'
  }
}

export class SyncCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncCursorError'
  }
}

export class SyncDeviceIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncDeviceIdentityError'
  }
}

export class SyncConfigPreflightError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncConfigPreflightError'
  }
}

/**
 * Strict canonical cursor parser (LOCK-PERSONAL-001): only canonical
 * non-negative safe-integer forms are accepted. Numbers must be safe
 * integers >= 0; strings must match /^(0|[1-9][0-9]*)$/ exactly (no
 * whitespace, no leading zeros, no trailing junk like `12junk`) and decode
 * to a safe integer. Anything else throws SyncCursorError — never reinterpreted.
 */
export function parseStrictCursor(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SyncCursorError(`malformed cursor ${JSON.stringify(String(value)).slice(0, 80)}`)
    }
    return value
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SyncCursorError(`malformed cursor ${JSON.stringify(String(value)).slice(0, 80)}`)
  }
  const n = Number(value)
  if (!Number.isSafeInteger(n)) {
    throw new SyncCursorError(`malformed cursor ${JSON.stringify(value).slice(0, 80)}`)
  }
  return n
}

/** True for any SQLite missing-table error (candidate pre-migration OR post-migration damage). */
function isMissingSyncTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /no such table/i.test(msg)
}

const MIGRATION_005_KEY = '005_sync_metadata'
const MIGRATION_006_KEY = '006_sync_field_merge'
const MIGRATION_007_KEY = '007_sync_pairing_trust'

/**
 * Device-identity validity (LOCK-PERSONAL-001/006): a present identity must be
 * a non-empty string (1..256 chars, not whitespace-only). NULL/empty/
 * whitespace/malformed values are never valid and fail closed — never treated
 * as absence and never silently replaced by the other store.
 */
function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0
}

/**
 * Migration-state proof (LOCK-PERSONAL-006): a missing-table error is a
 * truthful pre-migration miss ONLY when a present migration_state table on
 * the SAME database explicitly proves the owning migration was never applied
 * (absent row). For the 005 compatibility path proof additionally requires
 * no later sync migration marker (including 006) and no surviving sync
 * metadata tables (checked via sqlite_master); otherwise fail closed so a
 * damaged post-migration DB with a missing 005 marker is never treated as
 * pre-005 compatibility. A missing migration_state table itself is damage
 * (fail closed) unless an independent pre-migration marker proves the
 * database never reached the sync migrations: no sync tables exist at all on
 * the same database (checked via sqlite_master). A present migration row,
 * any other migration-state read failure, or any surviving sync table
 * alongside a missing migration_state table returns false (post-migration
 * damage).
 */
function isProvenMigrationNotApplied(dbLike: unknown, migrationKey: string): boolean {
  try {
    const typed = dbLike as BetterSQLite3Database<typeof schema>
    const row = typed.select().from(schema.migrationState).where(eq(schema.migrationState.key, migrationKey)).get()
    if (row) return false
    if (migrationKey === MIGRATION_005_KEY) {
      try {
        const later = typed
          .select()
          .from(schema.migrationState)
          .where(eq(schema.migrationState.key, MIGRATION_006_KEY))
          .get()
        if (later) return false
      } catch {
        return false
      }
      try {
        const raw = getRawSqliteForProof(dbLike)
        if (!raw) return false
        const rows = raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_state','sync_outbox','sync_applied','sync_entity_clock','sync_field_clock','sync_conflict_log')"
          )
          .all()
        if (Array.isArray(rows) && rows.length > 0) return false
        return true
      } catch {
        return false
      }
    }
    return true
  } catch (inner) {
    if (!isMissingSyncTableError(inner)) return false
    try {
      const raw = getRawSqliteForProof(dbLike)
      if (!raw) return false
      const rows = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_state','sync_outbox','sync_applied','sync_entity_clock','sync_field_clock','sync_conflict_log')"
        )
        .all()
      if (Array.isArray(rows) && rows.length > 0) return false
      return true
    } catch {
      return false
    }
  }
}

/** Best-effort raw better-sqlite3 handle for the same database behind a Drizzle executor. */
function getRawSqliteForProof(dbLike: unknown): Database.Database | null {
  try {
    const candidate = dbLike as {
      $client?: unknown
      session?: { client?: unknown }
    }
    const raw = candidate.$client ?? candidate.session?.client ?? null
    if (raw && typeof (raw as Database.Database).prepare === 'function') {
      return raw as Database.Database
    }
  } catch {}
  return null
}

/** Tolerate ONLY a proven pre-migration missing table on the same database; all other errors fail closed. */
function isTolerableMissingSyncTable(dbLike: unknown, e: unknown, migrationKey: string): boolean {
  if (!isMissingSyncTableError(e)) return false
  try {
    return isProvenMigrationNotApplied(dbLike, migrationKey)
  } catch {
    return false
  }
}

/**
 * Transaction executor compatible with both the root Drizzle database and a
 * `db.transaction((tx) => ...)` executor. The aggregate owns the atomic
 * mutation boundary; SyncService helpers here never open their own
 * BEGIN/COMMIT so no nested transaction can occur.
 */
export type SyncTxExecutor = BetterSQLite3Database<typeof schema>

// Mutable clocked fields per entity for per-field LWW. Identity/immutable
// relation fields (`id`, `topicId`, `messageId`) are never clocked.
// `sortOrder` is clocked on apply for old-full-payload convergence, but new
// local update patches never send it (reorder unsupported).
const TOPIC_CLOCKED = new Set<string>(SYNC_TOPIC_PATCH_FIELDS as readonly string[])
const MESSAGE_CLOCKED = new Set<string>([...(SYNC_MESSAGE_PATCH_FIELDS as readonly string[]), 'sortOrder'])
const BLOCK_CLOCKED = new Set<string>([...(SYNC_BLOCK_PATCH_FIELDS as readonly string[]), 'sortOrder'])

function clockedFieldsFor(entityType: SyncOperation['entityType']): Set<string> {
  return entityType === 'topic' ? TOPIC_CLOCKED : entityType === 'message' ? MESSAGE_CLOCKED : BLOCK_CLOCKED
}

export class SyncService {
  private statusSyncing = false
  private enqueueListeners = new Set<() => void>()
  private shutdownRequested = false
  private activeFetchControllers = new Set<AbortController>()
  /**
   * Config generation (LOCK-PERSONAL-001): bumped on every disable /
   * endpoint / token transition. An active sync() snapshots the generation at
   * start and aborts with SyncStaleConfigError before any further stale
   * transport or post-transition database/status effect.
   */
  private configGeneration = 0
  private configFailureListeners = new Set<(error: unknown) => void>()

  /** Current config generation (tests + automation coordination). */
  getConfigGeneration(): number {
    return this.configGeneration
  }

  /**
   * Decoupled lifecycle seam (LOCK-PERSONAL-001/006): SyncService never
   * imports syncAuto; automation registers a callback to stop its
   * subscriber/timers when setConfig fails (even though setConfig throws and
   * syncIpc refreshes only on success). Listener errors never propagate into
   * the setConfig throw path (they are scoped-logged).
   */
  onConfigFailure(listener: (error: unknown) => void): () => void {
    this.configFailureListeners.add(listener)
    return () => {
      this.configFailureListeners.delete(listener)
    }
  }

  private emitConfigFailure(error: unknown): void {
    for (const listener of [...this.configFailureListeners]) {
      try {
        listener(error)
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        logger.error(`[emitConfigFailure] listener failed: ${detail.slice(0, 200)}`)
      }
    }
  }

  /**
   * Invalidate in-flight sync() cycles for a disable/endpoint/token change
   * that bypassed setConfig (e.g. direct store writes observed by refresh).
   * Idempotent: callers bump only on a detected transition.
   */
  invalidateForConfigChange(): void {
    this.configGeneration += 1
  }

  private throwIfStaleConfig(syncGen: number): void {
    if (syncGen !== this.configGeneration) throw new SyncStaleConfigError()
  }

  /** True while a sync() push/pull cycle holds the exclusive lock. */
  isSyncing(): boolean {
    return this.statusSyncing
  }

  /**
   * Synchronous shutdown invalidation for Electron will-quit (no await).
   * Sets the shutdown flag and aborts in-flight relay fetches so a pending
   * sync() continuation observes cancellation before any post-close database
   * work. Must be called synchronously before ChatDb close.
   */
  beginShutdown(): void {
    this.shutdownRequested = true
    for (const c of [...this.activeFetchControllers]) {
      try {
        c.abort()
      } catch {}
    }
  }

  /** True after beginShutdown() until reset (tests only). */
  isShutdown(): boolean {
    return this.shutdownRequested
  }

  /** Test-only reset for the shutdown flag. */
  resetShutdownForTests(): void {
    this.shutdownRequested = false
  }

  private throwIfShutdown(): void {
    if (this.shutdownRequested) throw new SyncShutdownError()
  }

  /** Register a fetch abort controller for shutdown coordination. */
  trackFetchController(controller: AbortController): () => void {
    this.activeFetchControllers.add(controller)
    return () => {
      this.activeFetchControllers.delete(controller)
    }
  }

  /** Subscribe to successful local outbox enqueues (inserted only, not duplicates). */
  onEnqueue(listener: () => void): () => void {
    this.enqueueListeners.add(listener)
    return () => {
      this.enqueueListeners.delete(listener)
    }
  }

  private emitEnqueue(): void {
    for (const listener of [...this.enqueueListeners]) {
      try {
        listener()
      } catch {}
    }
  }

  private getDb(): BetterSQLite3Database<typeof schema> {
    return chatDbService.getDatabase()
  }
  private getSqlite(): Database.Database {
    return chatDbService.getSqlite()
  }

  getConfig(): SyncConfig {
    const endpoint = configManager.get<string>('sync:endpoint', '') ?? ''
    const token = configManager.get<string>('sync:token', '') ?? ''
    const enabled = configManager.get<boolean>('sync:enabled', false) ?? false
    return { endpoint, token: token || undefined, enabled }
  }

  setConfig(config: Partial<SyncConfig>): SyncConfig {
    // Fail closed (LOCK-PERSONAL-001/006): the previous routing snapshot must
    // be knowable before comparing. Never fabricate a disabled snapshot; on
    // prior-read failure conservatively invalidate stale work and rethrow the
    // original error without applying the update.
    let before: SyncConfig
    try {
      before = this.getConfig()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[setConfig] prior config read failed: ${msg.slice(0, 300)}`)
      try {
        this.recordCaptureFailure('sync:setConfig:prior-read', e)
      } catch (persistErr) {
        const detail = persistErr instanceof Error ? persistErr.message : String(persistErr)
        logger.error(`[setConfig] capture-error persistence failed: ${detail.slice(0, 300)}`)
        this.configGeneration += 1
        this.emitConfigFailure(e)
        throw persistErr instanceof Error ? persistErr : new Error(String(persistErr))
      }
      this.configGeneration += 1
      this.emitConfigFailure(e)
      throw e instanceof Error ? e : new Error(String(e))
    }
    if (config.endpoint !== undefined) {
      const err = validateEndpointUrl(config.endpoint)
      if (config.endpoint !== '' && err) throw new Error(err)
      configManager.set('sync:endpoint', config.endpoint)
    }
    if (config.token !== undefined) {
      configManager.set('sync:token', config.token)
    }
    if (config.enabled !== undefined) {
      configManager.set('sync:enabled', !!config.enabled)
    }
    // Post-write snapshot unknowable: writes already applied, so invalidate
    // conservatively and rethrow instead of comparing against a guess.
    let after: SyncConfig
    try {
      after = this.getConfig()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[setConfig] post config read failed: ${msg.slice(0, 300)}`)
      try {
        this.recordCaptureFailure('sync:setConfig:post-read', e)
      } catch (persistErr) {
        const detail = persistErr instanceof Error ? persistErr.message : String(persistErr)
        logger.error(`[setConfig] capture-error persistence failed: ${detail.slice(0, 300)}`)
        this.configGeneration += 1
        this.emitConfigFailure(e)
        throw persistErr instanceof Error ? persistErr : new Error(String(persistErr))
      }
      this.configGeneration += 1
      this.emitConfigFailure(e)
      throw e instanceof Error ? e : new Error(String(e))
    }
    // Any disable/endpoint/token transition invalidates in-flight sync()
    // cycles so they never continue on stale transport or commit
    // post-transition database/status effects.
    if (before.enabled !== after.enabled || before.endpoint !== after.endpoint || before.token !== after.token) {
      this.configGeneration += 1
    }
    return after
  }

  getStatus(): SyncStatus {
    const cfg = this.getConfig()
    const sqlite = this.tryGetSqlite()
    if (!sqlite) {
      throw new Error('sync database unavailable')
    }
    let db: BetterSQLite3Database<typeof schema>
    try {
      db = this.getDb()
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e))
    }
    try {
      const pendingCount = db.select().from(schema.syncOutbox).all().length
      const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).get()
      // Strict persisted cursor (LOCK-PERSONAL-001): a present row must hold a
      // canonical non-negative safe integer; malformed state fails closed via
      // the catch below (durable lastError + throw), never reinterpreted.
      // Absent row (never synced) is the only 0 default.
      let cursor = 0
      if (cursorRow) {
        if (cursorRow.value === null || cursorRow.value === undefined) {
          throw new SyncCursorError('malformed persisted cursor: missing value')
        }
        cursor = parseStrictCursor(cursorRow.value)
      }
      const lastSyncRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_SYNC_AT)).get()
      const lastSyncAt = lastSyncRow?.value ?? null
      const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_ERROR)).get()
      const lastError = errRow?.value ?? null
      const capRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CAPTURE_ERROR)).get()
      const lastCaptureError = capRow?.value ?? null
      const conflictCount = this.getConflictCount()
      return {
        enabled: cfg.enabled,
        endpoint: cfg.endpoint,
        lastSyncAt,
        lastError,
        lastCaptureError,
        pendingCount,
        cursor,
        syncing: this.statusSyncing,
        conflictCount
      }
    } catch (e) {
      // Proven pre-migration database (005 never applied): truthful empty
      // status, not a failure. Anything else is infrastructure damage — persist
      // a durable status error best-effort, then fail closed (throw) instead
      // of fabricating zero/null convergence.
      if (isTolerableMissingSyncTable(db!, e, MIGRATION_005_KEY)) {
        let conflictCount = 0
        try {
          conflictCount = this.getConflictCount()
        } catch {
          conflictCount = 0
        }
        return {
          enabled: cfg.enabled,
          endpoint: cfg.endpoint,
          lastSyncAt: null,
          lastError: null,
          lastCaptureError: null,
          pendingCount: 0,
          cursor: 0,
          syncing: this.statusSyncing,
          conflictCount
        }
      }
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.updateLastError(`status read failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /**
   * Bounded durable same-field conflict record count. Returns 0 ONLY for a
   * proven pre-006 database (a present migration_state table proves 006 never
   * applied). Any other read failure — including a missing migration_state
   * table — throws fail-closed (LOCK-PERSONAL-001/006/009) instead of
   * fabricating zero.
   */
  getConflictCount(): number {
    const db = this.getDb()
    try {
      return db.select().from(schema.syncConflictLog).all().length
    } catch (e) {
      if (isTolerableMissingSyncTable(db, e, MIGRATION_006_KEY)) return 0
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** True when sync capture is enabled (safe outside transactions). */
  isCaptureEnabled(): boolean {
    // Fail closed (LOCK-PERSONAL-001/006): an infrastructure failure reading
    // capture configuration must propagate (caller rolls back + records a
    // durable capture failure) instead of silently disabling capture. A
    // confirmed-disabled config is the only false return.
    return !!this.getConfig().enabled
  }

  /** Wake automation after an aggregate transaction commits outbox intent. */
  notifyEnqueued(): void {
    this.emitEnqueue()
  }

  private tryGetSqlite(): Database.Database | null {
    try {
      return this.getSqlite()
    } catch {
      return null
    }
  }

  /**
   * Durable device identity (LOCK-PERSONAL-001/006): the durable DB row is
   * authoritative and is never overwritten by config. Missing config is
   * repaired from a valid durable row; a fresh UUID is generated ONLY when
   * both stores prove absence (no config + no durable row, or proven pre-005
   * with no durable store). Present NULL/empty/malformed values in either
   * store fail closed, and two differing valid identities fail closed rather
   * than silently choosing one. The ONLY tolerated missing-table case is
   * proven pre-005 compatibility (a present migration_state table on the same
   * database explicitly proves 005 never applied) — then the config identity
   * is returned without DB persistence. Post-005 damage (migration row
   * present, or any migration-state read failure including a missing
   * migration_state table) throws SyncDeviceIdentityError so enabled capture
   * cannot proceed without durable identity persistence.
   */
  getDeviceId(): string {
    let configRaw: unknown
    let configPresent: boolean
    try {
      const hasFn = (configManager as unknown as { has?: unknown }).has
      if (typeof hasFn === 'function') {
        configPresent = (hasFn as (key: string) => boolean).call(configManager, STATE_DEVICE_ID)
        configRaw = configPresent ? configManager.get(STATE_DEVICE_ID as any) : (CONFIG_DEVICE_ID_MISSING as unknown)
      } else {
        configRaw = configManager.get(STATE_DEVICE_ID as any, CONFIG_DEVICE_ID_MISSING as any)
        configPresent = configRaw !== (CONFIG_DEVICE_ID_MISSING as unknown)
      }
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync device identity config read failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    if (configPresent && !isValidDeviceId(configRaw)) {
      throw new SyncDeviceIdentityError('sync device identity config malformed: present value is not a valid identity')
    }
    const configId = configPresent ? (configRaw as string) : null
    let dbForCheck: BetterSQLite3Database<typeof schema> | null = null
    try {
      const db = this.getDb()
      dbForCheck = db
      const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_DEVICE_ID)).get()
      if (row) {
        const rawValue: unknown = row.value
        if (!isValidDeviceId(rawValue)) {
          throw new SyncDeviceIdentityError(
            'sync device identity durable malformed: present DB value is NULL/empty/malformed'
          )
        }
        const durableId = rawValue
        if (configId === null) {
          try {
            configManager.set(STATE_DEVICE_ID as any, durableId)
          } catch (e) {
            throw new SyncDeviceIdentityError(
              `sync device identity config repair failed: ${e instanceof Error ? e.message : String(e)}`,
              { cause: e }
            )
          }
          return durableId
        }
        if (configId !== durableId) {
          throw new SyncDeviceIdentityError('sync device identity mismatch: config and durable DB identities differ')
        }
        return durableId
      }
      if (configId !== null) {
        try {
          db.insert(schema.syncState).values({ key: STATE_DEVICE_ID, value: configId }).run()
        } catch (e) {
          const dbLike = this.tryGetDbForTableCheck() ?? db
          if (isTolerableMissingSyncTable(dbLike, e, MIGRATION_005_KEY)) return configId
          throw new SyncDeviceIdentityError(
            `sync device identity persistence failed: ${e instanceof Error ? e.message : String(e)}`,
            { cause: e }
          )
        }
        return configId
      }
      const fresh = randomUUID()
      try {
        configManager.set(STATE_DEVICE_ID as any, fresh)
      } catch (e) {
        throw new SyncDeviceIdentityError(
          `sync device identity config persist failed: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e }
        )
      }
      try {
        db.insert(schema.syncState).values({ key: STATE_DEVICE_ID, value: fresh }).run()
      } catch (e) {
        const dbLike = this.tryGetDbForTableCheck() ?? db
        if (isTolerableMissingSyncTable(dbLike, e, MIGRATION_005_KEY)) return fresh
        throw new SyncDeviceIdentityError(
          `sync device identity persistence failed: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e }
        )
      }
      return fresh
    } catch (e) {
      if (e instanceof SyncDeviceIdentityError) throw e
      const dbLike = this.tryGetDbForTableCheck() ?? dbForCheck
      if (dbLike && isTolerableMissingSyncTable(dbLike, e, MIGRATION_005_KEY)) {
        if (configId !== null) return configId
        const fresh = randomUUID()
        try {
          configManager.set(STATE_DEVICE_ID as any, fresh)
        } catch (setErr) {
          throw new SyncDeviceIdentityError(
            `sync device identity config persist failed: ${setErr instanceof Error ? setErr.message : String(setErr)}`,
            { cause: setErr }
          )
        }
        return fresh
      }
      throw new SyncDeviceIdentityError(
        `sync device identity read failed: ${e instanceof Error ? e.message : String(e)}`,
        {
          cause: e
        }
      )
    }
  }

  /** Best-effort DB accessor for missing-table compatibility checks (never throws). */
  private tryGetDbForTableCheck(): BetterSQLite3Database<typeof schema> | null {
    try {
      return this.getDb()
    } catch {
      return null
    }
  }

  /**
   * Durable capture-failure record (LOCK-PERSONAL-006/009): persists the
   * original failure to sync_state and logs it. A persistence failure is
   * never swallowed — it is logged and thrown as SyncCaptureError carrying
   * the original message, so the failure remains inspectable and the caller
   * cannot treat the mutation as successfully captured.
   */
  recordCaptureFailure(channel: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error)
    try {
      const db = this.getDb()
      db.insert(schema.syncState)
        .values({ key: STATE_CAPTURE_ERROR, value: `${channel}: ${msg}`.slice(0, 1000) })
        .onConflictDoUpdate({ target: schema.syncState.key, set: { value: `${channel}: ${msg}`.slice(0, 1000) } })
        .run()
      this.updateLastError(`capture failed for ${channel}: ${msg}`.slice(0, 1000))
      logger.error(`[recordCaptureFailure] ${channel}: ${msg}`)
    } catch (persistErr) {
      const detail = persistErr instanceof Error ? persistErr.message : String(persistErr)
      logger.error(`[recordCaptureFailure] persistence failed for ${channel}: ${detail}; original: ${msg}`)
      throw new SyncCaptureError(`capture failure persistence failed for ${channel}: ${detail}; original: ${msg}`, {
        cause: persistErr
      })
    }
  }

  enqueueOperation(op: SyncOperation): void {
    const strictErr = validateSyncOperationStrict(op as any)
    if (strictErr) {
      logger.warn(`[enqueueOperation] strict validation rejected: ${strictErr}`)
      throw new Error(strictErr)
    }
    const allowErr = validateSyncPayloadAllowlist(op)
    if (allowErr) {
      logger.warn(`[enqueueOperation] payload allowlist rejected: ${allowErr}`)
      throw new Error(allowErr)
    }
    const db = this.getDb()
    const sqlite = this.getSqlite()
    sqlite.exec('BEGIN IMMEDIATE')
    let inserted = false
    try {
      db.insert(schema.syncOutbox)
        .values({
          id: op.id,
          entityType: op.entityType,
          op: op.op,
          entityId: op.entityId,
          timestamp: op.timestamp,
          deviceId: op.deviceId,
          payloadJson: op.payload ? JSON.stringify(op.payload) : null,
          createdAt: new Date().toISOString()
        })
        .onConflictDoNothing()
        .run()
      // Use SELECT changes() to detect insert vs ignore
      const ch = sqlite.prepare('SELECT changes() as c').get() as { c: number }
      inserted = ch.c > 0
      if (!inserted) {
        logger.warn(`[enqueueOperation] duplicate id ${op.id} ignored`)
        sqlite.exec('COMMIT')
        return
      }
      // Atomically update entity clock for LWW — outbox enqueue + clock in same transaction
      const existingClock = db
        .select()
        .from(schema.syncEntityClock)
        .where(eq(schema.syncEntityClock.entityType, op.entityType))
        .all()
        .find((r) => r.entityId === op.entityId) as typeof schema.syncEntityClock.$inferSelect | undefined
      let shouldUpdateClock = true
      if (existingClock) {
        if (op.timestamp < existingClock.timestamp) shouldUpdateClock = false
        else if (op.timestamp === existingClock.timestamp && op.id <= existingClock.operationId)
          shouldUpdateClock = false
      }
      if (shouldUpdateClock) {
        db.insert(schema.syncEntityClock)
          .values({ entityType: op.entityType, entityId: op.entityId, timestamp: op.timestamp, operationId: op.id })
          .onConflictDoUpdate({
            target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
            set: { timestamp: op.timestamp, operationId: op.id }
          })
          .run()
      }
      // Additive tombstone for hard-delete containment, inside the same
      // outbox/clock transaction: a late (older-or-equal) child upsert cannot
      // resurrect a hard-deleted parent. Stored in existing sync_state.
      // Fail closed: a tombstone write failure must roll back the enclosing
      // outbox/clock transaction (propagates to the outer catch/ROLLBACK).
      if (
        inserted &&
        op.op === 'delete' &&
        (op.entityType === 'topic' || op.entityType === 'message' || op.entityType === 'message_block')
      ) {
        this.setTombstoneInDb(db, op.entityType, op.entityId, op.timestamp, op.id)
      }
      if (inserted && op.op === 'upsert' && op.payload) {
        this.updateFieldClocksInDb(db, op.entityType, op.entityId, op.payload, op.timestamp, op.id)
      }
      sqlite.exec('COMMIT')
      // Notify automation only for a newly inserted outbox row; duplicates
      // carry no new work and must not wake the auto sync loop.
      if (inserted) this.emitEnqueue()
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // Transaction-bound capture (LOCK-PERSONAL-006): the aggregate owns the
  // atomic mutation boundary and calls these helpers INSIDE its existing
  // Drizzle transaction. No BEGIN/COMMIT here — a throw rolls back the
  // enclosing aggregate mutation so a committed row without durable sync
  // intent is impossible. The caller emits via notifyEnqueued() after commit.
  // -------------------------------------------------------------------------

  /**
   * Validate + insert outbox/clock/field-clock/tombstone intent using only
   * the provided aggregate transaction executor. Throws fail-closed on any
   * validation or persistence failure (rolls back the aggregate mutation).
   * Duplicate operation IDs are ignored idempotently (no clocks advanced).
   * Returns true when a new outbox row was inserted.
   */
  enqueueOperationInTx(tx: SyncTxExecutor, op: SyncOperation): boolean {
    const strictErr = validateSyncOperationStrict(op as any)
    if (strictErr) throw new Error(strictErr)
    const allowErr = validateSyncPayloadAllowlist(op)
    if (allowErr) throw new Error(allowErr)
    const existing = tx.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, op.id)).get()
    if (existing) {
      logger.warn(`[enqueueOperationInTx] duplicate id ${op.id} ignored`)
      return false
    }
    tx.insert(schema.syncOutbox)
      .values({
        id: op.id,
        entityType: op.entityType,
        op: op.op,
        entityId: op.entityId,
        timestamp: op.timestamp,
        deviceId: op.deviceId,
        payloadJson: op.payload ? JSON.stringify(op.payload) : null,
        createdAt: new Date().toISOString()
      })
      .onConflictDoNothing()
      .run()
    // Conditional entity-clock advance (deterministic LWW) inside the same tx.
    const clockRow = tx
      .select()
      .from(schema.syncEntityClock)
      .where(eq(schema.syncEntityClock.entityType, op.entityType))
      .all()
      .find((r) => r.entityId === op.entityId) as typeof schema.syncEntityClock.$inferSelect | undefined
    let advance = true
    if (clockRow) {
      if (this.compareLww(op.timestamp, op.id, clockRow.timestamp, clockRow.operationId) <= 0) advance = false
    }
    if (advance) {
      tx.insert(schema.syncEntityClock)
        .values({ entityType: op.entityType, entityId: op.entityId, timestamp: op.timestamp, operationId: op.id })
        .onConflictDoUpdate({
          target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
          set: { timestamp: op.timestamp, operationId: op.id }
        })
        .run()
    }
    if (op.op === 'upsert' && op.payload) {
      this.updateFieldClocksInDb(
        tx as unknown as BetterSQLite3Database<typeof schema>,
        op.entityType,
        op.entityId,
        op.payload,
        op.timestamp,
        op.id
      )
    }
    if (
      op.op === 'delete' &&
      (op.entityType === 'topic' || op.entityType === 'message' || op.entityType === 'message_block')
    ) {
      this.setTombstoneInDb(
        tx as unknown as BetterSQLite3Database<typeof schema>,
        op.entityType,
        op.entityId,
        op.timestamp,
        op.id
      )
    }
    return true
  }

  /** Build + enqueue an upsert intent inside the aggregate tx. Returns op id. */
  enqueueUpsertInTx(
    tx: SyncTxExecutor,
    entityType: SyncOperation['entityType'],
    entityId: string,
    payload: Record<string, unknown>,
    timestamp: number,
    deviceId: string
  ): string {
    const op: SyncOperation = { id: randomUUID(), entityType, op: 'upsert', entityId, timestamp, deviceId, payload }
    this.enqueueOperationInTx(tx, op)
    return op.id
  }

  /** Build + enqueue a delete intent inside the aggregate tx. Returns op id. */
  enqueueDeleteInTx(
    tx: SyncTxExecutor,
    entityType: SyncOperation['entityType'],
    entityId: string,
    timestamp: number,
    deviceId: string
  ): string {
    const op: SyncOperation = { id: randomUUID(), entityType, op: 'delete', entityId, timestamp, deviceId }
    this.enqueueOperationInTx(tx, op)
    return op.id
  }

  /** Tx-bound tracked check (clock or pending outbox via the same executor). */
  isTrackedEntityInTx(tx: SyncTxExecutor, entityType: SyncOperation['entityType'], entityId: string): boolean {
    try {
      const clock = tx
        .select()
        .from(schema.syncEntityClock)
        .where(eq(schema.syncEntityClock.entityType, entityType))
        .all()
        .find((r) => r.entityId === entityId)
      if (clock) return true
      return tx
        .select()
        .from(schema.syncOutbox)
        .where(eq(schema.syncOutbox.entityId, entityId))
        .all()
        .some((r) => r.entityType === entityType)
    } catch (e) {
      // Fail closed (LOCK-PERSONAL-001/006): an infrastructure read failure
      // inside the aggregate tx must roll back the enclosing mutation (never
      // a silent untracked verdict). Only a proven pre-005 missing sync table
      // (migration_state proves 005 never applied) is a truthful miss.
      if (isTolerableMissingSyncTable(tx, e, MIGRATION_005_KEY)) return false
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Tx-bound known check (tracked or surviving local row via the same executor). */
  isKnownEntityInTx(tx: SyncTxExecutor, entityType: SyncOperation['entityType'], entityId: string): boolean {
    try {
      if (this.isTrackedEntityInTx(tx, entityType, entityId)) return true
      const pending = tx
        .select()
        .from(schema.syncOutbox)
        .where(eq(schema.syncOutbox.entityId, entityId))
        .all()
        .some((r) => r.entityType === entityType)
      if (pending) return true
      if (entityType === 'topic') {
        return !!tx.select().from(schema.topics).where(eq(schema.topics.id, entityId)).get()
      }
      if (entityType === 'message') {
        return !!tx.select().from(schema.messages).where(eq(schema.messages.id, entityId)).get()
      }
      return !!tx.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, entityId)).get()
    } catch (e) {
      // Fail closed: propagate infrastructure failures to the enclosing tx
      // rollback; only a proven pre-005 missing sync table is a truthful miss.
      if (isTolerableMissingSyncTable(tx, e, MIGRATION_005_KEY)) return false
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  private tombstoneKey(entityType: string, entityId: string): string {
    if (entityType === 'topic') return `${TOMBSTONE_TOPIC_PREFIX}${entityId}`
    if (entityType === 'message_block') return `${TOMBSTONE_BLOCK_PREFIX}${entityId}`
    return `${TOMBSTONE_MESSAGE_PREFIX}${entityId}`
  }

  // Common deterministic LWW ordering: timestamp, then operation ID
  // (lexicographic). Single source of truth for entity clocks, outbox
  // candidates, and tombstone comparisons.
  private compareLww(aTimestamp: number, aId: string, bTimestamp: number, bId: string): number {
    if (aTimestamp !== bTimestamp) return aTimestamp < bTimestamp ? -1 : 1
    if (aId === bId) return 0
    return aId < bId ? -1 : 1
  }

  private formatTombstone(timestamp: number, operationId: string | null): string {
    if (operationId === null) return String(timestamp)
    return `${String(timestamp)}:${operationId}`
  }

  private parseTombstone(value: string | null | undefined): { timestamp: number; operationId: string | null } | null {
    // Absent row (no stored value) is the only null case. Any present-but-
    // malformed stored value throws fail-closed so it is never treated as
    // absence and never permits stale children past hard-delete containment.
    if (value === null || value === undefined) return null
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
      throw new SyncTombstoneError(`malformed tombstone value ${JSON.stringify(String(value)).slice(0, 80)}`)
    }
    const idx = value.indexOf(':')
    if (idx < 0) {
      // Canonical legacy timestamp-only form: non-negative safe integer with
      // no leading zeros, no whitespace, no trailing junk.
      if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new SyncTombstoneError(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
      }
      const ts = Number(value)
      if (!Number.isSafeInteger(ts)) {
        throw new SyncTombstoneError(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
      }
      // Legacy timestamp-only row: deterministic safe interpretation is
      // conservative — it wins equal-timestamp ties (suppresses) so an
      // upgrade can never resurrect data the old code suppressed.
      return { timestamp: ts, operationId: null }
    }
    const tsPart = value.slice(0, idx)
    const opPart = value.slice(idx + 1)
    // Canonical new form: `timestamp:non-empty-operationId` with exactly one
    // colon. Timestamp obeys the legacy canonical rules; operation ID obeys
    // the operation constraint (non-empty string) and must not contain a
    // colon so the stored form stays unambiguous.
    if (!/^(0|[1-9][0-9]*)$/.test(tsPart) || opPart.length === 0 || opPart.includes(':')) {
      throw new SyncTombstoneError(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
    }
    const ts = Number(tsPart)
    if (!Number.isSafeInteger(ts)) {
      throw new SyncTombstoneError(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
    }
    if (opPart.length > SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH) {
      throw new SyncTombstoneError(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
    }
    return { timestamp: ts, operationId: opPart }
  }

  // True when an incoming op with (opTimestamp, opId) loses to the tombstone
  // under LWW semantics: older loses; equal timestamp loses unless its
  // operation ID is strictly greater than the delete's ID. Legacy
  // timestamp-only tombstones suppress all equal-timestamp ops.
  private isSuppressedByTombstone(
    opTimestamp: number,
    opId: string,
    tomb: { timestamp: number; operationId: string | null }
  ): boolean {
    if (tomb.operationId === null) return opTimestamp <= tomb.timestamp
    if (opTimestamp !== tomb.timestamp) return opTimestamp < tomb.timestamp
    return opId <= tomb.operationId
  }

  private setTombstoneInDb(
    db: BetterSQLite3Database<typeof schema>,
    entityType: 'topic' | 'message' | 'message_block',
    entityId: string,
    timestamp: number,
    operationId: string | null
  ): void {
    // Fail closed on write inputs so a malformed value is never persisted.
    // Canonical operation-ID contract matches the parser and the shared wire
    // validator exactly: non-empty, colon-free, at most 256 characters.
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new SyncTombstoneError(`malformed tombstone timestamp ${String(timestamp).slice(0, 40)}`)
    }
    if (
      operationId !== null &&
      (typeof operationId !== 'string' ||
        operationId.length === 0 ||
        operationId.includes(':') ||
        operationId.length > SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH)
    ) {
      throw new SyncTombstoneError(
        `malformed tombstone operationId ${JSON.stringify(String(operationId)).slice(0, 80)}`
      )
    }
    const key = this.tombstoneKey(entityType, entityId)
    const existing = db.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get()
    if (!existing) {
      const value = this.formatTombstone(timestamp, operationId)
      db.insert(schema.syncState)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.syncState.key, set: { value } })
        .run()
      return
    }
    // Fail closed: only an absent row means absence. A present row with a
    // missing value is malformed (never silently overwritten) so the
    // enclosing outbox/apply transaction rolls back.
    if (existing.value === null || existing.value === undefined) {
      throw new SyncTombstoneError(`malformed tombstone value for ${entityType}/${entityId}: missing`)
    }
    // Fail closed: a malformed existing row throws here (never silently
    // overwritten) so the enclosing outbox/apply transaction rolls back.
    const parsed = this.parseTombstone(existing.value)
    if (parsed) {
      if (parsed.operationId === null || operationId === null) {
        // Any legacy side wins ties conservatively: keep the larger
        // timestamp; on equal timestamps keep the existing row so old
        // suppression is never weakened by an upgrade.
        if (parsed.timestamp >= timestamp) return
      } else {
        if (this.compareLww(timestamp, operationId, parsed.timestamp, parsed.operationId) <= 0) return
      }
    }
    const value = this.formatTombstone(timestamp, operationId)
    db.insert(schema.syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value } })
      .run()
  }

  // -------------------------------------------------------------------------
  // Per-field clocks + bounded conflict log (LOCK-PERSONAL-010)
  // -------------------------------------------------------------------------

  private getFieldClocksInDb(
    db: BetterSQLite3Database<typeof schema>,
    entityType: SyncOperation['entityType'],
    entityId: string
  ): Map<string, { timestamp: number; operationId: string }> {
    const out = new Map<string, { timestamp: number; operationId: string }>()
    try {
      const rows = db
        .select()
        .from(schema.syncFieldClock)
        .where(eq(schema.syncFieldClock.entityType, entityType))
        .all()
        .filter((r) => r.entityId === entityId)
      for (const r of rows) out.set(r.field, { timestamp: r.timestamp, operationId: r.operationId })
    } catch (e) {
      // Proven pre-006 compatibility ONLY (LOCK-PERSONAL-006): migration_state
      // on the same database must prove 006 never applied. Post-006 damage
      // (migration row present) propagates so the enclosing outbox/apply
      // transaction rolls back (fail closed, LOCK-PERSONAL-001/006).
      if (isTolerableMissingSyncTable(db, e, MIGRATION_006_KEY)) return out
      throw e instanceof Error ? e : new Error(String(e))
    }
    return out
  }

  /** Conditional per-field clock advance for payload intent fields (same tx). Fail closed except pre-006 missing table. */
  private updateFieldClocksInDb(
    db: BetterSQLite3Database<typeof schema>,
    entityType: SyncOperation['entityType'],
    entityId: string,
    payload: Record<string, unknown>,
    timestamp: number,
    operationId: string
  ): void {
    const clocked = clockedFieldsFor(entityType)
    // Read failure (other than a proven missing pre-006 table) throws above
    // and rolls back the enclosing transaction — never an empty-clock write.
    const existing = this.getFieldClocksInDb(db, entityType, entityId)
    for (const key of Object.keys(payload)) {
      if (!clocked.has(key)) continue
      const prior = existing.get(key)
      if (prior && this.compareLww(timestamp, operationId, prior.timestamp, prior.operationId) <= 0) continue
      try {
        db.insert(schema.syncFieldClock)
          .values({ entityType, entityId, field: key, timestamp, operationId })
          .onConflictDoUpdate({
            target: [schema.syncFieldClock.entityType, schema.syncFieldClock.entityId, schema.syncFieldClock.field],
            set: { timestamp, operationId }
          })
          .run()
      } catch (e) {
        // Proven pre-006 table absent only (migration_state proves 006 never
        // applied): skip silently (entity clock still governs). Post-006
        // damage propagates so the enclosing outbox/apply transaction rolls
        // back (LOCK-PERSONAL-001/006).
        if (isTolerableMissingSyncTable(db, e, MIGRATION_006_KEY)) continue
        throw e instanceof Error ? e : new Error(String(e))
      }
    }
  }

  private fieldValuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    try {
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    } catch {
      return false
    }
  }

  /**
   * Record a same-field loser with only allowlisted safe scalar values.
   * Bounded to SYNC_CONFLICT_LOG_MAX rows (oldest evicted). Fail closed
   * (LOCK-PERSONAL-010): any persistence or eviction failure throws so the
   * enclosing apply transaction rolls back — the incoming operation is left
   * unapplied (no sync_applied row, no clock advance) and the sync cycle
   * records a durable error without advancing the cursor. Conflict retention
   * must never silently disappear while the winner commits.
   */
  private recordConflictInDb(
    db: BetterSQLite3Database<typeof schema>,
    args: {
      entityType: string
      entityId: string
      field: string
      loserValue: unknown
      loserTimestamp: number
      loserOperationId: string
      winnerTimestamp: number
      winnerOperationId: string
    }
  ): void {
    // Safety: only clocked (allowlisted scalar) fields are ever recorded.
    // A non-clocked field carries no conflict record (not a failure).
    const clocked = clockedFieldsFor(args.entityType as SyncOperation['entityType'])
    if (!clocked.has(args.field)) return
    // Always valid bounded JSON (never throws): oversized or unserializable
    // values become a truncated structured record, never invalid JSON.
    const loserJson = this.toBoundedConflictJson(args.loserValue)
    db.insert(schema.syncConflictLog)
      .values({
        id: randomUUID(),
        entityType: args.entityType,
        entityId: args.entityId,
        field: args.field,
        loserValueJson: loserJson,
        loserTimestamp: args.loserTimestamp,
        loserOperationId: args.loserOperationId.slice(0, 256),
        winnerTimestamp: args.winnerTimestamp,
        winnerOperationId: args.winnerOperationId.slice(0, 256),
        createdAt: new Date().toISOString()
      })
      .onConflictDoNothing()
      .run()
    // Bounded cap: evict oldest beyond the fixed limit. Eviction failure
    // propagates (fail closed) rather than silently growing or dropping.
    const rows = db.select({ id: schema.syncConflictLog.id }).from(schema.syncConflictLog).all()
    if (rows.length > SYNC_CONFLICT_LOG_MAX) {
      const excess = rows.length - SYNC_CONFLICT_LOG_MAX
      const oldest = db
        .select()
        .from(schema.syncConflictLog)
        .orderBy(asc(schema.syncConflictLog.createdAt), asc(schema.syncConflictLog.id))
        .all()
        .slice(0, excess)
      for (const r of oldest) {
        db.delete(schema.syncConflictLog).where(eq(schema.syncConflictLog.id, r.id)).run()
      }
    }
  }

  /**
   * Valid bounded structured conflict value (LOCK-PERSONAL-010): always valid
   * JSON, with the FINAL serialized form bounded to maxLen characters AND
   * maxLen UTF-8 bytes. Short values keep their exact JSON form
   * (recovery-usable); oversized values become a truncated structured record
   * `{ truncated: true, preview }` so slicing can never emit invalid JSON and
   * escaping can never exceed the declared bound.
   */
  private toBoundedConflictJson(value: unknown, maxLen = 2000): string | null {
    let full: string | null = null
    try {
      full = JSON.stringify(value ?? null) ?? 'null'
    } catch {
      return this.toBoundedTruncatedRecord(String(value).slice(0, 1000), maxLen)
    }
    if (full.length <= maxLen && Buffer.byteLength(full, 'utf8') <= maxLen) return full
    return this.toBoundedTruncatedRecord(full, maxLen)
  }

  /**
   * Shrink a truncated `{ truncated: true, preview }` record until the FINAL
   * serialized JSON (after escaping) fits maxLen characters and bytes.
   * Preview carries only allowlisted scalar JSON text; structure stays valid.
   */
  private toBoundedTruncatedRecord(rawPreview: string, maxLen: number): string | null {
    let preview = rawPreview
    // Shrink the preview until the escaped serialized form fits. Halving
    // converges in O(log n) even for escaping-heavy values (quotes,
    // backslashes, CJK/emoji) where one preview char can cost up to 6 output
    // chars.
    for (let guard = 0; guard < 24; guard++) {
      let serialized: string
      try {
        serialized = JSON.stringify({ truncated: true, preview }) ?? '{"truncated":true,"preview":""}'
      } catch {
        preview = preview.slice(0, Math.floor(preview.length / 2))
        if (preview.length === 0) return JSON.stringify({ truncated: true, preview: 'unserializable' })
        continue
      }
      if (serialized.length <= maxLen && Buffer.byteLength(serialized, 'utf8') <= maxLen) return serialized
      if (preview.length === 0) return JSON.stringify({ truncated: true, preview: '' })
      preview = preview.slice(0, Math.max(0, Math.floor(preview.length / 2)))
    }
    return JSON.stringify({ truncated: true, preview: preview.slice(0, 64) })
  }

  private getTombstone(
    entityType: 'topic' | 'message' | 'message_block',
    entityId: string
  ): { timestamp: number; operationId: string | null } | null {
    // Fail closed: a read failure or a malformed stored value must propagate
    // (never interpreted as absence) so the caller transaction rolls back
    // and the operation is left unapplied with a durable sync failure.
    const db = this.getDb()
    const row = db
      .select()
      .from(schema.syncState)
      .where(eq(schema.syncState.key, this.tombstoneKey(entityType, entityId)))
      .get()
    if (!row) return null
    // A present row with a missing value is malformed, not absent.
    if (row.value === null || row.value === undefined) {
      throw new SyncTombstoneError(`malformed tombstone value for ${entityType}/${entityId}: missing`)
    }
    return this.parseTombstone(row.value)
  }

  /** True when the entity was ever tracked via clock or pending outbox (no row fallback). */
  isTrackedEntity(entityType: SyncOperation['entityType'], entityId: string): boolean {
    const db = this.getDb()
    try {
      const clock = db
        .select()
        .from(schema.syncEntityClock)
        .where(eq(schema.syncEntityClock.entityType, entityType))
        .all()
        .find((r) => r.entityId === entityId)
      if (clock) return true
      return db
        .select()
        .from(schema.syncOutbox)
        .where(eq(schema.syncOutbox.entityId, entityId))
        .all()
        .some((r) => r.entityType === entityType)
    } catch (e) {
      // Fail closed (LOCK-PERSONAL-001/006): hook callers record a durable
      // capture failure on throw instead of silently skipping. Only a proven
      // pre-005 missing sync table is a truthful miss.
      if (isTolerableMissingSyncTable(db, e, MIGRATION_005_KEY)) return false
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** True when the entity was ever observed locally (clock or pending outbox). Guards foreign destructive deletes. */
  isKnownEntity(entityType: SyncOperation['entityType'], entityId: string): boolean {
    const db = this.getDb()
    try {
      const clock = db
        .select()
        .from(schema.syncEntityClock)
        .where(eq(schema.syncEntityClock.entityType, entityType))
        .all()
        .find((r) => r.entityId === entityId)
      if (clock) return true
      const pending = db
        .select()
        .from(schema.syncOutbox)
        .where(eq(schema.syncOutbox.entityId, entityId))
        .all()
        .some((r) => r.entityType === entityType)
      if (pending) return true
      const applied = db.select().from(schema.syncApplied).all().length
      void applied
      // Fall back to current-row existence for pre-sync data (bounded: row
      // present means local ownership is plausible; row absent + no clock
      // means never seen -> do not emit destructive delete).
      if (entityType === 'topic') {
        return !!db.select().from(schema.topics).where(eq(schema.topics.id, entityId)).get()
      }
      if (entityType === 'message') {
        return !!db.select().from(schema.messages).where(eq(schema.messages.id, entityId)).get()
      }
      return !!db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, entityId)).get()
    } catch (e) {
      // Fail closed: propagate infrastructure failures so the hook records a
      // durable capture failure instead of silently skipping a delete. Only a
      // proven pre-005 missing sync table is a truthful miss.
      if (isTolerableMissingSyncTable(db, e, MIGRATION_005_KEY)) return false
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  recordUpsert(
    entityType: SyncOperation['entityType'],
    entityId: string,
    rawPayload: Record<string, unknown>,
    timestamp?: number
  ): SyncOperation | null {
    try {
      let payload: Record<string, unknown> | undefined
      if (entityType === 'topic') payload = filterTopicPayload(rawPayload) as Record<string, unknown>
      else if (entityType === 'message') payload = filterMessagePayload(rawPayload) as Record<string, unknown>
      else payload = filterBlockPayload(rawPayload) as Record<string, unknown>
      const op: SyncOperation = {
        id: randomUUID(),
        entityType,
        op: 'upsert',
        entityId,
        timestamp: timestamp ?? Date.now(),
        deviceId: this.getDeviceId(),
        payload
      }
      this.enqueueOperation(op)
      return op
    } catch (e) {
      logger.error('[recordUpsert] failed', e as Error)
      return null
    }
  }

  recordDelete(entityType: SyncOperation['entityType'], entityId: string, timestamp?: number): SyncOperation | null {
    try {
      const op: SyncOperation = {
        id: randomUUID(),
        entityType,
        op: 'delete',
        entityId,
        timestamp: timestamp ?? Date.now(),
        deviceId: this.getDeviceId()
      }
      this.enqueueOperation(op)
      return op
    } catch (e) {
      logger.error('[recordDelete] failed', e as Error)
      return null
    }
  }

  listOutbox(): SyncOperation[] {
    const db = this.getDb()
    const rows = db
      .select()
      .from(schema.syncOutbox)
      .orderBy(asc(schema.syncOutbox.timestamp), asc(schema.syncOutbox.id))
      .all()
    const mapped = rows.map((r) => ({
      id: r.id,
      entityType: r.entityType as SyncOperation['entityType'],
      op: r.op as SyncOperation['op'],
      entityId: r.entityId,
      timestamp: r.timestamp,
      deviceId: r.deviceId,
      payload: r.payloadJson ? (JSON.parse(r.payloadJson) as Record<string, unknown>) : undefined
    }))
    // Dependency order takes precedence over timestamps for the same drain:
    // parents before children so relay seq preserves topic < message < block
    // even when a child timestamp is earlier than its parent. Within the same
    // priority, timestamp then id order applies. LWW comparison semantics are
    // unchanged (shouldApplyIncoming still compares timestamps per entity).
    return mapped.sort((a, b) => {
      const pa = ENTITY_PUSH_PRIORITY[a.entityType] ?? 9
      const pb = ENTITY_PUSH_PRIORITY[b.entityType] ?? 9
      if (pa !== pb) return pa - pb
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
      return a.id.localeCompare(b.id)
    })
  }

  clearOutboxByIds(ids: string[]): void {
    if (ids.length === 0) return
    const db = this.getDb()
    for (const id of ids) {
      db.delete(schema.syncOutbox).where(eq(schema.syncOutbox.id, id)).run()
    }
  }

  /** Determine if incoming operation should win over local state (LWW). Checks both entity clock and pending outbox. */
  shouldApplyIncoming(incoming: SyncOperation): boolean {
    const db = this.getDb()
    const clockRow = db
      .select()
      .from(schema.syncEntityClock)
      .where(eq(schema.syncEntityClock.entityType, incoming.entityType))
      .all()
      .find((r) => r.entityId === incoming.entityId)
    if (clockRow) {
      return this.compareLww(incoming.timestamp, incoming.id, clockRow.timestamp, clockRow.operationId) > 0
    }
    // No clock row — check outbox for pending local op that is newer
    const outboxRows = db
      .select()
      .from(schema.syncOutbox)
      .where(eq(schema.syncOutbox.entityId, incoming.entityId))
      .all()
    const candidate = outboxRows
      .filter((r) => r.entityType === incoming.entityType)
      .sort((a, b) => {
        if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
        return b.id.localeCompare(a.id)
      })[0]
    if (candidate) {
      return this.compareLww(incoming.timestamp, incoming.id, candidate.timestamp, candidate.id) > 0
    }
    return true
  }

  applyIncomingOperation(op: SyncOperation): boolean {
    const db = this.getDb()
    const sqlite = this.getSqlite()

    const already = db.select().from(schema.syncApplied).where(eq(schema.syncApplied.operationId, op.id)).get()
    if (already) {
      logger.info(`[applyIncoming] duplicate ${op.id} skipped`)
      return false
    }

    // Defense-in-depth: validate before LWW so a malformed old operation
    // that loses LWW is rejected (throws) rather than being marked applied
    // as a silent LWW loss. Known-operation idempotence above is preserved.
    const strictErr = validateSyncOperationStrict(op as any)
    if (strictErr) {
      // Malformed: reject before persistence. Throw (not poison-ack) so the
      // pull loop records a truthful durable sync failure instead of silently
      // advancing the cursor or reporting success.
      logger.warn(`[applyIncoming] strict validation rejected ${op.id}: ${strictErr}`)
      throw new Error(`malformed sync operation ${op.id}: ${strictErr}`)
    }

    const allowErr = validateSyncPayloadAllowlist(op)
    if (allowErr) {
      logger.warn(`[applyIncoming] payload rejected ${op.id}: ${allowErr}`)
      throw new Error(`malformed sync operation ${op.id}: ${allowErr}`)
    }

    // Deletes stay entity-level LWW (delete/tombstone precedence). Upserts
    // merge per field: absent payload keys carry no intent and are preserved,
    // so an old full snapshot never wipes an independent newer patch field.
    if (op.op === 'delete' && !this.shouldApplyIncoming(op)) {
      db.transaction((tx) => {
        tx.insert(schema.syncApplied).values({ operationId: op.id, appliedAt: new Date().toISOString() }).run()
      })
      logger.info(`[applyIncoming] LWW rejected ${op.id} for ${op.entityType}/${op.entityId}`)
      return false
    }

    sqlite.exec('BEGIN IMMEDIATE')
    let appliedEntity = false
    try {
      if (op.op === 'upsert') {
        appliedEntity = this.applyUpsert(op)
      } else if (op.op === 'delete') {
        this.applyDelete(op)
        appliedEntity = true
      }
      // Advance the entity clock only when the mutation path won something:
      // per-field upserts advance conditionally inside applyUpsert; deletes
      // advance here. Orphan throws before here (no clock/applied advance).
      if (op.op === 'delete') {
        db.insert(schema.syncEntityClock)
          .values({ entityType: op.entityType, entityId: op.entityId, timestamp: op.timestamp, operationId: op.id })
          .onConflictDoUpdate({
            target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
            set: { timestamp: op.timestamp, operationId: op.id }
          })
          .run()
      } else if (appliedEntity) {
        const clockRow = db
          .select()
          .from(schema.syncEntityClock)
          .where(eq(schema.syncEntityClock.entityType, op.entityType))
          .all()
          .find((r) => r.entityId === op.entityId) as typeof schema.syncEntityClock.$inferSelect | undefined
        if (!clockRow || this.compareLww(op.timestamp, op.id, clockRow.timestamp, clockRow.operationId) > 0) {
          db.insert(schema.syncEntityClock)
            .values({ entityType: op.entityType, entityId: op.entityId, timestamp: op.timestamp, operationId: op.id })
            .onConflictDoUpdate({
              target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
              set: { timestamp: op.timestamp, operationId: op.id }
            })
            .run()
        }
      }
      db.insert(schema.syncApplied).values({ operationId: op.id, appliedAt: new Date().toISOString() }).run()
      sqlite.exec('COMMIT')
      return appliedEntity
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      if (e instanceof SyncOrphanError) {
        logger.warn(`[applyIncoming] orphan ${op.id} retryable: ${(e as Error).message}`)
        throw e
      }
      logger.error(`[applyIncoming] tx failed ${op.id}`, e as Error)
      throw e
    }
  }

  /**
   * Per-field LWW upsert (LOCK-PERSONAL-010): absent payload keys carry no
   * intent and are preserved; present keys win/lose per field against
   * sync_field_clock using timestamp + operationId tie-break. Same-field
   * losers are recorded with allowlisted safe values in the bounded conflict
   * log. Returns true when a row was created or at least one field won.
   */
  private applyUpsert(op: SyncOperation): boolean {
    const db = this.getDb()
    const nowIso = new Date().toISOString()
    const p = op.payload ?? {}
    if (op.entityType === 'topic') {
      const id = op.entityId
      // Fail closed on wrong metadata types so a malformed op never silently
      // drops metadata (strict validator already enforces; defense in depth).
      if (Object.prototype.hasOwnProperty.call(p, 'pinned')) {
        const v = p.pinned
        if (v !== undefined && v !== null && typeof v !== 'boolean') {
          throw new Error(`topic upsert invalid pinned for ${id}`)
        }
      }
      if (Object.prototype.hasOwnProperty.call(p, 'prompt')) {
        const v = p.prompt
        if (v !== undefined && v !== null && typeof v !== 'string') {
          throw new Error(`topic upsert invalid prompt for ${id}`)
        }
      }
      if (Object.prototype.hasOwnProperty.call(p, 'isNameManuallyEdited')) {
        const v = p.isNameManuallyEdited
        if (v !== undefined && v !== null && typeof v !== 'boolean') {
          throw new Error(`topic upsert invalid isNameManuallyEdited for ${id}`)
        }
      }
      // Own-tombstone delete-wins: a hard delete suppresses stale late
      // upserts for the same entity (deterministic LWW); a newer upsert may
      // still resurrect. Checked before any row mutation.
      const ownTopicTomb = this.getTombstone('topic', id)
      if (ownTopicTomb && this.isSuppressedByTombstone(op.timestamp, op.id, ownTopicTomb)) {
        logger.warn(`[applyUpsert] topic ${id} suppressed by own tombstone (delete-wins)`)
        return false
      }
      const existingTopic = db.select().from(schema.topics).where(eq(schema.topics.id, id)).get()
      let baseOverflow: Record<string, unknown> = {}
      if (existingTopic?.extra) {
        try {
          const parsed: unknown = JSON.parse(existingTopic.extra)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            baseOverflow = parsed as Record<string, unknown>
          } else if (parsed !== null) {
            throw new Error(`topic upsert malformed extra for ${id}`)
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes(`topic upsert`)) throw e
          throw new Error(`topic upsert malformed extra for ${id}`)
        }
      }
      const fieldClocks = this.getFieldClocksInDb(db, 'topic', id)
      const columnOf: Record<string, 'name' | 'assistantId' | 'createdAt' | 'updatedAt' | 'deletedAt'> = {
        name: 'name',
        assistantId: 'assistantId',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        deletedAt: 'deletedAt'
      }
      const currentOf = (field: string): unknown => {
        if (field in columnOf) {
          if (!existingTopic) return null
          return (existingTopic as unknown as Record<string, unknown>)[columnOf[field]] ?? null
        }
        return Object.prototype.hasOwnProperty.call(baseOverflow, field) ? baseOverflow[field] : null
      }
      if (!existingTopic) {
        // Create-union: no row — full insert from provided-or-default values.
        const name = (p.name as string | null) ?? null
        const assistantId = (p.assistantId as string | null) ?? null
        const createdAt = (p.createdAt as string | null) ?? nowIso
        const updatedAt = (p.updatedAt as string | null) ?? nowIso
        const deletedAt = (p.deletedAt as string | null) ?? null
        const mergedOverflow: Record<string, unknown> = { ...baseOverflow }
        for (const k of ['pinned', 'prompt', 'isNameManuallyEdited'] as const) {
          if (Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined) mergedOverflow[k] = p[k]
        }
        const extraValue = Object.keys(mergedOverflow).length > 0 ? JSON.stringify(mergedOverflow) : null
        db.insert(schema.topics)
          .values({ id, name, assistantId, createdAt, updatedAt, deletedAt, extra: extraValue })
          .onConflictDoNothing()
          .run()
        const provided: Record<string, unknown> = {}
        for (const k of Object.keys(p)) if (TOPIC_CLOCKED.has(k) && p[k] !== undefined) provided[k] = p[k]
        this.updateFieldClocksInDb(db, 'topic', id, provided, op.timestamp, op.id)
        return true
      }
      // Existing row: per-field contest only for present intent keys.
      const winners: Array<{ field: string; value: unknown }> = []
      for (const field of Object.keys(p)) {
        if (!TOPIC_CLOCKED.has(field)) continue
        const v = p[field]
        if (v === undefined) continue
        const incomingVal = (v ?? null) as unknown
        const prior = fieldClocks.get(field)
        if (!prior || this.compareLww(op.timestamp, op.id, prior.timestamp, prior.operationId) > 0) {
          const currentVal = currentOf(field)
          if (prior && !this.fieldValuesEqual(incomingVal, currentVal)) {
            this.recordConflictInDb(db, {
              entityType: 'topic',
              entityId: id,
              field,
              loserValue: currentVal,
              loserTimestamp: prior.timestamp,
              loserOperationId: prior.operationId,
              winnerTimestamp: op.timestamp,
              winnerOperationId: op.id
            })
          }
          winners.push({ field, value: incomingVal })
        } else {
          const currentVal = currentOf(field)
          if (!this.fieldValuesEqual(incomingVal, currentVal)) {
            this.recordConflictInDb(db, {
              entityType: 'topic',
              entityId: id,
              field,
              loserValue: incomingVal,
              loserTimestamp: op.timestamp,
              loserOperationId: op.id,
              winnerTimestamp: prior.timestamp,
              winnerOperationId: prior.operationId
            })
          }
        }
      }
      if (winners.length === 0) return false
      const colSet: Record<string, unknown> = {}
      const mergedOverflow: Record<string, unknown> = { ...baseOverflow }
      const wonPayload: Record<string, unknown> = {}
      for (const w of winners) {
        wonPayload[w.field] = p[w.field]
        if (w.field in columnOf) {
          colSet[columnOf[w.field]] = w.value
        } else {
          mergedOverflow[w.field] = w.value
        }
      }
      const extraValue = Object.keys(mergedOverflow).length > 0 ? JSON.stringify(mergedOverflow) : null
      db.update(schema.topics)
        .set({ ...colSet, extra: extraValue })
        .where(eq(schema.topics.id, id))
        .run()
      this.updateFieldClocksInDb(db, 'topic', id, wonPayload, op.timestamp, op.id)
      return true
    } else if (op.entityType === 'message') {
      const id = op.entityId
      const topicId = (p.topicId as string) ?? ''
      if (!topicId) throw new Error('message upsert missing topicId')
      // Hard-delete delete-wins for late descendants (LOCK-PERSONAL-007): when
      // the exact parent topic tombstone exists and the parent row is still
      // absent, the child must be consumed/suppressed even when its timestamp
      // is newer than the delete — it must neither resurrect a placeholder
      // parent nor stall as a retryable orphan. Explicit future recreation
      // must arrive as a parent topic creation operation first: when the
      // parent row exists (recreated), fall back to the common LWW comparator
      // (stale loses, newer wins). Unrelated missing parents (no exact
      // tombstone) remain retryable orphans via the placeholder path below.
      // Own-tombstone delete-wins for direct message deletes (same LWW rule
      // as topics; a newer upsert may still resurrect per the higher-ID test).
      const ownMsgTomb = this.getTombstone('message', id)
      if (ownMsgTomb && this.isSuppressedByTombstone(op.timestamp, op.id, ownMsgTomb)) {
        logger.warn(`[applyUpsert] message ${id} suppressed by own tombstone (delete-wins)`)
        return false
      }
      const topicTomb = this.getTombstone('topic', topicId)
      if (topicTomb !== null) {
        const topicRowForTomb = db.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get()
        if (!topicRowForTomb) {
          logger.warn(`[applyUpsert] message ${id} suppressed by topic tombstone ${topicId} (delete-wins)`)
          // Narrow containment: materialize an exact message tombstone for this
          // suppressed (never-local) message so a later stale block for the
          // same message is recognized and suppressed via its specific parent
          // tombstone. Identity inherits the topic tombstone (the delete), not
          // the stale op, so any block stale relative to the delete is covered.
          // Runs inside the caller's transaction: atomic with clock/applied.
          // Fail closed: materialization failure propagates so the suppressed
          // op is not marked applied and its entity clock does not advance.
          this.setTombstoneInDb(db, 'message', id, topicTomb.timestamp, topicTomb.operationId)
          return false
        }
        if (this.isSuppressedByTombstone(op.timestamp, op.id, topicTomb)) {
          logger.warn(`[applyUpsert] message ${id} suppressed by topic tombstone ${topicId}`)
          this.setTombstoneInDb(db, 'message', id, topicTomb.timestamp, topicTomb.operationId)
          return false
        }
      }
      const existingPre = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()
      if (existingPre && existingPre.topicId !== topicId) {
        // Immutable parent identity: never reparent an existing message.
        logger.warn(`[applyUpsert] message ${id} reparent ${existingPre.topicId} -> ${topicId} rejected`)
        return false
      }
      const topicRow = db.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get()
      if (!topicRow) {
        db.insert(schema.topics)
          .values({ id: topicId, name: null, createdAt: nowIso, updatedAt: nowIso })
          .onConflictDoNothing()
          .run()
      }
      const existing = existingPre ?? db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()
      const valOf = (v: unknown, fallback: null | number): unknown => {
        if (v === undefined) return fallback
        return (v ?? null) as unknown
      }
      if (!existing) {
        // Create-union: full insert from provided-or-default values.
        const role = (p.role as string | null) ?? null
        const content = (p.content as string | null) ?? null
        const status = (p.status as string | null) ?? null
        const askId = (p.askId as string | null) ?? null
        const model = (p.model as string | null) ?? null
        const modelId = (p.modelId as string | null) ?? null
        const assistantId = (p.assistantId as string | null) ?? null
        const createdAt = (p.createdAt as string | null) ?? nowIso
        const updatedAt = (p.updatedAt as string | null) ?? nowIso
        const rawSort = p.sortOrder as number | null | undefined
        const sortOrder = typeof rawSort === 'number' && Number.isFinite(rawSort) ? rawSort : 0
        const maxRow = db.select().from(schema.messages).where(eq(schema.messages.topicId, topicId)).all()
        const maxSort = maxRow.length > 0 ? Math.max(...maxRow.map((r) => r.sortOrder)) + 1 : sortOrder
        let insertSort = typeof sortOrder === 'number' ? sortOrder : maxSort
        if (maxRow.some((r) => r.sortOrder === insertSort)) insertSort = maxSort
        db.insert(schema.messages)
          .values({
            id,
            topicId,
            role,
            content,
            status,
            askId,
            model,
            modelId,
            assistantId,
            createdAt,
            updatedAt,
            sortOrder: insertSort,
            extra: null
          })
          .run()
        const provided: Record<string, unknown> = {}
        for (const k of Object.keys(p)) if (MESSAGE_CLOCKED.has(k) && p[k] !== undefined) provided[k] = p[k]
        this.updateFieldClocksInDb(db, 'message', id, provided, op.timestamp, op.id)
        return true
      }
      // Existing row: per-field contest for present intent keys only.
      const fieldClocksM = this.getFieldClocksInDb(db, 'message', id)
      const currentM = (field: string): unknown => {
        if (field === 'sortOrder') return (existing as unknown as Record<string, unknown>).sortOrder ?? 0
        return ((existing as unknown as Record<string, unknown>)[field] ?? null) as unknown
      }
      const winnersM: Array<{ field: string; value: unknown }> = []
      for (const field of Object.keys(p)) {
        if (!MESSAGE_CLOCKED.has(field)) continue
        const raw = p[field]
        if (raw === undefined) continue
        let incomingVal: unknown
        if (field === 'sortOrder') {
          incomingVal =
            typeof raw === 'number' && Number.isFinite(raw) ? (Number.isInteger(raw) ? raw : Math.trunc(raw)) : 0
        } else {
          incomingVal = valOf(raw, null)
        }
        const prior = fieldClocksM.get(field)
        if (!prior || this.compareLww(op.timestamp, op.id, prior.timestamp, prior.operationId) > 0) {
          const cur = currentM(field)
          if (prior && !this.fieldValuesEqual(incomingVal, cur)) {
            this.recordConflictInDb(db, {
              entityType: 'message',
              entityId: id,
              field,
              loserValue: cur,
              loserTimestamp: prior.timestamp,
              loserOperationId: prior.operationId,
              winnerTimestamp: op.timestamp,
              winnerOperationId: op.id
            })
          }
          winnersM.push({ field, value: incomingVal })
        } else {
          const cur = currentM(field)
          if (!this.fieldValuesEqual(incomingVal, cur)) {
            this.recordConflictInDb(db, {
              entityType: 'message',
              entityId: id,
              field,
              loserValue: incomingVal,
              loserTimestamp: op.timestamp,
              loserOperationId: op.id,
              winnerTimestamp: prior.timestamp,
              winnerOperationId: prior.operationId
            })
          }
        }
      }
      if (winnersM.length === 0) return false
      const setM: Record<string, unknown> = {}
      const wonM: Record<string, unknown> = {}
      for (const w of winnersM) {
        wonM[w.field] = p[w.field]
        setM[w.field] = w.value
      }
      db.update(schema.messages).set(setM).where(eq(schema.messages.id, id)).run()
      this.updateFieldClocksInDb(db, 'message', id, wonM, op.timestamp, op.id)
      return true
    } else if (op.entityType === 'message_block') {
      const id = op.entityId
      const messageId = (p.messageId as string) ?? ''
      if (!messageId) throw new Error('block upsert missing messageId')
      // Own-tombstone delete-wins for direct block deletes (LOCK-PERSONAL-007):
      // a late upsert at or below the delete loses; a newer upsert may still
      // resurrect per the higher-ID LWW rule. Checked before any row mutation.
      const ownBlockTomb = this.getTombstone('message_block', id)
      if (ownBlockTomb && this.isSuppressedByTombstone(op.timestamp, op.id, ownBlockTomb)) {
        logger.warn(`[applyUpsert] block ${id} suppressed by own tombstone (delete-wins)`)
        return false
      }
      // Hard-delete delete-wins for late descendants (LOCK-PERSONAL-007): when
      // the exact parent message tombstone exists and the parent row is still
      // absent, the child must be consumed/suppressed even when newer — never
      // stall as a retryable orphan. When the parent row exists (recreated),
      // fall back to the common LWW comparator.
      const msgTomb = this.getTombstone('message', messageId)
      if (msgTomb !== null) {
        const msgRowForTomb = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
        if (!msgRowForTomb) {
          logger.warn(`[applyUpsert] block ${id} suppressed by message tombstone ${messageId} (delete-wins)`)
          return false
        }
        if (this.isSuppressedByTombstone(op.timestamp, op.id, msgTomb)) {
          logger.warn(`[applyUpsert] block ${id} suppressed by message tombstone ${messageId}`)
          return false
        }
      }
      const msg = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
      if (!msg) {
        // Missing parent with no specific message tombstone is a retryable
        // orphan: defer until the parent arrives. Suppression requires exact
        // parent evidence (the message tombstone above); an unrelated topic
        // tombstone must never suppress this block (sync F3). Topic-cascade
        // positives are preserved because topic hard-delete records explicit
        // per-child message tombstones in applyDelete.
        throw new SyncOrphanError(`orphan block ${id} parent ${messageId} missing`)
      }
      const existingPreB = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, id)).get()
      if (existingPreB && existingPreB.messageId !== messageId) {
        logger.warn(`[applyUpsert] block ${id} reparent ${existingPreB.messageId} -> ${messageId} rejected`)
        return false
      }
      const existing =
        existingPreB ?? db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, id)).get()
      if (!existing) {
        const type = (p.type as string | null) ?? null
        const content = (p.content as string | null) ?? null
        const status = (p.status as string | null) ?? null
        const createdAt = (p.createdAt as string | null) ?? nowIso
        const updatedAt = (p.updatedAt as string | null) ?? nowIso
        const rawSortB = p.sortOrder as number | null | undefined
        const sortOrder = typeof rawSortB === 'number' && Number.isFinite(rawSortB) ? rawSortB : 0
        const siblings = db
          .select()
          .from(schema.messageBlocks)
          .where(eq(schema.messageBlocks.messageId, messageId))
          .all()
        const maxSort = siblings.length > 0 ? Math.max(...siblings.map((r) => r.sortOrder)) + 1 : sortOrder
        let insertSort = typeof sortOrder === 'number' ? sortOrder : maxSort
        if (siblings.some((r) => r.sortOrder === insertSort)) insertSort = maxSort
        db.insert(schema.messageBlocks)
          .values({ id, messageId, type, content, status, createdAt, updatedAt, sortOrder: insertSort, extra: null })
          .run()
        const provided: Record<string, unknown> = {}
        for (const k of Object.keys(p)) if (BLOCK_CLOCKED.has(k) && p[k] !== undefined) provided[k] = p[k]
        this.updateFieldClocksInDb(db, 'message_block', id, provided, op.timestamp, op.id)
        return true
      }
      const fieldClocksB = this.getFieldClocksInDb(db, 'message_block', id)
      const currentB = (field: string): unknown => {
        if (field === 'sortOrder') return (existing as unknown as Record<string, unknown>).sortOrder ?? 0
        return ((existing as unknown as Record<string, unknown>)[field] ?? null) as unknown
      }
      const winnersB: Array<{ field: string; value: unknown }> = []
      for (const field of Object.keys(p)) {
        if (!BLOCK_CLOCKED.has(field)) continue
        const raw = p[field]
        if (raw === undefined) continue
        const incomingVal: unknown =
          field === 'sortOrder'
            ? typeof raw === 'number' && Number.isFinite(raw)
              ? Number.isInteger(raw)
                ? raw
                : Math.trunc(raw)
              : 0
            : ((raw ?? null) as unknown)
        const prior = fieldClocksB.get(field)
        if (!prior || this.compareLww(op.timestamp, op.id, prior.timestamp, prior.operationId) > 0) {
          const cur = currentB(field)
          if (prior && !this.fieldValuesEqual(incomingVal, cur)) {
            this.recordConflictInDb(db, {
              entityType: 'message_block',
              entityId: id,
              field,
              loserValue: cur,
              loserTimestamp: prior.timestamp,
              loserOperationId: prior.operationId,
              winnerTimestamp: op.timestamp,
              winnerOperationId: op.id
            })
          }
          winnersB.push({ field, value: incomingVal })
        } else {
          const cur = currentB(field)
          if (!this.fieldValuesEqual(incomingVal, cur)) {
            this.recordConflictInDb(db, {
              entityType: 'message_block',
              entityId: id,
              field,
              loserValue: incomingVal,
              loserTimestamp: op.timestamp,
              loserOperationId: op.id,
              winnerTimestamp: prior.timestamp,
              winnerOperationId: prior.operationId
            })
          }
        }
      }
      if (winnersB.length === 0) return false
      const setB: Record<string, unknown> = {}
      const wonB: Record<string, unknown> = {}
      for (const w of winnersB) {
        wonB[w.field] = p[w.field]
        setB[w.field] = w.value
      }
      db.update(schema.messageBlocks).set(setB).where(eq(schema.messageBlocks.id, id)).run()
      this.updateFieldClocksInDb(db, 'message_block', id, wonB, op.timestamp, op.id)
      return true
    }
    return false
  }

  private applyDelete(op: SyncOperation): void {
    const db = this.getDb()
    if (op.entityType === 'topic') {
      // Collect child message ids before the FK cascade so their tombstones
      // survive the cascade and reject stale late blocks. Fail closed: any
      // collection or tombstone persistence failure propagates so the
      // caller's transaction rolls back (no clock/applied advance).
      const childMessageIds: string[] = db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.topicId, op.entityId))
        .all()
        .map((r) => r.id)
      db.delete(schema.topics).where(eq(schema.topics.id, op.entityId)).run()
      this.setTombstoneInDb(db, 'topic', op.entityId, op.timestamp, op.id)
      for (const mid of childMessageIds) {
        this.setTombstoneInDb(db, 'message', mid, op.timestamp, op.id)
      }
    } else if (op.entityType === 'message') {
      db.delete(schema.messages).where(eq(schema.messages.id, op.entityId)).run()
      this.setTombstoneInDb(db, 'message', op.entityId, op.timestamp, op.id)
    } else if (op.entityType === 'message_block') {
      db.delete(schema.messageBlocks).where(eq(schema.messageBlocks.id, op.entityId)).run()
      this.setTombstoneInDb(db, 'message_block', op.entityId, op.timestamp, op.id)
    }
  }

  private updateCursor(cursor: number): void {
    const db = this.getDb()
    db.insert(schema.syncState)
      .values({ key: STATE_CURSOR, value: String(cursor) })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: String(cursor) } })
      .run()
  }

  private updateLastSyncAt(iso: string): void {
    const db = this.getDb()
    db.insert(schema.syncState)
      .values({ key: STATE_LAST_SYNC_AT, value: iso })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: iso } })
      .run()
  }

  private updateLastError(err: string | null): void {
    const db = this.getDb()
    if (err === null) {
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_ERROR)).run()
    } else {
      db.insert(schema.syncState)
        .values({ key: STATE_LAST_ERROR, value: err.slice(0, 1000) })
        .onConflictDoUpdate({ target: schema.syncState.key, set: { value: err.slice(0, 1000) } })
        .run()
    }
  }

  async sync(): Promise<SyncStatus> {
    if (this.statusSyncing) throw new Error('sync already in progress')
    this.throwIfShutdown()
    // Initial config/preflight reads under the durable error-reporting
    // boundary (LOCK-PERSONAL-001/006/009): failures are logged and recorded
    // durably where the DB is available, then the original exception is
    // rethrown with no stale transport. A damaged DB keeps scoped logging +
    // rethrow (never swallowed).
    let cfg: SyncConfig
    try {
      cfg = this.getConfig()
      if (!cfg.enabled) throw new Error('sync is disabled')
      const endpointErr = validateEndpointUrl(cfg.endpoint)
      if (endpointErr) throw new Error(endpointErr)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn(`[sync] config preflight failed: ${msg.slice(0, 300)}`)
      try {
        this.updateLastError(`sync preflight failed: ${msg}`.slice(0, 1000))
      } catch {}
      if (e instanceof SyncConfigPreflightError) throw e
      throw new SyncConfigPreflightError(msg, { cause: e })
    }
    // Snapshot the config generation with the validated transport: every
    // subsequent transport and database commit re-checks it so a
    // disable/endpoint/token transition aborts the stale cycle before any
    // further stale-config work (LOCK-PERSONAL-001). An already-started
    // SQLite transaction finishes atomically; the stale check fires between
    // operations. Manual sync semantics are unchanged when no transition
    // occurs mid-flight.
    const syncGen = this.configGeneration
    this.statusSyncing = true
    try {
      // Preflight identity/outbox reads (LOCK-PERSONAL-006/009): failures
      // here must be durably visible where possible before rethrow — never a
      // silent escape, never a cursor advance, original error preserved. When
      // sync_state itself is damaged the lastError write fails and the
      // original error still propagates (existing fail-closed behavior).
      let deviceId: string
      try {
        deviceId = this.getDeviceId()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`sync preflight failed: ${msg}`.slice(0, 1000))
        } catch {}
        throw e instanceof Error ? e : new Error(String(e))
      }
      let deviceAuth: string | undefined
      try {
        deviceAuth = this.getDeviceAuth()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`sync preflight failed: ${msg}`.slice(0, 1000))
        } catch {}
        throw e instanceof Error ? e : new Error(String(e))
      }
      this.assertLocalTrustForSync(deviceId)
      const db = this.getDb()
      // Strict persisted cursor (LOCK-PERSONAL-001): malformed state records
      // a durable error and fails closed before any pull — never skip history.
      let cursor = 0
      try {
        const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).get()
        if (cursorRow) {
          if (cursorRow.value === null || cursorRow.value === undefined) {
            throw new SyncCursorError('malformed persisted cursor: missing value')
          }
          cursor = parseStrictCursor(cursorRow.value)
        }
      } catch (e) {
        if (isTolerableMissingSyncTable(db, e, MIGRATION_005_KEY)) {
          cursor = 0
        } else {
          const msg = e instanceof Error ? e.message : String(e)
          try {
            this.updateLastError(`persisted cursor invalid: ${msg}`.slice(0, 1000))
          } catch {}
          throw e instanceof Error ? e : new Error(String(e))
        }
      }

      // Push all outbox chunks — never advance pull cursor on push
      let outboxOps: SyncOperation[]
      try {
        outboxOps = this.listOutbox()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`sync preflight failed: ${msg}`.slice(0, 1000))
        } catch {}
        throw e instanceof Error ? e : new Error(String(e))
      }
      while (outboxOps.length > 0) {
        this.throwIfShutdown()
        this.throwIfStaleConfig(syncGen)
        const chunk = outboxOps.slice(0, SYNC_MAX_OPERATIONS_PER_PUSH)
        const chunkIds = new Set(chunk.map((o) => o.id))
        const pushReq: SyncPushRequest = { deviceId, operations: chunk }
        try {
          const pushRes = await this.pushWithShutdown(cfg.endpoint, cfg.token, pushReq, deviceAuth)
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
          // A relay-issued credential (founder bootstrap) must be durably
          // persisted before any success is reported. Persistence failure is
          // a sync failure: durable error + throw, outbox retained.
          if (pushRes.deviceAuth !== undefined) {
            try {
              this.persistIssuedDeviceAuth(pushRes.deviceAuth)
              deviceAuth = pushRes.deviceAuth
            } catch (persistErr) {
              const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr)
              this.updateLastError(`sync credential persistence failed: ${pmsg}`.slice(0, 1000))
              throw this.credentialPersistenceError(pushRes.deviceAuth, 'sync credential', persistErr)
            }
          }
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
          const acked = pushRes.acceptedIds ?? []
          // Sync F4: only clear IDs contained in the exact current chunk. An
          // ack for an operation outside this chunk (later outbox row or
          // unknown ID) is a faulty/malicious relay response: record it
          // durably and fail truthfully without clearing unrelated rows.
          const expected = acked.filter((id) => chunkIds.has(id))
          const unexpected = acked.filter((id) => !chunkIds.has(id))
          if (expected.length > 0) this.clearOutboxByIds(expected)
          if (unexpected.length > 0) {
            const msg =
              `push ack contained ${unexpected.length} unexpected id(s): ${unexpected.slice(0, 5).join(',')}`.slice(
                0,
                500
              )
            this.updateLastError(msg)
            throw new Error(msg)
          }
          // Push progress guard: a success response for a non-empty chunk
          // must acknowledge at least one valid in-chunk operation. An empty
          // ack would otherwise loop indefinitely on the same chunk. Fail
          // closed with a durable error: outbox retained, no pull, no success.
          if (expected.length === 0) {
            const msg = `push made no progress: relay accepted 0 of ${chunk.length} operation(s)`.slice(0, 500)
            this.updateLastError(msg)
            throw new Error(msg)
          }
        } catch (e) {
          if (e instanceof SyncShutdownError) throw e
          // A stale-config abort is never a transport failure: rethrow
          // without durable lastError writes (no post-transition status).
          if (e instanceof SyncStaleConfigError) throw e
          // Bootstrap lockout guard: persist a relay-issued credential
          // carried on the transport error before failing, so a rejected
          // founder bootstrap never strands the device without its credential.
          const issuedOnError = (e as { deviceAuth?: unknown })?.deviceAuth
          if (isValidSyncDeviceAuth(issuedOnError)) {
            try {
              this.persistIssuedDeviceAuth(issuedOnError)
              deviceAuth = issuedOnError
            } catch (persistErr) {
              const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr)
              this.throwIfShutdown()
              this.updateLastError(`sync credential persistence failed: ${pmsg}`.slice(0, 1000))
              throw this.credentialPersistenceError(issuedOnError, 'sync credential', persistErr)
            }
          }
          const msg = e instanceof Error ? e.message : String(e)
          this.throwIfShutdown()
          this.updateLastError(msg)
          throw e
        }
        this.throwIfShutdown()
        this.throwIfStaleConfig(syncGen)
        outboxOps = this.listOutbox()
        // Break after one chunk if we had limit? but keep looping until drained — guards large outbox
        if (outboxOps.length === 0) break
      }

      // Pull loop — page until exhausted. Two cursors: fetchCursor pages the
      // relay stream (last seq returned); commitCursor is the durable
      // contiguous cursor (never skips an unresolved gap). An orphan in an
      // early page is buffered in-memory and retried as later pages arrive;
      // a later-page parent resolves it without starvation. Applied later
      // entries stay applied (idempotent replay); commitCursor never jumps a
      // gap. Unresolved orphans after the stream end as a durable blocked
      // error with no success timestamp.
      let fetchCursor = cursor
      let commitCursor = cursor
      let pagingDone = false
      let pullError: unknown = null
      let applyError: unknown = null
      const resolved = new Map<number, boolean>()
      const deferred: Array<{ op: any; seq: number }> = []
      const seenSeq = new Set<number>()
      const markOwnEcho = (op: any): void => {
        const already = db.select().from(schema.syncApplied).where(eq(schema.syncApplied.operationId, op.id)).get()
        if (!already) {
          db.insert(schema.syncApplied).values({ operationId: op.id, appliedAt: new Date().toISOString() }).run()
        }
        if (typeof op.seq === 'number') resolved.set(op.seq, true)
      }
      const tryApplyDeferred = (): unknown => {
        if (deferred.length === 0) return null
        const still: typeof deferred = []
        let failed: unknown = null
        for (const entry of deferred) {
          try {
            this.applyIncomingOperation(entry.op as SyncOperation)
            resolved.set(entry.seq, true)
          } catch (inner) {
            if (inner instanceof SyncOrphanError) {
              still.push(entry)
            } else {
              failed = inner
              // Keep unprocessed remainder buffered
              const idx = deferred.indexOf(entry)
              for (let k = idx + 1; k < deferred.length; k++) still.push(deferred[k])
              deferred.length = 0
              deferred.push(...still)
              return failed
            }
          }
        }
        deferred.length = 0
        deferred.push(...still)
        return null
      }
      while (!pagingDone) {
        this.throwIfShutdown()
        this.throwIfStaleConfig(syncGen)
        let pullRes: { operations: any[]; cursor: number; deviceAuth?: string }
        try {
          pullRes = await this.pullWithShutdown(cfg.endpoint, cfg.token, fetchCursor, deviceId, deviceAuth)
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
          if (pullRes.deviceAuth !== undefined) {
            try {
              this.persistIssuedDeviceAuth(pullRes.deviceAuth)
              deviceAuth = pullRes.deviceAuth
            } catch (persistErr) {
              const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr)
              pullError = persistErr
              this.updateLastError(`sync credential persistence failed: ${pmsg}`.slice(0, 1000))
              throw this.credentialPersistenceError(pullRes.deviceAuth, 'sync credential', persistErr)
            }
          }
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
        } catch (e) {
          if (e instanceof SyncShutdownError) throw e
          if (e instanceof SyncStaleConfigError) throw e
          const issuedOnError = (e as { deviceAuth?: unknown })?.deviceAuth
          if (isValidSyncDeviceAuth(issuedOnError)) {
            try {
              this.persistIssuedDeviceAuth(issuedOnError)
              deviceAuth = issuedOnError
            } catch (persistErr) {
              const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr)
              pullError = persistErr
              this.updateLastError(`sync credential persistence failed: ${pmsg}`.slice(0, 1000))
              throw this.credentialPersistenceError(issuedOnError, 'sync credential', persistErr)
            }
          }
          pullError = e
          const msg = e instanceof Error ? e.message : String(e)
          this.updateLastError(msg)
          throw e
        }
        const ops = pullRes.operations ?? []
        // Defense-in-depth contiguous framing at the service boundary (covers
        // mocked/bypassed clients): each op seq must equal fetchCursor +
        // position, and response cursor must equal last seq. Gaps reject
        // before any application or fetch-cursor advance.
        try {
          this.assertContiguousPull(fetchCursor, pullRes as { operations: Array<{ seq?: unknown }>; cursor: number })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          pullError = e
          applyError = e
          this.updateLastError(msg.slice(0, 1000))
          throw e
        }
        if (ops.length === 0) {
          pagingDone = true
          break
        }
        let failedNonOrphan: unknown = null
        for (const op of ops) {
          if (typeof op.seq === 'number') {
            if (seenSeq.has(op.seq)) continue
            seenSeq.add(op.seq)
          }
          if (op.deviceId === deviceId) {
            markOwnEcho(op)
            continue
          }
          try {
            this.applyIncomingOperation(op as SyncOperation)
            if (typeof op.seq === 'number') resolved.set(op.seq, true)
          } catch (inner) {
            if (inner instanceof SyncOrphanError) {
              if (typeof op.seq === 'number') {
                if (deferred.length >= MAX_DEFERRED_ORPHANS) {
                  logger.error(`[sync] orphan budget exceeded (${MAX_DEFERRED_ORPHANS}), fail closed`)
                  failedNonOrphan = new SyncOrphanError(
                    `orphan budget exceeded: ${MAX_DEFERRED_ORPHANS} buffered (e.g. ${String(op.id).slice(0, 80)})`.slice(
                      0,
                      500
                    )
                  )
                  break
                }
                logger.warn(`[sync] orphan ${op.id} buffered for later-page retry`)
                deferred.push({ op, seq: op.seq })
              }
              continue
            }
            logger.error(`[sync] apply ${op.id} failed`, inner as Error)
            failedNonOrphan = inner
            break
          }
        }
        // A later parent in this page (or any buffered parent) may resolve
        // earlier orphans — retry the cross-page buffer after every page.
        if (!failedNonOrphan) {
          // In-page second pass then cross-page buffer retry
          failedNonOrphan = tryApplyDeferred()
        }
        if (failedNonOrphan) {
          const msg = failedNonOrphan instanceof Error ? failedNonOrphan.message : String(failedNonOrphan)
          applyError = failedNonOrphan
          this.updateLastError(`apply failed: ${msg}`.slice(0, 1000))
          this.throwIfStaleConfig(syncGen)
          const contiguous = this.contiguousCursor(
            commitCursor,
            [...seenSeq].sort((a, b) => a - b),
            resolved
          )
          if (contiguous > commitCursor) {
            this.updateCursor(contiguous)
            commitCursor = contiguous
          }
          pagingDone = true
          break
        }
        // Advance the durable cursor only contiguously; page on via the
        // relay fetch cursor (last seq returned) so later pages still arrive.
        this.throwIfStaleConfig(syncGen)
        const contiguous = this.contiguousCursor(
          commitCursor,
          [...seenSeq].sort((a, b) => a - b),
          resolved
        )
        if (contiguous > commitCursor) {
          this.updateCursor(contiguous)
          commitCursor = contiguous
        }
        const lastSeq =
          ops.length > 0 && typeof ops[ops.length - 1].seq === 'number' ? ops[ops.length - 1].seq : fetchCursor
        fetchCursor = Math.max(fetchCursor, lastSeq)
        if (ops.length < SYNC_MAX_OPERATIONS_PER_PULL) {
          pagingDone = true
        }
      }
      // Final retry of buffered orphans against the full traversed stream.
      if (!pullError && !applyError && deferred.length > 0) {
        this.throwIfStaleConfig(syncGen)
        const failed = tryApplyDeferred()
        if (failed) {
          const msg = failed instanceof Error ? failed.message : String(failed)
          applyError = failed
          this.updateLastError(`apply failed: ${msg}`.slice(0, 1000))
        } else if (deferred.length > 0) {
          const ids = deferred.map((d) => String(d.op?.id ?? d.seq)).join(',')
          applyError = new SyncOrphanError(`orphan blocked: ${ids}`.slice(0, 500))
          this.updateLastError(`sync blocked: ${deferred.length} orphan operation(s) unresolved`.slice(0, 1000))
        }
        this.throwIfStaleConfig(syncGen)
        const contiguous = this.contiguousCursor(
          commitCursor,
          [...seenSeq].sort((a, b) => a - b),
          resolved
        )
        if (contiguous > commitCursor) {
          this.updateCursor(contiguous)
          commitCursor = contiguous
        }
      }
      this.throwIfShutdown()
      this.throwIfStaleConfig(syncGen)
      if (!pullError && !applyError) {
        // F-008 fail-closed ordering: durable trust + credential persistence
        // complete BEFORE the success timestamp is written. Any persistence
        // failure records a durable error and rejects — never a success
        // status with unpersisted trust.
        try {
          this.recordBootstrapTrust(deviceId)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          try {
            this.updateLastError(`sync trust persistence failed: ${msg}`.slice(0, 1000))
          } catch {}
          throw new Error(`sync trust persistence failed: ${msg}`.slice(0, 1000))
        }
        this.updateLastSyncAt(new Date().toISOString())
        // Ordinary transport/reconciliation success clears lastError only.
        // A durable capture failure (lastCaptureError) is never cleared here;
        // it remains user-visible via getStatus until the next successful
        // stable capture path (explicit clear API may follow in later work).
        this.updateLastError(null)
      }
      // Sync F2: a durable pull/apply/orphan failure must never report
      // success. Status remains inspectable via getStatus (cursor + lastError
      // already persisted above); reject here so IPC/renderer observe failure
      // instead of a normal status. ChatDb envelopes are untouched.
      if (applyError) {
        throw applyError instanceof Error ? applyError : new Error(String(applyError))
      }
      return this.getStatus()
    } finally {
      this.statusSyncing = false
    }
  }

  /**
   * Contiguous pull framing (LOCK-PERSONAL-001): strict client + relay cursor
   * contract. Request cursor, response cursor, and every op seq must be
   * canonical non-negative safe integers; string forms are parsed strictly
   * (no `12junk`, no leading zeros). Ops must be exactly fetchCursor+1 ...
   * fetchCursor+n and response cursor must equal last seq.
   */
  private assertContiguousPull(
    fetchCursor: number,
    pullRes: { operations: Array<{ seq?: unknown }>; cursor: unknown }
  ): void {
    // Strict client request cursor: never advance from a malformed base.
    if (!Number.isSafeInteger(fetchCursor) || fetchCursor < 0) {
      throw new SyncCursorError(`malformed client cursor ${JSON.stringify(String(fetchCursor)).slice(0, 80)}`)
    }
    // Strict relay response cursor: canonical form only, never reinterpreted.
    const relayCursor: unknown = pullRes.cursor
    if (typeof relayCursor === 'string') {
      parseStrictCursor(relayCursor)
    } else if (typeof relayCursor !== 'number' || !Number.isSafeInteger(relayCursor) || relayCursor < 0) {
      throw new SyncCursorError(`malformed relay cursor ${JSON.stringify(String(relayCursor)).slice(0, 80)}`)
    }
    const ops = pullRes.operations ?? []
    if (ops.length === 0) {
      if (pullRes.cursor !== fetchCursor) {
        throw new Error(
          `pull response malformed: empty-page cursor ${String(pullRes.cursor)} must equal request cursor ${String(fetchCursor)}`
        )
      }
      return
    }
    for (let i = 0; i < ops.length; i++) {
      const seq: unknown = (ops[i] as { seq?: unknown })?.seq
      const expected = fetchCursor + i + 1
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq !== expected) {
        throw new Error(
          `pull response non-contiguous: expected seq ${String(expected)} at position ${String(i)} but got ${String(seq)} (request cursor ${String(fetchCursor)})`
        )
      }
    }
    const lastSeq = (ops[ops.length - 1] as { seq?: unknown }).seq as number
    if (pullRes.cursor !== lastSeq) {
      throw new Error(
        `pull response malformed: cursor ${String(pullRes.cursor)} must equal last seq ${String(lastSeq)}`
      )
    }
  }

  /** Contiguous cursor: largest seq such that every seq in (current, candidate] resolved. */
  private contiguousCursor(
    currentCursor: number,
    ops: Array<{ seq?: unknown }> | number[],
    resolved: Map<number, boolean>
  ): number {
    const seqs = (
      Array.isArray(ops) && ops.length > 0 && typeof ops[0] === 'number'
        ? (ops as number[]).slice()
        : (ops as Array<{ seq?: unknown }>)
            .map((o) => (typeof o.seq === 'number' ? o.seq : null))
            .filter((s): s is number => s !== null)
    ).sort((a, b) => a - b)
    let c = currentCursor
    for (const s of seqs) {
      if (s <= c) continue
      if (s === c + 1 && resolved.get(s)) {
        c = s
        continue
      }
      // Gap or unresolved: if seqs are dense from relay, any missing
      // resolved entry stops advancement. Allow jumping only over seqs that
      // were never returned? No — seqs are exactly the returned page, so stop.
      if (s > c + 1) {
        // Check whether all intermediate (c, s) resolved; they are not in page
        // only if page is non-dense (should not happen). Stop to avoid skip.
        break
      }
      break
    }
    return c
  }

  /**
   * Shutdown-aware push/pull wrappers: the relay fetch aborts synchronously
   * on beginShutdown() via a linked AbortController. Shutdown surfaces as
   * SyncShutdownError without durable lastError writes (no post-close DB).
   */
  private async pushWithShutdown(
    endpoint: string,
    token: string | undefined,
    req: SyncPushRequest,
    deviceAuth?: string
  ): Promise<{ cursor: number; acceptedIds: string[]; deviceAuth?: string }> {
    const controller = new AbortController()
    const untrack = this.trackFetchController(controller)
    try {
      return await syncClient.push(endpoint, token, req, controller.signal, deviceAuth)
    } catch (e) {
      if (this.shutdownRequested || (e as Error)?.name === 'AbortError') {
        try {
          ;(e as Error).name
        } catch {}
        if (this.shutdownRequested) throw new SyncShutdownError()
      }
      throw e
    } finally {
      untrack()
    }
  }

  private async pullWithShutdown(
    endpoint: string,
    token: string | undefined,
    cursor: number,
    deviceId: string,
    deviceAuth?: string
  ): Promise<{ operations: any[]; cursor: number; deviceAuth?: string }> {
    const controller = new AbortController()
    const untrack = this.trackFetchController(controller)
    try {
      return (await syncClient.pull(endpoint, token, cursor, deviceId, controller.signal, deviceAuth)) as unknown as {
        operations: any[]
        cursor: number
        deviceAuth?: string
      }
    } catch (e) {
      if (this.shutdownRequested) throw new SyncShutdownError()
      throw e
    } finally {
      untrack()
    }
  }

  /**
   * Per-device relay credential (F-001): issued once by the relay at founder
   * bootstrap or pairing-request, persisted in config alongside the token,
   * and presented on every device-authenticated call. Never logged.
   * Returns undefined when no credential was ever issued (pre-bootstrap).
   * A present-but-malformed value fails closed.
   */
  getDeviceAuth(): string | undefined {
    let raw: unknown
    try {
      raw = configManager.get(STATE_DEVICE_AUTH as never, undefined as never)
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync device auth config read failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    if (raw === undefined || raw === null || raw === '') return undefined
    if (!isValidSyncDeviceAuth(raw)) {
      throw new SyncDeviceIdentityError('sync device auth config malformed: present value is not a valid credential')
    }
    return raw
  }

  private persistDeviceAuth(secret: string): void {
    if (!isValidSyncDeviceAuth(secret)) throw new SyncDeviceIdentityError('sync device auth response malformed')
    try {
      configManager.set(STATE_DEVICE_AUTH as never, secret as never)
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync device auth persistence failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
  }

  /** Persist a relay-issued credential when present; fail closed on write error. */
  private persistIssuedDeviceAuth(issued: string | undefined): void {
    if (issued === undefined) return
    this.persistDeviceAuth(issued)
  }

  /**
   * Recoverable credential-persistence failure (F-001): the plaintext
   * credential travels only on the error object (`deviceAuth`), never in
   * the message text or logs. Callers/retries can extract it via
   * `(e as { deviceAuth?: unknown }).deviceAuth` and re-attempt persistence,
   * so a local store failure never silently drops a relay-issued secret.
   */
  private credentialPersistenceError(issued: string, context: string, cause: unknown): Error {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const err = new Error(`${context}: sync device auth persistence failed: ${detail}`.slice(0, 1000))
    ;(err as { deviceAuth?: string }).deviceAuth = issued
    if (cause instanceof Error) {
      try {
        ;(err as { cause?: unknown }).cause = cause
      } catch {}
    }
    return err
  }

  // -------------------------------------------------------------------------
  // Device pairing + durable trust (explicit user action, restart-persistent)
  // -------------------------------------------------------------------------

  listTrustedDevices(): SyncTrustedDevice[] {
    const db = this.getDb()
    try {
      const rows = db.select().from(schema.syncTrustedDevices).all()
      return rows.map((r) => ({
        deviceId: r.deviceId,
        deviceName: r.deviceName ?? undefined,
        trustedAt: r.trustedAt ?? new Date(0).toISOString(),
        source: r.source ?? 'unknown'
      }))
    } catch (e) {
      if (isTolerableMissingSyncTable(db, e, MIGRATION_007_KEY)) return []
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  isDeviceTrusted(deviceId: string): boolean {
    if (!isValidSyncDeviceId(deviceId)) return false
    try {
      return this.listTrustedDevices().some((d) => d.deviceId === deviceId)
    } catch {
      return false
    }
  }

  private upsertTrustedDevice(device: SyncTrustedDevice): void {
    const db = this.getDb()
    try {
      db.insert(schema.syncTrustedDevices)
        .values({
          deviceId: device.deviceId,
          deviceName: device.deviceName ?? null,
          trustedAt: device.trustedAt,
          source: device.source
        })
        .onConflictDoUpdate({
          target: schema.syncTrustedDevices.deviceId,
          set: { deviceName: device.deviceName ?? null, trustedAt: device.trustedAt, source: device.source }
        })
        .run()
    } catch (e) {
      if (isTolerableMissingSyncTable(db, e, MIGRATION_007_KEY)) {
        throw new SyncDeviceIdentityError('sync pairing trust store unavailable: migration 007 not applied')
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  private removeTrustedDeviceRow(deviceId: string): void {
    const db = this.getDb()
    try {
      db.delete(schema.syncTrustedDevices).where(eq(schema.syncTrustedDevices.deviceId, deviceId)).run()
    } catch (e) {
      if (isTolerableMissingSyncTable(db, e, MIGRATION_007_KEY)) {
        throw new SyncDeviceIdentityError('sync pairing trust store unavailable: migration 007 not applied')
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  private pairingTransport(): { endpoint: string; token: string | undefined } {
    const cfg = this.getConfig()
    const endpointErr = validateEndpointUrl(cfg.endpoint)
    if (endpointErr) throw new Error(endpointErr)
    return { endpoint: cfg.endpoint, token: cfg.token }
  }

  async createPairingInvite(): Promise<{ code: string; expiresAt: string }> {
    const { endpoint, token } = this.pairingTransport()
    const deviceId = this.getDeviceId()
    const deviceAuth = this.getDeviceAuth()
    let res: { code: string; expiresAt: string; deviceAuth?: string }
    try {
      res = await syncClient.createInvite(endpoint, token, deviceId, deviceAuth)
    } catch (e) {
      // F-001 production-path recovery: a relay error that still issues the
      // founder credential carries it on the error object (never in the
      // message). Persist the validated credential before rethrowing so a
      // bootstrap-adjacent invite failure never strands the device without
      // its credential. Persistence failure fails closed with a recoverable
      // carrier error; the original transport error is otherwise rethrown
      // unchanged (already redacted by SyncClient).
      const issuedOnError = (e as { deviceAuth?: unknown })?.deviceAuth
      if (isValidSyncDeviceAuth(issuedOnError)) {
        try {
          this.persistIssuedDeviceAuth(issuedOnError)
        } catch (persistErr) {
          const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr)
          try {
            this.updateLastError(`pairing invite credential persistence failed: ${pmsg}`.slice(0, 1000))
          } catch {}
          throw this.credentialPersistenceError(issuedOnError, 'pairing invite credential', persistErr)
        }
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
    // Founder issuance: persist the relay credential before reporting
    // success; a persistence failure fails closed (throw, no success).
    if (res.deviceAuth !== undefined) {
      try {
        this.persistIssuedDeviceAuth(res.deviceAuth)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`pairing invite credential persistence failed: ${msg}`.slice(0, 1000))
        } catch {}
        throw this.credentialPersistenceError(res.deviceAuth, 'pairing invite credential', e)
      }
    }
    logger.info('[createPairingInvite] invite created')
    return { code: res.code, expiresAt: res.expiresAt }
  }

  async requestPairing(code: string, deviceName?: string): Promise<{ requestId: string; status: string }> {
    const codeErr = validatePairingCode(code)
    if (codeErr) throw new Error(codeErr)
    const nameErr = validateSyncDeviceName(deviceName ?? undefined)
    if (nameErr) throw new Error(nameErr)
    const { endpoint, token } = this.pairingTransport()
    const deviceId = this.getDeviceId()
    let res: { requestId: string; status: string; deviceAuth: string }
    try {
      res = await syncClient.requestPairing(endpoint, token, {
        deviceId,
        deviceName,
        code: normalizePairingCode(code)
      })
    } catch (e) {
      // F-001 production-path recovery: same issued-credential-on-error
      // contract as createPairingInvite. Persist the validated joiner
      // credential before rethrowing so a bootstrap-adjacent request failure
      // never strands the device. Persistence failure fails closed with a
      // recoverable carrier error; otherwise rethrow the redacted error.
      const issuedOnError = (e as { deviceAuth?: unknown })?.deviceAuth
      if (isValidSyncDeviceAuth(issuedOnError)) {
        try {
          this.persistIssuedDeviceAuth(issuedOnError)
        } catch (persistErr) {
          const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr)
          try {
            this.updateLastError(`pairing request credential persistence failed: ${pmsg}`.slice(0, 1000))
          } catch {}
          throw this.credentialPersistenceError(issuedOnError, 'pairing request credential', persistErr)
        }
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
    // The relay credential is the joiner's only proof of identity for all
    // later push/pull calls: persist before reporting success. Failure fails
    // closed (durable lastError + throw) so the caller never believes the
    // request succeeded without holding the credential.
    try {
      this.persistIssuedDeviceAuth(res.deviceAuth)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.updateLastError(`pairing request credential persistence failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw this.credentialPersistenceError(res.deviceAuth, 'pairing request credential', e)
    }
    logger.info('[requestPairing] request submitted')
    return { requestId: res.requestId, status: res.status }
  }

  async listPairingRequests(): Promise<SyncPairingRequest[]> {
    const { endpoint, token } = this.pairingTransport()
    const deviceId = this.getDeviceId()
    const deviceAuth = this.getDeviceAuth()
    const res = await syncClient.listPending(endpoint, token, deviceId, deviceAuth)
    return res.requests
  }

  async acceptPairing(requestId: string): Promise<SyncTrustedDevice> {
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('request id invalid')
    const { endpoint, token } = this.pairingTransport()
    const approverDeviceId = this.getDeviceId()
    const deviceAuth = this.getDeviceAuth()
    const res = await syncClient.acceptPairing(endpoint, token, { approverDeviceId, requestId }, deviceAuth)
    if (!isValidSyncDeviceId(res.trusted?.deviceId)) throw new Error('accept response malformed')
    // F-003 atomic trust mirror: peer + self rows commit in one SQLite
    // transaction (existing BEGIN IMMEDIATE/COMMIT pattern). Any write
    // failure rolls back the whole batch and propagates — never a partial
    // mirror (peer without self or vice versa).
    const sqlite = this.getSqlite()
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      this.upsertTrustedDevice({
        deviceId: res.trusted.deviceId,
        deviceName: res.trusted.deviceName,
        trustedAt: res.trusted.trustedAt ?? new Date().toISOString(),
        source: 'pairing-accept'
      })
      // The approver itself is a trusted member; ensure self is mirrored locally
      // so restart persistence holds on both sides of the trust relation.
      this.upsertTrustedDevice({
        deviceId: approverDeviceId,
        trustedAt: new Date().toISOString(),
        source: 'pairing-accept-self'
      })
      sqlite.exec('COMMIT')
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
    logger.info('[acceptPairing] request accepted')
    return res.trusted
  }

  async rejectPairing(requestId: string): Promise<void> {
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('request id invalid')
    const { endpoint, token } = this.pairingTransport()
    const approverDeviceId = this.getDeviceId()
    const deviceAuth = this.getDeviceAuth()
    await syncClient.rejectPairing(endpoint, token, { approverDeviceId, requestId }, deviceAuth)
    logger.info('[rejectPairing] request rejected')
  }

  async refreshTrustedDevices(): Promise<SyncTrustedDevice[]> {
    const { endpoint, token } = this.pairingTransport()
    const deviceId = this.getDeviceId()
    const deviceAuth = this.getDeviceAuth()
    const res = await syncClient.listTrusted(endpoint, token, deviceId, deviceAuth)
    // F-003 atomic trust mirror: the whole refresh batch commits in one
    // SQLite transaction. Any row-write failure rolls back the batch and
    // propagates — never a partially refreshed mirror.
    const validDevices = res.devices.filter((d) => isValidSyncDeviceId(d?.deviceId))
    const sqlite = this.getSqlite()
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      for (const d of validDevices) {
        this.upsertTrustedDevice({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          trustedAt: d.trustedAt ?? new Date().toISOString(),
          source: d.source ?? 'relay-refresh'
        })
      }
      sqlite.exec('COMMIT')
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
    return this.listTrustedDevices()
  }

  async getPairingStatus(): Promise<SyncPairingStatus> {
    const { endpoint, token } = this.pairingTransport()
    const deviceId = this.getDeviceId()
    const status = await syncClient.getPairingStatus(endpoint, token, deviceId)
    if (status.trusted) {
      // Requester learns acceptance: mirror self + relay list locally so
      // restart retains trust without another explicit action. AUD-003: the
      // local trust-mirror refresh is the persistence confirmation — its
      // failure must propagate (fail closed) with the real error durably
      // recorded, never a trusted=true success.
      try {
        await this.refreshTrustedDevices()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`pairing status trust refresh failed: ${msg}`.slice(0, 1000))
        } catch {}
        logger.error(`[getPairingStatus] trusted refresh failed: ${msg.slice(0, 200)}`)
        throw e instanceof Error ? e : new Error(String(e))
      }
    }
    return status
  }

  async revokeTrustedDevice(targetDeviceId: string): Promise<void> {
    if (!isValidSyncDeviceId(targetDeviceId)) throw new Error('device id invalid')
    const { endpoint, token } = this.pairingTransport()
    const approverDeviceId = this.getDeviceId()
    if (targetDeviceId === approverDeviceId) throw new Error('cannot revoke own device')
    const deviceAuth = this.getDeviceAuth()
    await syncClient.revokeDevice(endpoint, token, { approverDeviceId, targetDeviceId }, deviceAuth)
    this.removeTrustedDeviceRow(targetDeviceId)
    logger.info('[revokeTrustedDevice] device revoked')
  }

  /**
   * Main-side sync authorization (LOCK-004): a relay token alone is never
   * trust. When the local durable trust mirror is non-empty, the local
   * device must be a member; otherwise sync fails closed before transport
   * with a durable lastError. An empty mirror is the founder bootstrap case
   * (first device forms the group); after a successful bootstrap sync the
   * local device is mirrored as trusted.
   */
  private assertLocalTrustForSync(deviceId: string): void {
    let trusted: SyncTrustedDevice[]
    try {
      trusted = this.listTrustedDevices()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.updateLastError(`sync authorization failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
    if (trusted.length > 0 && !trusted.some((d) => d.deviceId === deviceId)) {
      const msg = 'sync blocked: device-not-trusted (pairing required)'
      try {
        this.updateLastError(msg)
      } catch {}
      throw new Error(msg)
    }
  }

  private recordBootstrapTrust(deviceId: string): void {
    // F-008 fail-closed: bootstrap trust persistence failure must never be
    // swallowed. Throw so sync() records a durable error and rejects instead
    // of reporting success. Callers persist the issued device credential
    // separately via persistIssuedDeviceAuth (also fail-closed).
    const trusted = this.listTrustedDevices()
    if (trusted.length === 0) {
      this.upsertTrustedDevice({ deviceId, trustedAt: new Date().toISOString(), source: 'bootstrap' })
    }
  }

  clearAllForTests(): void {
    this.resetShutdownForTests()
    this.configGeneration = 0
    try {
      configManager.set(STATE_DEVICE_AUTH as never, '' as never)
    } catch {}
    try {
      const db = this.getDb()
      db.delete(schema.syncOutbox).run()
      db.delete(schema.syncApplied).run()
      db.delete(schema.syncEntityClock).run()
      try {
        db.delete(schema.syncFieldClock).run()
      } catch {}
      try {
        db.delete(schema.syncConflictLog).run()
      } catch {}
      try {
        db.delete(schema.syncTrustedDevices).run()
      } catch {}
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_SYNC_AT)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_ERROR)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CAPTURE_ERROR)).run()
    } catch {}
  }
}

export const syncService = new SyncService()
