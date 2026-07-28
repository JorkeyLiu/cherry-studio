/**
 * ChatDbAggregateService — implements all 23 ChatDb commands.
 *
 * Combines the five Phase 2 repositories (topics, messages, blocks,
 * topic_segments, file_references) into a single service that the IPC
 * handlers delegate to.
 *
 * Transaction strategy:
 * - Compound commands create repositories from tx inside root db.transaction().
 * - All repositories in a compound mutation are tx-bound (not root-bound).
 * - Existing nested repository transactions use Drizzle savepoints.
 * - All synchronous work stays within better-sqlite3 transactions; no await.
 * - No per-call SQLite→Dexie fallback.
 * - No implicit init. DB must be initialised before calling any command.
 *
 * Dexie remains authoritative throughout Phase 3/4.
 * updateFileCount(s) stays in Dexie/FileManager; not called here.
 */

import type { FileReferenceWire, JsonObject, SegmentWire } from '@shared/chatDb'
import type { ChatDbResult } from '@shared/chatDb'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { MessageBlockData } from './domain/types'
import { ChatDbConflictError, ChatDbNotFoundError, wrapResult } from './errors'
import type { ChatDbRepositories } from './repository/factory'
import { createRepositories } from './repository/factory'
import type * as schema from './schema'
import {
  blocksToWire,
  fileReferenceToWire,
  messagesToWire,
  projectFileReferences,
  reconstructMessageBlockRelations,
  segmentToWire,
  wireToBlock,
  wireToBlockPatch,
  wireToMessage,
  wireToMessagePatch
} from './wireAdapters'

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type FetchMessagesResult = { messages: JsonObject[]; blocks: JsonObject[] }
export type GetRawTopicResult = { id: string; messages: JsonObject[] } | null

// ---------------------------------------------------------------------------
// ChatDbAggregateService
// ---------------------------------------------------------------------------

