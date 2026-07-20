/**
 * BlocksRepository — CRUD + ordering for the message_blocks table.
 *
 * Ordering guarantees:
 * - sort_order is zero-based dense within each message.
 * - All mutating operations normalize sibling orders transactionally.
 * - replaceMessageOrder uses direct sequential assignment.
 *
 * Identity protection:
 * - update rejects attempts to change id or messageId.
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { messageBlockToRowPatch } from '../domain/mappers'
import type { EntityPatchInput, MessageBlockData } from '../domain/types'
import { fileReferences, messageBlocks, messages } from '../schema'
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
  toUpdateValues
} from './helpers'

const COLUMN_MAP = buildColumnMap([
  ['id', 'id'],
  ['messageId', 'message_id'],
  ['type', 'type'],
  ['content', 'content'],
  ['status', 'status'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['sortOrder', 'sort_order']
])

export class BlocksRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  private assertMessageExists(messageId: string): void {
    const exists = this.db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)).get()
    if (!exists) throw new Error(`Message ${messageId} does not exist`)
  }

  /**
   * Normalize all sibling sort_order values within a message to dense zero-based.
   * Phase 2: uses central loadOrderedIds + assignDenseOrders.
   */
  private normalizeOrdersInTx(tx: any, messageId: string): void {
    const ids = loadOrderedIds(tx, messageBlocks, messageBlocks.messageId, messageId)
    assignDenseOrders(tx, messageBlocks, ids)
  }

  getById(id: string): GetResult<MessageBlockData> {
    const row = this.db.select().from(messageBlocks).where(eq(messageBlocks.id, id)).get()
    if (!row) return notFound()
    return found(fromDrizzleResult<MessageBlockData>(row, 'message_blocks', (row as any).id))
  }

  findByIds(ids: string[]): MessageBlockData[] {
    if (ids.length === 0) return []
    const rows = this.db.select().from(messageBlocks).where(sql`${messageBlocks.id} IN ${ids}`).all()
    const rowMap = new Map(rows.map((r) => [(r as any).id, r]))
    return ids
      .map((id) => rowMap.get(id))
      .filter((r) => r !== undefined)
      .map((r) => fromDrizzleResult<MessageBlockData>(r, 'message_blocks', (r as any).id))
  }

  listByMessage(messageId: string): MessageBlockData[] {
    return this.db
      .select()
      .from(messageBlocks)
      .where(eq(messageBlocks.messageId, messageId))
      .orderBy(asc(messageBlocks.sortOrder), asc(messageBlocks.id))
      .all()
      .map((r) => fromDrizzleResult<MessageBlockData>(r, 'message_blocks', (r as any).id))
  }

  listByMessages(messageIds: string[]): Map<string, MessageBlockData[]> {
    if (messageIds.length === 0) return new Map()
    const rows = this.db
      .select()
      .from(messageBlocks)
      .where(sql`${messageBlocks.messageId} IN ${messageIds}`)
      .orderBy(asc(messageBlocks.sortOrder), asc(messageBlocks.id))
      .all()
      .map((r) => fromDrizzleResult<MessageBlockData>(r, 'message_blocks', (r as any).id))
    const grouped = new Map<string, MessageBlockData[]>()
    for (const id of messageIds) grouped.set(id, [])
    for (const block of rows) {
      const arr = grouped.get(block.messageId)
      if (arr) arr.push(block)
    }
    return grouped
  }

  countByMessage(messageId: string): number {
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(messageBlocks)
      .where(eq(messageBlocks.messageId, messageId))
      .get()
    return result?.count ?? 0
  }

  findByFileId(fileId: string): MessageBlockData[] {
    return this.db
      .select({
        id: messageBlocks.id,
        messageId: messageBlocks.messageId,
        type: messageBlocks.type,
        content: messageBlocks.content,
        status: messageBlocks.status,
        createdAt: messageBlocks.createdAt,
        updatedAt: messageBlocks.updatedAt,
        sortOrder: messageBlocks.sortOrder,
        extra: messageBlocks.extra
      })
      .from(messageBlocks)
      .innerJoin(fileReferences, eq(messageBlocks.id, fileReferences.blockId))
      .where(eq(fileReferences.fileId, fileId))
      .orderBy(asc(messageBlocks.sortOrder), asc(messageBlocks.id))
      .all()
      .map((r) => fromDrizzleResult<MessageBlockData>(r, 'message_blocks', (r as any).id))
  }

  /**
   * Create a block. Phase 2: normalizes sibling orders to ensure density.
   */
  create(data: MessageBlockData): MessageBlockData {
    this.assertMessageExists(data.messageId)
    return this.db.transaction((tx) => {
      const values = toInsertValues(data)
      tx.insert(messageBlocks)
        .values(values as any)
        .run()
      this.normalizeOrdersInTx(tx, data.messageId)
      return fromDrizzleResult<MessageBlockData>(
        tx.select().from(messageBlocks).where(eq(messageBlocks.id, data.id)).get() ?? ({} as any),
        'message_blocks',
        data.id
      )
    })
  }

  append(data: MessageBlockData): MessageBlockData {
    this.assertMessageExists(data.messageId)
    return this.db.transaction((tx) => {
      const maxOrder = tx
        .select({ max: sql<number>`COALESCE(MAX(${messageBlocks.sortOrder}), -1)` })
        .from(messageBlocks)
        .where(eq(messageBlocks.messageId, data.messageId))
        .get()
      const newOrder = (maxOrder?.max ?? -1) + 1
      const values = toInsertValues({ ...data, sortOrder: newOrder })
      tx.insert(messageBlocks)
        .values(values as any)
        .run()
      this.normalizeOrdersInTx(tx, data.messageId)
      return fromDrizzleResult<MessageBlockData>(
        tx.select().from(messageBlocks).where(eq(messageBlocks.id, data.id)).get() ?? ({} as any),
        'message_blocks',
        data.id
      )
    })
  }

  insertAt(data: MessageBlockData, index: number): MessageBlockData {
    const count = this.countByMessage(data.messageId)
    index = clampIndex(index, count)
    this.assertMessageExists(data.messageId)
    return this.db.transaction((tx) => {
      tx.run(
        sql`UPDATE ${messageBlocks} SET sort_order = sort_order + 1 WHERE ${messageBlocks.messageId} = ${data.messageId} AND ${messageBlocks.sortOrder} >= ${index}`
      )
      const values = toInsertValues({ ...data, sortOrder: index })
      tx.insert(messageBlocks)
        .values(values as any)
        .run()
      this.normalizeOrdersInTx(tx, data.messageId)
      return fromDrizzleResult<MessageBlockData>(
        tx.select().from(messageBlocks).where(eq(messageBlocks.id, data.id)).get() ?? ({} as any),
        'message_blocks',
        data.id
      )
    })
  }

  /**
   * Create many blocks. Phase 2: normalizes sibling orders after batch.
   */
  createMany(items: MessageBlockData[]): MessageBlockData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const affectedMessages = new Set<string>()
      for (const item of items) {
        this.assertMessageExists(item.messageId)
        affectedMessages.add(item.messageId)
        const values = toInsertValues(item)
        tx.insert(messageBlocks)
          .values(values as any)
          .run()
      }
      for (const msgId of affectedMessages) {
        this.normalizeOrdersInTx(tx, msgId)
      }
      return items.map((item) =>
        fromDrizzleResult<MessageBlockData>(
          tx.select().from(messageBlocks).where(eq(messageBlocks.id, item.id)).get() ?? ({} as any),
          'message_blocks',
          item.id
        )
      )
    })
  }

  /**
   * Upsert many blocks. Phase 2: rejects messageId change on existing
   * rows, normalizes sibling orders after batch.
   */
  upsertMany(items: MessageBlockData[]): MessageBlockData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const affectedMessages = new Set<string>()
      for (const item of items) {
        this.assertMessageExists(item.messageId)
        affectedMessages.add(item.messageId)
        const existing = tx.select().from(messageBlocks).where(eq(messageBlocks.id, item.id)).get()
        if (existing) {
          // Phase 2: reject messageId change
          if ((existing as any).messageId !== item.messageId) {
            throw new Error(
              `Block ${item.id} belongs to message ${(existing as any).messageId}, cannot reparent to ${item.messageId}`
            )
          }
          const rowPatch = messageBlockToRowPatch(item)
          const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
          tx.update(messageBlocks)
            .set(values as any)
            .where(eq(messageBlocks.id, item.id))
            .run()
        } else {
          const values = toInsertValues(item)
          tx.insert(messageBlocks)
            .values(values as any)
            .run()
        }
      }
      for (const msgId of affectedMessages) {
        this.normalizeOrdersInTx(tx, msgId)
      }
      return items.map((item) =>
        fromDrizzleResult<MessageBlockData>(
          tx.select().from(messageBlocks).where(eq(messageBlocks.id, item.id)).get() ?? ({} as any),
          'message_blocks',
          item.id
        )
      )
    })
  }

  /**
   * Update a block by ID.
   * Phase 2: rejects identity AND sortOrder changes.
   */
  update(messageId: string, blockId: string, patch: EntityPatchInput<MessageBlockData>): AffectedCount {
    assertNoIdentityChange(patch as Record<string, unknown>, 'messageBlocks', { id: blockId, messageId })
    assertNoSortOrderChange(patch as Record<string, unknown>)
    const current = this.db
      .select()
      .from(messageBlocks)
      .where(and(eq(messageBlocks.id, blockId), eq(messageBlocks.messageId, messageId)))
      .get()
    if (!current) return { affected: 0 }
    const rowPatch = messageBlockToRowPatch(patch)
    const values = toUpdateValues((current as any).extra, rowPatch, COLUMN_MAP)
    this.db
      .update(messageBlocks)
      .set(values as any)
      .where(eq(messageBlocks.id, blockId))
      .run()
    return { affected: 1 }
  }

  delete(id: string): AffectedCount {
    return this.db.transaction((tx) => {
      const block = tx
        .select({ messageId: messageBlocks.messageId })
        .from(messageBlocks)
        .where(eq(messageBlocks.id, id))
        .get()
      const result = tx.delete(messageBlocks).where(eq(messageBlocks.id, id)).run()
      if (result.changes > 0 && block) {
        this.normalizeOrdersInTx(tx, block.messageId)
      }
      return { affected: result.changes }
    })
  }

  deleteMany(ids: string[]): AffectedCount {
    if (ids.length === 0) return { affected: 0 }
    return this.db.transaction((tx) => {
      const affectedMessages = new Set<string>()
      for (const id of ids) {
        const block = tx
          .select({ messageId: messageBlocks.messageId })
          .from(messageBlocks)
          .where(eq(messageBlocks.id, id))
          .get()
        if (block) affectedMessages.add(block.messageId)
      }
      let total = 0
      for (const id of ids) total += tx.delete(messageBlocks).where(eq(messageBlocks.id, id)).run().changes
      for (const msgId of affectedMessages) {
        this.normalizeOrdersInTx(tx, msgId)
      }
      return { affected: total }
    })
  }

  deleteByMessage(messageId: string): AffectedCount {
    const result = this.db.delete(messageBlocks).where(eq(messageBlocks.messageId, messageId)).run()
    return { affected: result.changes }
  }

  /**
   * Replace the order of all blocks in a message.
   * Uses direct sequential assignment.
   */
  replaceMessageOrder(messageId: string, orderedIds: string[]): AffectedCount {
    const uniqueIds = new Set(orderedIds)
    if (uniqueIds.size !== orderedIds.length) throw new Error('Duplicate block IDs in orderedIds')
    const existing = this.db
      .select({ id: messageBlocks.id })
      .from(messageBlocks)
      .where(eq(messageBlocks.messageId, messageId))
      .all()
      .map((r) => r.id)
    const existingSet = new Set(existing)
    for (const id of orderedIds) {
      if (!existingSet.has(id)) throw new Error(`Block ${id} does not belong to message ${messageId}`)
    }
    if (orderedIds.length !== existing.length)
      throw new Error(`Incomplete block list: expected ${existing.length}, got ${orderedIds.length}`)
    return this.db.transaction((tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        tx.run(sql`UPDATE ${messageBlocks} SET sort_order = ${i} WHERE ${messageBlocks.id} = ${orderedIds[i]}`)
      }
      return { affected: orderedIds.length }
    })
  }
}
