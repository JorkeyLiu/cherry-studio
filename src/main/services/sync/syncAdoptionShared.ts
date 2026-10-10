/**
 * Minimal shared adoption helpers (SYNC-DATA-058 seed + receiver union).
 *
 * Single source for ordinary stable-history adoption payload construction
 * (allowlist, canonical defaults, no `sortOrder`) and persisted-clock
 * max-scan (entity/field/membership/parent-frame/high-water). Both
 * `syncSeedAdoption` (service-based enqueue, candidate payloads) and
 * `syncReceiverUnion` (tx-direct inserts, row-built payloads) contract to the
 * same allowlists and clock-scan boundary so future protocol changes land in
 * one place. Adoption-write sequencing (entity ops preceding frames) stays
 * with each caller to avoid refactoring unrelated transaction contexts.
 */

import { filterBlockPayload, filterBranchPayload, filterMessagePayload, filterTopicPayload } from '@shared/sync'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'
import { SyncBaselineApplyError } from './syncBaselineApply'

export const ADOPTION_TOPIC_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
])

export const ADOPTION_MESSAGE_FIELDS: ReadonlySet<string> = new Set([
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt'
])

export const ADOPTION_BLOCK_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'content',
  'status',
  'createdAt',
  'updatedAt',
  'assetIds'
])

export const ADOPTION_BRANCH_FIELDS: ReadonlySet<string> = new Set(['name', 'createdAt', 'updatedAt'])

/**
 * V5 portable-media type predicate for adoption (single source with the
 * incremental validator): file/image/video (case-insensitive, trimmed).
 * Never leaks paths/blobs — identity only.
 */
export function isAdoptionPortableMediaType(type: unknown): boolean {
  const t = typeof type === 'string' ? type.trim().toLowerCase() : ''
  return t === 'file' || t === 'image' || t === 'video'
}

/**
 * Normalize adoption assetIds to sorted unique portable refs.
 * Returns null when the value is not a usable portable ref list
 * (non-array, empty, non-string entry, traversal, duplicate after
 * normalization counts as invalid input — callers fail closed).
 * Absent/null/undefined normalizes to [] (non-media empty, never a
 * portable proof).
 */
export function normalizeAdoptionAssetIds(ids: unknown): string[] | null {
  if (ids === undefined || ids === null) return []
  if (!Array.isArray(ids)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of ids as unknown[]) {
    if (typeof v !== 'string' || v.length === 0) return null
    if (v.includes('/') || v.includes('\\') || v.includes('..')) return null
    if (seen.has(v)) return null
    seen.add(v)
    out.push(v)
  }
  out.sort()
  return out
}

export function decodeAdoptionOverflow(extra: string | null): Record<string, unknown> {
  if (!extra) return {}
  try {
    const parsed = JSON.parse(extra)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
}

function fail(msg: string): never {
  throw new SyncBaselineApplyError(msg)
}

export function buildAdoptionTopicPayload(row: {
  id: string
  assistantId: string | null
  name: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  extra: string | null
}): Record<string, unknown> {
  const overflow = decodeAdoptionOverflow(row.extra)
  const raw: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    assistantId: row.assistantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt
  }
  for (const k of ['pinned', 'prompt', 'isNameManuallyEdited'] as const) {
    if (Object.prototype.hasOwnProperty.call(overflow, k)) raw[k] = overflow[k]
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'pinned')) raw['pinned'] = false
  if (!Object.prototype.hasOwnProperty.call(raw, 'prompt')) raw['prompt'] = null
  if (!Object.prototype.hasOwnProperty.call(raw, 'isNameManuallyEdited')) raw['isNameManuallyEdited'] = false
  const filtered = filterTopicPayload(raw)
  if (!filtered) fail(`adoption topic payload filter rejected ${row.id}`)
  return filtered
}

