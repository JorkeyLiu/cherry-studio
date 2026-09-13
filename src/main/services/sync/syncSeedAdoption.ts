/**
 * One-shot seed adoption (SYNC-CC-026 / SYNC-DATA-058): current adoption event
 * for ordinary stable supported history on the grant holder.
 *
 * Never forges createdAt/entityClock: all clocks use the existing wall /
 * high-water monotonic mechanism with entity ops preceding frames. Single Main
 * SQLite write transaction for all eligible live topic/message/success-
 * supported blocks: full-state upsert (allowlist, no sortOrder), entity +
 * present-field clocks (via enqueueUpsertInTx LWW), message/block membership
 * (setMembershipClockInTx, topics carry none per contract), and complete
 * topic->message + message->block frames (tryRefresh helpers + order_frame
 * ops reusing winning frameClock verbatim). All atomic; any failure rolls
 * back with zero partial outbox/clocks/frames.
 *
 * Precondition (0-write on fail): ordinary stable supported history only, and
 * the local candidate must have no ambiguity beyond version absence
 * (entity/field/membership/order-frame). Any transient/unsupported/orphan/
 * conflict/tombstone-ambiguity/other incomplete reason defers with grant
 * pending retained and an explicit skip/deferred reason. First close strictly
 * allows only version-absence: any local tombstone or replacement register
 * defers with 0 writes (grant retained, no merge attempt).
 *
 * Idempotency: existing clocks are never rewritten; a pending grant with an
 * already-adopted local state only continues drain+publish (already-adopted).
 *
 * Shared contract: adoption payload allowlists and the persisted-clock
 * max-scan table boundary live in `syncAdoptionShared` (single source with
 * the receiver-union path); this holder path reuses candidate payloads built
 * by capture and service enqueue sequencing, so no second allowlist exists.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'
import { scanAdoptionMaxObserved } from './syncAdoptionShared'
import { captureLocalSyncBaselineCandidate } from './syncBaseline'

export type SeedAdoptionResult =
  | { kind: 'adopted'; detail: string; mintedEntities: number; mintedFrames: number }
  | { kind: 'already-adopted'; detail: string }
  | { kind: 'deferred'; reason: string; detail: string }

type SeedAdoptionDb = BetterSQLite3Database<typeof schema>

interface SeedAdoptionService {
  getDeviceId(): string
  enqueueUpsertInTx(
    tx: unknown,
    entityType: 'topic' | 'message' | 'message_block',
    entityId: string,
    payload: Record<string, unknown>,
    timestamp: number,
    deviceId: string
  ): string
  setMembershipClockInTx(
    tx: unknown,
    childEntityType: 'message' | 'message_block',
    childEntityId: string,
    parentId: string,
    timestamp: number,
    operationId: string
  ): void

  tryRefreshTopicMessageFrameAndEnqueueInTx(tx: unknown, parentId: string, deviceId: string): any

  tryRefreshMessageBlockFrameAndEnqueueInTx(tx: unknown, parentId: string, deviceId: string): any
  getMembershipClockInTx(
    tx: unknown,
    childEntityType: 'message' | 'message_block',
    childEntityId: string
  ): { parentId: string; timestamp: number; operationId: string } | null
}

/** Reasons that are pure version absence (plus drainable outbox), all else defers. */
const SEED_ALLOWED_REASONS = new Set([
  'unversioned-entity',
  'unversioned-field',
  'unversioned-membership',
  'missing-order-frame',
  'incomplete-order-frame',
  'pending-outbox'
])

function isSafeAdoptionTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER
}

