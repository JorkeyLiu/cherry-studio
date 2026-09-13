/**
 * Receiver fully-unversioned local-exclusive ordinary history union
 * (SYNC-DATA-058 receiver side, SYNC-CC-026 bootstrap pre-apply).
 *
 * Only baseline bootstrap (cursor==0) same Main SQLite tx before applying
 * incoming envelope. Adopts local-exclusive complete subtree/entities that
 * are fully unversioned and ordinary success. Fail-closed 0 writes on any
 * ambiguity, partial version, tombstone/register, orphan, unsupported, etc.
 *
 * Clock strictly > local+incoming+wall, MAX_SAFE fail-closed.
 * Entity ops precede frames; shared parents use membership > incoming frame
 * plus post-apply higher frame for push; pure local parents generate full frame.
 */

import { randomUUID } from 'node:crypto'

import { isStableBlockStatus, isStableMessageStatus, isUnsupportedBlockForSync } from '@shared/sync'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'
import {
  ADOPTION_BLOCK_FIELDS,
  ADOPTION_MESSAGE_FIELDS,
  ADOPTION_TOPIC_FIELDS,
  buildAdoptionBlockPayload,
  buildAdoptionMessagePayload,
  buildAdoptionTopicPayload,
  decodeAdoptionOverflow,
  scanAdoptionMaxObserved
} from './syncAdoptionShared'
import type { LocalSyncBaselineEntity } from './syncBaseline'
import type { ValidatedBaselineMergeInput } from './syncBaselineApply'
import { SyncBaselineApplyError } from './syncBaselineApply'

type Tx = BetterSQLite3Database<typeof schema>

function isSafeTs(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER
}

function fail(msg: string): never {
  throw new SyncBaselineApplyError(msg)
}

function isEligibleMessageRow(row: { status: string | null }): boolean {
  if (!isStableMessageStatus(row.status)) return false
  return row.status === 'success'
}
function isEligibleBlockRow(row: { status: string | null; type: string | null; extra: string | null }): boolean {
  if (!isStableBlockStatus(row.status)) return false
  if (row.status !== 'success') return false
  const overflow = decodeAdoptionOverflow(row.extra)
  if (isUnsupportedBlockForSync({ type: row.type, overflow })) return false
  return true
}

export interface ReceiverUnionResult {
  adopted: number
  sharedParents: { topicIds: string[]; messageIds: string[] }
  pureParents: { topicIds: string[]; messageIds: string[] }
}

