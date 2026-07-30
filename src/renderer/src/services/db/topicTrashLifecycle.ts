/**
 * topicTrashLifecycle — Phase 5.2B ordinary-chat trash lifecycle migration.
 *
 * Routes ordinary-chat soft delete, restore, trash listing, hard delete and
 * expired purge through the SQLite chat DB (SqliteMessageDataSource) and
 * consumes FileCleanupResult after committed destructive mutations.
 *
 * Contract:
 * - LOCK-521: only ordinary-chat topics go through here; agent-session topics
 *   keep their existing Dexie lifecycle at the caller boundary.
 * - LOCK-523: trash order is deletedAt DESC then id (Main-side); the purge
 *   cutoff is a caller-generated strict ISO timestamp — no Main timer.
 * - LOCK-524: no Dexie fallback and no renderer sequence of independent IPC
 *   calls emulating one lifecycle transaction.
 * - LOCK-525/526: destructive cleanup happens only AFTER the SQLite mutation
 *   committed; every affectedFileId is consumed and only files with a
 *   remaining SQLite reference count of 0 are eligible for cleanup through
 *   the existing FileManager policy (which itself preserves other local
 *   consumers via the Dexie files count and never force-deletes here).
 * - LOCK-527: a physical cleanup failure is post-commit cleanup state; it is
 *   logged and never surfaced as a SQLite rollback/mutation failure.
 * - LOCK-530: trash listing drains cursor pages sequentially, forwards
 *   cursors opaquely and never exposes a silently truncated list.
 */

import { loggerService } from '@logger'
import FileManager from '@renderer/services/FileManager'
import type { Topic } from '@renderer/types'
import { isAgentSessionTopicId } from '@renderer/utils/agentSession'
import type { FileCleanupResult, TopicWire } from '@shared/chatDb'

import { SqliteMessageDataSource } from './SqliteMessageDataSource'

const logger = loggerService.withContext('topicTrashLifecycle')

const sqliteSource = new SqliteMessageDataSource()

/** Trash retention in days. Matches the previous Dexie purge policy. */
export const TRASH_RETENTION_DAYS = 5

/** Page size used when draining trash pages. */
const TRASH_PAGE_LIMIT = 100

/**
 * Build the strict ISO purge cutoff in the renderer (LOCK-523).
 * Topics with deletedAt < cutoff are purged by Main.
 */
