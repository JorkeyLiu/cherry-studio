import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import type {
  SyncConfig,
  SyncOperation,
  SyncPairingState,
  SyncPairState,
  SyncPushRequest,
  SyncServiceStatus,
  SyncStatus
} from '@shared/sync'
import {
  filterBlockPayload,
  filterMessagePayload,
  filterTopicPayload,
  isStableBlockStatus,
  isStableMessageStatus,
  isUnsupportedBlockForSync,
  isValidSyncDeviceAuth,
  SYNC_BLOCK_PATCH_FIELDS,
  SYNC_CONFLICT_LOG_MAX,
  SYNC_MESSAGE_PATCH_FIELDS,
  SYNC_TOPIC_PATCH_FIELDS,
  validatePairingCode,
  validatePairingRequestId,
  validateSyncOperationStrict,
  validateSyncPayloadAllowlist
} from '@shared/sync'
import { SYNC_MAX_OPERATIONS_PER_PULL, SYNC_MAX_OPERATIONS_PER_PUSH } from '@shared/sync'
import type Database from 'better-sqlite3'
import { and, asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { chatDbService } from '../chatDb'
import * as schema from '../chatDb/schema'
import { applyWireSyncEnvelopeInTx } from './syncBaselineWireApply'
import type { BaselineFetchResult } from './SyncClient'
import { syncClient, validateEndpointUrl } from './SyncClient'
import {
  formatSyncTombstoneValue,
  parseSyncChannelKeyValue,
  parseSyncOperationIdShape,
  parseSyncTombstoneValue
} from './syncTombstoneCodec'

const logger = loggerService.withContext('SyncService')

const STATE_LAST_SYNC_AT = 'lastSyncAt'
const STATE_LAST_ERROR = 'lastError'
const STATE_CURSOR = 'cursor'
const STATE_DEVICE_ID = 'deviceId'
const STATE_CAPTURE_ERROR = 'lastCaptureError'
const STATE_DEVICE_AUTH = 'sync:deviceAuth'
const STATE_DEVICE_CODE = 'sync:deviceCode'
const STATE_EXPLICIT_DISCONNECT = 'sync:explicitDisconnect'
const STATE_CHANNEL_KEY = 'sync:channelKey'
const STATE_PAIRING_GENERATION = 'sync:pairingGeneration'
/** Current pairing-protocol generation (SYNC-CC-013 reset marker). */
const PAIRING_GENERATION_CURRENT = 'cc-1'
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

export class SyncFrameError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncFrameError'
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
const MIGRATION_009_KEY = '009_sync_membership_clock'
const MIGRATION_010_KEY = '010_sync_parent_order_frame'

/**
 * Local frame persistence prerequisite (SYNC-DATA-033..036/044).
 * Not remote/wire/candidate integration — authoritative local SQLite
 * mutation transactions only. Frames only for topic→message
 * (kind: topicMessage) and message→block (kind: messageBlock); topic
 * ordering excluded. Every persisted frame represents inventory-included
 * live children in current local user-visible order; live zero-child parent
 * may have empty []; deleted parent has no frame. Per-row sortOrder remains
 * local projection only.
 */
export const PARENT_ORDER_FRAME_VERSION = 'parent-order-frame-v1' as const
export const VALID_PARENT_FRAME_KINDS: ReadonlySet<string> = new Set(['topicMessage', 'messageBlock'])
const FRAME_MAX_SAFE_TIMESTAMP = 9007199254740991

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
  /**
   * Last observed relay reachability (SYNC-CC-004/006). False until a relay
   * round-trip succeeds; transport failures without a response clear it.
   * In-memory only: startup always re-observes via auto-reconnect.
   */
  private serviceConnected = false
  private enqueueListeners = new Set<() => void>()
  private channelChangeListeners = new Set<() => void>()
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

  /**
   * Channel-identity change subscription (SYNC-CC-016): emitted whenever the
   * observed channel key changes (paired, switched, or unpaired/dissolved)
   * so automation restarts its channel-bound SSE subscriber on the new
   * channel instead of relying on the reconcile timer. Listener errors never
   * propagate into the sync paths (they are scoped-logged).
   */
  onChannelChange(listener: () => void): () => void {
    this.channelChangeListeners.add(listener)
    return () => {
      this.channelChangeListeners.delete(listener)
    }
  }

  private emitChannelChange(): void {
    for (const listener of [...this.channelChangeListeners]) {
      try {
        listener()
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        logger.error(`[emitChannelChange] listener failed: ${detail.slice(0, 200)}`)
      }
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

  private parseTombstone(value: string | null | undefined): { timestamp: number; operationId: string | null } | null {
    // Shared strict semantics live in syncTombstoneCodec; the SyncTombstoneError
    // boundary is preserved here so callers observe the identical failure.
    try {
      return parseSyncTombstoneValue(value)
    } catch (e) {
      throw new SyncTombstoneError(e instanceof Error ? e.message : String(e))
    }
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
    // validator exactly: non-empty, colon-free, at most 256 characters. The
    // shape rule itself lives in syncTombstoneCodec; the SyncTombstoneError
    // boundary is preserved here so callers observe the identical failure.
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new SyncTombstoneError(`malformed tombstone timestamp ${String(timestamp).slice(0, 40)}`)
    }
    if (operationId !== null) {
      try {
        parseSyncOperationIdShape(operationId)
      } catch (e) {
        throw new SyncTombstoneError(e instanceof Error ? e.message : String(e))
      }
    }
    const key = this.tombstoneKey(entityType, entityId)
    const existing = db.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get()
    if (!existing) {
      const value = formatSyncTombstoneValue(timestamp, operationId)
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
    const value = formatSyncTombstoneValue(timestamp, operationId)
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

  // -------------------------------------------------------------------------
  // Parent-membership clock — additive, durable (009)
  // Only for message/message_block. Insert-if-absent: true first creation clock
  // is preserved; ordinary edits/idempotent retries never move it forward.
  // Tombstones retain membership clock (deterministic history).
  // -------------------------------------------------------------------------

  private restrictMembershipChildType(childType: string): childType is 'message' | 'message_block' {
    return childType === 'message' || childType === 'message_block'
  }

  /**
   * Fail-closed, idempotent parent-membership clock for a true child creation.
   * Only a row inserted by the SAME current aggregate transaction with a real
   * creation sync operation may get membership. Insert when absent; when present,
   * accept only exact child type/id + parentId + timestamp + operationId match
   * (idempotent retry); any difference throws so the enclosing transaction rolls
   * back (no partial business/sync mutation survives). Supported only for
   * message/message_block creation paths carrying a trustworthy creation
   * operation (appendMessage new row, bulkAddBlocks new row, remote true-create).
   * Currently skipped compound/branch/clone/paste/reset operations remain
   * explicitly unversioned in this unit rather than fabricating clocks.
   */
  setMembershipClockInTx(
    tx: SyncTxExecutor,
    childEntityType: 'message' | 'message_block',
    childEntityId: string,
    parentId: string,
    timestamp: number,
    operationId: string
  ): void {
    if (!this.restrictMembershipChildType(childEntityType)) return
    if (!childEntityId || !parentId) {
      throw new SyncTombstoneError('membership clock requires child and parent ids')
    }
    try {
      parseSyncOperationIdShape(operationId)
    } catch (e) {
      throw new SyncTombstoneError(e instanceof Error ? e.message : String(e))
    }
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new SyncTombstoneError(`malformed membership clock timestamp ${String(timestamp).slice(0, 40)}`)
    }
    try {
      const existing = tx
        .select()
        .from(schema.syncMembershipClock)
        .where(eq(schema.syncMembershipClock.childEntityType, childEntityType))
        .all()
        .find((r) => r.childEntityId === childEntityId) as typeof schema.syncMembershipClock.$inferSelect | undefined
      if (!existing) {
        tx.insert(schema.syncMembershipClock)
          .values({ childEntityType, childEntityId, parentId, timestamp, operationId })
          .run()
        return
      }
      // Idempotent exact retry: same parent+clock => no-op
      if (existing.parentId === parentId && existing.timestamp === timestamp && existing.operationId === operationId) {
        return
      }
      // Conflicting retained parent/clock => fail-closed (rollback)
      throw new SyncTombstoneError(
        `membership clock conflict for ${childEntityType}/${childEntityId}: retained parent ${existing.parentId} clock ${existing.timestamp}:${existing.operationId.slice(0, 8)} vs incoming ${parentId} ${timestamp}:${operationId.slice(0, 8)}`
      )
    } catch (e) {
      if (e instanceof SyncTombstoneError) throw e
      if (isTolerableMissingSyncTable(tx, e, MIGRATION_009_KEY)) return
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Read-only accessor for verification/testing: membership clock for a child. */
  getMembershipClock(
    childEntityType: 'message' | 'message_block',
    childEntityId: string
  ): { parentId: string; timestamp: number; operationId: string } | null {
    if (!this.restrictMembershipChildType(childEntityType)) return null
    const db = this.getDb()
    try {
      const row = db
        .select()
        .from(schema.syncMembershipClock)
        .where(eq(schema.syncMembershipClock.childEntityType, childEntityType))
        .all()
        .find((r) => r.childEntityId === childEntityId)
      if (!row) return null
      return { parentId: row.parentId, timestamp: row.timestamp, operationId: row.operationId }
    } catch (e) {
      if (isTolerableMissingSyncTable(db, e, MIGRATION_009_KEY)) return null
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Tx-bound read for atomic checks inside same transaction. */
  getMembershipClockInTx(
    tx: SyncTxExecutor,
    childEntityType: 'message' | 'message_block',
    childEntityId: string
  ): { parentId: string; timestamp: number; operationId: string } | null {
    if (!this.restrictMembershipChildType(childEntityType)) return null
    try {
      const row = tx
        .select()
        .from(schema.syncMembershipClock)
        .where(eq(schema.syncMembershipClock.childEntityType, childEntityType))
        .all()
        .find((r) => r.childEntityId === childEntityId)
      if (!row) return null
      return { parentId: row.parentId, timestamp: row.timestamp, operationId: row.operationId }
    } catch (e) {
      if (isTolerableMissingSyncTable(tx, e, MIGRATION_009_KEY)) return null
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  // -------------------------------------------------------------------------
  // Parent order frame — additive, durable (010)
  // Local frame persistence prerequisite only (SYNC-DATA-033..036/044):
  // not remote/wire/candidate integration. Frames only for topic→message
  // (topicMessage) and message→block (messageBlock). See migration 010.
  // Helpers are tx-bound where noted; fail-closed on validation/missing
  // membership/timestamp exhaustion so the enclosing aggregate transaction
  // rolls back atomically. No outbox enqueue here — frameClock is local
  // truthful state only.
  // -------------------------------------------------------------------------

  private isValidFrameKind(kind: string): kind is 'topicMessage' | 'messageBlock' {
    return VALID_PARENT_FRAME_KINDS.has(kind)
  }

  private validateFrameShape(frame: {
    kind: string
    parentId: string
    frameVersion: string
    orderedChildIds: unknown
    timestamp: unknown
    operationId: unknown
  }): void {
    if (!this.isValidFrameKind(frame.kind)) {
      throw new SyncFrameError(`invalid frame kind ${String(frame.kind).slice(0, 40)}`)
    }
    if (typeof frame.parentId !== 'string' || frame.parentId.length === 0 || frame.parentId.length > 256) {
      throw new SyncFrameError(`invalid frame parentId ${String(frame.parentId).slice(0, 40)}`)
    }
    if (frame.parentId.includes(':')) {
      // Parent IDs are entity IDs; colon-free mirrors operationId bound for safety
      // but not strictly required — we keep length check only for parent
      // The wire spec forbids colon only for operationId, not parent, so we
      // only guard length here. If a colon appears we do NOT throw for parent.
      void 0
    }
    if (frame.frameVersion !== PARENT_ORDER_FRAME_VERSION) {
      throw new SyncFrameError(`invalid frameVersion ${String(frame.frameVersion).slice(0, 40)}`)
    }
    if (!Array.isArray(frame.orderedChildIds)) {
      throw new SyncFrameError('orderedChildIds must be array')
    }
    const ids = frame.orderedChildIds as unknown[]
    const seen = new Set<string>()
    for (const v of ids) {
      if (typeof v !== 'string' || v.length === 0 || v.length > 256) {
        throw new SyncFrameError(`invalid orderedChildId ${String(v).slice(0, 40)}`)
      }
      if (seen.has(v)) {
        throw new SyncFrameError(`duplicate orderedChildId ${String(v).slice(0, 40)}`)
      }
      seen.add(v)
    }
    // Deterministic JSON serialization check: the stored JSON must be the
    // strict JSON array of strings without extra whitespace. We enforce that
    // JSON.stringify produces the same bytes as the stored value when we
    // validate persistence; here we just validate shape.
    if (
      !Number.isSafeInteger(frame.timestamp as number) ||
      (frame.timestamp as number) < 0 ||
      (frame.timestamp as number) > FRAME_MAX_SAFE_TIMESTAMP
    ) {
      throw new SyncFrameError(`invalid frame timestamp ${String(frame.timestamp).slice(0, 40)}`)
    }
    try {
      parseSyncOperationIdShape(frame.operationId as string)
    } catch (e) {
      throw new SyncFrameError(e instanceof Error ? e.message : String(e))
    }
  }

  private validateOrderedChildIdsJson(jsonStr: string): string[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      throw new SyncFrameError('ordered_child_ids_json is not valid JSON')
    }
    if (!Array.isArray(parsed)) {
      throw new SyncFrameError('ordered_child_ids_json must be JSON array')
    }
    const out: string[] = []
    const seen = new Set<string>()
    for (const v of parsed as unknown[]) {
      if (typeof v !== 'string' || v.length === 0 || v.length > 256) {
        throw new SyncFrameError(`invalid orderedChildId in JSON ${String(v).slice(0, 40)}`)
      }
      if (seen.has(v)) {
        throw new SyncFrameError(`duplicate orderedChildId in JSON ${String(v).slice(0, 40)}`)
      }
      seen.add(v)
      out.push(v)
    }
    // Strict determinism: serialized form must be JSON.stringify(out)
    const canonical = JSON.stringify(out)
    if (canonical !== jsonStr) {
      throw new SyncFrameError('ordered_child_ids_json not in canonical strict JSON array form')
    }
    return out
  }

  /**
   * Read parent frame inside an existing transaction (tx-bound).
   * Returns null when absent or when table is proven pre-010 (no backfill).
   * Fail-closed on malformed persisted row so the enclosing transaction rolls back.
   */
  getParentFrameInTx(
    tx: SyncTxExecutor,
    kind: 'topicMessage' | 'messageBlock',
    parentId: string
  ): {
    kind: string
    parentId: string
    frameVersion: string
    orderedChildIds: string[]
    timestamp: number
    operationId: string
  } | null {
    if (!this.isValidFrameKind(kind)) throw new SyncFrameError(`invalid frame kind ${kind}`)
    if (typeof parentId !== 'string' || parentId.length === 0) throw new SyncFrameError(`invalid parentId ${parentId}`)
    try {
      const row = tx
        .select()
        .from(schema.syncParentOrderFrame)
        .where(eq(schema.syncParentOrderFrame.kind, kind))
        .all()
        .find((r) => r.parentId === parentId) as typeof schema.syncParentOrderFrame.$inferSelect | undefined
      if (!row) return null
      // Fail-closed validation of persisted row
      if (row.frameVersion !== PARENT_ORDER_FRAME_VERSION) {
        throw new SyncFrameError(`persisted frameVersion mismatch for ${kind}/${parentId}`)
      }
      const orderedChildIds = this.validateOrderedChildIdsJson(row.orderedChildIdsJson)
      if (!Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > FRAME_MAX_SAFE_TIMESTAMP) {
        throw new SyncFrameError(`persisted frame timestamp invalid for ${kind}/${parentId}`)
      }
      try {
        parseSyncOperationIdShape(row.operationId)
      } catch (e) {
        throw new SyncFrameError(e instanceof Error ? e.message : String(e))
      }
      return {
        kind: row.kind,
        parentId: row.parentId,
        frameVersion: row.frameVersion,
        orderedChildIds,
        timestamp: row.timestamp,
        operationId: row.operationId
      }
    } catch (e) {
      if (e instanceof SyncFrameError) throw e
      if (isTolerableMissingSyncTable(tx, e, MIGRATION_010_KEY)) return null
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Read-only accessor for verification/testing. */
  getParentFrame(
    kind: 'topicMessage' | 'messageBlock',
    parentId: string
  ): {
    kind: string
    parentId: string
    frameVersion: string
    orderedChildIds: string[]
    timestamp: number
    operationId: string
  } | null {
    const db = this.getDb()
    try {
      const row = db
        .select()
        .from(schema.syncParentOrderFrame)
        .where(eq(schema.syncParentOrderFrame.kind, kind))
        .all()
        .find((r) => r.parentId === parentId) as typeof schema.syncParentOrderFrame.$inferSelect | undefined
      if (!row) return null
      if (row.frameVersion !== PARENT_ORDER_FRAME_VERSION) {
        throw new SyncFrameError(`persisted frameVersion mismatch for ${kind}/${parentId}`)
      }
      const orderedChildIds = this.validateOrderedChildIdsJson(row.orderedChildIdsJson)
      if (!Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > FRAME_MAX_SAFE_TIMESTAMP) {
        throw new SyncFrameError(`persisted frame timestamp invalid for ${kind}/${parentId}`)
      }
      parseSyncOperationIdShape(row.operationId)
      return {
        kind: row.kind,
        parentId: row.parentId,
        frameVersion: row.frameVersion,
        orderedChildIds,
        timestamp: row.timestamp,
        operationId: row.operationId
      }
    } catch (e) {
      if (e instanceof SyncFrameError) throw e
      if (isTolerableMissingSyncTable(db, e, MIGRATION_010_KEY)) return null
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /**
   * Persist a frame inside an existing transaction (tx-bound).
   * Validates frame shape/json/clock/version fail-closed.
   * Repeating exact frame is idempotent (no write).
   * Different frame is accepted only if incoming frameClock wins current by
   * timestamp+operationId total order; otherwise fail-closed (throw) so a
   * business mutation cannot commit with a stale frame. Winning higher clock applies.
   * Returns { applied: boolean, reason: string }.
   * Local generated writes should always allocate a winning clock before calling.
   */
  persistParentFrameInTx(
    tx: SyncTxExecutor,
    frame: {
      kind: 'topicMessage' | 'messageBlock'
      parentId: string
      frameVersion: string
      orderedChildIds: string[]
      timestamp: number
      operationId: string
    }
  ): { applied: boolean; reason: 'inserted' | 'updated' | 'idempotent' } {
    this.validateFrameShape({
      kind: frame.kind,
      parentId: frame.parentId,
      frameVersion: frame.frameVersion,
      orderedChildIds: frame.orderedChildIds,
      timestamp: frame.timestamp,
      operationId: frame.operationId
    })
    const jsonStr = JSON.stringify(frame.orderedChildIds)
    // Extra canonical check: already validated via shape, but ensure deterministic
    if ((JSON.parse(jsonStr) as unknown) === null) {
      throw new SyncFrameError('frame orderedChildIds JSON round-trip failed')
    }
    try {
      const existing = this.getParentFrameInTx(tx, frame.kind, frame.parentId)
      if (existing) {
        const sameJson = JSON.stringify(existing.orderedChildIds) === jsonStr
        const sameClock = existing.timestamp === frame.timestamp && existing.operationId === frame.operationId
        const sameVersion = existing.frameVersion === frame.frameVersion
        if (
          sameJson &&
          sameClock &&
          sameVersion &&
          existing.kind === frame.kind &&
          existing.parentId === frame.parentId
        ) {
          return { applied: false, reason: 'idempotent' }
        }
        const cmp = this.compareLww(frame.timestamp, frame.operationId, existing.timestamp, existing.operationId)
        if (cmp <= 0) {
          throw new SyncFrameError(
            `conflicting frame clock for ${frame.kind}/${frame.parentId}: incoming (${frame.timestamp},${frame.operationId}) does not win existing (${existing.timestamp},${existing.operationId})`
          )
        }
      }
      tx.insert(schema.syncParentOrderFrame)
        .values({
          kind: frame.kind,
          parentId: frame.parentId,
          frameVersion: frame.frameVersion,
          orderedChildIdsJson: jsonStr,
          timestamp: frame.timestamp,
          operationId: frame.operationId
        })
        .onConflictDoUpdate({
          target: [schema.syncParentOrderFrame.kind, schema.syncParentOrderFrame.parentId],
          set: {
            frameVersion: frame.frameVersion,
            orderedChildIdsJson: jsonStr,
            timestamp: frame.timestamp,
            operationId: frame.operationId
          }
        })
        .run()
      return { applied: true, reason: existing ? 'updated' : 'inserted' }
    } catch (e) {
      if (e instanceof SyncFrameError) throw e
      if (isTolerableMissingSyncTable(tx, e, MIGRATION_010_KEY)) {
        throw new SyncFrameError(`parent order frame table missing for ${frame.kind}/${frame.parentId}`)
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Invalidate (delete) a single parent frame inside an existing transaction. Idempotent. */
  invalidateParentFrameInTx(tx: SyncTxExecutor, kind: 'topicMessage' | 'messageBlock', parentId: string): void {
    if (!this.isValidFrameKind(kind)) throw new SyncFrameError(`invalid frame kind ${kind}`)
    if (typeof parentId !== 'string' || parentId.length === 0) throw new SyncFrameError(`invalid parentId ${parentId}`)
    try {
      tx.delete(schema.syncParentOrderFrame)
        .where(and(eq(schema.syncParentOrderFrame.kind, kind), eq(schema.syncParentOrderFrame.parentId, parentId)))
        .run()
    } catch (e) {
      if (e instanceof SyncFrameError) throw e
      if (isTolerableMissingSyncTable(tx, e, MIGRATION_010_KEY)) return
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Allocate a dedicated winning frameClock for a parent inside same aggregate transaction. */
  allocateWinningFrameClockInTx(
    tx: SyncTxExecutor,
    kind: 'topicMessage' | 'messageBlock',
    parentId: string,
    includedChildIds: string[]
  ): { timestamp: number; operationId: string } {
    if (!this.isValidFrameKind(kind)) throw new SyncFrameError(`invalid frame kind ${kind}`)
    if (typeof parentId !== 'string' || parentId.length === 0) throw new SyncFrameError(`invalid parentId ${parentId}`)
    // Existing frame clock
    const existing = this.getParentFrameInTx(tx, kind, parentId)
    let maxTs = -1
    if (existing) {
      if (
        !Number.isSafeInteger(existing.timestamp) ||
        existing.timestamp < 0 ||
        existing.timestamp > FRAME_MAX_SAFE_TIMESTAMP
      ) {
        throw new SyncFrameError(`existing frame timestamp malformed for ${kind}/${parentId}`)
      }
      maxTs = Math.max(maxTs, existing.timestamp)
    }
    const childType = kind === 'topicMessage' ? 'message' : 'message_block'
    for (const childId of includedChildIds) {
      if (typeof childId !== 'string' || childId.length === 0) {
        throw new SyncFrameError(`invalid included childId ${String(childId).slice(0, 40)}`)
      }
      const mem = this.getMembershipClockInTx(tx, childType, childId)
      if (!mem) {
        throw new SyncFrameError(
          `missing membership clock for included child ${childType}/${childId} parent ${parentId}`
        )
      }
      if (!Number.isSafeInteger(mem.timestamp) || mem.timestamp < 0 || mem.timestamp > FRAME_MAX_SAFE_TIMESTAMP) {
        throw new SyncFrameError(`malformed membership timestamp for ${childType}/${childId}`)
      }
      try {
        parseSyncOperationIdShape(mem.operationId)
      } catch (e) {
        throw new SyncFrameError(e instanceof Error ? e.message : String(e))
      }
      if (mem.parentId !== parentId) {
        throw new SyncFrameError(
          `membership parent mismatch for ${childType}/${childId}: ${mem.parentId} vs ${parentId}`
        )
      }
      maxTs = Math.max(maxTs, mem.timestamp)
    }
    if (maxTs === FRAME_MAX_SAFE_TIMESTAMP) {
      throw new SyncFrameError(
        `frame clock timestamp exhaustion for ${kind}/${parentId}: max relevant timestamp is MAX_SAFE_INTEGER`
      )
    }
    const newTs = maxTs === -1 ? 0 : maxTs + 1
    if (!Number.isSafeInteger(newTs) || newTs < 0 || newTs > FRAME_MAX_SAFE_TIMESTAMP) {
      throw new SyncFrameError(`allocated frame timestamp invalid for ${kind}/${parentId}`)
    }
    const newOpId = randomUUID()
    // Validate operationId shape (randomUUID is valid)
    parseSyncOperationIdShape(newOpId)
    return { timestamp: newTs, operationId: newOpId }
  }

  private getOrderedMessageIdsForTopicInTx(tx: SyncTxExecutor, topicId: string): string[] {
    // Read final child order after repository normalization: sortOrder ASC, id ASC
    // Filter to inventory-included stable messages (transient statuses excluded)
    const rows = tx
      .select({ id: schema.messages.id, sortOrder: schema.messages.sortOrder, status: schema.messages.status })
      .from(schema.messages)
      .where(eq(schema.messages.topicId, topicId))
      .all()
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return a.id.localeCompare(b.id)
      })
    const filtered: string[] = []
    for (const r of rows) {
      if (!isStableMessageStatus(r.status)) continue
      filtered.push(r.id)
    }
    return filtered
  }

  private getOrderedBlockIdsForMessageInTx(tx: SyncTxExecutor, messageId: string): string[] {
    const rows = tx
      .select({
        id: schema.messageBlocks.id,
        sortOrder: schema.messageBlocks.sortOrder,
        status: schema.messageBlocks.status,
        type: schema.messageBlocks.type,
        extra: schema.messageBlocks.extra
      })
      .from(schema.messageBlocks)
      .where(eq(schema.messageBlocks.messageId, messageId))
      .all()
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return a.id.localeCompare(b.id)
      })
    const filtered: string[] = []
    for (const r of rows) {
      if (!isStableBlockStatus(r.status)) continue
      let overflow: Record<string, unknown> = {}
      if (r.extra) {
        let parsed: unknown
        try {
          parsed = JSON.parse(r.extra)
        } catch (e) {
          throw new SyncFrameError(
            `malformed block extra JSON for ${r.id}: ${e instanceof Error ? e.message : String(e)}`
          )
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new SyncFrameError(`malformed block extra JSON for ${r.id}: not an object`)
        }
        overflow = parsed as Record<string, unknown>
      }
      if (isUnsupportedBlockForSync({ type: r.type, overflow })) continue
      filtered.push(r.id)
    }
    return filtered
  }

  /**
   * Truthful refresh: read final order, allocate winning clock, persist.
   * If parent has no live included children, persists empty [] with winning clock.
   * Caller must ensure parent is live (deleted parent should invalidate instead).
   */
  refreshParentFrameInTx(tx: SyncTxExecutor, kind: 'topicMessage' | 'messageBlock', parentId: string): void {
    const orderedIds =
      kind === 'topicMessage'
        ? this.getOrderedMessageIdsForTopicInTx(tx, parentId)
        : this.getOrderedBlockIdsForMessageInTx(tx, parentId)
    const clock = this.allocateWinningFrameClockInTx(tx, kind, parentId, orderedIds)
    this.persistParentFrameInTx(tx, {
      kind,
      parentId,
      frameVersion: PARENT_ORDER_FRAME_VERSION,
      orderedChildIds: orderedIds,
      timestamp: clock.timestamp,
      operationId: clock.operationId
    })
  }

  /**
   * Transition/unsupported helper: attempt truthful refresh only when all
   * included children have valid matching membership; if any included child
   * is missing membership, invalidate the parent frame and continue the user
   * mutation. Malformed membership/overflow remains fail-closed (throws and
   * rolls back the enclosing transaction). Local prerequisite only — no clock mint on invalidate.
   */
  tryRefreshOrInvalidateParentFrameInTx(
    tx: SyncTxExecutor,
    kind: 'topicMessage' | 'messageBlock',
    parentId: string
  ): void {
    try {
      this.refreshParentFrameInTx(tx, kind, parentId)
    } catch (e) {
      if (e instanceof SyncFrameError) {
        const msg = e.message
        // Missing membership for included child: truthful invalidation path, not rollback.
        if (msg.includes('missing membership clock for included child')) {
          this.invalidateParentFrameInTx(tx, kind, parentId)
          return
        }
        // Parent mismatch, malformed overflow/extra, timestamp exhaustion, malformed clocks remain fail-closed
      }
      throw e
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
        // Retained membership check for remote reappearance (009):
        // - Same parent: preserve historical membership (do not overwrite).
        // - Different parent: fail closed and rollback (reparent unsupported).
        // - No retained row: establish from this operation.
        const retained = this.getMembershipClockInTx(db as unknown as SyncTxExecutor, 'message', id)
        if (retained && retained.parentId !== topicId) {
          throw new SyncTombstoneError(
            `membership clock conflict for message/${id}: retained parent ${retained.parentId} vs incoming ${topicId}`
          )
        }
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
        // Dedicated parent-membership clock for true creates only (atomic with row + field clocks).
        // Preserve historical membership when same parent already retained; only establish when absent.
        if (!retained) {
          this.setMembershipClockInTx(db as unknown as SyncTxExecutor, 'message', id, topicId, op.timestamp, op.id)
        }
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
        const retainedBlk = this.getMembershipClockInTx(db as unknown as SyncTxExecutor, 'message_block', id)
        if (retainedBlk && retainedBlk.parentId !== messageId) {
          throw new SyncTombstoneError(
            `membership clock conflict for message_block/${id}: retained parent ${retainedBlk.parentId} vs incoming ${messageId}`
          )
        }
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
        if (!retainedBlk) {
          this.setMembershipClockInTx(
            db as unknown as SyncTxExecutor,
            'message_block',
            id,
            messageId,
            op.timestamp,
            op.id
          )
        }
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
      // Single consistent registration/channel model (SYNC-CC-013): discard
      // superseded invite/founder/trust state once, preserving outbox intent.
      try {
        this.ensurePairingGeneration()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`sync preflight failed: ${msg}`.slice(0, 1000))
        } catch {}
        throw e instanceof Error ? e : new Error(String(e))
      }
      // Explicit attachment gate (SYNC-CC-004/005): an unregistered or
      // user-disconnected service never touches transport.
      let attached: { deviceCode: string; deviceSecret: string }
      try {
        attached = this.requireAttachedService()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`sync preflight failed: ${msg}`.slice(0, 1000))
        } catch {}
        throw e instanceof Error ? e : new Error(String(e))
      }
      const deviceCode = attached.deviceCode
      const deviceSecret = attached.deviceSecret
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
      // Strict local channel binding for receiver bootstrap (SYNC-CC-023):
      // malformed state fails closed; absent (null) means unbound and skips
      // the baseline path (existing push/pull will bind via reconcile).
      let localChannelKey: string | null = null
      try {
        localChannelKey = this.getChannelKey()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`persisted channel invalid: ${msg}`.slice(0, 1000))
        } catch {}
        throw e instanceof Error ? e : new Error(String(e))
      }

      // Receiver-first baseline bootstrap (SYNC-CC-023/SYNC-DATA-047): only
      // when registered/attached, locally channel-bound, and strictly
      // cursor==0 — before any ordinary push/pull in this cycle. cursor>0
      // never fetches. 404 continues with the existing push/pull; 200 merges
      // in one transaction and commits cursor=N, then push/pull resume from N.
      if (cursor === 0 && localChannelKey !== null) {
        this.throwIfShutdown()
        this.throwIfStaleConfig(syncGen)
        let fetched: BaselineFetchResult
        try {
          fetched = await this.fetchBaselineWithShutdown(cfg.endpoint, cfg.token, deviceCode, deviceSecret)
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
          this.markRelayContact(true)
        } catch (e) {
          if (e instanceof SyncShutdownError) throw e
          if (e instanceof SyncStaleConfigError) throw e
          this.markRelayContact(false, e)
          const msg = e instanceof Error ? e.message : String(e)
          this.throwIfShutdown()
          try {
            this.updateLastError(msg.slice(0, 1000))
          } catch {}
          throw e instanceof Error ? e : new Error(String(e))
        }
        if (fetched.found) {
          const envelope = fetched.envelope
          if (envelope.channelId !== localChannelKey) {
            const msg =
              `baseline envelope channel mismatch: envelope ${envelope.channelId} vs local ${localChannelKey}`.slice(
                0,
                500
              )
            try {
              this.updateLastError(msg)
            } catch {}
            throw new SyncCursorError(msg)
          }
          try {
            const watermark = this.runBaselineBootstrapTransaction(envelope, localChannelKey, syncGen)
            cursor = watermark
          } catch (e) {
            if (e instanceof SyncShutdownError) throw e
            if (e instanceof SyncStaleConfigError) throw e
            const msg = e instanceof Error ? e.message : String(e)
            try {
              this.updateLastError(`baseline bootstrap failed: ${msg}`.slice(0, 1000))
            } catch {}
            throw e instanceof Error ? e : new Error(String(e))
          }
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
          const pushRes = await this.pushWithShutdown(cfg.endpoint, cfg.token, pushReq, deviceCode, deviceSecret)
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
          this.markRelayContact(true)
          // Per-channel cursor scope (SYNC-CC-016): a new channel identity
          // restarts this client on that channel's own cursor origin. Cursor
          // values are never reused across channels.
          if (pushRes.channelId !== undefined) {
            const switched = this.reconcileChannelKey(pushRes.channelId)
            if (switched) {
              cursor = 0
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
          this.markRelayContact(false, e)
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
        let pullRes: { operations: any[]; cursor: number; channelId?: string }
        try {
          pullRes = await this.pullWithShutdown(
            cfg.endpoint,
            cfg.token,
            fetchCursor,
            deviceId,
            deviceCode,
            deviceSecret
          )
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
          this.markRelayContact(true)
          if (pullRes.channelId !== undefined) {
            const switched = this.reconcileChannelKey(pullRes.channelId)
            if (switched) {
              // Channel changed mid-sync: restart the pull stream on the new
              // channel from its own cursor origin. Entries buffered from the
              // previous channel are applied best-effort, then dropped —
              // history convergence across channels is out of scope.
              try {
                const leftover = tryApplyDeferred()
                if (leftover) {
                  logger.warn(
                    `[sync] channel switch dropped buffered entry: ${(leftover instanceof Error ? leftover.message : String(leftover)).slice(0, 200)}`
                  )
                }
              } catch (leftoverErr) {
                logger.warn(
                  `[sync] channel switch drop failed: ${(leftoverErr instanceof Error ? leftoverErr.message : String(leftoverErr)).slice(0, 200)}`
                )
              }
              deferred.length = 0
              seenSeq.clear()
              resolved.clear()
              fetchCursor = 0
              commitCursor = 0
              continue
            }
          }
          this.throwIfShutdown()
          this.throwIfStaleConfig(syncGen)
        } catch (e) {
          if (e instanceof SyncShutdownError) throw e
          if (e instanceof SyncStaleConfigError) throw e
          this.markRelayContact(false, e)
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
    deviceCode: string,
    deviceSecret: string
  ): Promise<{ cursor: number; acceptedIds: string[]; channelId?: string }> {
    const controller = new AbortController()
    const untrack = this.trackFetchController(controller)
    try {
      return await syncClient.push(endpoint, token, req, controller.signal, deviceCode, deviceSecret)
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
    deviceCode: string,
    deviceSecret: string
  ): Promise<{ operations: any[]; cursor: number; channelId?: string }> {
    const controller = new AbortController()
    const untrack = this.trackFetchController(controller)
    try {
      return (await syncClient.pull(
        endpoint,
        token,
        cursor,
        deviceId,
        controller.signal,
        deviceCode,
        deviceSecret
      )) as unknown as {
        operations: any[]
        cursor: number
        channelId?: string
      }
    } catch (e) {
      if (this.shutdownRequested) throw new SyncShutdownError()
      throw e
    } finally {
      untrack()
    }
  }

  private async fetchBaselineWithShutdown(
    endpoint: string,
    token: string | undefined,
    deviceCode: string,
    deviceSecret: string
  ): Promise<BaselineFetchResult> {
    const controller = new AbortController()
    const untrack = this.trackFetchController(controller)
    try {
      return await syncClient.fetchBaseline(endpoint, token, deviceCode, deviceSecret, controller.signal)
    } catch (e) {
      if (this.shutdownRequested) throw new SyncShutdownError()
      throw e
    } finally {
      untrack()
    }
  }

  /**
   * Receiver bootstrap transaction (SYNC-DATA-047/SYNC-CC-023): in ONE SQLite
   * transaction, assert the persisted cursor is still 0 and the persisted
   * channel still matches the envelope, merge the wire baseline via the
   * shared merge core, and commit `sync_state.cursor=N`. Preserves
   * `sync_outbox`/`sync_applied`/pre-pair rows untouched; never clears the
   * outbox and never requires it empty. Fails closed with full rollback on
   * any validation/channel/cursor/DB failure (cursor stays 0).
   */
  private runBaselineBootstrapTransaction(envelope: unknown, expectedChannelKey: string, syncGen: number): number {
    this.throwIfShutdown()
    this.throwIfStaleConfig(syncGen)
    const db = this.getDb()
    let watermark = -1
    db.transaction((tx) => {
      const inner = tx as unknown as BetterSQLite3Database<typeof schema>
      this.throwIfShutdown()
      this.throwIfStaleConfig(syncGen)
      const cursorRow = inner.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).get()
      let current = 0
      if (cursorRow) {
        if (cursorRow.value === null || cursorRow.value === undefined) {
          throw new SyncCursorError('malformed persisted cursor: missing value')
        }
        current = parseStrictCursor(cursorRow.value)
      }
      if (current !== 0) {
        throw new SyncCursorError(`baseline bootstrap requires cursor 0 but found ${String(current)}`)
      }
      const channelRow = inner.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CHANNEL_KEY)).get()
      if (!channelRow || channelRow.value === null || channelRow.value === undefined) {
        throw new SyncCursorError('baseline bootstrap requires bound channel but found none')
      }
      let persistedChannel: string
      try {
        persistedChannel = parseSyncChannelKeyValue(channelRow.value)
      } catch (e) {
        throw new SyncCursorError(`malformed persisted channel key: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (persistedChannel !== expectedChannelKey) {
        throw new SyncCursorError(
          `baseline bootstrap channel changed before commit: expected ${expectedChannelKey} but found ${persistedChannel}`
        )
      }
      const applied = applyWireSyncEnvelopeInTx(inner, envelope, { expectedChannelId: expectedChannelKey })
      if (applied.channelId !== persistedChannel) {
        throw new SyncCursorError(
          `baseline bootstrap envelope channel mismatch: envelope ${applied.channelId} vs local ${persistedChannel}`
        )
      }
      watermark = applied.watermark
      if (!Number.isSafeInteger(watermark) || watermark < 0) {
        throw new SyncCursorError(`malformed baseline watermark ${String(watermark)}`)
      }
      inner
        .insert(schema.syncState)
        .values({ key: STATE_CURSOR, value: String(watermark) })
        .onConflictDoUpdate({ target: schema.syncState.key, set: { value: String(watermark) } })
        .run()
    })
    this.throwIfShutdown()
    this.throwIfStaleConfig(syncGen)
    if (watermark < 0) throw new SyncCursorError('baseline bootstrap transaction produced no watermark')
    return watermark
  }

  /**
   * Per-device relay credential: issued once by the relay at registration
   * (Connect) or pairing-request accept, persisted in config alongside the token,
   * and presented on every device-authenticated call. Never logged.
   * Returns undefined when no credential was ever issued (pre-registration).
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

  /**
   * Credential-persistence failure (SYNC-CC-004): the plaintext secret is
   * never carried on the error object, message text, or logs (secret minimal
   * surface). The registration write is rolled back so no half
   * (code-without-secret) state survives; a retry re-registers via transport
   * and never silently attaches without a durable credential.
   */
  private credentialPersistenceError(context: string, cause: unknown): Error {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const err = new Error(`${context}: sync device auth persistence failed: ${detail}`.slice(0, 1000))
    if (cause instanceof Error) {
      try {
        ;(err as { cause?: unknown }).cause = cause
      } catch {}
    }
    return err
  }

  // -------------------------------------------------------------------------
  // Service connection + registration + channel pairing (SYNC-CC-*)
  // -------------------------------------------------------------------------

  /**
   * This device's public device code when registered, null when
   * unregistered. The code is public by design (safe to display); a
   * present-but-malformed value fails closed.
   */
  getDeviceCodeOrNull(): string | null {
    let raw: unknown
    try {
      raw = configManager.get(STATE_DEVICE_CODE as never, undefined as never)
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync device code config read failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    if (raw === undefined || raw === null || raw === '') return null
    if (validatePairingCode(raw)) {
      throw new SyncDeviceIdentityError('sync device code config malformed: present value is not a valid code')
    }
    return (raw as string).trim().toUpperCase()
  }

  /** True after an explicit user Disconnect (attachment stopped, registration kept). */
  isExplicitlyDisconnected(): boolean {
    try {
      return configManager.get(STATE_EXPLICIT_DISCONNECT as never, false as never) === true
    } catch {
      return false
    }
  }

  /**
   * Separate service/pairing state (SYNC-CC-003/006): this client's own
   * observed relay attachment plus registration. Relay-unreachable surfaces
   * as `disconnected`; broadcast presence of other devices is never implied.
   */
  getServiceStatus(): SyncServiceStatus {
    try {
      this.ensurePairingGeneration()
    } catch (e) {
      // Fail closed: a pairing-reset failure must never be disguised as an
      // ordinary unregistered/disconnected state. The marker is unwritten so
      // the reset retries on the next entry; the failure stays observable via
      // the durable lastError (existing UI surface) plus the throw.
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[getServiceStatus] pairing generation reset failed: ${msg.slice(0, 200)}`)
      try {
        this.updateLastError(`service status unavailable: ${msg}`.slice(0, 1000))
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
    // Current-generation strict registration coherence (SYNC-CC-004/013):
    // a malformed or half-persisted code/secret fragment fails closed with
    // an explicit recovery requirement — never disguised as `unregistered`.
    // Only the both-absent case is `unregistered`. No value (in particular
    // no secret) is ever written to the error text or logs.
    let deviceCode: string | null = null
    let codeErr: unknown = null
    try {
      deviceCode = this.getDeviceCodeOrNull()
    } catch (e) {
      codeErr = e
    }
    let secret: string | undefined
    let secretErr: unknown = null
    try {
      secret = this.getDeviceAuth()
    } catch (e) {
      secretErr = e
    }
    if (codeErr !== null || secretErr !== null || (deviceCode === null) !== (secret === undefined)) {
      const parts: string[] = []
      if (codeErr !== null) parts.push('device code malformed')
      if (secretErr !== null) parts.push('device auth malformed')
      if (parts.length === 0) parts.push('registration incomplete')
      const msg = `sync ${parts.join(' + ')}: recovery required (clear registration explicitly before re-registering)`
      try {
        this.updateLastError(`service status unavailable: ${msg}`.slice(0, 1000))
      } catch {}
      throw new SyncDeviceIdentityError(msg)
    }
    const registered = deviceCode !== null && secret !== undefined
    const explicitDisconnect = this.isExplicitlyDisconnected()
    if (!registered) return { state: 'unregistered', deviceCode: null, explicitDisconnect }
    if (explicitDisconnect) return { state: 'disconnected', deviceCode, explicitDisconnect }
    return { state: this.serviceConnected ? 'connected' : 'disconnected', deviceCode, explicitDisconnect }
  }

  /** Automation gate: registered devices attach unless explicitly disconnected. */
  isAutoSyncAllowed(): boolean {
    try {
      if (this.isExplicitlyDisconnected()) return false
      return this.getDeviceCodeOrNull() !== null && this.getDeviceAuth() !== undefined
    } catch {
      return false
    }
  }

  /**
   * Auto-sync credentials (Main-internal only; never exposed via IPC or UI).
   * Null unless the service is attached with a durable registration.
   */
  getAutoCredentials(): { deviceCode: string; deviceSecret: string } | null {
    try {
      if (this.isExplicitlyDisconnected()) return null
      const deviceCode = this.getDeviceCodeOrNull()
      const deviceSecret = this.getDeviceAuth()
      if (!deviceCode || !deviceSecret) return null
      return { deviceCode, deviceSecret }
    } catch {
      return null
    }
  }

  private setServiceConnected(value: boolean): void {
    this.serviceConnected = value
  }

  /**
   * Observed relay reachability (SYNC-CC-004): any relay HTTP response —
   * even an error status — proves the relay is reachable; only a transport
   * failure without a response marks the service disconnected. A credential
   * failure (unknown/invalid credential) breaks this client's attachment
   * itself, so it also surfaces as disconnected. Shutdown and stale-config
   * aborts never flip the flag.
   */
  private markRelayContact(reached: boolean, error?: unknown): void {
    if (reached) {
      this.serviceConnected = true
      return
    }
    if (error instanceof SyncShutdownError || error instanceof SyncStaleConfigError) return
    const msg = error instanceof Error ? error.message : String(error ?? '')
    // Attachment-breaking responses surface as disconnected: wrong relay
    // token (401) or a broken device credential means this client is not
    // attached, even though the relay itself is reachable.
    if (/failed 401:|unknown-credential|invalid-credential/.test(msg)) {
      this.serviceConnected = false
      return
    }
    if (
      /failed \d+:/.test(msg) ||
      /response malformed/.test(msg) ||
      /non-contiguous/.test(msg) ||
      /request-\w+/.test(msg) ||
      /pairing-/.test(msg) ||
      /not-paired/.test(msg) ||
      /unknown-device/.test(msg) ||
      /credential/.test(msg)
    ) {
      this.serviceConnected = true
      return
    }
    this.serviceConnected = false
  }

  /**
   * Fail-closed attachment requirement for any relay contact. Both-absent
   * is `unregistered` (Connect to register); any single-sided fragment
   * (half-persisted registration) fails closed with an explicit recovery
   * requirement and is never silently re-registered. A present-but-malformed
   * value throws from the getters below (fail closed, secret never logged).
   */
  private requireAttachedService(): { deviceCode: string; deviceSecret: string } {
    if (this.isExplicitlyDisconnected()) {
      throw new Error('service disconnected (explicit disconnect; Connect to resume)')
    }
    const deviceCode = this.getDeviceCodeOrNull()
    const deviceSecret = this.getDeviceAuth()
    if (!deviceCode && !deviceSecret) {
      throw new Error('service not connected (registration required; Connect to register)')
    }
    if (!deviceCode || !deviceSecret) {
      throw new SyncDeviceIdentityError(
        'sync registration incomplete: recovery required (clear registration explicitly before re-registering)'
      )
    }
    return { deviceCode, deviceSecret }
  }

  /**
   * Guard an in-flight connect() continuation: shutdown, config/lifecycle
   * generation, explicit disconnect, and endpoint/token identity. A stale
   * (expired endpoint/token) result must never write credential, status,
   * channel, or cursor.
   */
  private assertConnectFresh(snapshot: { endpoint: string; token: string | undefined }, connectGen: number): void {
    this.throwIfShutdown()
    this.throwIfStaleConfig(connectGen)
    if (this.isExplicitlyDisconnected()) throw new SyncStaleConfigError('sync cancelled: disconnected during connect')
    let current: SyncConfig
    try {
      current = this.getConfig()
    } catch (e) {
      throw new SyncStaleConfigError(
        `sync cancelled: config unreadable during connect: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    if (current.endpoint !== snapshot.endpoint || (current.token ?? undefined) !== (snapshot.token ?? undefined)) {
      throw new SyncStaleConfigError('sync cancelled: endpoint/token changed during connect')
    }
  }

  /**
   * Atomically persist the device code + secret registration record as one
   * logical unit. The config store has no transaction, so the write order is
   * code-then-secret with rollback: a secret-write failure removes the just-
   * written code so no half (code-without-secret) registration survives.
   */
  private persistRegistrationAtomically(deviceCode: string, deviceSecret: string): void {
    let codeWritten = false
    try {
      configManager.set(STATE_DEVICE_CODE as never, deviceCode as never)
      codeWritten = true
      this.persistDeviceAuth(deviceSecret)
    } catch (e) {
      if (codeWritten) {
        try {
          configManager.set(STATE_DEVICE_CODE as never, '' as never)
        } catch (rollbackErr) {
          const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          logger.error(`[persistRegistration] rollback failed: ${detail.slice(0, 200)}`)
        }
      }
      throw e
    }
  }

  /** Public for tests: transport/SSE disconnect observation without import cycles. */
  notifyRelayDisconnect(error?: unknown): void {
    if (error instanceof SyncShutdownError || error instanceof SyncStaleConfigError) return
    this.setServiceConnected(false)
  }

  /**
   * Explicit Connect (SYNC-CC-004/005): first Connect registers the device
   * (stable public code + durable secret); later Connects re-attach with the
   * same credential and reconcile membership. Unknown credentials fail
   * closed and are never silently re-registered. Clears the explicit
   * disconnect stop so auto-reconnect resumes.
   */
  async connect(): Promise<SyncServiceStatus> {
    this.throwIfShutdown()
    let cfg: SyncConfig
    try {
      cfg = this.getConfig()
      const endpointErr = validateEndpointUrl(cfg.endpoint)
      if (endpointErr) throw new Error(endpointErr)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new SyncConfigPreflightError(msg, { cause: e })
    }
    try {
      this.ensurePairingGeneration()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.updateLastError(`connect failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
    try {
      configManager.set(STATE_EXPLICIT_DISCONNECT as never, false as never)
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync attach persistence failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    this.configGeneration += 1
    const connectGen = this.configGeneration
    const snapshot = { endpoint: cfg.endpoint, token: cfg.token }
    // Fail-closed registration coherence (SYNC-CC-004/013): malformed
    // fragments throw here (secret never logged); a half-persisted record
    // (exactly one side present) requires explicit recovery and is never
    // silently re-registered. Only the both-absent case registers below.
    let existingCode: string | null = null
    let existingSecret: string | undefined
    try {
      existingCode = this.getDeviceCodeOrNull()
      existingSecret = this.getDeviceAuth()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.updateLastError(`connect failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
    if ((existingCode !== null) !== (existingSecret !== undefined)) {
      const msg =
        'sync registration incomplete: recovery required (clear registration explicitly before re-registering)'
      try {
        this.updateLastError(`connect failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw new SyncDeviceIdentityError(msg)
    }
    if (existingCode && existingSecret) {
      // Registered: re-attach with the same credential (no rotation) and
      // reconcile membership/channel observation.
      let state: { channelId: string | null }
      try {
        state = await syncClient.getPairState(cfg.endpoint, cfg.token, existingCode, existingSecret)
      } catch (e) {
        if (e instanceof SyncShutdownError || e instanceof SyncStaleConfigError) throw e
        try {
          this.assertConnectFresh(snapshot, connectGen)
        } catch (freshErr) {
          throw freshErr
        }
        this.markRelayContact(false, e)
        const msg = e instanceof Error ? e.message : String(e)
        try {
          this.updateLastError(`connect failed: ${msg}`.slice(0, 1000))
        } catch {}
        throw e instanceof Error ? e : new Error(String(e))
      }
      try {
        this.assertConnectFresh(snapshot, connectGen)
      } catch (freshErr) {
        throw freshErr
      }
      this.markRelayContact(true)
      this.reconcileChannelFull(state.channelId)
      return this.getServiceStatus()
    }
    // First Connect: register and persist the issued credential before any
    // success is reported. Persistence failure fails closed (durable error
    // + throw) so the caller never believes registration succeeded without
    // holding the credential.
    let res: { deviceCode: string; deviceSecret?: string }
    try {
      res = await syncClient.register(cfg.endpoint, cfg.token, { deviceId: this.getDeviceId() })
    } catch (e) {
      if (e instanceof SyncShutdownError || e instanceof SyncStaleConfigError) throw e
      try {
        this.assertConnectFresh(snapshot, connectGen)
      } catch (freshErr) {
        throw freshErr
      }
      this.markRelayContact(false, e)
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.updateLastError(`connect failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw e instanceof Error ? e : new Error(String(e))
    }
    try {
      this.assertConnectFresh(snapshot, connectGen)
    } catch (freshErr) {
      throw freshErr
    }
    this.markRelayContact(true)
    if (!res.deviceSecret) {
      const msg = 'connect failed: register response missing device secret'
      try {
        this.updateLastError(msg)
      } catch {}
      throw new Error(msg)
    }
    try {
      this.assertConnectFresh(snapshot, connectGen)
      this.persistRegistrationAtomically(res.deviceCode, res.deviceSecret)
    } catch (e) {
      if (e instanceof SyncShutdownError || e instanceof SyncStaleConfigError) throw e
      const msg = e instanceof Error ? e.message : String(e)
      try {
        this.updateLastError(`connect credential persistence failed: ${msg}`.slice(0, 1000))
      } catch {}
      throw this.credentialPersistenceError('connect credential', e)
    }
    try {
      this.assertConnectFresh(snapshot, connectGen)
    } catch (freshErr) {
      throw freshErr
    }
    // A fresh registration starts on the channel cursor origin; any stale
    // cursor from a previous identity is never reused.
    this.resetCursorAndChannel()
    logger.info('[connect] device registered')
    return this.getServiceStatus()
  }

  /**
   * Explicit Disconnect (SYNC-CC-005/008): stops service attachment and
   * auto-reconnect but preserves registration, channel membership, and all
   * local chats plus existing outbox intent (nothing is deleted).
   */
  async disconnect(): Promise<SyncServiceStatus> {
    try {
      configManager.set(STATE_EXPLICIT_DISCONNECT as never, true as never)
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync detach persistence failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    this.configGeneration += 1
    this.setServiceConnected(false)
    logger.info('[disconnect] service detached (registration preserved)')
    return this.getServiceStatus()
  }

  /**
   * One-time reset without migration (SYNC-CC-013): superseded
   * invite/founder/trust pairing state carries no compatibility burden and
   * is discarded. Existing local chats and outbox intent are never deleted
   * or moved; only obsolete pairing state (credential, trust mirror,
   * global cursor) is cleared for the registration/channel protocol.
   */
  private ensurePairingGeneration(): void {
    let db: BetterSQLite3Database<typeof schema>
    try {
      db = this.getDb()
    } catch {
      return
    }
    let marker: unknown = null
    try {
      const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_PAIRING_GENERATION)).get()
      marker = row?.value ?? null
    } catch (e) {
      if (isTolerableMissingSyncTable(db, e, MIGRATION_005_KEY)) return
      throw e instanceof Error ? e : new Error(String(e))
    }
    if (marker === PAIRING_GENERATION_CURRENT) {
      // Current generation (cc-1): never auto-clear. Any present code/secret
      // fragment must already be coherent; a malformed or half-persisted
      // registration fails closed with an explicit recovery requirement and
      // is never silently cleared into `unregistered` or auto re-registered.
      // Unified oracle tokens: malformed messages keep the `device code` /
      // `device auth` substrings; half-persisted messages carry
      // `registration incomplete` + `recovery required`. No value (in
      // particular no secret) ever enters the message.
      let code: string | null = null
      let codeErr: unknown = null
      try {
        code = this.getDeviceCodeOrNull()
      } catch (e) {
        codeErr = e
      }
      let secret: string | undefined
      let secretErr: unknown = null
      try {
        secret = this.getDeviceAuth()
      } catch (e) {
        secretErr = e
      }
      if (codeErr !== null || secretErr !== null) {
        const parts: string[] = []
        if (codeErr !== null) parts.push('device code malformed')
        if (secretErr !== null) parts.push('device auth malformed')
        throw new SyncDeviceIdentityError(
          `sync registration ${parts.join(' + ')}: recovery required (clear registration explicitly before re-registering)`
        )
      }
      if (code === null && secret === undefined) return
      if (code !== null && secret !== undefined) return
      throw new SyncDeviceIdentityError(
        'sync registration incomplete: recovery required (clear registration explicitly before re-registering)'
      )
    }
    // First upgrade (marker absent/old, SYNC-CC-013): the reused config keys
    // are still old-generation state, so clearing them alongside the
    // unambiguous old DB state (trust mirror, pre-channel cursor/channel) is
    // safe. A valid code+secret pair proves a live registration and is
    // preserved (only the generation is recorded). Legacy state (a secret
    // without a code, or nothing at all) takes the clear path below.
    //
    // Fail-closed config reads: ANY exception while reading the device code
    // or device auth (storage failure or malformed fragment) throws before
    // any mutation — no credential/cursor/channel/trust cleanup, no cc-1
    // marker write — with a fixed safe message carrying no value that could
    // be a secret and no raw cause. The reset retries on the next entry.
    // Only an explicitly successful read proving absent/legacy state clears
    // below. Both reads share this single handling.
    let code: string | null
    let secret: string | undefined
    try {
      code = this.getDeviceCodeOrNull()
      secret = this.getDeviceAuth()
    } catch {
      throw new SyncDeviceIdentityError('sync pairing reset failed: device identity config read failed (retryable)')
    }
    const codeValid = code !== null
    const secretValid = secret !== undefined
    if (codeValid && secretValid) {
      try {
        db.insert(schema.syncState)
          .values({ key: STATE_PAIRING_GENERATION, value: PAIRING_GENERATION_CURRENT })
          .onConflictDoUpdate({
            target: schema.syncState.key,
            set: { value: PAIRING_GENERATION_CURRENT }
          })
          .run()
      } catch (e) {
        throw new SyncDeviceIdentityError(`sync pairing reset failed: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e
        })
      }
      return
    }
    // Reset legacy state, then record the generation. Every critical cleanup
    // step is fail-closed: a failure throws before the marker is written so
    // the reset retries on the next entry and the failure is explicitly
    // reported (never swallowed + marked complete).
    try {
      configManager.set(STATE_DEVICE_AUTH as never, '' as never)
    } catch (e) {
      throw new SyncDeviceIdentityError(`sync pairing reset failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e
      })
    }
    try {
      configManager.set(STATE_DEVICE_CODE as never, '' as never)
    } catch (e) {
      throw new SyncDeviceIdentityError(`sync pairing reset failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e
      })
    }
    try {
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).run()
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync pairing reset failed: cursor cleanup: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    try {
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CHANNEL_KEY)).run()
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync pairing reset failed: channel cleanup: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    try {
      const sqlite = this.getSqlite()
      sqlite.exec('DROP TABLE IF EXISTS sync_trusted_devices')
    } catch (e) {
      throw new SyncDeviceIdentityError(
        `sync pairing reset failed: trust cleanup: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
    try {
      db.insert(schema.syncState)
        .values({ key: STATE_PAIRING_GENERATION, value: PAIRING_GENERATION_CURRENT })
        .onConflictDoUpdate({
          target: schema.syncState.key,
          set: { value: PAIRING_GENERATION_CURRENT }
        })
        .run()
    } catch (e) {
      throw new SyncDeviceIdentityError(`sync pairing reset failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e
      })
    }
    this.setServiceConnected(false)
    logger.info('[ensurePairingGeneration] legacy pairing state reset for channel protocol')
  }

  /** Internal channel identity for cursor scoping (never user-visible). */
  getChannelKey(): string | null {
    const db = this.getDb()
    try {
      const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CHANNEL_KEY)).get()
      if (!row) return null
      try {
        return parseSyncChannelKeyValue(row.value)
      } catch {
        throw new SyncCursorError('malformed persisted channel key')
      }
    } catch (e) {
      if (e instanceof SyncCursorError) throw e
      if (isTolerableMissingSyncTable(db, e, MIGRATION_005_KEY)) return null
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  private setChannelKey(channelId: string | null): void {
    const db = this.getDb()
    if (channelId === null) {
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CHANNEL_KEY)).run()
      return
    }
    db.insert(schema.syncState)
      .values({ key: STATE_CHANNEL_KEY, value: channelId })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: channelId } })
      .run()
  }

  private resetCursorAndChannel(): void {
    this.updateCursor(0)
    this.setChannelKey(null)
  }

  /**
   * Reconcile an observed channel identity (SYNC-CC-016): first observation
   * records the channel; a changed channel resets the cursor to that
   * channel's own origin (never reused across channels). Returns true only
   * when switching away from a previously known channel.
   */
  reconcileChannelKey(channelId: string | undefined): boolean {
    if (channelId === undefined) return false
    const stored = this.getChannelKey()
    if (stored === channelId) return false
    this.updateCursor(0)
    this.setChannelKey(channelId)
    logger.info('[reconcileChannel] channel identity changed; cursor reset to channel origin')
    return stored !== null
  }

  /** Full reconcile including the unpaired case (dissolve observation). Returns true on any channel change. */
  private reconcileChannelFull(channelId: string | null): boolean {
    if (channelId === null) {
      if (this.getChannelKey() !== null) {
        this.updateCursor(0)
        this.setChannelKey(null)
        logger.info('[reconcileChannel] unpaired; channel cursor cleared')
        this.emitChannelChange()
        return true
      }
      return false
    }
    const before = this.getChannelKey()
    this.reconcileChannelKey(channelId)
    if (this.getChannelKey() !== before) {
      this.emitChannelChange()
      return true
    }
    return false
  }

  private pairingTransport(): { endpoint: string; token: string | undefined } {
    const cfg = this.getConfig()
    const endpointErr = validateEndpointUrl(cfg.endpoint)
    if (endpointErr) throw new Error(endpointErr)
    return { endpoint: cfg.endpoint, token: cfg.token }
  }

  /** Fail-closed transport requirement for pairing actions (must Connect first). */
  private requirePairingTransport(): {
    endpoint: string
    token: string | undefined
    deviceCode: string
    deviceSecret: string
  } {
    const attached = this.requireAttachedService()
    const { endpoint, token } = this.pairingTransport()
    return { endpoint, token, deviceCode: attached.deviceCode, deviceSecret: attached.deviceSecret }
  }

  /**
   * Channel pairing state for this device (SYNC-CC-003/006): Unpaired /
   * Outgoing pending / Incoming pending / Paired, observed via the relay.
   */
  async getPairState(): Promise<SyncPairState> {
    this.throwIfShutdown()
    try {
      this.ensurePairingGeneration()
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e))
    }
    const { endpoint, token, deviceCode, deviceSecret } = this.requirePairingTransport()
    let res: {
      deviceCode: string
      paired: boolean
      channelId: string | null
      outgoing: SyncPairState['outgoing']
      incoming: SyncPairState['incoming']
    }
    try {
      res = await syncClient.getPairState(endpoint, token, deviceCode, deviceSecret)
      this.markRelayContact(true)
    } catch (e) {
      this.markRelayContact(false, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
    this.reconcileChannelFull(res.channelId)
    const state: SyncPairingState = res.paired
      ? 'paired'
      : res.outgoing
        ? 'outgoing'
        : res.incoming.length > 0
          ? 'incoming'
          : 'unpaired'
    return { deviceCode: res.deviceCode, state, outgoing: res.outgoing, incoming: res.incoming }
  }

  /**
   * Request pairing with the target device code (SYNC-CC-007/008). A paired
   * requester cannot initiate (refused client-side before any relay call,
   * SYNC-CC-009); the relay additionally fails closed.
   */
  async requestPairing(targetCode: string): Promise<{ requestId: string; status: string }> {
    this.throwIfShutdown()
    const codeErr = validatePairingCode(targetCode)
    if (codeErr) throw new Error(codeErr)
    const current = await this.getPairState()
    if (current.state === 'paired') {
      throw new Error('already paired (unpair before requesting a new pairing)')
    }
    const { endpoint, token } = this.pairingTransport()
    const secret = this.getDeviceAuth()
    if (!secret) throw new Error('service not connected (registration required; Connect to register)')
    try {
      const res = await syncClient.requestPairing(endpoint, token, { targetCode }, current.deviceCode, secret)
      this.markRelayContact(true)
      logger.info('[requestPairing] request submitted')
      return res
    } catch (e) {
      this.markRelayContact(false, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Cancel this device's outgoing pending request (SYNC-CC-008/010). */
  async cancelPairing(requestId?: string): Promise<{ requestId: string }> {
    this.throwIfShutdown()
    if (requestId !== undefined) {
      const idErr = validatePairingRequestId(requestId)
      if (idErr) throw new Error(idErr)
    }
    const { endpoint, token, deviceCode, deviceSecret } = this.requirePairingTransport()
    try {
      const res = await syncClient.cancelPairing(endpoint, token, { requestId }, deviceCode, deviceSecret)
      this.markRelayContact(true)
      logger.info('[cancelPairing] request cancelled')
      return res
    } catch (e) {
      this.markRelayContact(false, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /**
   * Accept an incoming request as the target (SYNC-CC-009): both unpaired
   * => a channel is created for both; requester unpaired + this target
   * paired => the requester joins this channel; a paired requester fails
   * with no merge. Returns the (internal, never user-visible) channel
   * identity for cursor scoping.
   */
  async acceptPairing(requestId: string): Promise<{ channelId: string }> {
    this.throwIfShutdown()
    const idErr = validatePairingRequestId(requestId)
    if (idErr) throw new Error(idErr)
    const { endpoint, token, deviceCode, deviceSecret } = this.requirePairingTransport()
    try {
      const res = await syncClient.acceptPairing(endpoint, token, { requestId }, deviceCode, deviceSecret)
      this.markRelayContact(true)
      this.reconcileChannelFull(res.channelId)
      logger.info('[acceptPairing] request accepted')
      return res
    } catch (e) {
      this.markRelayContact(false, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** Reject an incoming request as the target (SYNC-CC-008/010). */
  async rejectPairing(requestId: string): Promise<void> {
    this.throwIfShutdown()
    const idErr = validatePairingRequestId(requestId)
    if (idErr) throw new Error(idErr)
    const { endpoint, token, deviceCode, deviceSecret } = this.requirePairingTransport()
    try {
      await syncClient.rejectPairing(endpoint, token, { requestId }, deviceCode, deviceSecret)
      this.markRelayContact(true)
      logger.info('[rejectPairing] request rejected')
    } catch (e) {
      this.markRelayContact(false, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /**
   * Unpair this device (SYNC-CC-005/008/011): requires a connected relay
   * (refused while disconnected — Connect first). Atomically removes only
   * self membership; service registration and all local chats plus outbox
   * intent are preserved. Sub-two membership dissolves the channel; this
   * client observes unpaired afterwards.
   */
  async unpair(): Promise<void> {
    this.throwIfShutdown()
    const { endpoint, token, deviceCode, deviceSecret } = this.requirePairingTransport()
    try {
      await syncClient.unpair(endpoint, token, deviceCode, deviceSecret)
      this.markRelayContact(true)
    } catch (e) {
      this.markRelayContact(false, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
    this.reconcileChannelFull(null)
    logger.info('[unpair] self membership removed (service preserved)')
  }

  clearAllForTests(): void {
    this.resetShutdownForTests()
    this.configGeneration = 0
    this.serviceConnected = false
    try {
      configManager.set(STATE_DEVICE_AUTH as never, '' as never)
    } catch {}
    try {
      configManager.set(STATE_DEVICE_CODE as never, '' as never)
    } catch {}
    try {
      configManager.set(STATE_EXPLICIT_DISCONNECT as never, false as never)
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
        db.delete(schema.syncMembershipClock).run()
      } catch {}
      try {
        db.delete(schema.syncParentOrderFrame).run()
      } catch {}
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CHANNEL_KEY)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_PAIRING_GENERATION)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_SYNC_AT)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_ERROR)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CAPTURE_ERROR)).run()
    } catch {}
  }
}

export const syncService = new SyncService()