export function adoptReceiverExclusiveInTx(
  tx: Tx,
  incoming: ValidatedBaselineMergeInput,
  deviceId: string,
  wallMs?: number
): ReceiverUnionResult {
  const wall = wallMs ?? Date.now()
  if (!isSafeTs(wall)) fail('receiver union wall clock invalid')

  // Build incoming sets
  const incomingTopicIds = new Set<string>()
  const incomingMessageIds = new Set<string>()
  const incomingBlockIds = new Set<string>()
  const incomingTombstoneKeys = new Set<string>()
  const incomingEntityByKey = new Map<string, LocalSyncBaselineEntity>()
  for (const e of incoming.entities) {
    const key = `${e.entityType}:${e.entityId}`
    incomingEntityByKey.set(key, e)
    if (e.entityType === 'topic') incomingTopicIds.add(e.entityId)
    else if (e.entityType === 'message') incomingMessageIds.add(e.entityId)
    else if (e.entityType === 'message_block') incomingBlockIds.add(e.entityId)
  }
  for (const t of incoming.tombstones) {
    incomingTombstoneKeys.add(`${t.entityType}:${t.entityId}`)
  }
  const incomingParentIds = new Set<string>() // topic ids for messages, message ids for blocks that are incoming parents
  for (const mid of incomingMessageIds) {
    const e = incomingEntityByKey.get(`message:${mid}`)
    if (e) incomingParentIds.add(e.payload.topicId as string)
  }
  for (const bid of incomingBlockIds) {
    const e = incomingEntityByKey.get(`message_block:${bid}`)
    if (e) incomingParentIds.add(e.payload.messageId as string)
  }
  // Incoming frames map
  const incomingFrameByParent = new Map<string, { timestamp: number; operationId: string; kind: string }>()
  for (const f of incoming.orderFrames) {
    incomingFrameByParent.set(`${f.kind}:${f.parentId}`, {
      timestamp: f.frameClock.timestamp,
      operationId: f.frameClock.operationId,
      kind: f.kind
    })
  }

  // Collect incoming clocks max
  let incomingMax = -1
  const updInc = (ts: unknown): void => {
    if (typeof ts === 'number' && Number.isSafeInteger(ts) && ts >= 0 && ts > incomingMax) incomingMax = ts
  }
  for (const e of incoming.entities) {
    if (e.entityClock) updInc(e.entityClock.timestamp)
    for (const fc of e.fieldClocks) updInc(fc.timestamp)
    const pm = (e as unknown as { parentMembershipClock?: { timestamp: number } }).parentMembershipClock
    if (pm) updInc(pm.timestamp)
  }
  for (const f of incoming.orderFrames) updInc(f.frameClock.timestamp)
  for (const r of incoming.replacementRegisters ?? []) updInc(r.timestamp)
  for (const t of incoming.tombstones) updInc(t.timestamp)

  // Global 0-write gate: any local tombstone/register present => fail if exclusive exists? We check per candidate but also global for purity.
  // For receiver we fail only if exclusive candidate would be affected; but we also need to fail if local has any tombstone/register at all and exclusive set non-empty?
  // Implement global check: if exclusive set non-empty and any tombstone/register exists, fail.
  // We'll defer global check until after candidate collection.

  // Query local rows
  const topicRows = tx.select().from(schema.topics).all() as Array<{
    id: string
    assistantId: string | null
    name: string | null
    createdAt: string | null
    updatedAt: string | null
    deletedAt: string | null
    extra: string | null
  }>
  const messageRows = tx.select().from(schema.messages).all() as Array<{
    id: string
    topicId: string
    role: string | null
    content: string | null
    status: string | null
    askId: string | null
    model: string | null
    modelId: string | null
    assistantId: string | null
    createdAt: string | null
    updatedAt: string | null
    sortOrder: number
    extra: string | null
  }>
  const blockRows = tx.select().from(schema.messageBlocks).all() as Array<{
    id: string
    messageId: string
    type: string | null
    content: string | null
    status: string | null
    createdAt: string | null
    updatedAt: string | null
    sortOrder: number
    extra: string | null
  }>

  const topicRowById = new Map<string, (typeof topicRows)[number]>()
  for (const r of topicRows) topicRowById.set(r.id, r)
  const messageRowById = new Map<string, (typeof messageRows)[number]>()
  for (const r of messageRows) messageRowById.set(r.id, r)
  const blockRowById = new Map<string, (typeof blockRows)[number]>()
  for (const r of blockRows) blockRowById.set(r.id, r)

  // Version helpers: fully-unversioned vs fully-versioned-complete vs partial.
  // Fully-unversioned = no entity/field/membership/outbox/frame/tombstone/register.
  // Fully-versioned-complete = has entity + all required field clocks + membership (if needed).
  // Anything in between = partial -> fail-closed when exclusive.
  // Field allowlists are shared with seed adoption (syncAdoptionShared) so the
  // protocol cannot fork between holder and receiver paths.
  const TOPIC_FIELDS = [...ADOPTION_TOPIC_FIELDS]
  const MESSAGE_FIELDS = [...ADOPTION_MESSAGE_FIELDS]
  const BLOCK_FIELDS = [...ADOPTION_BLOCK_FIELDS]

  const hasEntityClock = (t: 'topic' | 'message' | 'message_block', id: string): boolean => {
    return !!tx
      .select()
      .from(schema.syncEntityClock)
      .where(eq(schema.syncEntityClock.entityType, t))
      .all()
      .find((r) => r.entityId === id)
  }
  const fieldCountFor = (t: 'topic' | 'message' | 'message_block', id: string): number => {
    return tx
      .select()
      .from(schema.syncFieldClock)
      .where(eq(schema.syncFieldClock.entityType, t))
      .all()
      .filter((r) => r.entityId === id).length
  }
  const hasMembership = (t: 'message' | 'message_block', id: string): boolean => {
    const childType = t === 'message' ? 'message' : 'message_block'
    return !!tx
      .select()
      .from(schema.syncMembershipClock)
      .where(eq(schema.syncMembershipClock.childEntityType, childType as never))
      .all()
      .find((r) => (r as unknown as { childEntityId: string }).childEntityId === id)
  }
  const hasOutboxFor = (t: 'topic' | 'message' | 'message_block', id: string): boolean => {
    return !!tx
      .select()
      .from(schema.syncOutbox)
      .where(eq(schema.syncOutbox.entityId, id))
      .all()
      .find((r) => r.entityType === t)
  }
  const hasFrameAsParent = (t: 'topic' | 'message', id: string): boolean => {
    try {
      if (t === 'topic') {
        return !!tx
          .select()
          .from(schema.syncParentOrderFrame)
          .where(eq(schema.syncParentOrderFrame.kind, 'topicMessage'))
          .all()
          .find((r) => r.parentId === id)
      }
      return !!tx
        .select()
        .from(schema.syncParentOrderFrame)
        .where(eq(schema.syncParentOrderFrame.kind, 'messageBlock'))
        .all()
        .find((r) => r.parentId === id)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (/no such table/i.test(m)) return false
      throw e
    }
  }
  const hasTombstoneFor = (t: 'topic' | 'message' | 'message_block', id: string): boolean => {
    const key =
      t === 'topic'
        ? `tombstone:topic:${id}`
        : t === 'message'
          ? `tombstone:message:${id}`
          : `tombstone:message_block:${id}`
    return !!tx.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get()
  }
  const hasRegisterFor = (id: string): boolean => {
    try {
      return !!tx
        .select()
        .from(schema.syncStableReplaceRegister)
        .where(eq(schema.syncStableReplaceRegister.messageId, id))
        .get()
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (/no such table/i.test(m)) return false
      throw e
    }
  }

  const isFullyUnversioned = (t: 'topic' | 'message' | 'message_block', id: string): boolean => {
    if (hasEntityClock(t, id)) return false
    if (fieldCountFor(t, id) > 0) return false
    if (t !== 'topic' && hasMembership(t, id)) return false
    if (hasOutboxFor(t, id)) return false
    if (t === 'topic' && hasFrameAsParent('topic', id)) return false
    if (t === 'message' && hasFrameAsParent('message', id)) return false
    if (hasTombstoneFor(t, id)) return false
    if (t === 'message' && hasRegisterFor(id)) return false
    return true
  }

  const isFullyVersionedComplete = (t: 'topic' | 'message' | 'message_block', id: string): boolean => {
    if (!hasEntityClock(t, id)) return false
    const need = t === 'topic' ? TOPIC_FIELDS.length : t === 'message' ? MESSAGE_FIELDS.length : BLOCK_FIELDS.length
    if (fieldCountFor(t, id) < need) return false
    if (t !== 'topic' && !hasMembership(t, id)) return false
    return true
  }

  // Same-ID check only for fully-unversioned local rows: strict-identical passes to merge, divergence fails.
  // Versioned overlaps are left to existing LWW merge.
  // Compare keys derive from the shared ADOPTION_*_FIELDS allowlists
  // (single source with the seed path) plus identity/parent keys, so the
  // protocol cannot fork between holder and receiver paths.
  const comparePayload = (
    local: Record<string, unknown>,
    inc: Record<string, unknown>,
    keys: string[],
    ctx: string
  ): void => {
    for (const k of keys) {
      const lv = local[k] ?? null
      const iv = inc[k] ?? null
      if (JSON.stringify(lv) !== JSON.stringify(iv)) {
        fail(`receiver union same-ID value divergence for ${ctx} field ${k}`)
      }
    }
  }
  const TOPIC_COMPARE_KEYS = ['id', ...ADOPTION_TOPIC_FIELDS]
  const MESSAGE_COMPARE_KEYS = ['id', 'topicId', ...ADOPTION_MESSAGE_FIELDS]
  const BLOCK_COMPARE_KEYS = ['id', 'messageId', ...ADOPTION_BLOCK_FIELDS]
  for (const row of topicRows) {
    if (!incomingTopicIds.has(row.id)) continue
    if (!isFullyUnversioned('topic', row.id)) continue
    const incomingEntity = incomingEntityByKey.get(`topic:${row.id}`)!
    comparePayload(buildAdoptionTopicPayload(row), incomingEntity.payload, TOPIC_COMPARE_KEYS, `topic/${row.id}`)
  }
  for (const row of messageRows) {
    if (!incomingMessageIds.has(row.id)) continue
    if (!isFullyUnversioned('message', row.id)) continue
    const incomingEntity = incomingEntityByKey.get(`message:${row.id}`)!
    comparePayload(buildAdoptionMessagePayload(row), incomingEntity.payload, MESSAGE_COMPARE_KEYS, `message/${row.id}`)
  }
  for (const row of blockRows) {
    if (!incomingBlockIds.has(row.id)) continue
    if (!isFullyUnversioned('message_block', row.id)) continue
    const incomingEntity = incomingEntityByKey.get(`message_block:${row.id}`)!
    comparePayload(buildAdoptionBlockPayload(row), incomingEntity.payload, BLOCK_COMPARE_KEYS, `block/${row.id}`)
  }

  // Candidate collection: exclusive = local rows not in incoming live/tombstone.
  // - ineligible/orphan always fail-closed (even versioned, to avoid silent partial shells)
  // - fully-unversioned eligible -> adopt
  // - fully-versioned-complete -> ignore (existing suffix/merge handles)
  // - partial (some version but incomplete) or exclusive with outbox/frame/tombstone/register -> fail
  type Candidate = {
    entityType: 'topic' | 'message' | 'message_block'
    entityId: string
    row: unknown
    payload: Record<string, unknown>
  }
  const candidates: Candidate[] = []

  for (const row of topicRows) {
    const id = row.id
    if (incomingTopicIds.has(id) || incomingTombstoneKeys.has(`topic:${id}`)) continue
    const payload = buildAdoptionTopicPayload(row)
    if (isFullyUnversioned('topic', id)) {
      candidates.push({ entityType: 'topic', entityId: id, row, payload })
    } else if (isFullyVersionedComplete('topic', id)) {
      continue
    } else {
      fail(`receiver union partial topic ${id}`)
    }
  }
  for (const row of messageRows) {
    const id = row.id
    if (incomingMessageIds.has(id) || incomingTombstoneKeys.has(`message:${id}`)) continue
    if (!isEligibleMessageRow(row)) {
      fail(`receiver union ineligible message ${id} status ${String(row.status)}`)
    }
    if (!topicRowById.has(row.topicId)) {
      fail(`receiver union orphan message ${id} missing topic ${row.topicId}`)
    }
    const payload = buildAdoptionMessagePayload(row)
    if (isFullyUnversioned('message', id)) {
      candidates.push({ entityType: 'message', entityId: id, row, payload })
    } else if (isFullyVersionedComplete('message', id)) {
      continue
    } else {
      fail(`receiver union partial message ${id}`)
    }
  }
  for (const row of blockRows) {
    const id = row.id
    if (incomingBlockIds.has(id) || incomingTombstoneKeys.has(`message_block:${id}`)) continue
    if (!isEligibleBlockRow(row)) {
      fail(`receiver union ineligible block ${id} type ${String(row.type)} status ${String(row.status)}`)
    }
    if (!messageRowById.has(row.messageId)) {
      fail(`receiver union orphan block ${id} missing message ${row.messageId}`)
    }
    const payload = buildAdoptionBlockPayload(row)
    if (isFullyUnversioned('message_block', id)) {
      candidates.push({ entityType: 'message_block', entityId: id, row, payload })
    } else if (isFullyVersionedComplete('message_block', id)) {
      continue
    } else {
      fail(`receiver union partial block ${id}`)
    }
  }

  if (candidates.length === 0) {
    return {
      adopted: 0,
      sharedParents: { topicIds: [], messageIds: [] },
      pureParents: { topicIds: [], messageIds: [] }
    }
  }

  // Global gates when adoption will happen: any tombstone/register/outbox/frame/applied anywhere fails.
  {
    const tombRows = tx
      .select()
      .from(schema.syncState)
      .all()
      .filter((r) => typeof r.key === 'string' && r.key.startsWith('tombstone:'))
    if (tombRows.length > 0) fail(`receiver union tombstone present ${tombRows.length}`)
  }
  {
    try {
      const regs = tx.select().from(schema.syncStableReplaceRegister).all()
      if (regs.length > 0) fail(`receiver union replacement register present ${regs.length}`)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (!/no such table/i.test(m)) throw e
    }
  }
  {
    const outRows = tx.select().from(schema.syncOutbox).all()
    if (outRows.length > 0) fail(`receiver union pending outbox present ${outRows.length}`)
  }
  {
    try {
      const frs = tx.select().from(schema.syncParentOrderFrame).all()
      if (frs.length > 0) fail(`receiver union parent frame present ${frs.length}`)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (!/no such table/i.test(m)) throw e
    }
  }
  {
    const appliedRows = tx.select().from(schema.syncApplied).all()
    if (appliedRows.length > 0) fail(`receiver union applied present ${appliedRows.length}`)
  }

  // Parent closure: for each candidate message/block, parent must be in incoming live or candidate set
  const candidateTopicIds = new Set<string>(candidates.filter((c) => c.entityType === 'topic').map((c) => c.entityId))
  const candidateMessageIds = new Set<string>(
    candidates.filter((c) => c.entityType === 'message').map((c) => c.entityId)
  )
  // For closure, also consider incoming parent ids already in incoming sets (topics/messages). But for message's topicId, check if topicId in incomingTopicIds or candidateTopicIds
  for (const c of candidates) {
    if (c.entityType === 'message') {
      const topicId = c.payload.topicId as string
      if (!incomingTopicIds.has(topicId) && !candidateTopicIds.has(topicId)) {
        fail(`receiver union parent closure missing topic ${topicId} for message ${c.entityId}`)
      }
      // also ensure local parent row exists (already checked) and if parent is candidate, its payload etc. already validated
      // If parent is incoming, also ensure incoming parent payload exists (it does)
    } else if (c.entityType === 'message_block') {
      const messageId = c.payload.messageId as string
      if (!incomingMessageIds.has(messageId) && !candidateMessageIds.has(messageId)) {
        fail(`receiver union parent closure missing message ${messageId} for block ${c.entityId}`)
      }
    }
  }
  // Also ensure candidate set is closed under children: i.e., if candidate includes a topic, all its eligible children that are local exclusive must be included (already). But if candidate topic has a local child that is eligible but not in candidates because we missed? That would be a local message whose id is not incoming but we did include it, so it should be in candidates. Our loop included all eligible local messages not incoming, so all such children are in candidates. So closure satisfied.

  // Additional check: for any candidate parent, ensure it has no excluded/orphan children that would make it incomplete.
  // For each candidate topic that is in candidates, check its local messages: any message row with same topicId that is not in candidates and not incoming and is eligible would have been excluded only if ineligible, but we already failed on ineligible. So no need.
  // For shared parents (incoming topics that have exclusive children), we don't need to check completeness of that shared parent's other children; incoming frame will handle.

  // Compute maxObserved local via the shared adoption clock-scan boundary
  // (same tables as seed adoption monotonic computation, single source).
  let maxObserved = scanAdoptionMaxObserved(tx)
  // incoming max already computed
  if (incomingMax > maxObserved) maxObserved = incomingMax
  if (wall > maxObserved) maxObserved = wall
  const baseTs = maxObserved + 1
  if (!isSafeTs(baseTs) || baseTs >= Number.MAX_SAFE_INTEGER) fail('receiver union clock MAX_SAFE exhausted')
  // Need also check that baseTs + candidates.length < MAX_SAFE
  if (baseTs + candidates.length >= Number.MAX_SAFE_INTEGER) fail('receiver union clock MAX_SAFE exhausted for batch')

  // Adoption: for each candidate in deterministic order, enqueue upsert + membership.
  // Tx-direct inserts mirror enqueueUpsertInTx sequencing (entity ops preceding
  // frames, shared payload/clock helpers in syncAdoptionShared) without a
  // service import cycle; payload allowlists and clock-scan stay single-sourced.
  const ordered = [...candidates].sort((a, b) => {
    const rank = (t: string): number => (t === 'topic' ? 0 : t === 'message' ? 1 : 2)
    const r = rank(a.entityType) - rank(b.entityType)
    if (r !== 0) return r
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
  })

  const insertedOpIds: string[] = []
  let idx = 0
  for (const c of ordered) {
    const ts = baseTs + idx
    idx += 1
    if (!isSafeTs(ts) || ts >= Number.MAX_SAFE_INTEGER) fail('receiver union per-entity clock exhausted')
    const opId = randomUUID()
    // Validate payload allowlist via service? Use filter functions already validated.
    // Insert outbox
    tx.insert(schema.syncOutbox)
      .values({
        id: opId,
        entityType: c.entityType,
        op: 'upsert',
        entityId: c.entityId,
        timestamp: ts,
        deviceId,
        payloadJson: JSON.stringify(c.payload),
        createdAt: new Date().toISOString()
      })
      .run()
    // Entity clock
    tx.insert(schema.syncEntityClock)
      .values({ entityType: c.entityType, entityId: c.entityId, timestamp: ts, operationId: opId })
      .onConflictDoUpdate({
        target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
        set: { timestamp: ts, operationId: opId }
      })
      .run()
    // Field clocks: shared adoption allowlists (single source with seed path).
    const fieldAllow =
      c.entityType === 'topic'
        ? ADOPTION_TOPIC_FIELDS
        : c.entityType === 'message'
          ? ADOPTION_MESSAGE_FIELDS
          : ADOPTION_BLOCK_FIELDS
    for (const k of Object.keys(c.payload)) {
      if (!fieldAllow.has(k)) continue
      tx.insert(schema.syncFieldClock)
        .values({ entityType: c.entityType, entityId: c.entityId, field: k, timestamp: ts, operationId: opId })
        .onConflictDoUpdate({
          target: [schema.syncFieldClock.entityType, schema.syncFieldClock.entityId, schema.syncFieldClock.field],
          set: { timestamp: ts, operationId: opId }
        })
        .run()
    }
    // Membership for message/block
    if (c.entityType !== 'topic') {
      const parentId = c.entityType === 'message' ? (c.payload.topicId as string) : (c.payload.messageId as string)
      const childType = c.entityType === 'message' ? 'message' : 'message_block'
      tx.insert(schema.syncMembershipClock)
        .values({
          childEntityType: childType as never,
          childEntityId: c.entityId,
          parentId,
          timestamp: ts,
          operationId: opId
        })
        .run()
    }
    insertedOpIds.push(opId)
  }

  // Determine parent sets for post-merge frame generation
  const exclusiveParentTopicIds = new Set<string>()
  const exclusiveParentMessageIds = new Set<string>()
  for (const c of candidates) {
    if (c.entityType === 'message') exclusiveParentTopicIds.add(c.payload.topicId as string)
    if (c.entityType === 'message_block') exclusiveParentMessageIds.add(c.payload.messageId as string)
  }
  // Also topics themselves are parents for their messages, but already in exclusiveParentTopicIds via messages.
  // For pure exclusive topics with no messages? They still need frame (empty). Add topic ids themselves.
  for (const c of candidates.filter((c) => c.entityType === 'topic')) {
    exclusiveParentTopicIds.add(c.entityId)
  }
  for (const c of candidates.filter((c) => c.entityType === 'message')) {
    exclusiveParentMessageIds.add(c.entityId) // message is parent for blocks (even if no blocks, need empty frame)
  }

  // Classify pure vs shared
  const sharedTopicIds: string[] = []
  const pureTopicIds: string[] = []
  for (const tid of exclusiveParentTopicIds) {
    if (incomingTopicIds.has(tid) || incomingFrameByParent.has(`topicMessage:${tid}`)) sharedTopicIds.push(tid)
    else pureTopicIds.push(tid)
  }
  const sharedMessageIds: string[] = []
  const pureMessageIds: string[] = []
  for (const mid of exclusiveParentMessageIds) {
    if (incomingMessageIds.has(mid) || incomingFrameByParent.has(`messageBlock:${mid}`)) sharedMessageIds.push(mid)
    else pureMessageIds.push(mid)
  }

  // Note: frames will be created post-merge via caller; we return sets for caller to mint after merge.
  // However we have already minted memberships; the post-merge step needs to know which parents to refresh.
  // Return all exclusive parents; caller will decide.
  return {
    adopted: candidates.length,
    sharedParents: { topicIds: sharedTopicIds.sort(), messageIds: sharedMessageIds.sort() },
    pureParents: { topicIds: pureTopicIds.sort(), messageIds: pureMessageIds.sort() }
  }
}
