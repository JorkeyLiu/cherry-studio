/**
 * FileReferencesRepository — CRUD for the file_references table.
 *
 * Upsert semantics: when a unique (blockId, fileId) pair already exists,
 * the stored row's ID is preserved (not the incoming ID). The incoming
 * identity fields (id, blockId, fileId) are stripped from the update patch
 * so the stored row identity is never changed by upsert.
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { fileReferenceToRowPatch } from '../domain/mappers'
import type { EntityPatchInput, FileReferenceData } from '../domain/types'
import { fileReferences, messageBlocks } from '../schema'
import {
  type AffectedCount,
  assertNoIdentityChange,
  buildColumnMap,
  found,
  fromDrizzleResult,
  type GetResult,
  notFound,
  toInsertValues,
  toUpdateValues
} from './helpers'

const COLUMN_MAP = buildColumnMap([
  ['id', 'id'],
  ['blockId', 'block_id'],
  ['fileId', 'file_id'],
  ['fileName', 'file_name'],
  ['filePath', 'file_path'],
  ['fileType', 'file_type'],
  ['count', 'count']
])

export class FileReferencesRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  private assertBlockExists(blockId: string): void {
    const exists = this.db
      .select({ id: messageBlocks.id })
      .from(messageBlocks)
      .where(eq(messageBlocks.id, blockId))
      .get()
    if (!exists) throw new Error(`Block ${blockId} does not exist`)
  }

  getById(id: string): GetResult<FileReferenceData> {
    const row = this.db.select().from(fileReferences).where(eq(fileReferences.id, id)).get()
    if (!row) return notFound()
    return found(fromDrizzleResult<FileReferenceData>(row, 'file_references', (row as any).id))
  }

  listByBlock(blockId: string): FileReferenceData[] {
    return this.db
      .select()
      .from(fileReferences)
      .where(eq(fileReferences.blockId, blockId))
      .orderBy(asc(fileReferences.id))
      .all()
      .map((r) => fromDrizzleResult<FileReferenceData>(r, 'file_references', (r as any).id))
  }

  listByFile(fileId: string): FileReferenceData[] {
    return this.db
      .select()
      .from(fileReferences)
      .where(eq(fileReferences.fileId, fileId))
      .orderBy(asc(fileReferences.id))
      .all()
      .map((r) => fromDrizzleResult<FileReferenceData>(r, 'file_references', (r as any).id))
  }

  listByMessage(messageId: string): FileReferenceData[] {
    return this.db
      .select({
        id: fileReferences.id,
        blockId: fileReferences.blockId,
        fileId: fileReferences.fileId,
        fileName: fileReferences.fileName,
        filePath: fileReferences.filePath,
        fileType: fileReferences.fileType,
        count: fileReferences.count,
        extra: fileReferences.extra
      })
      .from(fileReferences)
      .innerJoin(messageBlocks, eq(fileReferences.blockId, messageBlocks.id))
      .where(eq(messageBlocks.messageId, messageId))
      .orderBy(asc(fileReferences.id))
      .all()
      .map((r) => fromDrizzleResult<FileReferenceData>(r, 'file_references', (r as any).id))
  }

  listByMessages(messageIds: string[]): FileReferenceData[] {
    if (messageIds.length === 0) return []
    return this.db
      .select({
        id: fileReferences.id,
        blockId: fileReferences.blockId,
        fileId: fileReferences.fileId,
        fileName: fileReferences.fileName,
        filePath: fileReferences.filePath,
        fileType: fileReferences.fileType,
        count: fileReferences.count,
        extra: fileReferences.extra
      })
      .from(fileReferences)
      .innerJoin(messageBlocks, eq(fileReferences.blockId, messageBlocks.id))
      .where(sql`${messageBlocks.messageId} IN ${messageIds}`)
      .orderBy(asc(fileReferences.id))
      .all()
      .map((r) => fromDrizzleResult<FileReferenceData>(r, 'file_references', (r as any).id))
  }

  countByFile(fileId: string): number {
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(fileReferences)
      .where(eq(fileReferences.fileId, fileId))
      .get()
    return result?.count ?? 0
  }

  create(data: FileReferenceData): FileReferenceData {
    this.assertBlockExists(data.blockId)
    const values = toInsertValues(data)
    this.db
      .insert(fileReferences)
      .values(values as any)
      .run()
    return (this.getById(data.id) as any).data
  }

  createMany(items: FileReferenceData[]): FileReferenceData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const results: FileReferenceData[] = []
      for (const item of items) {
        const values = toInsertValues(item)
        tx.insert(fileReferences)
          .values(values as any)
          .run()
        results.push(
          fromDrizzleResult<FileReferenceData>(
            tx.select().from(fileReferences).where(eq(fileReferences.id, item.id)).get() ?? ({} as any),
            'file_references',
            item.id
          )
        )
      }
      return results
    })
  }

  /**
   * Upsert by unique (blockId, fileId).
   *
   * When the pair already exists, the stored row's ID is preserved.
   * Identity fields (id, blockId, fileId) are stripped from the update patch.
   * The incoming data's ID is ignored — the stored business row identity wins.
   */
  upsert(data: FileReferenceData): FileReferenceData {
    const existing = this.db
      .select()
      .from(fileReferences)
      .where(and(eq(fileReferences.blockId, data.blockId), eq(fileReferences.fileId, data.fileId)))
      .get()
    if (existing) {
      const existingId = (existing as any).id as string
      // Strip identity fields — preserve stored row identity
      const { id: _id, blockId: _block, fileId: _file, ...patchData } = data
      const rowPatch = fileReferenceToRowPatch(patchData as EntityPatchInput<FileReferenceData>)
      const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
      this.db
        .update(fileReferences)
        .set(values as any)
        .where(eq(fileReferences.id, existingId))
        .run()
      return (this.getById(existingId) as any).data
    }
    return this.create(data)
  }

  /**
   * Batch upsert by unique (blockId, fileId).
   * Preserves stored row identity for existing pairs (same as upsert).
   */
  upsertMany(items: FileReferenceData[]): FileReferenceData[] {
    if (items.length === 0) return []
    return this.db.transaction((tx) => {
      const results: FileReferenceData[] = []
      for (const item of items) {
        const existing = tx
          .select()
          .from(fileReferences)
          .where(and(eq(fileReferences.blockId, item.blockId), eq(fileReferences.fileId, item.fileId)))
          .get()
        if (existing) {
          const existingId = (existing as any).id as string
          // Strip identity fields — preserve stored row identity
          const { id: _id, blockId: _block, fileId: _file, ...patchData } = item
          const rowPatch = fileReferenceToRowPatch(patchData as EntityPatchInput<FileReferenceData>)
          const values = toUpdateValues((existing as any).extra, rowPatch, COLUMN_MAP)
          tx.update(fileReferences)
            .set(values as any)
            .where(eq(fileReferences.id, existingId))
            .run()
          results.push(
            fromDrizzleResult<FileReferenceData>(
              tx.select().from(fileReferences).where(eq(fileReferences.id, existingId)).get() ?? ({} as any),
              'file_references',
              existingId
            )
          )
        } else {
          const values = toInsertValues(item)
          tx.insert(fileReferences)
            .values(values as any)
            .run()
          results.push(
            fromDrizzleResult<FileReferenceData>(
              tx.select().from(fileReferences).where(eq(fileReferences.id, item.id)).get() ?? ({} as any),
              'file_references',
              item.id
            )
          )
        }
      }
      return results
    })
  }

  /**
   * Update a file reference by ID.
   * Rejects attempts to change identity fields (id, blockId, fileId).
   */
  update(id: string, patch: EntityPatchInput<FileReferenceData>): AffectedCount {
    assertNoIdentityChange(patch as Record<string, unknown>, 'fileReferences', { id })
    const current = this.db.select().from(fileReferences).where(eq(fileReferences.id, id)).get()
    if (!current) return { affected: 0 }
    const rowPatch = fileReferenceToRowPatch(patch)
    const values = toUpdateValues((current as any).extra, rowPatch, COLUMN_MAP)
    this.db
      .update(fileReferences)
      .set(values as any)
      .where(eq(fileReferences.id, id))
      .run()
    return { affected: 1 }
  }

  delete(id: string): AffectedCount {
    const result = this.db.delete(fileReferences).where(eq(fileReferences.id, id)).run()
    return { affected: result.changes }
  }

  deleteMany(ids: string[]): AffectedCount {
    if (ids.length === 0) return { affected: 0 }
    return this.db.transaction((tx) => {
      let total = 0
      for (const id of ids) total += tx.delete(fileReferences).where(eq(fileReferences.id, id)).run().changes
      return { affected: total }
    })
  }

  deleteByBlock(blockId: string): AffectedCount {
    const result = this.db.delete(fileReferences).where(eq(fileReferences.blockId, blockId)).run()
    return { affected: result.changes }
  }

  deleteByMessage(messageId: string): AffectedCount {
    const result = this.db
      .delete(fileReferences)
      .where(
        sql`${fileReferences.blockId} IN (SELECT id FROM ${messageBlocks} WHERE ${messageBlocks.messageId} = ${messageId})`
      )
      .run()
    return { affected: result.changes }
  }

  deleteByFile(fileId: string): AffectedCount {
    const result = this.db.delete(fileReferences).where(eq(fileReferences.fileId, fileId)).run()
    return { affected: result.changes }
  }
}
