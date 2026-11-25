/**
 * TopicSegmentsRepository — CRUD + membership management for topic_segments.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { decodeNumericOrderCursor, encodeNumericOrderCursor, type PageCursor, type PageResult } from '../domain/cursor'
import { topicSegmentToRowPatch } from '../domain/mappers'
import type { EntityPatchInput, TopicSegmentData } from '../domain/types'
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
  loadOrderedIds,
  notFound,
  toInsertValues,
  toUpdateValues,
  validatePageLimit
} from './helpers'

const COLUMN_MAP = buildColumnMap([
  ['id', 'id'],
  ['topicId', 'topic_id'],
  ['name', 'name'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['sortOrder', 'sort_order'],
  ['headerMessageId', 'header_message_id']
])

export class TopicSegmentsRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  private assertTopicExists(topicId: string): void {
    const exists = this.db.select({ id: topics.id }).from(topics).where(eq(topics.id, topicId)).get()
    if (!exists) throw new Error(`Topic ${topicId} does not exist`)
  }

  private validateMessagesBelongToTopic(messageIds: string[], topicId: string): void {
    if (messageIds.length === 0) return
    const existing = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(sql`${messages.id} IN ${messageIds} AND ${messages.topicId} = ${topicId}`)
      .all()
      .map((r) => r.id)
    const existingSet = new Set(existing)
    for (const id of messageIds) {
      if (!existingSet.has(id)) throw new Error(`Message ${id} does not belong to topic ${topicId}`)
    }
  }

  /**
   * Normalize membership sort_order values to dense 0..n-1.
   * Must be called inside a transaction.
   */
  private normalizeMembershipOrdersInTx(tx: any, segmentId: string): void {
    const rows = tx
      .select({ messageId: topicSegmentMessages.messageId })
      .from(topicSegmentMessages)
      .where(eq(topicSegmentMessages.segmentId, segmentId))
      .orderBy(asc(topicSegmentMessages.sortOrder), asc(topicSegmentMessages.messageId))
      .all()
    for (let i = 0; i < rows.length; i++) {
      tx.update(topicSegmentMessages)
        .set({ sortOrder: i })
        .where(
          and(eq(topicSegmentMessages.segmentId, segmentId), eq(topicSegmentMessages.messageId, rows[i].messageId))
        )
        .run()
    }
  }

  /**
   * Normalize sibling segment sort_order values within a topic to dense 0..n-1.
   * Must be called inside a transaction.
   */
  private normalizeSiblingOrdersInTx(tx: any, topicId: string): void {
    const ids = loadOrderedIds(tx, topicSegments, topicSegments.topicId, topicId)
    assignDenseOrders(tx, topicSegments, ids)
  }
  /**
   * Keep a group's persisted head consistent with its membership.
   *
   * The invariants are exactly two: the head stays the same while it is still
   * a member (membership order changes never move it), and a head that left
   * the group repairs to the group's first surviving member in authoritative
   * membership order. A group with no members has no head. This runs inside
   * the caller's transaction, from authority rows only.
   */
  private repairHeaderInTx(tx: any, segmentId: string): void {
    const current = (
      tx
        .select({ headerMessageId: topicSegments.headerMessageId })
        .from(topicSegments)
        .where(eq(topicSegments.id, segmentId))
        .get() as { headerMessageId: string | null } | undefined
    )?.headerMessageId
    const persisted = current ?? null
    if (persisted !== null) {
      const stillMember = tx
        .select({ messageId: topicSegmentMessages.messageId })
        .from(topicSegmentMessages)
        .where(and(eq(topicSegmentMessages.segmentId, segmentId), eq(topicSegmentMessages.messageId, persisted)))
        .get()
      if (stillMember) return
    }
    const first = tx
      .select({ messageId: topicSegmentMessages.messageId })
      .from(topicSegmentMessages)
      .where(eq(topicSegmentMessages.segmentId, segmentId))
      .orderBy(asc(topicSegmentMessages.sortOrder), asc(topicSegmentMessages.messageId))
      .get() as { messageId: string } | undefined
    const next = first?.messageId ?? null
    if (next === persisted) return
    tx.update(topicSegments).set({ headerMessageId: next }).where(eq(topicSegments.id, segmentId)).run()
  }

  getById(id: string): GetResult<TopicSegmentData> {
    const row = this.db.select().from(topicSegments).where(eq(topicSegments.id, id)).get()
    if (!row) return notFound()
    return found(fromDrizzleResult<TopicSegmentData>(row, 'topic_segments', (row as any).id))
  }

  listByTopic(topicId: string): TopicSegmentData[] {
    return this.db
      .select()
      .from(topicSegments)
      .where(eq(topicSegments.topicId, topicId))
      .orderBy(asc(topicSegments.sortOrder), asc(topicSegments.id))
      .all()
      .map((r) => fromDrizzleResult<TopicSegmentData>(r, 'topic_segments', (r as any).id))
  }

  /**
   * List segments in a topic with keyset pagination.
   * Phase 2: uses typed numeric-order cursor.
   */
  listByTopicPage(topicId: string, page: PageCursor): PageResult<TopicSegmentData> {
    const limit = validatePageLimit(page.limit)
    const conditions = [eq(topicSegments.topicId, topicId)]
    if (page.cursor) {
      const decoded = decodeNumericOrderCursor(page.cursor)
      if (page.direction === 'desc') {
        conditions.push(sql`(${topicSegments.sortOrder}, ${topicSegments.id}) < (${decoded.sortOrder}, ${decoded.id})`)
      } else {
        conditions.push(sql`(${topicSegments.sortOrder}, ${topicSegments.id}) > (${decoded.sortOrder}, ${decoded.id})`)
      }
    }
    const where = and(...conditions)
    const orderBy =
      page.direction === 'desc'
        ? [desc(topicSegments.sortOrder), desc(topicSegments.id)]
        : [asc(topicSegments.sortOrder), asc(topicSegments.id)]
    const items = this.db
      .select()
      .from(topicSegments)
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
      items: pageItems.map((r) => fromDrizzleResult<TopicSegmentData>(r, 'topic_segments', (r as any).id)),
      nextCursor,
      hasMore
    }
  }

  /**
   * Complete membership of every group in one topic in a single set-based
   * read, assembled per group.
   *
   * Intra-group order is exactly the order `getMessageIds` returns
   * (`sortOrder`, then `messageId`), so a caller can replace one membership
   * query per group with one query per topic without changing any value.
   * Groups with no member row are absent from the map; callers read absence as
   * the empty list `getMessageIds` returns for them.
   */
  listMembersByTopic(topicId: string): Map<string, string[]> {
    const rows = this.db
      .select({
        segmentId: topicSegmentMessages.segmentId,
        messageId: topicSegmentMessages.messageId
      })
      .from(topicSegmentMessages)
      .innerJoin(topicSegments, eq(topicSegments.id, topicSegmentMessages.segmentId))
      .where(eq(topicSegments.topicId, topicId))
      .orderBy(
        asc(topicSegmentMessages.segmentId),
        asc(topicSegmentMessages.sortOrder),
        asc(topicSegmentMessages.messageId)
      )
      .all()
    const bySegment = new Map<string, string[]>()
    for (const row of rows) {
      const list = bySegment.get(row.segmentId)
      if (list) list.push(row.messageId)
      else bySegment.set(row.segmentId, [row.messageId])
    }
    return bySegment
  }

  getMessageIds(segmentId: string): string[] {
    return this.db
      .select({ messageId: topicSegmentMessages.messageId })
      .from(topicSegmentMessages)
      .where(eq(topicSegmentMessages.segmentId, segmentId))
      .orderBy(asc(topicSegmentMessages.sortOrder), asc(topicSegmentMessages.messageId))
      .all()
      .map((r) => r.messageId)
  }

  /**
   * Persisted group head identity, or null when the row carries none yet
   * (pre-020 row, or a head that has not been resolved/backfilled).
   */
  getHeaderMessageId(segmentId: string): string | null {
    const row = this.db
      .select({ headerMessageId: topicSegments.headerMessageId })
      .from(topicSegments)
      .where(eq(topicSegments.id, segmentId))
      .get()
    return (row?.headerMessageId ?? null) || null
  }

  /**
   * Write the group head identity. Callers derive the value from authority
   * (the first ordered member at creation, or the first surviving member when
   * the previous head left the group) — never from a renderer window.
   */
  setHeaderMessageId(segmentId: string, messageId: string | null): AffectedCount {
    const result = this.db
      .update(topicSegments)
      .set({ headerMessageId: messageId })
      .where(eq(topicSegments.id, segmentId))
      .run()
    return { affected: result.changes }
  }

  /**
   * Create a segment. Phase 2: normalizes sibling orders.
   */
  create(data: TopicSegmentData): TopicSegmentData {
    this.assertTopicExists(data.topicId)
    return this.db.transaction((tx) => {
      const values = toInsertValues(data)
      tx.insert(topicSegments)
        .values(values as any)
        .run()
      const ids = loadOrderedIds(tx, topicSegments, topicSegments.topicId, data.topicId)
      assignDenseOrders(tx, topicSegments, ids)
      return fromDrizzleResult<TopicSegmentData>(
        tx.select().from(topicSegments).where(eq(topicSegments.id, data.id)).get() ?? ({} as any),
        'topic_segments',
        data.id
      )
    })
  }

  /**
   * Create a segment at a dense catalog index, shifting siblings atomically.
   *
   * Preserves historical conversation-position ordering for new segments:
   * the caller derives `targetIndex` from authority message positions, and
   * this primitive splices the new id into the ordered sibling list then
   * assigns dense 0..n-1 orders in the same transaction. No global
   * recompute of existing catalog order beyond the shift. Target is clamped
   * to [0, siblingCount]; ties are stable by existing order (no UUID order).
   */
  createAtCatalogIndex(data: TopicSegmentData, targetIndex: number): TopicSegmentData {
    this.assertTopicExists(data.topicId)
    return this.db.transaction((tx) => {
      const values = toInsertValues(data)
      tx.insert(topicSegments)
        .values(values as any)
        .run()
      let ids = loadOrderedIds(tx, topicSegments, topicSegments.topicId, data.topicId)
      ids = ids.filter((id) => id !== data.id)
      const clamped = clampIndex(targetIndex, ids.length)
      ids.splice(clamped, 0, data.id)
      assignDenseOrders(tx, topicSegments, ids)
      return fromDrizzleResult<TopicSegmentData>(
        tx.select().from(topicSegments).where(eq(topicSegments.id, data.id)).get() ?? ({} as any),
        'topic_segments',
        data.id
      )
    })
  }

  upsert(data: TopicSegmentData): TopicSegmentData {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(topicSegments).where(eq(topicSegments.id, data.id)).get()
      if (!existing) {
        // Delegate to create which handles normalization
        return this.create(data)
      }
      // Phase 2: reject topicId change, allow same-topic update
      if ((existing as any).topicId !== data.topicId) {
        throw new Error(
          `Segment ${data.id} belongs to topic ${(existing as any).topicId}, cannot reparent to ${data.topicId}`
        )
      }
      const rowPatch = topicSegmentToRowPatch(data)
      const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
      tx.update(topicSegments)
        .set(values as any)
        .where(eq(topicSegments.id, data.id))
        .run()
      // Normalize sibling orders
      const ids = loadOrderedIds(tx, topicSegments, topicSegments.topicId, data.topicId)
      assignDenseOrders(tx, topicSegments, ids)
      return fromDrizzleResult<TopicSegmentData>(
        tx.select().from(topicSegments).where(eq(topicSegments.id, data.id)).get() ?? ({} as any),
        'topic_segments',
        data.id
      )
    })
  }

  /**
   * Create many segments. Phase 2: normalizes sibling orders after batch.
   */
  createMany(items: TopicSegmentData[]): TopicSegmentData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const affectedTopics = new Set<string>()
      for (const item of items) {
        this.assertTopicExists(item.topicId)
        affectedTopics.add(item.topicId)
        const values = toInsertValues(item)
        tx.insert(topicSegments)
          .values(values as any)
          .run()
      }
      for (const topicId of affectedTopics) {
        const ids = loadOrderedIds(tx, topicSegments, topicSegments.topicId, topicId)
        assignDenseOrders(tx, topicSegments, ids)
      }
      return items.map((item) =>
        fromDrizzleResult<TopicSegmentData>(
          tx.select().from(topicSegments).where(eq(topicSegments.id, item.id)).get() ?? ({} as any),
          'topic_segments',
          item.id
        )
      )
    })
  }

  /**
   * Upsert many segments. Phase 2: rejects topicId change on existing
   * rows, normalizes sibling orders after batch.
   */
  upsertMany(items: TopicSegmentData[]): TopicSegmentData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const affectedTopics = new Set<string>()
      for (const item of items) {
        this.assertTopicExists(item.topicId)
        affectedTopics.add(item.topicId)
        const existing = tx.select().from(topicSegments).where(eq(topicSegments.id, item.id)).get()
        if (existing) {
          // Phase 2: reject topicId change
          if ((existing as any).topicId !== item.topicId) {
            throw new Error(
              `Segment ${item.id} belongs to topic ${(existing as any).topicId}, cannot reparent to ${item.topicId}`
            )
          }
          const rowPatch = topicSegmentToRowPatch(item)
          const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
          tx.update(topicSegments)
            .set(values as any)
            .where(eq(topicSegments.id, item.id))
            .run()
        } else {
          const values = toInsertValues(item)
          tx.insert(topicSegments)
            .values(values as any)
            .run()
        }
      }
      for (const topicId of affectedTopics) {
        const ids = loadOrderedIds(tx, topicSegments, topicSegments.topicId, topicId)
        assignDenseOrders(tx, topicSegments, ids)
      }
      return items.map((item) =>
        fromDrizzleResult<TopicSegmentData>(
          tx.select().from(topicSegments).where(eq(topicSegments.id, item.id)).get() ?? ({} as any),
          'topic_segments',
          item.id
        )
      )
    })
  }

  /**
   * Update segment metadata.
   * Phase 2: rejects identity AND sortOrder changes.
   */
  updateMetadata(id: string, patch: EntityPatchInput<TopicSegmentData>): AffectedCount {
    assertNoIdentityChange(patch as Record<string, unknown>, 'topicSegments', { id })
    assertNoSortOrderChange(patch as Record<string, unknown>)
    const current = this.db.select().from(topicSegments).where(eq(topicSegments.id, id)).get()
    if (!current) return { affected: 0 }
    const rowPatch = topicSegmentToRowPatch(patch)
    const values = toUpdateValues((current as any).extra, rowPatch, COLUMN_MAP)
    this.db
      .update(topicSegments)
      .set(values as any)
      .where(eq(topicSegments.id, id))
      .run()
    return { affected: 1 }
  }

  delete(id: string): AffectedCount {
    return this.db.transaction((tx) => {
      const seg = tx
        .select({ topicId: topicSegments.topicId })
        .from(topicSegments)
        .where(eq(topicSegments.id, id))
        .get()
      const result = tx.delete(topicSegments).where(eq(topicSegments.id, id)).run()
      if (result.changes > 0 && seg) {
        this.normalizeSiblingOrdersInTx(tx, seg.topicId)
      }
      return { affected: result.changes }
    })
  }

  deleteMany(ids: string[]): AffectedCount {
    if (ids.length === 0) return { affected: 0 }
    return this.db.transaction((tx) => {
      const affectedTopics = new Set<string>()
      for (const id of ids) {
        const seg = tx
          .select({ topicId: topicSegments.topicId })
          .from(topicSegments)
          .where(eq(topicSegments.id, id))
          .get()
        if (seg) affectedTopics.add(seg.topicId)
      }
      let total = 0
      for (const id of ids) total += tx.delete(topicSegments).where(eq(topicSegments.id, id)).run().changes
      for (const topicId of affectedTopics) {
        this.normalizeSiblingOrdersInTx(tx, topicId)
      }
      return { affected: total }
    })
  }

  deleteByTopic(topicId: string): AffectedCount {
    const result = this.db.delete(topicSegments).where(eq(topicSegments.topicId, topicId)).run()
    return { affected: result.changes }
  }

  /**
   * Add messages to segment. Phase 2: normalizes membership orders.
   */
  addMessages(segmentId: string, messageIds: string[]): AffectedCount {
    if (messageIds.length === 0) return { affected: 0 }
    const segment = this.db
      .select({ topicId: topicSegments.topicId })
      .from(topicSegments)
      .where(eq(topicSegments.id, segmentId))
      .get()
    if (!segment) throw new Error(`Segment ${segmentId} does not exist`)
    this.validateMessagesBelongToTopic(messageIds, segment.topicId)
    return this.db.transaction((tx) => {
      const maxOrder = tx
        .select({ max: sql<number>`COALESCE(MAX(${topicSegmentMessages.sortOrder}), -1)` })
        .from(topicSegmentMessages)
        .where(eq(topicSegmentMessages.segmentId, segmentId))
        .get()
      let nextOrder = (maxOrder?.max ?? -1) + 1
      let affected = 0
      for (const messageId of messageIds) {
        const exists = tx
          .select()
          .from(topicSegmentMessages)
          .where(and(eq(topicSegmentMessages.segmentId, segmentId), eq(topicSegmentMessages.messageId, messageId)))
          .get()
        if (!exists) {
          tx.insert(topicSegmentMessages).values({ segmentId, messageId, sortOrder: nextOrder }).run()
          nextOrder++
          affected++
        }
      }
      this.normalizeMembershipOrdersInTx(tx, segmentId)
      this.repairHeaderInTx(tx, segmentId)
      return { affected }
    })
  }

  removeMessage(segmentId: string, messageId: string): AffectedCount {
    return this.removeMessages(segmentId, [messageId])
  }

  removeMessages(segmentId: string, messageIds: string[]): AffectedCount {
    if (messageIds.length === 0) return { affected: 0 }
    return this.db.transaction((tx) => {
      const seg = tx
        .select({ topicId: topicSegments.topicId })
        .from(topicSegments)
        .where(eq(topicSegments.id, segmentId))
        .get()
      let affected = 0
      for (const messageId of messageIds) {
        affected += tx
          .delete(topicSegmentMessages)
          .where(and(eq(topicSegmentMessages.segmentId, segmentId), eq(topicSegmentMessages.messageId, messageId)))
          .run().changes
      }
      // Normalize surviving membership orders before empty-segment check
      this.normalizeMembershipOrdersInTx(tx, segmentId)
      const remaining = tx
        .select({ count: sql<number>`count(*)` })
        .from(topicSegmentMessages)
        .where(eq(topicSegmentMessages.segmentId, segmentId))
        .get()
      if (remaining?.count === 0) {
        tx.delete(topicSegments).where(eq(topicSegments.id, segmentId)).run()
        // Normalize sibling segment orders after empty-segment deletion
        if (seg) this.normalizeSiblingOrdersInTx(tx, seg.topicId)
      } else {
        // A removed head row repairs the head to the first surviving member.
        this.repairHeaderInTx(tx, segmentId)
      }
      return { affected }
    })
  }

  removeMessagesByTopic(topicId: string): AffectedCount {
    return this.db.transaction((tx) => {
      const segments = tx
        .select({ id: topicSegments.id })
        .from(topicSegments)
        .where(eq(topicSegments.topicId, topicId))
        .all()
      let affected = 0
      for (const seg of segments) {
        affected += tx.delete(topicSegmentMessages).where(eq(topicSegmentMessages.segmentId, seg.id)).run().changes
        tx.delete(topicSegments).where(eq(topicSegments.id, seg.id)).run()
      }
      return { affected }
    })
  }

  /**
   * Replace segment message IDs. Phase 2: normalizes membership orders.
   * If messageIds is empty, deletes the segment (empty-segment invariant).
   */
  replaceMessageIds(segmentId: string, messageIds: string[]): AffectedCount {
    const uniqueIds = new Set(messageIds)
    if (uniqueIds.size !== messageIds.length) throw new Error('Duplicate message IDs in messageIds')
    const segment = this.db
      .select({ topicId: topicSegments.topicId })
      .from(topicSegments)
      .where(eq(topicSegments.id, segmentId))
      .get()
    if (!segment) throw new Error(`Segment ${segmentId} does not exist`)
    if (messageIds.length > 0) {
      this.validateMessagesBelongToTopic(messageIds, segment.topicId)
    }
    return this.db.transaction((tx) => {
      tx.delete(topicSegmentMessages).where(eq(topicSegmentMessages.segmentId, segmentId)).run()
      if (messageIds.length === 0) {
        // Empty segment: delete the segment itself and normalize siblings
        tx.delete(topicSegments).where(eq(topicSegments.id, segmentId)).run()
        this.normalizeSiblingOrdersInTx(tx, segment.topicId)
        return { affected: 0 }
      }
      for (let i = 0; i < messageIds.length; i++) {
        tx.insert(topicSegmentMessages).values({ segmentId, messageId: messageIds[i], sortOrder: i }).run()
      }
      // Membership was replaced wholesale: a head that is still a member keeps
      // its identity, a head that left repairs to the new first member.
      this.repairHeaderInTx(tx, segmentId)
      return { affected: messageIds.length }
    })
  }

  /**
   * Repair persisted heads after message rows leave outside segment
   * membership writes. Message deletes cascade membership rows away without
   * touching the segment row, so a head that pointed at a deleted message
   * would dangle. Only segments whose persisted head is in `messageIds` are
   * touched, and the repair is the same deterministic rule as every other
   * path: first surviving member in authority order, NULL when empty.
   * Segments are never deleted here — empty-group dissolution stays with the
   * membership-write paths.
   */
  repairHeadersForDeletedMessages(messageIds: string[]): void {
    if (messageIds.length === 0) return
    return this.db.transaction((tx) => {
      const candidates = tx
        .select({ id: topicSegments.id })
        .from(topicSegments)
        .where(sql`${topicSegments.headerMessageId} IN ${messageIds}`)
        .all()
      for (const row of candidates) {
        this.repairHeaderInTx(tx, row.id)
      }
    })
  }
}