export class ChatDbAggregateService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Create repositories bound to the root database.
   * Only for read-only or single-statement commands.
   */
  private repos(): ChatDbRepositories {
    return createRepositories(this.db)
  }

  // =========================================================================
  // Command implementations
  // =========================================================================

  /**
   * Fetch all messages and blocks for a topic.
   * Returns consistent ordered message/block snapshot.
   * Rebuilds each message.blocks relationally.
   *
   * Topic priming: if the topic is absent, ensure/create it within
   * the same aggregate transaction and return empty arrays.
   */
  fetchMessages(topicId: string): ChatDbResult<FetchMessagesResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Absent topic → ensure it exists, return empty result
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          repos.topics.ensure(topicId)
          return { messages: [], blocks: [] }
        }

        const messageData = repos.messages.listByTopic(topicId)
        const messageIds = messageData.map((m) => m.id)
        const blockDataMap = repos.blocks.listByMessages(messageIds)

        // Flatten all blocks
        const allBlocks: MessageBlockData[] = []
        for (const id of messageIds) {
          const msgBlocks = blockDataMap.get(id) ?? []
          allBlocks.push(...msgBlocks)
        }

        // Convert to wire format
        const wireMessages = messagesToWire(messageData)
        const wireBlocks = blocksToWire(allBlocks)

        // Reconstruct relational message.blocks
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

        return { messages: messagesWithBlocks, blocks: wireBlocks }
      })
    }, `fetchMessages(${topicId})`)
  }

  /**
   * Get raw topic with ordered messages and relational block IDs.
   * Returns null if topic does not exist.
   */
  getRawTopic(topicId: string): ChatDbResult<GetRawTopicResult> {
    return wrapResult(() => {
      const { topics, messages: msgRepo, blocks } = this.repos()

      const topic = topics.getById(topicId)
      if (!topic.found) return null

      const messageData = msgRepo.listByTopic(topicId)
      const messageIds = messageData.map((m) => m.id)
      const blockDataMap = blocks.listByMessages(messageIds)

      const allBlocks: MessageBlockData[] = []
      for (const id of messageIds) {
        allBlocks.push(...(blockDataMap.get(id) ?? []))
      }

      const wireMessages = messagesToWire(messageData)
      const wireBlocks = blocksToWire(allBlocks)
      const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

      return { id: topicId, messages: messagesWithBlocks }
    }, `getRawTopic(${topicId})`)
  }

  /**
   * Check if a topic exists. Real DB errors become failure, not false.
   */
  topicExists(topicId: string): ChatDbResult<boolean> {
    return wrapResult(() => {
      const { topics } = this.repos()
      return topics.exists(topicId)
    }, `topicExists(${topicId})`)
  }

  /**
   * Ensure a topic exists. Create-only: only sets assistantId on creation.
   * Does not overwrite existing topic's assistantId.
   */
  ensureTopic(topicId: string, assistantId?: string): ChatDbResult<null> {
    return wrapResult(() => {
      const { topics } = this.repos()
      topics.ensure(topicId, assistantId)
      return null
    }, `ensureTopic(${topicId})`)
  }

  /**
   * Append a message with blocks to a topic.
   *
   * - Ensures topic exists.
   * - New message at valid insertIndex, else append at end.
   * - Existing message ID preserves current position.
   * - Full supplied blocks are upserted, ordered, and references synced.
   */
  appendMessage(
    topicId: string,
    messageJson: JsonObject,
    blocksJson: JsonObject[],
    insertIndex?: number
  ): ChatDbResult<null> {
    return wrapResult(() => {
      // Convert wire → domain
      const messageData = wireToMessage(messageJson)
      messageData.topicId = topicId // Ensure consistency
      const blockDataList = blocksJson.map(wireToBlock)

      // Validate block ownership: all blocks must reference this message
      for (const block of blockDataList) {
        block.messageId = messageData.id // Enforce consistency
      }

      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure topic exists
        repos.topics.ensure(topicId)

        // Check if message already exists
        const existing = repos.messages.getById(messageData.id)

        if (existing.found) {
          // Existing ID: preserve current position (update metadata only)
          const patch = wireToMessagePatch(messageJson)
          delete patch.id
          delete patch.topicId
          delete patch.sortOrder
          if (Object.keys(patch).length > 0) {
            repos.messages.update(topicId, messageData.id, patch)
          }
        } else {
          // New message: insert at index or append
          if (insertIndex !== undefined) {
            repos.messages.insertAt(messageData, insertIndex)
          } else {
            repos.messages.append(messageData)
          }
        }

        // Upsert blocks (preserves existing order for existing blocks)
        if (blockDataList.length > 0) {
          repos.blocks.upsertMany(blockDataList)

          // Sync file references for file/image blocks
          this.syncFileReferences(repos, blockDataList)
        }
      })

      return null
    }, `appendMessage(${topicId}, ${messageJson.id})`)
  }

  /**
   * Update a message by ID.
   * Missing target: no-op (returns success).
   * Identity/reparenting fields rejected at contract level.
   */
  updateMessage(topicId: string, messageId: string, updatesJson: JsonObject): ChatDbResult<null> {
    return wrapResult(() => {
      const patch = wireToMessagePatch(updatesJson)
      // Strip identity fields (defense in depth — contract already rejects)
      delete patch.id
      delete patch.topicId
      delete patch.sortOrder

      const { messages } = this.repos()
      messages.update(topicId, messageId, patch)
      return null
    }, `updateMessage(${topicId}, ${messageId})`)
  }

  /**
   * Atomic message patch + full block upserts + references/order.
   * Missing message: follows Dexie-compatible no-op without weakening FK.
   */
  updateMessageAndBlocks(
    topicId: string,
    messageUpdatesJson: JsonObject,
    blocksToUpdateJson: JsonObject[]
  ): ChatDbResult<null> {
    return wrapResult(() => {
      const messageId = messageUpdatesJson.id as string
      const messagePatch = wireToMessagePatch(messageUpdatesJson)
      delete messagePatch.id
      delete messagePatch.topicId
      delete messagePatch.sortOrder

      const blockDataList = blocksToUpdateJson.map(wireToBlock)

      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check message exists
        const existing = repos.messages.getInTopic(messageId, topicId)
        if (!existing.found) {
          // No-op: follow Dexie-compatible semantics
          return
        }

        // Apply message patch
        if (Object.keys(messagePatch).length > 0) {
          repos.messages.update(topicId, messageId, messagePatch)
        }

        // Upsert blocks
        if (blockDataList.length > 0) {
          repos.blocks.upsertMany(blockDataList)

          // Sync file references
          this.syncFileReferences(repos, blockDataList)
        }
      })

      return null
    }, `updateMessageAndBlocks(${topicId}, ${messageUpdatesJson.id})`)
  }

  /**
   * Delete a single message. Only deletes if owned by the specified topic.
   * Missing/foreign IDs: no-op.
   */
  deleteMessage(topicId: string, messageId: string): ChatDbResult<null> {
    return wrapResult(() => {
      const { messages } = this.repos()
      // Verify ownership before delete
      const existing = messages.getInTopic(messageId, topicId)
      if (!existing.found) return null // no-op for missing/foreign IDs
      messages.delete(messageId)
      return null
    }, `deleteMessage(${topicId}, ${messageId})`)
  }

  /**
   * Delete multiple messages. Only deletes messages owned by the specified topic.
   * Missing/foreign IDs: no-op.
   */
  deleteMessages(topicId: string, messageIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      const { messages } = this.repos()
      // Filter to messages actually owned by this topic
      const ownedIds: string[] = []
      for (const id of messageIds) {
        const existing = messages.getInTopic(id, topicId)
        if (existing.found) ownedIds.push(id)
      }
      if (ownedIds.length > 0) {
        messages.deleteMany(ownedIds)
      }
      return null
    }, `deleteMessages(${topicId}, ${messageIds.length} ids)`)
  }

  /**
   * Upsert blocks. Existing order preserved, new blocks append per input order.
   * No reparent. Reference sync for file/image blocks.
   *
   * Atomicity: block upsert + file-reference replacement in one root transaction.
   * All repositories are tx-bound.
   */
  updateBlocks(blocksJson: JsonObject[]): ChatDbResult<null> {
    return wrapResult(() => {
      const blockDataList = blocksJson.map(wireToBlock)

      this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        repos.blocks.upsertMany(blockDataList)

        // Sync file references within the same transaction
        this.syncFileReferences(repos, blockDataList)
      })

      return null
    }, `updateBlocks(${blocksJson.length} blocks)`)
  }

  /**
   * Update a single block by ID.
   * Missing: no-op. Patch only. Merge existing full block before recomputing
   * reference projection.
   *
   * Atomicity: load/merge/update + file-reference delete/create in one root
   * transaction. All repositories are tx-bound.
   */
  updateSingleBlock(blockId: string, updatesJson: JsonObject): ChatDbResult<null> {
    return wrapResult(() => {
      const patch = wireToBlockPatch(updatesJson)
      // Strip identity fields (defense in depth)
      delete patch.id
      delete patch.messageId
      delete patch.sortOrder

      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        const existing = repos.blocks.getById(blockId)
        if (!existing.found) return // no-op for missing

        // Apply patch to the existing block to get the merged result
        const merged: Record<string, unknown> = { ...existing.data }
        for (const [key, value] of Object.entries(patch)) {
          if (key !== 'overflow') {
            merged[key] = value
          }
        }
        // Merge overflow
        if (patch.overflow) {
          merged.overflow = { ...existing.data.overflow, ...patch.overflow }
        }

        // Apply the update
        repos.blocks.update(existing.data.messageId, blockId, patch)

        // Recompute file references from merged block (same tx)
        const mergedBlock = merged as unknown as MessageBlockData
        const newRefs = projectFileReferences(mergedBlock)
        const oldRefs = repos.fileRefs.listByBlock(blockId)

        // Replace stale references
        if (oldRefs.length > 0) {
          repos.fileRefs.deleteByBlock(blockId)
        }
        if (newRefs.length > 0) {
          repos.fileRefs.createMany(newRefs)
        }
      })

      return null
    }, `updateSingleBlock(${blockId})`)
  }

  /**
   * Bulk add blocks (insert-only). Duplicate ID aborts whole batch.
   * Appends in input order. Syncs file references.
   *
   * Atomicity: one root transaction with tx-bound repositories.
   * Duplicate IDs throw ChatDbConflictError (typed).
   */
  bulkAddBlocks(blocksJson: JsonObject[]): ChatDbResult<null> {
    return wrapResult(() => {
      const blockDataList = blocksJson.map(wireToBlock)

      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check for duplicate IDs in the batch
        const seenIds = new Set<string>()
        for (const block of blockDataList) {
          if (seenIds.has(block.id)) {
            throw new ChatDbConflictError(`Duplicate block ID in batch: ${block.id}`)
          }
          seenIds.add(block.id)
        }

        // Insert only (not upsert) — createMany will throw on existing IDs
        repos.blocks.createMany(blockDataList)

        // Sync file references
        this.syncFileReferences(repos, blockDataList)
      })

      return null
    }, `bulkAddBlocks(${blocksJson.length} blocks)`)
  }

  /**
   * Delete blocks by IDs. Missing: no-op.
   *
   * Atomicity: one root transaction. FK cascade handles file_references
   * cleanup (file_references.blockId → messageBlocks.id ON DELETE CASCADE).
   * No pre-transaction destructive reference deletes.
   * Normalize affected message block order via repository.
   */
  deleteBlocks(blockIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        // blocks.deleteMany handles order normalization within its own
        // savepoint transaction. FK cascade removes file_references.
        repos.blocks.deleteMany(blockIds)
      })
      return null
    }, `deleteBlocks(${blockIds.length} blocks)`)
  }

  /**
   * Clear all messages from a topic. Missing topic: no-op.
   * Retains topic. Clears messages, blocks/references via FK cascade,
   * and topic segments. Never touches Dexie file counts.
   *
   * Cascade chain (FK ON DELETE CASCADE):
   * - delete messages → blocks cascade → file_references cascade
   * - delete topic_segment_messages (by message FK cascade)
   * - clearTopic also explicitly deletes topic_segments + topic_segment_messages
   *
   * No explicit fileRefs.deleteByMessage — relies on cascade and
   * repository segment cleanup. The old call was semantically wrong:
   * by the time it executed, messages/blocks were already deleted by
   * clearTopic, so the subquery-based delete was targeting already-cascaded rows.
   */
  clearMessages(topicId: string): ChatDbResult<null> {
    return wrapResult(() => {
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check topic exists
        const topic = repos.topics.getById(topicId)
        if (!topic.found) return // no-op for missing topic

        // clearTopic cascades: deletes messages (→ blocks cascade via FK,
        // → file_references cascade via FK, → topic_segment_messages cascade
        // via message FK), and topic_segments + topic_segment_messages.
        repos.messages.clearTopic(topicId)
      })

      return null
    }, `clearMessages(${topicId})`)
  }

  // =========================================================================
  // Phase 5.1A: Segment commands
  // =========================================================================

  /**
   * List all segments for a topic with ordered messageIds.
   * Each segment's messageIds are reconstructed from topic_segment_messages sort_order.
   */
  listSegments(topicId: string): ChatDbResult<SegmentWire[]> {
    return wrapResult(() => {
      const repos = this.repos()
      const segments = repos.segments.listByTopic(topicId)
      return segments.map((seg) => {
        const messageIds = repos.segments.getMessageIds(seg.id)
        return segmentToWire(seg, messageIds)
      })
    }, `listSegments(${topicId})`)
  }

  /**
   * Atomically upsert a segment with metadata and ordered membership.
   * - Creates segment if absent, updates metadata if present.
   * - Replaces message membership atomically in one transaction.
   * - Empty membership deletes the segment per repository semantics.
   */
  upsertSegment(
    segmentId: string,
    topicId: string,
    name: string | null | undefined,
    messageIds: string[],
    color: string | null | undefined
  ): ChatDbResult<SegmentWire> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure topic exists
        repos.topics.ensure(topicId)

        // Build segment data
        const overflow: Record<string, unknown> = {}
        if (color !== undefined && color !== null) {
          overflow.color = color
        }

        const existing = repos.segments.getById(segmentId)
        if (existing.found) {
          // Update metadata
          const patch: Record<string, unknown> = {}
          if (name !== undefined) patch.name = name
          if (color !== undefined) patch.overflow = overflow
          if (Object.keys(patch).length > 0) {
            repos.segments.updateMetadata(segmentId, patch as any)
          }
        } else {
          // Create new segment
          repos.segments.create({
            id: segmentId,
            topicId,
            name: name ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sortOrder: 0,
            overflow
          })
        }

        // Replace membership atomically
        repos.segments.replaceMessageIds(segmentId, messageIds)

        // Read back the result
        const segment = repos.segments.getById(segmentId)
        if (!segment.found) {
          // Segment was deleted (empty membership) — return empty wire
          return {
            id: segmentId,
            topicId,
            name: name ?? null,
            messageIds: [],
            color: color ?? undefined,
            createdAt: null,
            updatedAt: null
          }
        }

        const finalMessageIds = repos.segments.getMessageIds(segmentId)
        return segmentToWire(segment.data, finalMessageIds)
      })
    }, `upsertSegment(${segmentId}, ${topicId})`)
  }

  /**
   * Update segment metadata (name, color). No membership change.
   * Missing segment: throws ChatDbNotFoundError → ERR_NOT_FOUND.
   * Returns the updated segment wire.
   */
  updateSegmentMetadata(
    segmentId: string,
    name: string | null | undefined,
    color: string | null | undefined
  ): ChatDbResult<SegmentWire> {
    return wrapResult(() => {
      const repos = this.repos()
      const existing = repos.segments.getById(segmentId)
      if (!existing.found) {
        throw new ChatDbNotFoundError(`Segment ${segmentId} does not exist`)
      }

      const patch: Record<string, unknown> = {}
      if (name !== undefined) patch.name = name
      if (color !== undefined) {
        patch.overflow = { ...existing.data.overflow, color }
      }
      if (Object.keys(patch).length > 0) {
        repos.segments.updateMetadata(segmentId, patch as any)
      }

      // Read back
      const updated = repos.segments.getById(segmentId)
      if (!updated.found) {
        // Defensive: segment was deleted between getById and updateMetadata
        // within the same operation. Should not happen in practice.
        throw new ChatDbNotFoundError(`Segment ${segmentId} was deleted during update`)
      }
      const messageIds = repos.segments.getMessageIds(segmentId)
      return segmentToWire(updated.data, messageIds)
    }, `updateSegmentMetadata(${segmentId})`)
  }

  /**
   * Delete a segment. Missing: no-op.
   */
  deleteSegment(segmentId: string): ChatDbResult<null> {
    return wrapResult(() => {
      const { segments } = this.repos()
      segments.delete(segmentId)
      return null
    }, `deleteSegment(${segmentId})`)
  }

  /**
   * Replace segment message IDs atomically.
   * Empty membership deletes the segment per repository semantics.
   * Returns the updated segment wire, or null if segment was deleted.
   */
  replaceSegmentMembership(segmentId: string, messageIds: string[]): ChatDbResult<SegmentWire | null> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        repos.segments.replaceMessageIds(segmentId, messageIds)

        const segment = repos.segments.getById(segmentId)
        if (!segment.found) return null

        const finalMessageIds = repos.segments.getMessageIds(segmentId)
        return segmentToWire(segment.data, finalMessageIds)
      })
    }, `replaceSegmentMembership(${segmentId})`)
  }

  // =========================================================================
  // Phase 5.1A: Message reorder
  // =========================================================================

  /**
   * Reorder all messages in a topic atomically.
   * Validates exact membership and dense order via repository.
   */
  reorderMessages(topicId: string, messageIds: string[]): ChatDbResult<null> {
    return wrapResult(() => {
      const { messages } = this.repos()
      messages.replaceOrder(topicId, messageIds)
      return null
    }, `reorderMessages(${topicId})`)
  }

  // =========================================================================
  // Phase 5.1A: File reference queries (read-only)
  // =========================================================================

  /**
   * List file references by file ID. Read-only.
   */
  listFileRefsByFile(fileId: string): ChatDbResult<FileReferenceWire[]> {
    return wrapResult(() => {
      const { fileRefs } = this.repos()
      const refs = fileRefs.listByFile(fileId)
      return refs.map(fileReferenceToWire)
    }, `listFileRefsByFile(${fileId})`)
  }

  /**
   * Count file references by file ID. Read-only.
   */
  countFileRefsByFile(fileId: string): ChatDbResult<number> {
    return wrapResult(() => {
      const { fileRefs } = this.repos()
      return fileRefs.countByFile(fileId)
    }, `countFileRefsByFile(${fileId})`)
  }

  /**
   * List blocks associated with a file via file_references. Read-only.
   */
  listBlocksByFile(fileId: string): ChatDbResult<JsonObject[]> {
    return wrapResult(() => {
      const repos = this.repos()
      const blocks = repos.blocks.findByFileId(fileId)
      return blocksToWire(blocks)
    }, `listBlocksByFile(${fileId})`)
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * Sync file references for file/image blocks.
   * Replaces stale references for each block with deterministic snapshots.
   * Non-file blocks have zero references (old refs cleared).
   */
  private syncFileReferences(repos: ChatDbRepositories, blocks: MessageBlockData[]): void {
    for (const block of blocks) {
      const newRefs = projectFileReferences(block)
      const oldRefs = repos.fileRefs.listByBlock(block.id)

      // Clear old references for this block
      if (oldRefs.length > 0) {
        repos.fileRefs.deleteByBlock(block.id)
      }

      // Create new references
      if (newRefs.length > 0) {
        repos.fileRefs.createMany(newRefs)
      }
    }
  }
}
