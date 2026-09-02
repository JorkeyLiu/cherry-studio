import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import type { SyncConfig, SyncOperation, SyncPushRequest, SyncStatus } from '@shared/sync'
import {
  filterBlockPayload,
  filterMessagePayload,
  filterTopicPayload,
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

export class SyncOrphanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncOrphanError'
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
      sqlite.exec('COMMIT')
    } catch (e) {
      try {
        sqlite.exec('ROLLBACK')
      } catch {}
      throw e
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
    return rows.map((r) => ({
      id: r.id,
      entityType: r.entityType as SyncOperation['entityType'],
      op: r.op as SyncOperation['op'],
      entityId: r.entityId,
      timestamp: r.timestamp,
      deviceId: r.deviceId,
      payload: r.payloadJson ? (JSON.parse(r.payloadJson) as Record<string, unknown>) : undefined
    }))
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
      if (incoming.timestamp > clockRow.timestamp) return true
      if (incoming.timestamp < clockRow.timestamp) return false
      return incoming.id > clockRow.operationId
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
      if (incoming.timestamp > candidate.timestamp) return true
      if (incoming.timestamp < candidate.timestamp) return false
      return incoming.id > candidate.id
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

    if (!this.shouldApplyIncoming(op)) {
      db.transaction((tx) => {
        tx.insert(schema.syncApplied).values({ operationId: op.id, appliedAt: new Date().toISOString() }).run()
      })
      logger.info(`[applyIncoming] LWW rejected ${op.id} for ${op.entityType}/${op.entityId}`)
      return false
    }

    const allowErr = validateSyncPayloadAllowlist(op)
    if (allowErr) {
      logger.warn(`[applyIncoming] payload rejected ${op.id}: ${allowErr}`)
      db.insert(schema.syncApplied).values({ operationId: op.id, appliedAt: new Date().toISOString() }).run()
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
      const sortOrder = (p.sortOrder as number | null) ?? 0
      const existing = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()
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
        db.update(schema.messages)
          .set({ topicId, role, content, status, askId, model, modelId, assistantId, createdAt, updatedAt })
          .where(eq(schema.messages.id, id))
          .run()
      }
    } else if (op.entityType === 'message_block') {
      const id = op.entityId
      const messageId = (p.messageId as string) ?? ''
      if (!messageId) throw new Error('block upsert missing messageId')
      const msg = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
      if (!msg) {
        throw new SyncOrphanError(`orphan block ${id} parent ${messageId} missing`)
      }
      const type = (p.type as string | null) ?? null
      const content = (p.content as string | null) ?? null
      const status = (p.status as string | null) ?? null
      const createdAt = (p.createdAt as string | null) ?? nowIso
      const updatedAt = (p.updatedAt as string | null) ?? nowIso
      const sortOrder = (p.sortOrder as number | null) ?? 0
      const existing = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, id)).get()
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
          .set({ messageId, type, content, status, createdAt, updatedAt })
          .where(eq(schema.messageBlocks.id, id))
          .run()
      }
    }
  }

  private applyDelete(op: SyncOperation): void {
    const db = this.getDb()
    if (op.entityType === 'topic') {
      db.delete(schema.topics).where(eq(schema.topics.id, op.entityId)).run()
    } else if (op.entityType === 'message') {
      db.delete(schema.messages).where(eq(schema.messages.id, op.entityId)).run()
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
        const pushReq: SyncPushRequest = { deviceId, operations: chunk }
        try {
          const pushRes = await syncClient.push(cfg.endpoint, cfg.token, pushReq)
          const acked = pushRes.acceptedIds
          if (acked.length > 0) this.clearOutboxByIds(acked)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.updateLastError(msg)
          throw e
        }
        outboxOps = this.listOutbox()
        // Break after one chunk if we had limit? but keep looping until drained — guards large outbox
        if (outboxOps.length === 0) break
      }

      // Pull loop — page until exhausted, advance cursor only after successful application
      let currentCursor = cursor
      let pagingDone = false
      let pullError: unknown = null
      while (!pagingDone) {
        let pullRes: { operations: any[]; cursor: number }
        try {
          pullRes = await syncClient.pull(cfg.endpoint, cfg.token, currentCursor, deviceId)
        } catch (e) {
          pullError = e
          const msg = e instanceof Error ? e.message : String(e)
          this.updateLastError(msg)
          throw e
        }
        const ops = pullRes.operations ?? []
        if (ops.length === 0) {
          pagingDone = true
          break
        }
        // Apply each op in seq order; track contiguous success
        let lastSuccessfulSeq = currentCursor
        let encounteredOrphan = false
        for (const op of ops) {
          if (op.deviceId === deviceId) {
            const already = db.select().from(schema.syncApplied).where(eq(schema.syncApplied.operationId, op.id)).get()
            if (!already) {
              db.insert(schema.syncApplied).values({ operationId: op.id, appliedAt: new Date().toISOString() }).run()
            }
            // Own echo advances cursor contiguously
            if (typeof op.seq === 'number') lastSuccessfulSeq = op.seq
            continue
          }
          try {
            this.applyIncomingOperation(op as SyncOperation)
            if (typeof op.seq === 'number') lastSuccessfulSeq = op.seq
          } catch (inner) {
            if (inner instanceof SyncOrphanError) {
              logger.warn(`[sync] orphan ${op.id} deferred, cursor stays at ${lastSuccessfulSeq}`)
              encounteredOrphan = true
              // Do not advance beyond orphan; keep cursor at last success before orphan
              // Break applying remaining ops in this page to preserve contiguous advancement
              break
            }
            logger.error(`[sync] apply ${op.id} failed`, inner as Error)
            // Non-orphan error — also keep cursor at last success, but continue? Fail closed: stop advancing
            encounteredOrphan = true
            break
          }
        }
        // Advance cursor only to contiguously successful seq
        if (lastSuccessfulSeq > currentCursor) {
          this.updateCursor(lastSuccessfulSeq)
          currentCursor = lastSuccessfulSeq
        }
        if (encounteredOrphan) {
          // Do not page further — retry orphan next sync
          pagingDone = true
          break
        }
        // If we returned full page, there may be more — continue pulling from lastSuccessfulSeq (which equals last seq of page if no orphan)
        // The relay returns last seq returned; if ops.length < limit we are done
        if (ops.length < SYNC_MAX_OPERATIONS_PER_PULL) {
          pagingDone = true
        } else {
          // If ops.length == limit, loop will pull next page; but ensure we use returned cursor not global max
          // If lastSuccessfulSeq didn't move (all were own echoes?), still advance to ops[ops.length-1].seq
          if (lastSuccessfulSeq === currentCursor && ops.length > 0) {
            // All ops were duplicates/own? Then advance to last seq
            const lastSeq = ops[ops.length - 1].seq
            if (typeof lastSeq === 'number' && lastSeq > currentCursor) {
              this.updateCursor(lastSeq)
              currentCursor = lastSeq
            }
          }
          // Continue loop to check next page
        }
      }
      if (!pullError) {
        this.updateLastSyncAt(new Date().toISOString())
        this.updateLastError(null)
      }
      return this.getStatus()
    } finally {
      this.statusSyncing = false
    }
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