export function adoptSeedBaselineOnce(db: SeedAdoptionDb, service: SeedAdoptionService): SeedAdoptionResult {
  let candidate: ReturnType<typeof captureLocalSyncBaselineCandidate>
  try {
    candidate = captureLocalSyncBaselineCandidate(db)
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)
    return { kind: 'deferred', reason: 'candidate-capture-failed', detail }
  }
  if (candidate.observationBinding !== 'bound') {
    return {
      kind: 'deferred',
      reason: 'unbound-channel',
      detail: 'seed adoption requires a bound channel/cursor observation'
    }
  }
  const reasons = Array.isArray(candidate.completeness?.reasons) ? candidate.completeness.reasons : []
  const blocking = reasons.filter((r) => !SEED_ALLOWED_REASONS.has(r))
  if (blocking.length > 0) {
    return {
      kind: 'deferred',
      reason: 'seed-precondition-not-met',
      detail: `seed adoption deferred: ${blocking.slice().sort().join(',').slice(0, 300)}`
    }
  }
  if (candidate.completeness?.state === 'complete') {
    return { kind: 'already-adopted', detail: 'seed candidate already complete (clocks preserved, no rewrite)' }
  }
  // First-close strict gate: any local tombstone or replacement register present
  // defers with 0 writes. The syncBaselineApply merge core remains the sole
  // receiver decision; this gate explicitly excludes tombstone/register from
  // adoption monotonic computation (logic below documents the exclusion).
  try {
    const hasTombstone = (() => {
      try {
        const rows = db.select().from(schema.syncState).all() as Array<{ key: string }>
        return rows.some((r) => typeof r.key === 'string' && r.key.startsWith('tombstone:'))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/no such table/i.test(msg)) return false
        throw e
      }
    })()
    if (hasTombstone) {
      return {
        kind: 'deferred',
        reason: 'seed-tombstone-present',
        detail: 'seed adoption deferred: local tombstone present (first close supports only live history)'
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/no such table/i.test(msg)) {
      return { kind: 'deferred', reason: 'seed-tombstone-present', detail: msg.slice(0, 300) }
    }
  }
  try {
    const hasRegister = (() => {
      try {
        const rows = db.select().from(schema.syncStableReplaceRegister).all() as unknown[]
        return rows.length > 0
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/no such table/i.test(msg)) return false
        throw e
      }
    })()
    if (hasRegister) {
      return {
        kind: 'deferred',
        reason: 'seed-replacement-present',
        detail: 'seed adoption deferred: local replacement register present (first close excludes replacement)'
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/no such table/i.test(msg)) {
      return { kind: 'deferred', reason: 'seed-replacement-present', detail: msg.slice(0, 300) }
    }
  }
  let deviceId: string
  try {
    deviceId = service.getDeviceId()
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)
    return { kind: 'deferred', reason: 'device-id-unavailable', detail }
  }
  const baseWall = Date.now()
  if (!isSafeAdoptionTimestamp(baseWall)) {
    return { kind: 'deferred', reason: 'wall-clock-invalid', detail: 'adoption wall clock not a safe integer' }
  }
  const run = (txArg?: unknown): SeedAdoptionResult => {
    const tx = (txArg ?? db) as unknown
    const txDb = (txArg ?? db) as BetterSQLite3Database<typeof schema>
    // Compute monotonic adoption clock inside the same adoption transaction
    // snapshot via the shared single-source scan (entity/field + membership +
    // parent frames + frame high-water). Tombstone and replacement register
    // clocks are excluded by the preflight above (0-write deferred if present,
    // so adoption never observes them; logic explicitly documents this).
    const maxObserved = scanAdoptionMaxObserved(txDb)
    const adoptionTs = Math.max(baseWall, maxObserved + 1)
    if (!isSafeAdoptionTimestamp(adoptionTs) || adoptionTs >= Number.MAX_SAFE_INTEGER) {
      throw new Error('seed adoption timestamp exhausted')
    }
    // Re-read clocks inside the write tx so already-adopted rows are never
    // rewritten (lost-response/restart idempotency).
    let mintedEntities = 0
    const ordered = [...candidate.entities].sort((a, b) => {
      const rank = (t: string): number => (t === 'topic' ? 0 : t === 'message' ? 1 : 2)
      const r = rank(a.entityType) - rank(b.entityType)
      if (r !== 0) return r
      return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
    })
    for (const entity of ordered) {
      const needsEntity = !entity.entityClock
      let needsField = false
      try {
        const present = new Set(entity.fieldClocks.map((f) => f.field))
        for (const key of Object.keys(entity.payload)) {
          if (key === 'id' || key === 'topicId' || key === 'messageId') continue
          if (!present.has(key)) {
            needsField = true
            break
          }
        }
      } catch {
        needsField = true
      }
      let needsMembership = false
      if (entity.entityType !== 'topic') {
        const pm = (entity as { parentMembershipClock?: { timestamp: number; operationId: string } | null })
          .parentMembershipClock
        if (!pm) {
          needsMembership = true
        } else {
          try {
            const existing = service.getMembershipClockInTx(tx, entity.entityType, entity.entityId)
            if (existing) {
              const expectedParent =
                entity.entityType === 'message'
                  ? (entity.payload.topicId as string)
                  : (entity.payload.messageId as string)
              if (existing.parentId !== expectedParent) {
                throw new Error(`seed adoption parent mismatch for ${entity.entityType}/${entity.entityId}`)
              }
              needsMembership = false
            } else {
              needsMembership = true
            }
          } catch (e) {
            throw e instanceof Error ? e : new Error(String(e))
          }
        }
      }
      if (!needsEntity && !needsField && !needsMembership) continue
      const opTs = adoptionTs
      if (!isSafeAdoptionTimestamp(opTs) || opTs >= Number.MAX_SAFE_INTEGER) {
        throw new Error('seed adoption timestamp exhausted')
      }
      const payload = { ...entity.payload }
      const opId = service.enqueueUpsertInTx(tx, entity.entityType, entity.entityId, payload, opTs, deviceId)
      if (needsMembership && entity.entityType !== 'topic') {
        const parentId =
          entity.entityType === 'message' ? (entity.payload.topicId as string) : (entity.payload.messageId as string)
        service.setMembershipClockInTx(tx, entity.entityType, entity.entityId, parentId, opTs, opId)
      }
      mintedEntities += 1
    }
    const parentTopics = new Set<string>()
    const parentMessages = new Set<string>()
    for (const entity of ordered) {
      if (entity.entityType === 'topic') parentTopics.add(entity.entityId)
      if (entity.entityType === 'message') {
        parentTopics.add(entity.payload.topicId as string)
        parentMessages.add(entity.entityId)
      }
      if (entity.entityType === 'message_block') parentMessages.add(entity.payload.messageId as string)
    }
    for (const f of candidate.orderFrames) {
      if (f.kind === 'topicMessage') parentTopics.add(f.parentId)
      else parentMessages.add(f.parentId)
    }
    let mintedFrames = 0
    for (const topicId of [...parentTopics].sort()) {
      const res = service.tryRefreshTopicMessageFrameAndEnqueueInTx(tx, topicId, deviceId)
      if (res === 'invalidated') {
        throw new Error(`seed adoption incomplete frame for topic ${topicId}`)
      }
      mintedFrames += 1
    }
    for (const messageId of [...parentMessages].sort()) {
      const res = service.tryRefreshMessageBlockFrameAndEnqueueInTx(tx, messageId, deviceId)
      if (res === 'invalidated') {
        throw new Error(`seed adoption incomplete frame for message ${messageId}`)
      }
      mintedFrames += 1
    }
    if (mintedEntities === 0) {
      return { kind: 'already-adopted', detail: 'seed clocks already present (no rewrite)' }
    }
    return {
      kind: 'adopted',
      detail: `seed adopted ${mintedEntities} entities + ${mintedFrames} frames`,
      mintedEntities,
      mintedFrames
    }
  }
  try {
    const txDb = db as unknown as { transaction: (fn: (tx: unknown) => SeedAdoptionResult) => SeedAdoptionResult }
    return txDb.transaction((tx) => run(tx))
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)
    return { kind: 'deferred', reason: 'seed-adoption-tx-failed', detail }
  }
}
