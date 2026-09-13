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

import { filterBlockPayload, filterMessagePayload, filterTopicPayload } from '@shared/sync'
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
  'updatedAt'
])

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
  const raw: Record<string, unknown> = {
    id: row.id,
    topicId: row.topicId,
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

export function buildAdoptionBlockPayload(row: {
  id: string
  messageId: string
  type: string | null
  content: string | null
  status: string | null
  createdAt: string | null
  updatedAt: string | null
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: row.id,
    messageId: row.messageId,
    type: row.type,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
  const filtered = filterBlockPayload(raw)
  if (!filtered) fail(`adoption block payload filter rejected ${row.id}`)
  if (Object.prototype.hasOwnProperty.call(filtered, 'sortOrder')) fail(`sortOrder leak for ${row.id}`)
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
