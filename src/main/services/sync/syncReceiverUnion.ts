/**
 * Receiver fully-unversioned local-exclusive ordinary history union
 * (SYNC-DATA-058 receiver side, SYNC-CC-026 bootstrap pre-apply).
 *
 * Only baseline bootstrap (cursor==0) same Main SQLite tx before applying
 * incoming envelope. Adopts local-exclusive complete subtree/entities that
 * are fully unversioned and ordinary live stable non-transient. Fail-closed
 * 0 writes on any ambiguity, partial version, tombstone/register, orphan,
 * unsupported, etc.
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
  ADOPTION_BRANCH_FIELDS,
  ADOPTION_MESSAGE_FIELDS,
  ADOPTION_TOPIC_FIELDS,
  buildAdoptionBlockPayload,
  buildAdoptionBranchPayload,
  buildAdoptionMessagePayload,
  buildAdoptionTopicPayload,
  decodeAdoptionOverflow,
  scanAdoptionMaxObserved
} from './syncAdoptionShared'
import type { LocalSyncBaselineEntity } from './syncBaseline'
import type { ValidatedBaselineMergeInput } from './syncBaselineApply'
import { SyncBaselineApplyError } from './syncBaselineApply'
import { buildMessageBranchById, isBranchOwnedBlock, isProvenBranchMessageRow } from './syncLocalInventoryBoundary'

type Tx = BetterSQLite3Database<typeof schema>

function isSafeTs(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER
}

function fail(msg: string): never {
  throw new SyncBaselineApplyError(msg)
}

function isEligibleMessageRow(row: { status: string | null }): boolean {
  return isStableMessageStatus(row.status)
}
function isEligibleBlockRow(row: { status: string | null; type: string | null; extra: string | null }): boolean {
  if (!isStableBlockStatus(row.status)) return false
  const overflow = decodeAdoptionOverflow(row.extra)
  if (isUnsupportedBlockForSync({ type: row.type, overflow })) return false
  return true
}

export interface ReceiverUnionResult {
  adopted: number
  sharedParents: { topicIds: string[]; messageIds: string[]; branchIds: string[] }
  pureParents: { topicIds: string[]; messageIds: string[]; branchIds: string[] }
}

type TombstoneRef = {
  entityType: 'topic' | 'message' | 'message_block' | 'topic_branch' | 'file_asset'
  entityId: string
}
type RegisterRef = { messageId: string; activeBlockIds: string[] }

function parseTombstoneKey(key: string): TombstoneRef {
  if (key.startsWith('tombstone:file_asset:')) {
    const id = key.slice('tombstone:file_asset:'.length)
    if (!id || id.includes(':')) fail(`receiver union malformed tombstone key ${key}`)
    return { entityType: 'file_asset', entityId: id }
  }
  if (key.startsWith('tombstone:topic_branch:')) {
    const id = key.slice('tombstone:topic_branch:'.length)
    if (!id || id.includes(':')) fail(`receiver union malformed tombstone key ${key}`)
    return { entityType: 'topic_branch', entityId: id }
  }
  if (key.startsWith('tombstone:message_block:')) {
    const id = key.slice('tombstone:message_block:'.length)
    if (!id || id.includes(':')) fail(`receiver union malformed tombstone key ${key}`)
    return { entityType: 'message_block', entityId: id }
  }
  if (key.startsWith('tombstone:message:')) {
    const id = key.slice('tombstone:message:'.length)
    if (!id || id.includes(':')) fail(`receiver union malformed tombstone key ${key}`)
    return { entityType: 'message', entityId: id }
  }
  if (key.startsWith('tombstone:topic:')) {
    const id = key.slice('tombstone:topic:'.length)
    if (!id || id.includes(':')) fail(`receiver union malformed tombstone key ${key}`)
    return { entityType: 'topic', entityId: id }
  }
  fail(`receiver union unknown tombstone key ${key}`)
}

function collectLocalTombstones(tx: Tx): TombstoneRef[] {
  const rows = tx.select().from(schema.syncState).all() as Array<{ key: string }>
  const out: TombstoneRef[] = []
  for (const r of rows) {
    if (typeof r.key !== 'string' || !r.key.startsWith('tombstone:')) continue
    out.push(parseTombstoneKey(r.key))
  }
  return out
}

function parseActiveBlockIds(raw: unknown, ctx: string): string[] {
  let arr: unknown
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      fail(`receiver union malformed register activeBlockIds for ${ctx}`)
    }
  } else {
    arr = raw
  }
  if (!Array.isArray(arr)) fail(`receiver union malformed register activeBlockIds for ${ctx}`)
  const ids = arr as unknown[]
  const seen = new Set<string>()
  for (const v of ids) {
    if (typeof v !== 'string' || !v || v.includes(':')) {
      fail(`receiver union malformed register activeBlockId for ${ctx}`)
    }
    if (seen.has(v)) fail(`receiver union duplicate register activeBlockId for ${ctx}`)
    seen.add(v)
  }
  return [...seen]
}

function isValidOpId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 256 && !v.includes(':')
}

function collectLocalRegisters(tx: Tx): RegisterRef[] {
  let rows: Array<{
    messageId: string
    timestamp: number
    operationId: string
    activeBlockIdsJson: string
  }>
  try {
    rows = tx.select().from(schema.syncStableReplaceRegister).all() as never as typeof rows
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(m)) return []
    throw e
  }
  return rows.map((r) => {
    if (typeof r.messageId !== 'string' || !r.messageId || r.messageId.includes(':')) {
      fail(`receiver union malformed register owner ${String(r.messageId)}`)
    }
    if (typeof r.timestamp !== 'number' || !Number.isSafeInteger(r.timestamp) || r.timestamp < 0) {
      fail(`receiver union malformed register clock for ${r.messageId}`)
    }
    if (!isValidOpId(r.operationId)) fail(`receiver union malformed register op for ${r.messageId}`)
    return { messageId: r.messageId, activeBlockIds: parseActiveBlockIds(r.activeBlockIdsJson, r.messageId) }
  })
}

function collectIncomingRegisters(
  incoming: ValidatedBaselineMergeInput
): Array<RegisterRef & { timestamp: number; operationId: string }> {
  const out: Array<RegisterRef & { timestamp: number; operationId: string }> = []
  for (const r of incoming.replacementRegisters ?? []) {
    if (typeof r.messageId !== 'string' || !r.messageId || r.messageId.includes(':')) {
      fail(`receiver union malformed incoming register owner ${String(r.messageId)}`)
    }
    if (typeof r.timestamp !== 'number' || !Number.isSafeInteger(r.timestamp) || r.timestamp < 0) {
      fail(`receiver union malformed incoming register clock for ${r.messageId}`)
    }
    if (!isValidOpId(r.operationId)) fail(`receiver union malformed incoming register op for ${r.messageId}`)
    if (!Array.isArray(r.activeBlockIds))
      fail(`receiver union malformed incoming register activeBlockIds for ${r.messageId}`)
    out.push({
      messageId: r.messageId,
      activeBlockIds: parseActiveBlockIds(r.activeBlockIds, `incoming:${r.messageId}`),
      timestamp: r.timestamp,
      operationId: r.operationId
    })
  }
  return out
}

function assertCandidateClosureDisjoint(
  candidates: Array<{
    entityType: 'topic' | 'message' | 'message_block' | 'topic_branch'
    entityId: string
    payload: Record<string, unknown>
  }>,
  topicRowById: Map<string, { id: string }>,
  messageRowById: Map<string, { id: string; topicId: string }>,
  blockRowById: Map<string, { id: string; messageId: string }>,
  branchRowById: Map<string, { id: string; parentBranchId: string | null }>,
  incomingEntityByKey: Map<string, LocalSyncBaselineEntity>,
  incomingTombstones: TombstoneRef[],
  localTombstones: TombstoneRef[],
  localRegisters: RegisterRef[],
  incomingRegisters: RegisterRef[]
): void {
  const candidateKeys = new Set(candidates.map((c) => `${c.entityType}:${c.entityId}`))
  const candidateTopicIds = new Set(candidates.filter((c) => c.entityType === 'topic').map((c) => c.entityId))
  const candidateMessageIds = new Set(candidates.filter((c) => c.entityType === 'message').map((c) => c.entityId))
  const candidateAllIds = new Set(candidates.map((c) => c.entityId))

  const candMsgParent = new Map<string, string>()
  const candBlockParent = new Map<string, string>()
  const candBranchParent = new Map<string, string | null>()
  const candBranchTopic = new Map<string, string>()
  for (const c of candidates) {
    if (c.entityType === 'message') {
      const tid: unknown = c.payload.topicId
      if (typeof tid !== 'string' || !tid) fail(`receiver union parent mismatch for message ${c.entityId}`)
      candMsgParent.set(c.entityId, tid)
    } else if (c.entityType === 'message_block') {
      const mid: unknown = c.payload.messageId
      if (typeof mid !== 'string' || !mid) fail(`receiver union parent mismatch for block ${c.entityId}`)
      candBlockParent.set(c.entityId, mid)
    } else if (c.entityType === 'topic_branch') {
      const tid: unknown = c.payload.topicId
      if (typeof tid !== 'string' || !tid) fail(`receiver union parent mismatch for branch ${c.entityId}`)
      candBranchTopic.set(c.entityId, tid)
      const pid: unknown = c.payload.parentBranchId
      if (pid !== null && pid !== undefined && (typeof pid !== 'string' || !pid)) {
        fail(`receiver union parent mismatch for branch ${c.entityId}`)
      }
      candBranchParent.set(c.entityId, pid ?? null)
    }
  }
  const localMsgParent = new Map<string, string>()
  for (const [id, row] of messageRowById) localMsgParent.set(id, row.topicId)
  const localBlockParent = new Map<string, string>()
  for (const [id, row] of blockRowById) localBlockParent.set(id, row.messageId)
  const incomingMsgParent = new Map<string, string>()
  const incomingBlockParent = new Map<string, string>()
  for (const e of incomingEntityByKey.values()) {
    if (e.entityType === 'message') {
      const tid: unknown = e.payload.topicId
      if (typeof tid !== 'string' || !tid) fail(`receiver union malformed incoming message parent for ${e.entityId}`)
      incomingMsgParent.set(e.entityId, tid)
    } else if (e.entityType === 'message_block') {
      const mid: unknown = e.payload.messageId
      if (typeof mid !== 'string' || !mid) fail(`receiver union malformed incoming block parent for ${e.entityId}`)
      incomingBlockParent.set(e.entityId, mid)
    }
  }
  const resolveMessageTopic = (mid: string): string | undefined => {
    const got = [candMsgParent.get(mid), localMsgParent.get(mid), incomingMsgParent.get(mid)].filter(
      (v): v is string => v !== undefined
    )
    if (got.length === 0) return undefined
    for (const v of got) if (v !== got[0]) fail(`receiver union parent mismatch for message ${mid}`)
    return got[0]
  }
  const resolveBlockMessage = (bid: string): string | undefined => {
    const got = [candBlockParent.get(bid), localBlockParent.get(bid), incomingBlockParent.get(bid)].filter(
      (v): v is string => v !== undefined
    )
    if (got.length === 0) return undefined
    for (const v of got) if (v !== got[0]) fail(`receiver union parent mismatch for block ${bid}`)
    return got[0]
  }
  const resolveBlockTopic = (bid: string): string | undefined => {
    const mid = resolveBlockMessage(bid)
    if (mid === undefined) return undefined
    return resolveMessageTopic(mid)
  }

  const allTombs: TombstoneRef[] = [
    ...localTombstones,
    ...incomingTombstones.map((t) => {
      if (
        t.entityType !== 'topic' &&
        t.entityType !== 'message' &&
        t.entityType !== 'message_block' &&
        t.entityType !== 'topic_branch'
      ) {
        fail(`receiver union unknown incoming tombstone type ${String(t.entityType)}`)
      }
      if (typeof t.entityId !== 'string' || !t.entityId || t.entityId.includes(':')) {
        fail(`receiver union malformed incoming tombstone id ${String(t.entityId)}`)
      }
      return { entityType: t.entityType, entityId: t.entityId }
    })
  ]
  const candMessageOwner = new Map<string, string | null>()
  for (const c of candidates) {
    if (c.entityType !== 'message') continue
    const owner: unknown = c.payload.branchId
    candMessageOwner.set(c.entityId, typeof owner === 'string' && owner ? owner : null)
  }
  const candidateBranchIds = new Set<string>(
    candidates.filter((c) => c.entityType === 'topic_branch').map((c) => c.entityId)
  )
  // Local branch ancestry for subtree-disjointness walks (candidate chain
  // first, then the locally present parent row, bounded).
  const localBranchParentOf = (bid: string): string | null | undefined => {
    const cand = candBranchParent.get(bid)
    if (cand !== undefined) return cand
    const row = branchRowById.get(bid) as { parentBranchId?: unknown } | undefined
    if (!row) return undefined
    const p = row.parentBranchId
    return typeof p === 'string' && p ? p : null
  }
  const branchUnderBranch = (start: string, ancestor: string): boolean => {
    let cur: string | null | undefined = localBranchParentOf(start)
    for (let depth = 0; depth < 32 && cur !== undefined && cur !== null; depth++) {
      if (cur === ancestor) return true
      cur = localBranchParentOf(cur)
    }
    return false
  }
  for (const t of allTombs) {
    const key = `${t.entityType}:${t.entityId}`
    if (candidateKeys.has(key)) fail(`receiver union tombstone direct overlap ${key}`)
    if (t.entityType === 'topic') {
      for (const [, tid] of candMsgParent)
        if (tid === t.entityId) fail(`receiver union candidate under tombstoned topic ${t.entityId}`)
      for (const [, tid] of candBranchTopic)
        if (tid === t.entityId) fail(`receiver union candidate branch under tombstoned topic ${t.entityId}`)
      for (const [bid] of candBlockParent) {
        const topic = resolveBlockTopic(bid)
        if (topic === undefined)
          fail(`receiver union cannot prove block ${bid} disjoint from tombstoned topic ${t.entityId}`)
        if (topic === t.entityId) fail(`receiver union candidate block under tombstoned topic ${t.entityId}`)
      }
    } else if (t.entityType === 'message') {
      for (const [, mid] of candBlockParent)
        if (mid === t.entityId) fail(`receiver union candidate block under tombstoned message ${t.entityId}`)
      const topic = resolveMessageTopic(t.entityId)
      if (topic === undefined) {
        if (candidateTopicIds.size > 0)
          fail(`receiver union cannot prove tombstoned message ${t.entityId} disjoint from candidates`)
      } else if (candidateTopicIds.has(topic)) {
        fail(`receiver union tombstoned message ${t.entityId} under candidate topic ${topic}`)
      }
    } else if (t.entityType === 'topic_branch') {
      // v3: candidate messages owned by the tombstoned branch, and
      // candidate branches at or under it, sit inside the deleted subtree.
      for (const [mid, owner] of candMessageOwner) {
        if (owner !== null && (owner === t.entityId || branchUnderBranch(owner, t.entityId))) {
          fail(`receiver union candidate message ${mid} under tombstoned branch ${t.entityId}`)
        }
      }
      if (candidateBranchIds.has(t.entityId)) {
        fail(`receiver union candidate branch under tombstoned branch ${t.entityId}`)
      }
      for (const bid of candidateBranchIds) {
        if (bid !== t.entityId && branchUnderBranch(bid, t.entityId)) {
          fail(`receiver union candidate branch ${bid} under tombstoned branch ${t.entityId}`)
        }
      }
    } else {
      const parentMid = resolveBlockMessage(t.entityId)
      if (parentMid === undefined) {
        if (candidateMessageIds.size > 0 || candidateTopicIds.size > 0) {
          fail(`receiver union cannot prove tombstoned block ${t.entityId} disjoint from candidates`)
        }
      } else {
        if (candidateMessageIds.has(parentMid))
          fail(`receiver union tombstoned block ${t.entityId} under candidate message ${parentMid}`)
        const topic = resolveMessageTopic(parentMid)
        if (topic === undefined) {
          if (candidateTopicIds.size > 0)
            fail(`receiver union cannot prove tombstoned block ${t.entityId} disjoint from candidates`)
        } else if (candidateTopicIds.has(topic)) {
          fail(`receiver union tombstoned block ${t.entityId} under candidate topic ${topic}`)
        }
      }
    }
  }

  const allRegs: RegisterRef[] = [...localRegisters, ...incomingRegisters]
  for (const r of allRegs) {
    if (candidateAllIds.has(r.messageId)) fail(`receiver union candidate within replacement domain ${r.messageId}`)
    for (const [, mid] of candBlockParent)
      if (mid === r.messageId) fail(`receiver union candidate block within replacement domain ${r.messageId}`)
    for (const aid of r.activeBlockIds)
      if (candidateAllIds.has(aid)) fail(`receiver union candidate matches replacement active ${aid} in ${r.messageId}`)
    const topic = resolveMessageTopic(r.messageId)
    if (topic === undefined) {
      if (candidateTopicIds.size > 0)
        fail(`receiver union cannot prove replacement ${r.messageId} disjoint from candidates`)
    } else if (candidateTopicIds.has(topic)) {
      fail(`receiver union replacement ${r.messageId} under candidate topic ${topic}`)
    }
    for (const aid of r.activeBlockIds) {
      const parent = resolveBlockMessage(aid)
      if (parent === undefined) {
        if (candidateTopicIds.size > 0 || candidateMessageIds.size > 0) {
          fail(`receiver union cannot prove replacement active ${aid} disjoint from candidates`)
        }
      } else if (parent !== r.messageId) {
        fail(`receiver union replacement active ${aid} parent mismatch for ${r.messageId}`)
      }
    }
  }
  void topicRowById
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
  const incomingBranchIds = new Set<string>()
  const incomingTombstoneKeys = new Set<string>()
  const incomingEntityByKey = new Map<string, LocalSyncBaselineEntity>()
  for (const e of incoming.entities) {
    const key = `${e.entityType}:${e.entityId}`
    incomingEntityByKey.set(key, e)
    if (e.entityType === 'topic') incomingTopicIds.add(e.entityId)
    else if (e.entityType === 'message') incomingMessageIds.add(e.entityId)
    else if (e.entityType === 'message_block') incomingBlockIds.add(e.entityId)
    else if (e.entityType === 'topic_branch') incomingBranchIds.add(e.entityId)
  }
  // Branch-domain gate (v3 full sync): the incoming input carries branch
  // inventory. v1/v2 inputs keep the exact local-only boundary below
  // (branch rows skipped, never adopted); only the branch domain adopts
  // fully-unversioned local branch rows/messages/blocks with truthful
  // clocks or fails on ambiguity — never permanently suppressed.
  const branchDomain =
    incomingBranchIds.size > 0 ||
    incoming.tombstones.some((t) => t.entityType === 'topic_branch') ||
    incoming.orderFrames.some((f) => (f as { kind?: string }).kind === 'branchSuffix')
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
  // Branch rows (v3 adoption domain; pre-016 tolerant — absent table means
  // no local branches).
  let branchRows: Array<{
    id: string
    topicId: string
    parentBranchId: string | null
    anchorMessageId: string
    name: string | null
    createdAt: string | null
    updatedAt: string | null
  }> = []
  try {
    branchRows = tx
      .select({
        id: schema.topicBranches.id,
        topicId: schema.topicBranches.topicId,
        parentBranchId: schema.topicBranches.parentBranchId,
        anchorMessageId: schema.topicBranches.anchorMessageId,
        name: schema.topicBranches.name,
        createdAt: schema.topicBranches.createdAt,
        updatedAt: schema.topicBranches.updatedAt
      })
      .from(schema.topicBranches)
      .all() as typeof branchRows
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(m)) branchRows = []
    else throw e
  }

  const topicRowById = new Map<string, (typeof topicRows)[number]>()
  for (const r of topicRows) topicRowById.set(r.id, r)
  const messageRowById = new Map<string, (typeof messageRows)[number]>()
  for (const r of messageRows) messageRowById.set(r.id, r)
  const blockRowById = new Map<string, (typeof blockRows)[number]>()
  for (const r of blockRows) blockRowById.set(r.id, r)
  const branchRowById = new Map<string, (typeof branchRows)[number]>()
  for (const r of branchRows) branchRowById.set(r.id, r)

  // Branch inventory boundary (version-scoped): v1/v2 inputs keep the exact
  // local-only boundary (branch-owned messages/blocks never candidates,
  // never minting). v3 (branchDomain) adopts the branch domain with
  // truthful clocks. Unknown ownership stays syncable so existing
  // fail-closed validation still applies.
  const messageBranchById = buildMessageBranchById(messageRows as Array<{ id: string; branchId?: unknown }>)

  // Version helpers: fully-unversioned vs fully-versioned-complete vs partial.
  // Fully-unversioned = no entity/field/membership/outbox/frame/tombstone/register.
  // Fully-versioned-complete = has entity + all required field clocks + membership (if needed).
  // Anything in between = partial -> fail-closed when exclusive.
  // Field allowlists are shared with seed adoption (syncAdoptionShared) so the
  // protocol cannot fork between holder and receiver paths.
  const TOPIC_FIELDS = [...ADOPTION_TOPIC_FIELDS]
  const MESSAGE_FIELDS = [...ADOPTION_MESSAGE_FIELDS]
  const BLOCK_FIELDS = [...ADOPTION_BLOCK_FIELDS]
  const BRANCH_FIELDS = [...ADOPTION_BRANCH_FIELDS]

  const hasEntityClock = (t: 'topic' | 'message' | 'message_block' | 'topic_branch', id: string): boolean => {
    return !!tx
      .select()
      .from(schema.syncEntityClock)
      .where(eq(schema.syncEntityClock.entityType, t))
      .all()
      .find((r) => r.entityId === id)
  }
  const fieldCountFor = (t: 'topic' | 'message' | 'message_block' | 'topic_branch', id: string): number => {
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
  const hasOutboxFor = (t: 'topic' | 'message' | 'message_block' | 'topic_branch', id: string): boolean => {
    return !!tx
      .select()
      .from(schema.syncOutbox)
      .where(eq(schema.syncOutbox.entityId, id))
      .all()
      .find((r) => r.entityType === t)
  }
  const hasFrameAsParent = (t: 'topic' | 'message' | 'topic_branch', id: string): boolean => {
    try {
      if (t === 'topic') {
        return !!tx
          .select()
          .from(schema.syncParentOrderFrame)
          .where(eq(schema.syncParentOrderFrame.kind, 'topicMessage'))
          .all()
          .find((r) => r.parentId === id)
      }
      if (t === 'topic_branch') {
        return !!tx
          .select()
          .from(schema.syncParentOrderFrame)
          .where(eq(schema.syncParentOrderFrame.kind, 'branchSuffix'))
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
  const hasTombstoneFor = (t: 'topic' | 'message' | 'message_block' | 'topic_branch', id: string): boolean => {
    const key =
      t === 'topic'
        ? `tombstone:topic:${id}`
        : t === 'message'
          ? `tombstone:message:${id}`
          : t === 'topic_branch'
            ? `tombstone:topic_branch:${id}`
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

  const isFullyUnversioned = (t: 'topic' | 'message' | 'message_block' | 'topic_branch', id: string): boolean => {
    if (hasEntityClock(t, id)) return false
    if (fieldCountFor(t, id) > 0) return false
    if ((t === 'message' || t === 'message_block') && hasMembership(t, id)) return false
    if (hasOutboxFor(t, id)) return false
    if (t === 'topic' && hasFrameAsParent('topic', id)) return false
    if (t === 'message' && hasFrameAsParent('message', id)) return false
    if (t === 'topic_branch' && hasFrameAsParent('topic_branch', id)) return false
    if (hasTombstoneFor(t, id)) return false
    if (t === 'message' && hasRegisterFor(id)) return false
    return true
  }

  const isFullyVersionedComplete = (t: 'topic' | 'message' | 'message_block' | 'topic_branch', id: string): boolean => {
    if (!hasEntityClock(t, id)) return false
    const need =
      t === 'topic'
        ? TOPIC_FIELDS.length
        : t === 'message'
          ? MESSAGE_FIELDS.length
          : t === 'topic_branch'
            ? BRANCH_FIELDS.length
            : BLOCK_FIELDS.length
    if (fieldCountFor(t, id) < need) return false
    if ((t === 'message' || t === 'message_block') && !hasMembership(t, id)) return false
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
  const MESSAGE_COMPARE_KEYS = ['id', 'topicId', 'branchId', ...ADOPTION_MESSAGE_FIELDS]
  const BLOCK_COMPARE_KEYS = ['id', 'messageId', ...ADOPTION_BLOCK_FIELDS]
  const BRANCH_COMPARE_KEYS = ['id', 'topicId', 'parentBranchId', 'anchorMessageId', ...ADOPTION_BRANCH_FIELDS]
  for (const row of topicRows) {
    if (!incomingTopicIds.has(row.id)) continue
    if (!isFullyUnversioned('topic', row.id)) continue
    const incomingEntity = incomingEntityByKey.get(`topic:${row.id}`)!
    comparePayload(buildAdoptionTopicPayload(row), incomingEntity.payload, TOPIC_COMPARE_KEYS, `topic/${row.id}`)
  }
  for (const row of branchRows) {
    // v3 only: same-ID branch rows compare identity + state; v1 inputs
    // never carry branches (no local-only suppression needed here since
    // incomingBranchIds is empty without the branch domain).
    if (!branchDomain) continue
    if (!incomingBranchIds.has(row.id)) continue
    if (!isFullyUnversioned('topic_branch', row.id)) continue
    const incomingEntity = incomingEntityByKey.get(`topic_branch:${row.id}`)!
    comparePayload(buildAdoptionBranchPayload(row), incomingEntity.payload, BRANCH_COMPARE_KEYS, `branch/${row.id}`)
  }
  for (const row of messageRows) {
    if (!incomingMessageIds.has(row.id)) continue
    // v1/v2 inputs: branch-owned rows are out of the sync inventory —
    // never compared, never adopted, never version-gated. v3 adopts them.
    if (!branchDomain && isProvenBranchMessageRow(row as { branchId?: unknown })) continue
    if (!isFullyUnversioned('message', row.id)) continue
    const incomingEntity = incomingEntityByKey.get(`message:${row.id}`)!
    comparePayload(
      buildAdoptionMessagePayload(row as Parameters<typeof buildAdoptionMessagePayload>[0]),
      incomingEntity.payload,
      MESSAGE_COMPARE_KEYS,
      `message/${row.id}`
    )
  }
  for (const row of blockRows) {
    if (!incomingBlockIds.has(row.id)) continue
    if (!branchDomain && isBranchOwnedBlock(row.messageId, messageBranchById)) continue
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
    entityType: 'topic' | 'message' | 'message_block' | 'topic_branch'
    entityId: string
    row: unknown
    payload: Record<string, unknown>
  }
  const candidates: Candidate[] = []

  for (const row of topicRows) {
    const id = row.id
    if (incomingTopicIds.has(id)) continue
    if (incomingTombstoneKeys.has(`topic:${id}`)) {
      if (isFullyVersionedComplete('topic', id)) continue
      fail(`receiver union tombstone direct overlap topic/${id}`)
    }
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
    // v1/v2 inputs: local-only branch suffix excluded from candidacy and
    // from every eligibility gate. v3 adopts the branch domain below.
    if (!branchDomain && isProvenBranchMessageRow(row as { branchId?: unknown })) continue
    if (incomingMessageIds.has(id)) continue
    if (incomingTombstoneKeys.has(`message:${id}`)) {
      if (isFullyVersionedComplete('message', id)) continue
      fail(`receiver union tombstone direct overlap message/${id}`)
    }
    if (!isEligibleMessageRow(row)) {
      fail(`receiver union ineligible message ${id} status ${String(row.status)}`)
    }
    if (!topicRowById.has(row.topicId)) {
      fail(`receiver union orphan message ${id} missing topic ${row.topicId}`)
    }
    const ownerBranch = (row as { branchId?: unknown }).branchId
    const ownerBranchId = typeof ownerBranch === 'string' && ownerBranch.length > 0 ? ownerBranch : null
    if (branchDomain && ownerBranchId !== null && !branchRowById.has(ownerBranchId)) {
      fail(`receiver union orphan message ${id} missing branch ${ownerBranchId}`)
    }
    const payload = buildAdoptionMessagePayload(row as Parameters<typeof buildAdoptionMessagePayload>[0])
    if (isFullyUnversioned('message', id)) {
      candidates.push({ entityType: 'message', entityId: id, row, payload })
    } else if (isFullyVersionedComplete('message', id)) {
      continue
    } else {
      fail(`receiver union partial message ${id}`)
    }
  }
  // v3 branch nodes: exclusive fully-unversioned local branches adopt with
  // truthful clocks; tombstone overlap, orphan topic, or partial version
  // fails closed. Parent/anchor eligibility is proven via local rows or the
  // same-input candidate set below (parent closure).
  if (branchDomain) {
    for (const row of branchRows) {
      const id = row.id
      if (incomingBranchIds.has(id)) continue
      if (incomingTombstoneKeys.has(`topic_branch:${id}`)) {
        if (isFullyVersionedComplete('topic_branch', id)) continue
        fail(`receiver union tombstone direct overlap branch/${id}`)
      }
      if (!topicRowById.has(row.topicId)) {
        fail(`receiver union orphan branch ${id} missing topic ${row.topicId}`)
      }
      const payload = buildAdoptionBranchPayload(row)
      if (isFullyUnversioned('topic_branch', id)) {
        candidates.push({ entityType: 'topic_branch', entityId: id, row, payload })
      } else if (isFullyVersionedComplete('topic_branch', id)) {
        continue
      } else {
        fail(`receiver union partial branch ${id}`)
      }
    }
  }
  for (const row of blockRows) {
    const id = row.id
    // v1/v2 inputs: blocks inherit their parent message's local-only owner.
    // v3 adopts branch-owned blocks with truthful clocks.
    if (!branchDomain && isBranchOwnedBlock(row.messageId, messageBranchById)) continue
    if (incomingBlockIds.has(id)) continue
    if (incomingTombstoneKeys.has(`message_block:${id}`)) {
      if (isFullyVersionedComplete('message_block', id)) continue
      fail(`receiver union tombstone direct overlap block/${id}`)
    }
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
      sharedParents: { topicIds: [], messageIds: [], branchIds: [] },
      pureParents: { topicIds: [], messageIds: [], branchIds: [] }
    }
  }

  // Narrowed tombstone/register gate: adoption candidates may proceed only when
  // their entity/parent/descendant impact closure is provably disjoint from all
  // local + incoming tombstones and stable replacement registers. Outbox/order
  // frames/applied ops retain the existing any-presence fail-closed gates.
  assertCandidateClosureDisjoint(
    candidates,
    topicRowById,
    messageRowById,
    blockRowById,
    branchRowById as Map<string, { id: string; parentBranchId: string | null }>,
    incomingEntityByKey,
    incoming.tombstones,
    collectLocalTombstones(tx),
    collectLocalRegisters(tx),
    collectIncomingRegisters(incoming)
  )
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
  const candidateBranchIds = new Set<string>(
    candidates.filter((c) => c.entityType === 'topic_branch').map((c) => c.entityId)
  )
  // For closure, also consider incoming parent ids already in incoming sets (topics/messages). But for message's topicId, check if topicId in incomingTopicIds or candidateTopicIds
  for (const c of candidates) {
    if (c.entityType === 'message') {
      const topicId = c.payload.topicId as string
      if (!incomingTopicIds.has(topicId) && !candidateTopicIds.has(topicId)) {
        fail(`receiver union parent closure missing topic ${topicId} for message ${c.entityId}`)
      }
      // Branch owner closure (v3): the owning branch must be incoming,
      // candidate, or a locally present row (versioned or fully-unversioned
      // local subtree roots are candidates themselves; anything else fails).
      const ownerBranchId = c.payload.branchId as string | null | undefined
      if (typeof ownerBranchId === 'string' && ownerBranchId.length > 0) {
        if (!incomingBranchIds.has(ownerBranchId) && !candidateBranchIds.has(ownerBranchId)) {
          if (!branchRowById.has(ownerBranchId)) {
            fail(`receiver union parent closure missing branch ${ownerBranchId} for message ${c.entityId}`)
          }
        }
      }
      // also ensure local parent row exists (already checked) and if parent is candidate, its payload etc. already validated
      // If parent is incoming, also ensure incoming parent payload exists (it does)
    } else if (c.entityType === 'message_block') {
      const messageId = c.payload.messageId as string
      if (!incomingMessageIds.has(messageId) && !candidateMessageIds.has(messageId)) {
        fail(`receiver union parent closure missing message ${messageId} for block ${c.entityId}`)
      }
    } else if (c.entityType === 'topic_branch') {
      const topicId = c.payload.topicId as string
      if (!incomingTopicIds.has(topicId) && !candidateTopicIds.has(topicId)) {
        fail(`receiver union parent closure missing topic ${topicId} for branch ${c.entityId}`)
      }
      // Parent branch closure: nested parents must be incoming, candidate,
      // or locally present (same rule as message owner closure above).
      const parentBranchId = c.payload.parentBranchId as string | null | undefined
      if (typeof parentBranchId === 'string' && parentBranchId.length > 0) {
        if (!incomingBranchIds.has(parentBranchId) && !candidateBranchIds.has(parentBranchId)) {
          if (!branchRowById.has(parentBranchId)) {
            fail(`receiver union parent closure missing branch ${parentBranchId} for branch ${c.entityId}`)
          }
        }
      }
      // Anchor closure: the fork anchor must be incoming, candidate, or
      // locally present; unknown anchors fail (deferral is the caller's
      // page buffering, not silent adoption).
      const anchorMessageId = c.payload.anchorMessageId as string
      if (
        !incomingMessageIds.has(anchorMessageId) &&
        !candidateMessageIds.has(anchorMessageId) &&
        !messageRowById.has(anchorMessageId)
      ) {
        fail(`receiver union parent closure missing anchor ${anchorMessageId} for branch ${c.entityId}`)
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
    const rank = (t: string): number => (t === 'topic' ? 0 : t === 'topic_branch' ? 1 : t === 'message' ? 2 : 3)
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
          : c.entityType === 'topic_branch'
            ? ADOPTION_BRANCH_FIELDS
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
    // Membership for message/block. Branch-owned messages bind their
    // owning branch id; main messages bind topicId (never a fallback).
    if (c.entityType === 'message' || c.entityType === 'message_block') {
      const parentId =
        c.entityType === 'message'
          ? (c.payload.branchId as string | null | undefined) && (c.payload.branchId as string).length > 0
            ? (c.payload.branchId as string)
            : (c.payload.topicId as string)
          : (c.payload.messageId as string)
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
  const exclusiveParentBranchIds = new Set<string>()
  for (const c of candidates) {
    if (c.entityType === 'message') {
      const ownerBranch = c.payload.branchId as string | null | undefined
      if (typeof ownerBranch === 'string' && ownerBranch.length > 0) exclusiveParentBranchIds.add(ownerBranch)
      else exclusiveParentTopicIds.add(c.payload.topicId as string)
    }
    if (c.entityType === 'message_block') exclusiveParentMessageIds.add(c.payload.messageId as string)
    if (c.entityType === 'topic_branch') exclusiveParentBranchIds.add(c.entityId)
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
  const sharedBranchIds: string[] = []
  const pureBranchIds: string[] = []
  for (const bid of exclusiveParentBranchIds) {
    if (incomingBranchIds.has(bid) || incomingFrameByParent.has(`branchSuffix:${bid}`)) sharedBranchIds.push(bid)
    else pureBranchIds.push(bid)
  }

  // Note: frames will be created post-merge via caller; we return sets for caller to mint after merge.
  // However we have already minted memberships; the post-merge step needs to know which parents to refresh.
  // Return all exclusive parents; caller will decide.
  return {
    adopted: candidates.length,
    sharedParents: {
      topicIds: sharedTopicIds.sort(),
      messageIds: sharedMessageIds.sort(),
      branchIds: sharedBranchIds.sort()
    },
    pureParents: { topicIds: pureTopicIds.sort(), messageIds: pureMessageIds.sort(), branchIds: pureBranchIds.sort() }
  }
}
