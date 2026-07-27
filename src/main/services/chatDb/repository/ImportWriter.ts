/**
 * ChatImportWriter — import-only, order-preserving write seam (Phase 4.2).
 *
 * Purpose:
 * - Insert source-sorted candidate rows (topics, messages, blocks, segments,
 *   segment memberships, file references) exactly as supplied by the importer.
 * - Preserve caller-supplied `sortOrder` verbatim across repeated, globally
 *   ID-paginated pages. Unlike the runtime repositories' `createMany`, this
 *   seam performs NO dense normalization, so source order (sparse or dense)
 *   survives sibling splits across pages.
 *
 * Transaction ownership (LOCK-4212C):
 * - The caller owns exactly one outer page transaction and passes the bound
 *   Drizzle transaction executor here. This writer NEVER opens a nested
 *   transaction / savepoint. Any constraint failure therefore propagates to
 *   the caller's transaction and rolls back every row written on that page —
 *   preserving all-or-nothing semantics across all tables.
 *
 * Constraint handling (LOCK-4212D):
 * - Uses the existing domain row mappers / overflow codecs (`toInsertValues`)
 *   and the shared Drizzle schema. FK, primary-key, and uniqueness enforcement
 *   are delegated to SQLite (requires `PRAGMA foreign_keys = ON`). Violations
 *   surface as thrown errors that propagate to the outer transaction. No raw
 *   SQL and no SQL IPC surface are introduced.
 *
 * Empty segments (LOCK-4212E):
 * - Segment rows are inserted independently of memberships, so empty segments
 *   are insertable and retained (this seam never cleans up empty segments).
 * - Membership insertion consumes the complete `messageIds` array and assigns
 *   `sortOrder` from the exact array index.
 *
 * This seam is import-specific and transaction-bound. It does not replace or
 * alter any runtime repository public method or normalization behavior
 * (LOCK-4212A).
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type {
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicData,
  TopicSegmentData,
  TopicSegmentMessageData
} from '../domain/types'
import { fileReferences, messageBlocks, messages, topics, topicSegmentMessages, topicSegments } from '../schema'
import { toInsertValues } from './helpers'

/**
 * Import-only writer bound to a caller-provided Drizzle executor.
 *
 * The executor should be an outer transaction (`db.transaction((tx) => ...)`),
 * but a root database instance is also accepted for read-only test scaffolding.
 * No method opens its own transaction.
 */
export class ChatImportWriter {
  /**
   * @param tx  Caller-owned Drizzle transaction (or database) executor.
   *            All inserts run directly on this executor without nesting.
   */
  constructor(private readonly tx: BetterSQLite3Database<any>) {}

  /**
   * Insert topic rows exactly as supplied.
   *
   * Source `createdAt` / `updatedAt` are preserved verbatim (no canonicalization,
   * unlike the runtime `TopicsRepository`). Duplicate ids surface as a primary-key
   * violation that propagates to the outer transaction.
   *
   * @returns Number of rows inserted.
   */
  insertTopics(items: TopicData[]): number {
    for (const item of items) {
      const values = toInsertValues(item)
      this.tx
        .insert(topics)
        .values(values as any)
        .run()
    }
    return items.length
  }

  /**
   * Insert message rows preserving caller-supplied `sortOrder` exactly.
   *
   * No sibling normalization is performed, so sparse or non-contiguous source
   * orders survive across repeated ID-paginated pages (LOCK-4212B). Missing
   * parent topics surface as FK violations.
   *
   * @returns Number of rows inserted.
   */
  insertMessages(items: MessageData[]): number {
    for (const item of items) {
      const values = toInsertValues(item)
      this.tx
        .insert(messages)
        .values(values as any)
        .run()
    }
    return items.length
  }

  /**
   * Insert message-block rows preserving caller-supplied `sortOrder` exactly.
   *
   * No sibling normalization is performed. Missing parent messages surface as
   * FK violations.
   *
   * @returns Number of rows inserted.
   */
  insertBlocks(items: MessageBlockData[]): number {
    for (const item of items) {
      const values = toInsertValues(item)
      this.tx
        .insert(messageBlocks)
        .values(values as any)
        .run()
    }
    return items.length
  }

  /**
   * Insert topic-segment rows preserving caller-supplied `sortOrder` exactly.
   *
   * Segments are inserted independently of memberships; empty segments are
   * therefore insertable and retained (LOCK-4212E). No sibling normalization
   * is performed.
   *
   * @returns Number of rows inserted.
   */
  insertSegments(items: TopicSegmentData[]): number {
    for (const item of items) {
      const values = toInsertValues(item)
      this.tx
        .insert(topicSegments)
        .values(values as any)
        .run()
    }
    return items.length
  }

  /**
   * Insert a segment's complete membership list using exact array indexes
   * for `sortOrder` (LOCK-4212E).
   *
   * The caller supplies the full, source-ordered `messageIds` for the segment.
   * Each membership row is written with `sortOrder = index`. Duplicate
   * (segmentId, messageId) pairs surface as composite primary-key violations;
   * unknown segment/message ids surface as FK violations.
   *
   * @param segmentId   Owning segment id (must already be inserted).
   * @param messageIds  Complete, source-ordered message ids for the segment.
   * @returns           Number of membership rows inserted.
   */
  insertSegmentMembership(segmentId: string, messageIds: string[]): number {
    for (let i = 0; i < messageIds.length; i++) {
      this.tx.insert(topicSegmentMessages).values({ segmentId, messageId: messageIds[i], sortOrder: i }).run()
    }
    return messageIds.length
  }

  /**
   * Insert pre-built segment-membership rows preserving caller-supplied
   * `sortOrder` exactly.
   *
   * Lower-level alternative to {@link insertSegmentMembership} for callers that
   * already carry explicit `sortOrder` values per row. No normalization is
   * performed.
   *
   * @returns Number of rows inserted.
   */
  insertSegmentMessages(items: TopicSegmentMessageData[]): number {
    for (const item of items) {
      this.tx
        .insert(topicSegmentMessages)
        .values({ segmentId: item.segmentId, messageId: item.messageId, sortOrder: item.sortOrder })
        .run()
    }
    return items.length
  }

  /**
   * Insert file-reference rows exactly as supplied.
   *
   * The unique (blockId, fileId) index and the block FK are enforced by
   * SQLite; violations propagate to the outer transaction. No upsert or
   * identity rewriting is performed — the seam inserts source rows verbatim.
   *
   * @returns Number of rows inserted.
   */
  insertFileReferences(items: FileReferenceData[]): number {
    for (const item of items) {
      const values = toInsertValues(item)
      this.tx
        .insert(fileReferences)
        .values(values as any)
        .run()
    }
    return items.length
  }
}

/**
 * Create an import-only writer bound to the given Drizzle executor.
 *
 * Intended usage (caller owns the single outer page transaction):
 *
 *   db.transaction((tx) => {
 *     const writer = createImportWriter(tx)
 *     writer.insertTopics(topicRows)
 *     writer.insertMessages(messageRowsPage)
 *     writer.insertBlocks(blockRowsPage)
 *     writer.insertSegments(segmentRows)
 *     writer.insertSegmentMembership(segmentId, segment.messageIds)
 *     writer.insertFileReferences(fileRefRows)
 *   })
 *
 * @param tx  Caller-owned Drizzle transaction (or database) executor.
 * @returns   A transaction-bound {@link ChatImportWriter}.
 */
export function createImportWriter(tx: BetterSQLite3Database<any>): ChatImportWriter {
  return new ChatImportWriter(tx)
}