export function buildAdoptionMessagePayload(row: {
  id: string
  topicId: string
  branchId?: string | null
  role: string | null
  content: string | null
  status: string | null
  askId: string | null
  model: string | null
  modelId: string | null
  assistantId: string | null
  createdAt: string | null
  updatedAt: string | null
}): Record<string, unknown> {
  const branchId = typeof row.branchId === 'string' && row.branchId.length > 0 ? row.branchId : null
  const raw: Record<string, unknown> = {
    id: row.id,
    topicId: row.topicId,
    branchId,
    role: row.role,
    content: row.content,
    status: row.status,
    askId: row.askId,
    model: row.model,
    modelId: row.modelId,
    assistantId: row.assistantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
  const filtered = filterMessagePayload(raw)
  if (!filtered) fail(`adoption message payload filter rejected ${row.id}`)
  if (Object.prototype.hasOwnProperty.call(filtered, 'sortOrder')) fail(`sortOrder leak for ${row.id}`)
  return filtered
}

export function buildAdoptionBranchPayload(row: {
  id: string
  topicId: string
  parentBranchId: string | null
  anchorMessageId: string
  name: string | null
  createdAt: string | null
  updatedAt: string | null
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: row.id,
    topicId: row.topicId,
    parentBranchId: row.parentBranchId,
    anchorMessageId: row.anchorMessageId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
  const filtered = filterBranchPayload(raw)
  if (!filtered) fail(`adoption branch payload filter rejected ${row.id}`)
  return filtered
}

export function buildAdoptionBlockPayload(row: {
  id: string
  messageId: string
  type: string | null
  content: string | null
  status: string | null
  createdAt: string | null
  updatedAt: string | null
  assetIds?: unknown
}): Record<string, unknown> {
  const portable = isAdoptionPortableMediaType(row.type)
  const normalized = normalizeAdoptionAssetIds((row as { assetIds?: unknown }).assetIds)
  if (normalized === null) fail(`adoption block assetIds invalid for ${row.id}`)
  if (portable && normalized.length === 0) {
    // V5 portable full-state requires non-empty assetIds (payloadFilter:614).
    // Callers must supply validated portable refs or defer to the attachment
    // capture pipeline — never mint a shell here.
    fail(`adoption portable media block requires non-empty assetIds for ${row.id}`)
  }
  if (!portable && normalized.length > 0) fail(`adoption non-media block must not have assetIds for ${row.id}`)
  const raw: Record<string, unknown> = {
    id: row.id,
    messageId: row.messageId,
    type: row.type,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    assetIds: [...normalized]
  }
  const filtered = filterBlockPayload(raw)
  if (!filtered) fail(`adoption block payload filter rejected ${row.id}`)
  if (Object.prototype.hasOwnProperty.call(filtered, 'sortOrder')) fail(`sortOrder leak for ${row.id}`)
  return filtered
}

/**
 * Known pre-V5 adoption emitter shape (strictly malformed under the V5
 * portable contract): message_block upsert whose explicit portable type
 * (file/image/video) carries no assetIds and no sortOrder/extra keys.
 * Returns true only for that exact shape — never for arbitrary failed
 * payloads, non-portable blocks, or blocks that already carry refs.
 */
export function isKnownMalformedAdoptionPortableOp(op: {
  entityType?: unknown
  op?: unknown
  entityId?: unknown
  payload?: unknown
}): boolean {
  if (op.entityType !== 'message_block' || op.op !== 'upsert') return false
  if (typeof op.entityId !== 'string' || op.entityId.length === 0) return false
  const p = op.payload as Record<string, unknown> | null | undefined
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false
  if (!isAdoptionPortableMediaType(p.type)) return false
  const keys = new Set(Object.keys(p))
  // Exact known emitter keys: id/messageId + five V5-minus-assetIds fields.
  // Any assetIds/sortOrder/unknown key disqualifies (not the known shape).
  const allowed = new Set(['id', 'messageId', 'type', 'content', 'status', 'createdAt', 'updatedAt'])
  for (const k of keys) if (!allowed.has(k)) return false
  if (p.id !== op.entityId) return false
  const mid = p.messageId
  if (typeof mid !== 'string' || mid.length === 0) return false
  return true
}

/**
 * Build the canonical repaired payload for the known malformed shape:
 * preserves every non-asset key byte-identically (same id/parent/type/
 * business fields) and hydrates only the missing assetIds from proven
 * portable refs (sorted unique, validated). Never fabricates clocks/paths.
 */
export function buildRepairedAdoptionPortablePayload(
  malformedPayload: Record<string, unknown>,
  provenAssetIds: unknown
): Record<string, unknown> {
  const normalized = normalizeAdoptionAssetIds(provenAssetIds)
  if (!normalized || normalized.length === 0) fail('repair requires proven non-empty portable refs')
  const out: Record<string, unknown> = { ...malformedPayload, assetIds: [...normalized] }
  const filtered = filterBlockPayload(out)
  if (!filtered) fail('repair payload filter rejected')
  return filtered
}

/**
 * Max persisted clock across entity/field/membership/parent-frame/high-water
 * tables in the adoption tx snapshot. Missing sync tables are tolerated as
 * empty (fresh profile); any other read failure propagates. Returns -1 when
 * no clocks exist. Callers max with incoming clocks and wall before +1.
 */
export function scanAdoptionMaxObserved(tx: BetterSQLite3Database<typeof schema>): number {
  let maxObserved = -1
  const upd = (ts: unknown): void => {
    if (typeof ts === 'number' && Number.isSafeInteger(ts) && ts >= 0 && ts > maxObserved) maxObserved = ts
  }
  const tolerant = (fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (!/no such table/i.test(m)) throw e
    }
  }
  tolerant(() => {
    for (const r of tx.select().from(schema.syncEntityClock).all() as Array<{ timestamp: number }>) upd(r.timestamp)
  })
  tolerant(() => {
    for (const r of tx.select().from(schema.syncFieldClock).all() as Array<{ timestamp: number }>) upd(r.timestamp)
  })
  tolerant(() => {
    for (const r of tx.select().from(schema.syncMembershipClock).all() as Array<{ timestamp: number }>) {
      upd(r.timestamp)
    }
  })
  tolerant(() => {
    for (const r of tx.select().from(schema.syncParentOrderFrame).all() as Array<{ timestamp: number }>) {
      upd(r.timestamp)
    }
  })
  tolerant(() => {
    for (const r of tx.select().from(schema.syncFrameHighWater).all() as Array<{ maxTimestamp: number }>) {
      upd(r.maxTimestamp)
    }
  })
  return maxObserved
}