export function buildPurgeCutoffTimestamp(now: Date = new Date()): string {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Map a TopicWire to the existing renderer Topic shape without inventing
 * fields. Wire has no messages; the renderer shape requires the array, so it
 * is always empty here (trash entries never render messages).
 */
export function topicWireToTopic(wire: TopicWire): Topic {
  const topic: Topic = {
    id: wire.id,
    assistantId: wire.assistantId ?? '',
    name: wire.name ?? '',
    createdAt: wire.createdAt ?? '',
    updatedAt: wire.updatedAt ?? '',
    messages: []
  }
  if (wire.pinned != null) topic.pinned = wire.pinned
  if (wire.prompt != null) topic.prompt = wire.prompt
  if (wire.isNameManuallyEdited != null) topic.isNameManuallyEdited = wire.isNameManuallyEdited
  if (wire.deletedAt != null) topic.deletedAt = wire.deletedAt
  return topic
}

/**
 * Consume a FileCleanupResult from a committed destructive SQLite mutation.
 *
 * Every affectedFileId is inspected (LOCK-525):
 * - remaining count > 0 → still referenced by ordinary chat; no cleanup.
 * - remaining count === 0 → eligible; existing FileManager.deleteFile
 *   semantics apply (Dexie files.count still protects other local/non-chat
 *   consumers; physical delete failures are caught inside FileManager).
 * - missing count → conservatively skipped and logged; never guessed.
 *
 * Failures here are post-commit cleanup state (LOCK-527): they are logged
 * and never rethrown as a mutation failure.
 */
export async function consumeFileCleanupResult(result: FileCleanupResult): Promise<void> {
  for (const fileId of result.affectedFileIds) {
    const remaining = result.remainingReferenceCounts[fileId]
    if (remaining === undefined) {
      logger.warn(`File cleanup result missing remaining reference count for file ${fileId}; skipping cleanup`)
      continue
    }
    if (remaining > 0) {
      // Still referenced by ordinary chat in SQLite — not eligible.
      continue
    }
    try {
      await FileManager.deleteFile(fileId)
    } catch (error) {
      // LOCK-527: the SQLite mutation is already committed. This is
      // post-commit cleanup state, never a rollback signal.
      logger.error(`Post-commit file cleanup failed for file ${fileId}:`, error as Error)
    }
  }
}

/**
 * Establish SQLite ownership for an ordinary-chat topic at creation time
 * (LOCK-533): the topic must exist in SQLite with its assistantId BEFORE it
 * is exposed in Redux. Main-side ensure is create-only, so an existing
 * topic's assistant binding is never overwritten.
 *
 * Agent-session topic IDs are bypassed: agent creation keeps its existing
 * Dexie/backend path unchanged (LOCK-521).
 */
export async function ensureOrdinaryTopicOwnership(
  topicId: string,
  assistantId: string,
  name?: string | null
): Promise<void> {
  if (isAgentSessionTopicId(topicId)) {
    return
  }
  await sqliteSource.ensureTopic(topicId, assistantId, name)
}

/** Soft-delete an ordinary-chat topic in SQLite. No Dexie writes. */
export async function softDeleteOrdinaryTopic(topicId: string, name?: string | null): Promise<void> {
  await sqliteSource.softDeleteTopic(topicId, name)
}

/**
 * Restore an ordinary-chat topic from SQLite trash.
 *
 * LOCK-532: exactly ONE Main command performs the restore atomically and
 * returns the restored wire entity — never a list+restore sequence that a
 * stale UI snapshot could race. Returns the restored Topic (without
 * deletedAt) or undefined when no soft-deleted row was restored — in which
 * case no Redux update may occur.
 */
export async function restoreOrdinaryTopic(topicId: string): Promise<Topic | undefined> {
  const restoredWire = await sqliteSource.restoreTopic(topicId)
  if (restoredWire === null) {
    return undefined
  }
  const restored = topicWireToTopic(restoredWire)
  delete restored.deletedAt
  return restored
}

/**
 * List all ordinary-chat trash topics from SQLite.
 *
 * LOCK-530: drains cursor pages sequentially within this read operation,
 * forwarding opaque cursors without reinterpretation. Order is the
 * deterministic Main-side order (deletedAt DESC, id tie-break).
 */
export async function listOrdinaryTrashTopics(assistantId?: string): Promise<Topic[]> {
  const topics: Topic[] = []
  let cursor: string | undefined
  do {
    const page = await sqliteSource.listTrashTopics(assistantId, TRASH_PAGE_LIMIT, cursor)
    for (const item of page.items) {
      topics.push(topicWireToTopic(item))
    }
    if (page.hasMore && page.nextCursor === undefined) {
      // Never expose false completeness (LOCK-530).
      throw new Error('listTrashTopics reported more pages without a cursor')
    }
    cursor = page.hasMore ? page.nextCursor : undefined
  } while (cursor !== undefined)
  return topics
}

/**
 * Hard-delete an ordinary-chat topic in SQLite, then consume the cleanup
 * result. The SQLite mutation must commit first (LOCK-525/526); a mutation
 * failure propagates and no cleanup is attempted.
 */
export async function hardDeleteOrdinaryTopic(topicId: string): Promise<void> {
  const cleanup = await sqliteSource.hardDeleteTopic(topicId)
  await consumeFileCleanupResult(cleanup)
}

/**
 * Empty an assistant's ordinary trash in ONE atomic Main SQLite transaction
 * (LOCK-531): Main hard-deletes every topic of the assistant that is still
 * trashed at transaction time and returns one aggregate FileCleanupResult,
 * which is consumed here after the commit (LOCK-525/526/527). Never a
 * renderer list+loop of hard deletes.
 */
export async function emptyOrdinaryTrash(assistantId: string): Promise<void> {
  const cleanup = await sqliteSource.emptyTrashTopics(assistantId)
  await consumeFileCleanupResult(cleanup)
}

export async function resetOrdinaryAssistantTopics(
  assistantId: string,
  replacementTopicId: string
): Promise<{ replacementTopic: Topic; cleanup: FileCleanupResult }> {
  const result = await sqliteSource.resetAssistantTopics(assistantId, replacementTopicId)
  await consumeFileCleanupResult(result.cleanup)
  return { replacementTopic: topicWireToTopic(result.replacementTopic), cleanup: result.cleanup }
}

/**
 * Purge expired ordinary-chat trash topics in SQLite using a renderer
 * generated strict ISO cutoff (LOCK-523), then consume the cleanup result.
 */
export async function purgeExpiredOrdinaryTopics(now: Date = new Date()): Promise<void> {
  const cleanup = await sqliteSource.purgeExpiredTopics(buildPurgeCutoffTimestamp(now))
  await consumeFileCleanupResult(cleanup)
}

/**
 * Deterministic trash display order (LOCK-523): deletedAt DESC with id DESC
 * tie-break, matching the Main-side SQLite ordering. Used when merging the
 * agent-session Dexie trash rows with the ordinary SQLite trash rows so one
 * panel shows both lifecycles in one deterministic order (LOCK-521).
 */
export function compareTrashTopicsForDisplay(a: Topic, b: Topic): number {
  const aDeletedAt = a.deletedAt ?? ''
  const bDeletedAt = b.deletedAt ?? ''
  if (aDeletedAt !== bDeletedAt) {
    return aDeletedAt < bDeletedAt ? 1 : -1
  }
  if (a.id !== b.id) {
    return a.id < b.id ? 1 : -1
  }
  return 0
}
