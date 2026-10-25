/**
 * TopicReferencesRepository — read/write for cross-topic history references.
 *
 * One row per reference target topic (migration 018). The target topic's
 * effective route begins with a LIVE stable-ID prefix of the source topic's
 * effective route through the anchor; nothing is copied. This repository is
 * the pure data access layer: it never mints sync intent itself — the
 * aggregate captures the relation as one versioned `topic_reference` entity
 * inside the same mutation transaction.
 *
 * - `targetTopicId` is the PK (one relation per target); FK CASCADE on the
 *   target topic is the cleanup backstop (target-owned cascade is allowed).
 * - `sourceTopicId` is a plain column with NO foreign key and NO cascade:
 *   deleting the source topic must never delete the target or its relation —
 *   the relation degrades to status 'missing' at resolve time.
 */

import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { TopicReferenceData } from '../domain/types'
import { topicReferences } from '../schema'
import {
  type AffectedCount,
  buildColumnMap,
  found,
  fromDrizzleResult,
  type GetResult,
  notFound,
  toInsertValues,
  toUpdateValues
} from './helpers'

const COLUMN_MAP = buildColumnMap([
  ['targetTopicId', 'target_topic_id'],
  ['sourceTopicId', 'source_topic_id'],
  ['sourceBranchId', 'source_branch_id'],
  ['anchorMessageId', 'anchor_message_id'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at']
])

export class TopicReferencesRepository {
  constructor(private db: BetterSQLite3Database<any>) {}

  /** The reference relation owned by a target topic, or not-found. */
  getByTarget(targetTopicId: string): GetResult<TopicReferenceData> {
    const row = this.db.select().from(topicReferences).where(eq(topicReferences.targetTopicId, targetTopicId)).get()
    if (!row) return notFound()
    return found(fromDrizzleResult<TopicReferenceData>(row, 'topic_references', (row as any).targetTopicId))
  }

  exists(targetTopicId: string): boolean {
    const row = this.db
      .select({ targetTopicId: topicReferences.targetTopicId })
      .from(topicReferences)
      .where(eq(topicReferences.targetTopicId, targetTopicId))
      .get()
    return row !== undefined
  }

  /**
   * All reference target topic IDs pointing at one source topic in
   * deterministic (targetTopicId ASC) order. Used for invalidation fan-out.
   */
  listTargetsBySource(sourceTopicId: string): string[] {
    return this.db
      .select({ targetTopicId: topicReferences.targetTopicId })
      .from(topicReferences)
      .where(eq(topicReferences.sourceTopicId, sourceTopicId))
      .orderBy(asc(topicReferences.targetTopicId))
      .all()
      .map((r) => r.targetTopicId)
  }

  create(data: TopicReferenceData): TopicReferenceData {
    const values = toInsertValues(data)
    this.db
      .insert(topicReferences)
      .values(values as any)
      .run()
    return (this.getByTarget(data.targetTopicId) as any).data
  }

  /** Delete the relation owned by a target topic (target-owned cleanup). */
  deleteByTarget(targetTopicId: string): AffectedCount {
    const result = this.db.delete(topicReferences).where(eq(topicReferences.targetTopicId, targetTopicId)).run()
    return { affected: result.changes }
  }

  /** Patch the relation metadata (identity columns rejected via column map). */
  update(targetTopicId: string, patch: Partial<TopicReferenceData>): AffectedCount {
    const current = this.db.select().from(topicReferences).where(eq(topicReferences.targetTopicId, targetTopicId)).get()
    if (!current) return { affected: 0 }
    const values = toUpdateValues(
      (current as any).extra,
      { columns: patch as Record<string, unknown>, overflowDelta: null, clearOverflow: false },
      COLUMN_MAP
    )
    this.db
      .update(topicReferences)
      .set(values as any)
      .where(eq(topicReferences.targetTopicId, targetTopicId))
      .run()
    return { affected: 1 }
  }
}
