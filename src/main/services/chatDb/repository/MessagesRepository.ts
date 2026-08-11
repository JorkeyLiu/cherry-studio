/**
 * MessagesRepository — CRUD + ordering for the messages table.
 *
 * Ordering guarantees:
 * - sort_order is zero-based dense within each topic.
 * - All mutating operations (append, insertAt, upsertAt, delete, deleteMany)
 *   normalize sibling orders transactionally.
 * - replaceOrder uses direct sequential assignment (no fixed-offset hack).
 *
 * Segment cleanup:
 * - delete, deleteMany remove segments that become empty.
 *
 * Identity protection:
 * - update rejects attempts to change id or topicId.
 * - upsertAt rejects cross-topic reparenting.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { decodeNumericOrderCursor, encodeNumericOrderCursor, type PageCursor, type PageResult } from '../domain/cursor'
import { messageToRowPatch } from '../domain/mappers'
import type { EntityPatchInput, MessageData } from '../domain/types'
import { messages, topics, topicSegmentMessages, topicSegments } from '../schema'
import {
  type AffectedCount,
  assertNoIdentityChange,
  assertNoSortOrderChange,
  assignDenseOrders,
  buildColumnMap,
  clampIndex,
  found,
  fromDrizzleResult,
  type GetResult,
  insertAtId,
  loadOrderedIds,
  moveId,
  notFound,
  toInsertValues,
  toUpdateValues,
  validatePageLimit
} from './helpers'

const COLUMN_MAP = buildColumnMap([
  ['id', 'id'],
  ['topicId', 'topic_id'],
  ['role', 'role'],
  ['content', 'content'],
  ['status', 'status'],
  ['askId', 'ask_id'],
  ['model', 'model'],
  ['modelId', 'model_id'],
  ['assistantId', 'assistant_id'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['sortOrder', 'sort_order']
])

export class MessagesRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  private assertTopicExists(topicId: string): void {
    const exists = this.db.select({ id: topics.id }).from(topics).where(eq(topics.id, topicId)).get()
    if (!exists) throw new Error(`Topic ${topicId} does not exist`)
  }

  /**
   * Normalize all sibling sort_order values within a topic to dense zero-based.
   * Phase 2: uses central loadOrderedIds + assignDenseOrders.
   */
  private normalizeOrdersInTx(tx: any, topicId: string): void {
    const ids = loadOrderedIds(tx, messages, messages.topicId, topicId)
    assignDenseOrders(tx, messages, ids)
  }

  /**
   * Clean up segments that have become empty after message deletion.
   * Normalizes membership orders in surviving segments and sibling
   * segment orders after empty-segment deletion.
   * Must be called inside a transaction.
   */
  private cleanupEmptySegmentsInTx(tx: any, topicId: string): void {
    const segments = tx
      .select({ id: topicSegments.id })
      .from(topicSegments)
      .where(eq(topicSegments.topicId, topicId))
      .all()
    let deletedAny = false
    for (const seg of segments) {
      // Normalize membership orders in every surviving segment
      const rows = tx
        .select({ messageId: topicSegmentMessages.messageId })
        .from(topicSegmentMessages)
        .where(eq(topicSegmentMessages.segmentId, seg.id))
        .orderBy(asc(topicSegmentMessages.sortOrder), asc(topicSegmentMessages.messageId))
        .all()
      for (let i = 0; i < rows.length; i++) {
        tx.update(topicSegmentMessages)
          .set({ sortOrder: i })
          .where(and(eq(topicSegmentMessages.segmentId, seg.id), eq(topicSegmentMessages.messageId, rows[i].messageId)))
          .run()
      }
      if (rows.length === 0) {
        tx.delete(topicSegments).where(eq(topicSegments.id, seg.id)).run()
        deletedAny = true
      }
    }
    // Normalize sibling segment orders after any empty-segment deletion
    if (deletedAny) {
      const remainingIds = tx
        .select({ id: topicSegments.id })
        .from(topicSegments)
        .where(eq(topicSegments.topicId, topicId))
        .orderBy(asc(topicSegments.sortOrder), asc(topicSegments.id))
        .all()
        .map((r: any) => r.id as string)
      for (let i = 0; i < remainingIds.length; i++) {
        tx.update(topicSegments).set({ sortOrder: i }).where(eq(topicSegments.id, remainingIds[i])).run()
      }
    }
  }

  getById(id: string): GetResult<MessageData> {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get()
    if (!row) return notFound()
    return found(fromDrizzleResult<MessageData>(row, 'messages', (row as any).id))
  }

  getInTopic(id: string, topicId: string): GetResult<MessageData> {
    const row = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.topicId, topicId)))
      .get()
    if (!row) return notFound()
    return found(fromDrizzleResult<MessageData>(row, 'messages', (row as any).id))
  }

  findByIds(ids: string[]): MessageData[] {
    if (ids.length === 0) return []
    const rows = this.db.select().from(messages).where(sql`${messages.id} IN ${ids}`).all()
    const rowMap = new Map(rows.map((r) => [(r as any).id, r]))
    return ids
      .map((id) => rowMap.get(id))
      .filter((r) => r !== undefined)
      .map((r) => fromDrizzleResult<MessageData>(r, 'messages', (r as any).id))
  }

  listByTopic(topicId: string): MessageData[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.topicId, topicId))
      .orderBy(asc(messages.sortOrder), asc(messages.id))
      .all()
      .map((r) => fromDrizzleResult<MessageData>(r, 'messages', (r as any).id))
  }

  /**
   * List messages in a topic with keyset pagination.
   * Phase 2: uses typed numeric-order cursor.
   */
  listByTopicPage(topicId: string, page: PageCursor): PageResult<MessageData> {
    const limit = validatePageLimit(page.limit)
    const conditions = [eq(messages.topicId, topicId)]
    if (page.cursor) {
      const decoded = decodeNumericOrderCursor(page.cursor)
      if (page.direction === 'desc') {
        conditions.push(sql`(${messages.sortOrder}, ${messages.id}) < (${decoded.sortOrder}, ${decoded.id})`)
      } else {
        conditions.push(sql`(${messages.sortOrder}, ${messages.id}) > (${decoded.sortOrder}, ${decoded.id})`)
      }
    }
    const where = and(...conditions)
    const orderBy =
      page.direction === 'desc'
        ? [desc(messages.sortOrder), desc(messages.id)]
        : [asc(messages.sortOrder), asc(messages.id)]
    const items = this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit + 1)
      .all()
    const hasMore = items.length > limit
    const pageItems = hasMore ? items.slice(0, limit) : items
    let nextCursor: string | undefined
    if (hasMore && pageItems.length > 0) {
      const last = pageItems[pageItems.length - 1] as any
      nextCursor = encodeNumericOrderCursor(last.sortOrder ?? last.sort_order, last.id)
    }
    return {
      items: pageItems.map((r) => fromDrizzleResult<MessageData>(r, 'messages', (r as any).id)),
      nextCursor,
      hasMore
    }
  }

  countByTopic(topicId: string): number {
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.topicId, topicId))
      .get()
    return result?.count ?? 0
  }

  /**
   * Create a message. Phase 2: normalizes sibling orders to ensure density.
   */
  create(data: MessageData): MessageData {
    this.assertTopicExists(data.topicId)
    return this.db.transaction((tx) => {
      const values = toInsertValues(data)
      tx.insert(messages)
        .values(values as any)
        .run()
      this.normalizeOrdersInTx(tx, data.topicId)
      return fromDrizzleResult<MessageData>(
        tx.select().from(messages).where(eq(messages.id, data.id)).get() ?? ({} as any),
        'messages',
        data.id
      )
    })
  }

  append(data: MessageData): MessageData {
    this.assertTopicExists(data.topicId)
    return this.db.transaction((tx) => {
      const maxOrder = tx
        .select({ max: sql<number>`COALESCE(MAX(${messages.sortOrder}), -1)` })
        .from(messages)
        .where(eq(messages.topicId, data.topicId))
        .get()
      const newOrder = (maxOrder?.max ?? -1) + 1
      const values = toInsertValues({ ...data, sortOrder: newOrder })
      tx.insert(messages)
        .values(values as any)
        .run()
      this.normalizeOrdersInTx(tx, data.topicId)
      return fromDrizzleResult<MessageData>(
        tx.select().from(messages).where(eq(messages.id, data.id)).get() ?? ({} as any),
        'messages',
        data.id
      )
    })
  }

  insertAt(data: MessageData, index: number): MessageData {
    const count = this.countByTopic(data.topicId)
    index = clampIndex(index, count)
    this.assertTopicExists(data.topicId)
    return this.db.transaction((tx) => {
      tx.run(
        sql`UPDATE ${messages} SET sort_order = sort_order + 1 WHERE ${messages.topicId} = ${data.topicId} AND ${messages.sortOrder} >= ${index}`
      )
      const values = toInsertValues({ ...data, sortOrder: index })
      tx.insert(messages)
        .values(values as any)
        .run()
      this.normalizeOrdersInTx(tx, data.topicId)
      return fromDrizzleResult<MessageData>(
        tx.select().from(messages).where(eq(messages.id, data.id)).get() ?? ({} as any),
        'messages',
        data.id
      )
    })
  }

  /**
   * Upsert a message at a specific position.
   *
   * Phase 2: uses central ordered-list helpers for correct forward/backward
   * moves on clean or corrupt orders. Rejects cross-topic reparenting.
   */
  upsertAt(data: MessageData, index: number): MessageData {
    this.assertTopicExists(data.topicId)
    return this.db.transaction((tx) => {
      const existing = tx.select().from(messages).where(eq(messages.id, data.id)).get()
      const currentIds = loadOrderedIds(tx, messages, messages.topicId, data.topicId)

      if (existing) {
        // Reject cross-topic reparenting
        if ((existing as any).topicId !== data.topicId) {
          throw new Error(
            `Message ${data.id} belongs to topic ${(existing as any).topicId}, cannot reparent to ${data.topicId}`
          )
        }
        // Move in the list
        const clampedIndex = clampIndex(index, currentIds.length - 1)
        const newIds = moveId(currentIds, data.id, clampedIndex)

        // Update metadata
        const rowPatch = messageToRowPatch(data)
        const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
        tx.update(messages).set(values).where(eq(messages.id, data.id)).run()

        // Assign dense orders based on new positions
        assignDenseOrders(tx, messages, newIds)
      } else {
        const clampedIndex = clampIndex(index, currentIds.length)
        const newIds = insertAtId(currentIds, data.id, clampedIndex)

        const values = toInsertValues(data)
        tx.insert(messages)
          .values(values as any)
          .run()

        assignDenseOrders(tx, messages, newIds)
      }

      return fromDrizzleResult<MessageData>(
        tx.select().from(messages).where(eq(messages.id, data.id)).get() ?? ({} as any),
        'messages',
        data.id
      )
    })
  }

  /**
   * Create many messages. Phase 2: normalizes sibling orders after batch.
   */
  createMany(items: MessageData[]): MessageData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const affectedTopics = new Set<string>()
      for (const item of items) {
        this.assertTopicExists(item.topicId)
        affectedTopics.add(item.topicId)
        const values = toInsertValues(item)
        tx.insert(messages)
          .values(values as any)
          .run()
      }
      // Normalize all affected topics
      for (const topicId of affectedTopics) {
        this.normalizeOrdersInTx(tx, topicId)
      }
      return items.map((item) =>
        fromDrizzleResult<MessageData>(
          tx.select().from(messages).where(eq(messages.id, item.id)).get() ?? ({} as any),
          'messages',
          item.id
        )
      )
    })
  }

  /**
   * Upsert many messages. Phase 2: rejects topicId change on existing
   * rows, normalizes sibling orders after batch.
   */
  upsertMany(items: MessageData[]): MessageData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const affectedTopics = new Set<string>()
      for (const item of items) {
        this.assertTopicExists(item.topicId)
        affectedTopics.add(item.topicId)
        const existing = tx.select().from(messages).where(eq(messages.id, item.id)).get()
        if (existing) {
          // Phase 2: reject topicId change
          if ((existing as any).topicId !== item.topicId) {
            throw new Error(
              `Message ${item.id} belongs to topic ${(existing as any).topicId}, cannot reparent to ${item.topicId}`
            )
          }
          const rowPatch = messageToRowPatch(item)
          const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
          tx.update(messages)
            .set(values as any)
            .where(eq(messages.id, item.id))
            .run()
        } else {
          const values = toInsertValues(item)
          tx.insert(messages)
            .values(values as any)
            .run()
        }
      }
      // Normalize all affected topics
      for (const topicId of affectedTopics) {
        this.normalizeOrdersInTx(tx, topicId)
      }
      return items.map((item) =>
        fromDrizzleResult<MessageData>(
          tx.select().from(messages).where(eq(messages.id, item.id)).get() ?? ({} as any),
          'messages',
          item.id
        )
      )
    })
  }

  /**
   * Update a message by ID.
   * Phase 2: rejects identity AND sortOrder changes.
   */
  update(topicId: string, messageId: string, patch: EntityPatchInput<MessageData>): AffectedCount {
    assertNoIdentityChange(patch as Record<string, unknown>, 'messages', { id: messageId, topicId })
    assertNoSortOrderChange(patch as Record<string, unknown>)
    const current = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.topicId, topicId)))
      .get()
    if (!current) return { affected: 0 }
    const rowPatch = messageToRowPatch(patch)
    const values = toUpdateValues((current as any).extra, rowPatch, COLUMN_MAP)
    this.db
      .update(messages)
      .set(values as any)
      .where(eq(messages.id, messageId))
      .run()
    return { affected: 1 }
  }

  /**
   * Delete a single message. Normalizes sibling orders and cleans up
   * segments that become empty, all in one transaction.
   */
  delete(id: string): AffectedCount {
    return this.db.transaction((tx) => {
      // Find topic before deleting (for normalization + cleanup)
      const msg = tx.select({ topicId: messages.topicId }).from(messages).where(eq(messages.id, id)).get()
      const result = tx.delete(messages).where(eq(messages.id, id)).run()
      if (result.changes > 0 && msg) {
        this.normalizeOrdersInTx(tx, msg.topicId)
        this.cleanupEmptySegmentsInTx(tx, msg.topicId)
      }
      return { affected: result.changes }
    })
  }

  /**
   * Delete multiple messages. Normalizes sibling orders and cleans up
   * empty segments per affected topic, all in one transaction.
   */
  deleteMany(ids: string[]): AffectedCount {
    if (ids.length === 0) return { affected: 0 }
    return this.db.transaction((tx) => {
      // Collect affected topics before deletion
      const affectedTopics = new Set<string>()
      for (const id of ids) {
        const msg = tx.select({ topicId: messages.topicId }).from(messages).where(eq(messages.id, id)).get()
        if (msg) affectedTopics.add(msg.topicId)
      }
      let total = 0
      for (const id of ids) total += tx.delete(messages).where(eq(messages.id, id)).run().changes
      // Normalize and clean up per affected topic
      for (const topicId of affectedTopics) {
        this.normalizeOrdersInTx(tx, topicId)
        this.cleanupEmptySegmentsInTx(tx, topicId)
      }
      return { affected: total }
    })
  }

  /**
   * Replace the order of all messages in a topic.
   * Phase 2: uses assignDenseOrders for direct sequential assignment.
   */
  replaceOrder(topicId: string, orderedIds: string[]): AffectedCount {
    const uniqueIds = new Set(orderedIds)
    if (uniqueIds.size !== orderedIds.length) throw new Error('Duplicate message IDs in orderedIds')
    const existing = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.topicId, topicId))
      .all()
      .map((r) => r.id)
    const existingSet = new Set(existing)
    for (const id of orderedIds) {
      if (!existingSet.has(id)) throw new Error(`Message ${id} does not belong to topic ${topicId}`)
    }
    if (orderedIds.length !== existing.length)
      throw new Error(`Incomplete message list: expected ${existing.length}, got ${orderedIds.length}`)
    return this.db.transaction((tx) => {
      assignDenseOrders(tx, messages, orderedIds)
      return { affected: orderedIds.length }
    })
  }
}
