/**
 * TopicsRepository — CRUD + pagination for the topics table.
 *
 * Topics have no sort_order column; ordering uses (createdAt, id).
 * The cursor stores createdAt as an ISO string (not a numeric sortOrder).
 */

import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import {
  decodeTopicTimestampCursor,
  encodeTopicTimestampCursor,
  type PageCursor,
  type PageResult
} from '../domain/cursor'
import { topicToRowPatch } from '../domain/mappers'
import type { EntityPatchInput, TopicData } from '../domain/types'
import { topics } from '../schema'
import {
  type AffectedCount,
  assertNoIdentityChange,
  buildColumnMap,
  found,
  fromDrizzleResult,
  type GetResult,
  notFound,
  toInsertValues,
  toUpdateValues,
  validatePageLimit
} from './helpers'

const COLUMN_MAP = buildColumnMap([
  ['id', 'id'],
  ['assistantId', 'assistant_id'],
  ['name', 'name'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['deletedAt', 'deleted_at']
])

export class TopicsRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  getById(id: string): GetResult<TopicData> {
    const row = this.db.select().from(topics).where(eq(topics.id, id)).get()
    if (!row) return notFound()
    return found(fromDrizzleResult<TopicData>(row, 'topics', (row as any).id))
  }

  exists(id: string): boolean {
    const row = this.db.select({ id: topics.id }).from(topics).where(eq(topics.id, id)).get()
    return row !== undefined
  }

  count(options?: { assistantId?: string; excludeDeleted?: boolean }): number {
    const conditions: ReturnType<typeof eq>[] = []
    if (options?.assistantId) conditions.push(eq(topics.assistantId, options.assistantId))
    if (options?.excludeDeleted) conditions.push(isNull(topics.deletedAt))
    const where = conditions.length > 0 ? and(...conditions) : undefined
    const result = this.db.select({ count: sql<number>`count(*)` }).from(topics).where(where).get()
    return result?.count ?? 0
  }

  create(data: TopicData): TopicData {
    const canonicalized = { ...data, createdAt: data.createdAt ?? new Date().toISOString() }
    const values = toInsertValues(canonicalized)
    this.db
      .insert(topics)
      .values(values as any)
      .run()
    return (this.getById(data.id) as any).data
  }

  ensure(id: string, assistantId?: string): TopicData {
    const existing = this.getById(id)
    if (existing.found) return existing.data
    return this.create({
      id,
      assistantId: assistantId ?? null,
      name: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      overflow: {}
    })
  }

  upsert(data: TopicData): TopicData {
    const existing = this.getById(data.id)
    if (!existing.found) return this.create(data)
    const canonicalized = { ...data, createdAt: data.createdAt ?? existing.data.createdAt ?? new Date().toISOString() }
    this.updatePatch(data.id, canonicalized)
    return (this.getById(data.id) as any).data
  }

  /**
   * Update a topic by ID.
   * Rejects attempts to change the identity field (id).
   */
  updatePatch(id: string, patch: EntityPatchInput<TopicData>): AffectedCount {
    assertNoIdentityChange(patch as Record<string, unknown>, 'topics', { id })
    const current = this.db.select().from(topics).where(eq(topics.id, id)).get()
    if (!current) return { affected: 0 }
    const rowPatch = topicToRowPatch(patch)
    const values = toUpdateValues((current as any).extra, rowPatch, COLUMN_MAP)
    this.db
      .update(topics)
      .set(values as any)
      .where(eq(topics.id, id))
      .run()
    return { affected: 1 }
  }

  softDelete(id: string): AffectedCount {
    return this.updatePatch(id, { deletedAt: new Date().toISOString() })
  }

  restore(id: string): AffectedCount {
    return this.updatePatch(id, { deletedAt: null })
  }

  hardDelete(id: string): AffectedCount {
    const result = this.db.delete(topics).where(eq(topics.id, id)).run()
    return { affected: result.changes }
  }

  createMany(items: TopicData[]): TopicData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const results: TopicData[] = []
      for (const item of items) {
        const canonicalized = { ...item, createdAt: item.createdAt ?? new Date().toISOString() }
        const values = toInsertValues(canonicalized)
        tx.insert(topics)
          .values(values as any)
          .run()
        results.push(
          fromDrizzleResult<TopicData>(
            tx.select().from(topics).where(eq(topics.id, item.id)).get() ?? ({} as any),
            'topics',
            item.id
          )
        )
      }
      return results
    })
  }

  upsertMany(items: TopicData[]): TopicData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const results: TopicData[] = []
      for (const item of items) {
        const existing = tx.select().from(topics).where(eq(topics.id, item.id)).get()
        if (existing) {
          // Canonicalize createdAt: preserve existing if incoming is null
          const canonicalized = {
            ...item,
            createdAt: item.createdAt ?? (existing as any).createdAt ?? new Date().toISOString()
          }
          const rowPatch = topicToRowPatch(canonicalized)
          const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
          tx.update(topics)
            .set(values as any)
            .where(eq(topics.id, item.id))
            .run()
        } else {
          const canonicalized = { ...item, createdAt: item.createdAt ?? new Date().toISOString() }
          const values = toInsertValues(canonicalized)
          tx.insert(topics)
            .values(values as any)
            .run()
        }
        results.push(
          fromDrizzleResult<TopicData>(
            tx.select().from(topics).where(eq(topics.id, item.id)).get() ?? ({} as any),
            'topics',
            item.id
          )
        )
      }
      return results
    })
  }

  deleteMany(ids: string[]): AffectedCount {
    if (ids.length === 0) return { affected: 0 }
    return this.db.transaction((tx) => {
      let total = 0
      for (const id of ids) {
        total += tx.delete(topics).where(eq(topics.id, id)).run().changes
      }
      return { affected: total }
    })
  }

  /**
   * List active (non-deleted) topics with keyset pagination.
   *
   * Topics are ordered by (createdAt, id). The cursor stores createdAt
   * as an ISO string. Both ASC and DESC directions are supported.
   *
   * Phase 2: filters deleted_at IS NULL, uses typed topic-timestamp
   * cursor, and handles legacy null createdAt via COALESCE to ''.
   */
  listPage(page: PageCursor): PageResult<TopicData> {
    const limit = validatePageLimit(page.limit)
    // Active topics only
    const conditions: ReturnType<typeof sql>[] = [isNull(topics.deletedAt)]
    if (page.cursor) {
      const decoded = decodeTopicTimestampCursor(page.cursor)
      const ts = decoded.sortOrder // ISO timestamp or '' sentinel for null
      if (page.direction === 'desc') {
        conditions.push(sql`(COALESCE(${topics.createdAt}, ''), ${topics.id}) < (${ts}, ${decoded.id})`)
      } else {
        conditions.push(sql`(COALESCE(${topics.createdAt}, ''), ${topics.id}) > (${ts}, ${decoded.id})`)
      }
    }
    const where = and(...conditions)
    const orderBy =
      page.direction === 'desc' ? [desc(topics.createdAt), desc(topics.id)] : [asc(topics.createdAt), asc(topics.id)]
    const items = this.db
      .select()
      .from(topics)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit + 1)
      .all()
    const hasMore = items.length > limit
    const pageItems = hasMore ? items.slice(0, limit) : items
    let nextCursor: string | undefined
    if (hasMore && pageItems.length > 0) {
      const last = pageItems[pageItems.length - 1] as any
      nextCursor = encodeTopicTimestampCursor(last.createdAt ?? '', last.id)
    }
    return {
      items: pageItems.map((r) => fromDrizzleResult<TopicData>(r, 'topics', (r as any).id)),
      nextCursor,
      hasMore
    }
  }

  /**
   * List soft-deleted topics with cursor-based pagination (descending by default).
   *
   * Phase 2: uses typed topic-timestamp cursor, COALESCE for null createdAt.
   */
  listTrashPage(page: PageCursor, options?: { assistantId?: string }): PageResult<TopicData> {
    const limit = validatePageLimit(page.limit)
    const conditions = [isNotNull(topics.deletedAt)]
    if (options?.assistantId) conditions.push(eq(topics.assistantId, options.assistantId))
    if (page.cursor) {
      const decoded = decodeTopicTimestampCursor(page.cursor)
      const ts = decoded.sortOrder
      if (page.direction === 'asc') {
        conditions.push(sql`(COALESCE(${topics.createdAt}, ''), ${topics.id}) > (${ts}, ${decoded.id})`)
      } else {
        conditions.push(sql`(COALESCE(${topics.createdAt}, ''), ${topics.id}) < (${ts}, ${decoded.id})`)
      }
    }
    const where = and(...conditions)
    const orderBy =
      page.direction === 'asc' ? [asc(topics.createdAt), asc(topics.id)] : [desc(topics.createdAt), desc(topics.id)]
    const items = this.db
      .select()
      .from(topics)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit + 1)
      .all()
    const hasMore = items.length > limit
    const pageItems = hasMore ? items.slice(0, limit) : items
    let nextCursor: string | undefined
    if (hasMore && pageItems.length > 0) {
      const last = pageItems[pageItems.length - 1] as any
      nextCursor = encodeTopicTimestampCursor(last.createdAt ?? '', last.id)
    }
    return {
      items: pageItems.map((r) => fromDrizzleResult<TopicData>(r, 'topics', (r as any).id)),
      nextCursor,
      hasMore
    }
  }
}
