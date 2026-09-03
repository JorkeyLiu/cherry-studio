import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import type { SyncConfig, SyncOperation, SyncPushRequest, SyncStatus } from '@shared/sync'
import {
  filterBlockPayload,
  filterMessagePayload,
  filterTopicPayload,
  SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH,
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
const TOMBSTONE_TOPIC_PREFIX = 'tombstone:topic:'
const TOMBSTONE_MESSAGE_PREFIX = 'tombstone:message:'

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

export class SyncService {
  private statusSyncing = false

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
    return this.getConfig()
  }

  getStatus(): SyncStatus {
    const cfg = this.getConfig()
    const sqlite = this.tryGetSqlite()
    let pendingCount = 0
    let cursor = 0
    let lastSyncAt: string | null = null
    let lastError: string | null = null
    if (sqlite) {
      try {
        const db = this.getDb()
        pendingCount = db.select().from(schema.syncOutbox).all().length
        const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).get()
        cursor = cursorRow ? parseInt(cursorRow.value ?? '0', 10) || 0 : 0
        const lastSyncRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_SYNC_AT)).get()
        lastSyncAt = lastSyncRow?.value ?? null
        const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_ERROR)).get()
        lastError = errRow?.value ?? null
      } catch {
        // ignore if migration not yet applied
      }
    }
    return {
      enabled: cfg.enabled,
      endpoint: cfg.endpoint,
      lastSyncAt,
      lastError,
      pendingCount,
      cursor,
      syncing: this.statusSyncing
    }
  }

  private tryGetSqlite(): Database.Database | null {
    try {
      return this.getSqlite()
    } catch {
      return null
    }
  }

  getDeviceId(): string {
    let deviceId = configManager.get<string>(STATE_DEVICE_ID as any, '') ?? ''
    if (!deviceId) {
      deviceId = randomUUID()
      configManager.set(STATE_DEVICE_ID as any, deviceId)
      try {
        const db = this.getDb()
        db.insert(schema.syncState)
          .values({ key: STATE_DEVICE_ID, value: deviceId })
          .onConflictDoUpdate({ target: schema.syncState.key, set: { value: deviceId } })
          .run()
      } catch {}
    }
    try {
      const db = this.getDb()
      const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_DEVICE_ID)).get()
      if (!row) {
        db.insert(schema.syncState).values({ key: STATE_DEVICE_ID, value: deviceId }).run()
      }
    } catch {}
    return deviceId
  }

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
    } catch {}
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
      if (inserted && op.op === 'delete' && (op.entityType === 'topic' || op.entityType === 'message')) {
        this.setTombstoneInDb(db, op.entityType, op.entityId, op.timestamp, op.id)
      }
      sqlite.exec('COMMIT')
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      throw e
    }
  }

  private tombstoneKey(entityType: string, entityId: string): string {
    return entityType === 'topic' ? `${TOMBSTONE_TOPIC_PREFIX}${entityId}` : `${TOMBSTONE_MESSAGE_PREFIX}${entityId}`
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
    entityType: 'topic' | 'message',
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

  private getTombstone(
    entityType: 'topic' | 'message',
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
    try {
      const db = this.getDb()
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
    } catch {
      return false
    }
  }

  /** True when the entity was ever observed locally (clock or pending outbox). Guards foreign destructive deletes. */
  isKnownEntity(entityType: SyncOperation['entityType'], entityId: string): boolean {
    try {
      const db = this.getDb()
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
    } catch {
      return false
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

    if (!this.shouldApplyIncoming(op)) {
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
        this.applyUpsert(op)
        appliedEntity = true
      } else if (op.op === 'delete') {
        this.applyDelete(op)
        appliedEntity = true
      }
      // Only update clock/applied if entity mutation succeeded (orphan throws before here)
      db.insert(schema.syncEntityClock)
        .values({ entityType: op.entityType, entityId: op.entityId, timestamp: op.timestamp, operationId: op.id })
        .onConflictDoUpdate({
          target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
          set: { timestamp: op.timestamp, operationId: op.id }
        })
        .run()
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

  private applyUpsert(op: SyncOperation): void {
    const db = this.getDb()
    const nowIso = new Date().toISOString()
    const p = op.payload ?? {}
    if (op.entityType === 'topic') {
      const id = op.entityId
      const name = (p.name as string | null) ?? null
      const assistantId = (p.assistantId as string | null) ?? null
      const createdAt = (p.createdAt as string | null) ?? nowIso
      const updatedAt = (p.updatedAt as string | null) ?? nowIso
      const deletedAt = (p.deletedAt as string | null) ?? null
      // Upsert topic — preserve soft-delete semantics
      db.insert(schema.topics)
        .values({ id, name, assistantId, createdAt, updatedAt, deletedAt, extra: null })
        .onConflictDoUpdate({
          target: schema.topics.id,
          set: { name, assistantId, updatedAt, deletedAt }
        })
        .run()
    } else if (op.entityType === 'message') {
      const id = op.entityId
      const topicId = (p.topicId as string) ?? ''
      if (!topicId) throw new Error('message upsert missing topicId')
      // Tombstone guard (common LWW comparator): a losing child must not
      // resurrect a hard-deleted parent. An equal-timestamp op wins only
      // when its operation ID is strictly greater than the delete's ID.
      const topicTomb = this.getTombstone('topic', topicId)
      if (topicTomb !== null && this.isSuppressedByTombstone(op.timestamp, op.id, topicTomb)) {
        logger.warn(`[applyUpsert] message ${id} suppressed by topic tombstone ${topicId}`)
        // Narrow containment: materialize an exact message tombstone for this
        // suppressed (never-local) message so a later stale block for the
        // same message is recognized and suppressed via its specific parent
        // tombstone. Identity inherits the topic tombstone (the delete), not
        // the stale op, so any block stale relative to the delete is covered.
        // Runs inside the caller's transaction: atomic with clock/applied.
        // Fail closed: materialization failure propagates so the suppressed
        // op is not marked applied and its entity clock does not advance.
        this.setTombstoneInDb(db, 'message', id, topicTomb.timestamp, topicTomb.operationId)
        return
      }
      const existingPre = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()
      if (existingPre && existingPre.topicId !== topicId) {
        // Immutable parent identity: never reparent an existing message.
        // Skip mutation (clock/applied still advance via caller) and keep
        // the existing topicId.
        logger.warn(`[applyUpsert] message ${id} reparent ${existingPre.topicId} -> ${topicId} rejected`)
        return
      }
      const topicRow = db.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get()
      if (!topicRow) {
        db.insert(schema.topics)
          .values({ id: topicId, name: null, createdAt: nowIso, updatedAt: nowIso })
          .onConflictDoNothing()
          .run()
      }
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
      const existing = existingPre ?? db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()
      if (!existing) {
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
      } else {
        // Bounded ordering: preserve full incoming ordering state on existing
        // rows so reorder converges via LWW. Per-entity LWW (not a broad
        // ordering redesign); duplicates remain possible but converge equally.
        db.update(schema.messages)
          .set({ role, content, status, askId, model, modelId, assistantId, createdAt, updatedAt, sortOrder })
          .where(eq(schema.messages.id, id))
          .run()
      }
    } else if (op.entityType === 'message_block') {
      const id = op.entityId
      const messageId = (p.messageId as string) ?? ''
      if (!messageId) throw new Error('block upsert missing messageId')
      // Tombstone first (common LWW comparator): a stale late child of a
      // hard-deleted parent must be rejected (suppressed), never stall as
      // a retryable orphan. Equal timestamp wins only with a strictly
      // greater operation ID.
      const msgTomb = this.getTombstone('message', messageId)
      if (msgTomb !== null && this.isSuppressedByTombstone(op.timestamp, op.id, msgTomb)) {
        logger.warn(`[applyUpsert] block ${id} suppressed by message tombstone ${messageId}`)
        return
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
        return
      }
      const type = (p.type as string | null) ?? null
      const content = (p.content as string | null) ?? null
      const status = (p.status as string | null) ?? null
      const createdAt = (p.createdAt as string | null) ?? nowIso
      const updatedAt = (p.updatedAt as string | null) ?? nowIso
      const rawSortB = p.sortOrder as number | null | undefined
      const sortOrder = typeof rawSortB === 'number' && Number.isFinite(rawSortB) ? rawSortB : 0
      const existing =
        existingPreB ?? db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, id)).get()
      if (!existing) {
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
      } else {
        db.update(schema.messageBlocks)
          .set({ type, content, status, createdAt, updatedAt, sortOrder })
          .where(eq(schema.messageBlocks.id, id))
          .run()
      }
    }
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
    const cfg = this.getConfig()
    if (!cfg.enabled) throw new Error('sync is disabled')
    const endpointErr = validateEndpointUrl(cfg.endpoint)
    if (endpointErr) throw new Error(endpointErr)
    this.statusSyncing = true
    try {
      const deviceId = this.getDeviceId()
      const db = this.getDb()
      const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).get()
      const cursor = cursorRow ? parseInt(cursorRow.value ?? '0', 10) || 0 : 0

      // Push all outbox chunks — never advance pull cursor on push
      let outboxOps = this.listOutbox()
      while (outboxOps.length > 0) {
        const chunk = outboxOps.slice(0, SYNC_MAX_OPERATIONS_PER_PUSH)
        const chunkIds = new Set(chunk.map((o) => o.id))
        const pushReq: SyncPushRequest = { deviceId, operations: chunk }
        try {
          const pushRes = await syncClient.push(cfg.endpoint, cfg.token, pushReq)
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
          const msg = e instanceof Error ? e.message : String(e)
          this.updateLastError(msg)
          throw e
        }
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
        let pullRes: { operations: any[]; cursor: number }
        try {
          pullRes = await syncClient.pull(cfg.endpoint, cfg.token, fetchCursor, deviceId)
        } catch (e) {
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
              logger.warn(`[sync] orphan ${op.id} buffered for later-page retry`)
              if (typeof op.seq === 'number') deferred.push({ op, seq: op.seq })
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
      if (!pullError && !applyError) {
        this.updateLastSyncAt(new Date().toISOString())
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

  /** Contiguous pull framing: ops must be exactly fetchCursor+1 ... fetchCursor+n, cursor must equal last seq. */
  private assertContiguousPull(
    fetchCursor: number,
    pullRes: { operations: Array<{ seq?: unknown }>; cursor: number }
  ): void {
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
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq !== expected) {
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

  clearAllForTests(): void {
    try {
      const db = this.getDb()
      db.delete(schema.syncOutbox).run()
      db.delete(schema.syncApplied).run()
      db.delete(schema.syncEntityClock).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CURSOR)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_SYNC_AT)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_LAST_ERROR)).run()
      db.delete(schema.syncState).where(eq(schema.syncState.key, STATE_CAPTURE_ERROR)).run()
    } catch {}
  }
}

export const syncService = new SyncService()
