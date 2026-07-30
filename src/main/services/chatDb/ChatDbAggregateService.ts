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

import type { FileCleanupResult, FileReferenceWire, JsonObject, SegmentWire } from '@shared/chatDb'
import type { ChatDbResult } from '@shared/chatDb'
import type { SearchMessagesRequest, SearchMessagesResponse } from '@shared/chatDb'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { FileReferenceData, MessageBlockData } from './domain/types'
import { ChatDbConflictError, ChatDbNotFoundError, wrapResult } from './errors'
import type { ChatDbRepositories } from './repository/factory'
import { createRepositories } from './repository/factory'
import { SearchRepository } from './repository/SearchRepository'
import type * as schema from './schema'
import {
  blocksToWire,
  buildFileCleanupResult,
  collectAffectedFileIds,
  fileReferenceToWire,
  messagesToWire,
  projectFileReferences,
  reconstructMessageBlockRelations,
  segmentToWire,
  topicToWireFull,
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
  constructor(
    private db: BetterSQLite3Database<typeof schema>,
    private sqlite?: Database.Database
  ) {}

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
  ensureTopic(topicId: string, assistantId?: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const { topics } = this.repos()
      topics.ensure(topicId, assistantId, name)
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

      return this.db.transaction((tx) => {
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
        return null
      })
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
   *
   * When blockIdsToDelete is provided:
   * - Each block ID is resolved through its parent message to verify
   *   topic ownership (LOCK-004). Blocks whose parent message does not
   *   belong to the requested topic are rejected atomically.
   * - File references are collected from owned blocks only before cascade.
   * - Returns FileCleanupResult for caller-side post-commit consumption.
   */
  updateMessageAndBlocks(
    topicId: string,
    messageUpdatesJson: JsonObject,
    blocksToUpdateJson: JsonObject[],
    blockIdsToDelete: string[] = []
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const messageId = messageUpdatesJson.id as string
      const messagePatch = wireToMessagePatch(messageUpdatesJson)
      delete messagePatch.id
      delete messagePatch.topicId
      delete messagePatch.sortOrder

      const blockDataList = blocksToUpdateJson.map(wireToBlock)

      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check message exists
        const existing = repos.messages.getInTopic(messageId, topicId)
        if (!existing.found) {
          // No-op: follow Dexie-compatible semantics — empty cleanup
          return { affectedFileIds: [], remainingReferenceCounts: {} }
        }

        // Phase 1: Resolve every block through its parent message and verify ownership.
        // Missing blocks follow delete no-op semantics. Existing blocks must belong
        // to the message being updated, not merely to the requested topic.
        let affectedFileIds: string[] = []
        if (blockIdsToDelete.length > 0) {
          const ownedBlockIds: string[] = []
          for (const blockId of blockIdsToDelete) {
            const block = repos.blocks.getById(blockId)
            if (!block.found) {
              // Missing block: skip (consistent with no-op semantics)
              continue
            }
            if (block.data.messageId !== messageId) {
              throw new ChatDbConflictError(
                `Block ${blockId} belongs to message ${block.data.messageId}, cannot delete from message ${messageId}`
              )
            }
            // Resolve block → message → topic ownership
            const msg = repos.messages.getInTopic(block.data.messageId, topicId)
            if (!msg.found) {
              throw new ChatDbConflictError(
                `Block ${blockId} belongs to message ${block.data.messageId} which is not in topic ${topicId}`
              )
            }
            ownedBlockIds.push(blockId)
          }

          // Collect affected file IDs from owned blocks only
          if (ownedBlockIds.length > 0) {
            const allRefs: FileReferenceData[] = []
            for (const blockId of ownedBlockIds) {
              const refs = repos.fileRefs.listByBlock(blockId)
              allRefs.push(...refs)
            }
            affectedFileIds = collectAffectedFileIds(allRefs)

            // Delete owned blocks (FK cascade removes file_references)
            repos.blocks.deleteMany(ownedBlockIds)
          }
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
        return buildFileCleanupResult(repos, affectedFileIds)
      })
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
  deleteBlocks(blockIds: string[]): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const affectedFileIds = collectAffectedFileIds(
          blockIds.flatMap((blockId) => repos.fileRefs.listByBlock(blockId))
        )
        // blocks.deleteMany handles order normalization within its own
        // savepoint transaction. FK cascade removes file_references.
        repos.blocks.deleteMany(blockIds)
        return buildFileCleanupResult(repos, affectedFileIds)
      })
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
  clearMessages(topicId: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check topic exists
        const topic = repos.topics.getById(topicId)
        if (!topic.found) return { affectedFileIds: [], remainingReferenceCounts: {} }
        const messages = repos.messages.listByTopic(topicId)
        const affectedFileIds = collectAffectedFileIds(repos.fileRefs.listByMessages(messages.map((m) => m.id)))

        // clearTopic cascades: deletes messages (→ blocks cascade via FK,
        // → file_references cascade via FK, → topic_segment_messages cascade
        // via message FK), and topic_segments + topic_segment_messages.
        repos.messages.clearTopic(topicId)
        return buildFileCleanupResult(repos, affectedFileIds)
      })
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
  // Phase 5.1B: Topic lifecycle
  // =========================================================================

  /**
   * Update topic metadata. Mutable fields: name (column), pinned/prompt/
   * isNameManuallyEdited (overflow). updatedAt is maintained consistently.
   * Identity fields (id, assistantId, createdAt, deletedAt, messages) are
   * NOT mutable through this path.
   *
   * Returns ERR_NOT_FOUND if topic does not exist.
   */
  updateTopicMetadata(
    topicId: string,
    name?: string | null,
    pinned?: boolean | null,
    prompt?: string | null,
    isNameManuallyEdited?: boolean | null
  ): ChatDbResult<JsonObject> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        const existing = repos.topics.getById(topicId)
        if (!existing.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }

        // Build patch from allowed fields
        const patch: Record<string, unknown> = {}
        if (name !== undefined) patch.name = name
        if (pinned !== undefined) patch.pinned = pinned
        if (prompt !== undefined) patch.prompt = prompt
        if (isNameManuallyEdited !== undefined) patch.isNameManuallyEdited = isNameManuallyEdited

        if (Object.keys(patch).length === 0) {
          // No-op: return current state
          return topicToWireFull(existing.data)
        }

        // Maintain updatedAt consistently
        patch.updatedAt = new Date().toISOString()

        // Split into columns vs overflow
        const domainPatch: Record<string, unknown> = {}
        const overflowDelta: Record<string, unknown> = {}

        if ('name' in patch || 'updatedAt' in patch) {
          if ('name' in patch) domainPatch.name = patch.name
          domainPatch.updatedAt = patch.updatedAt
        }
        if ('pinned' in patch) overflowDelta.pinned = patch.pinned
        if ('prompt' in patch) overflowDelta.prompt = patch.prompt
        if ('isNameManuallyEdited' in patch) overflowDelta.isNameManuallyEdited = patch.isNameManuallyEdited

        // Merge overflow into existing topic
        const mergedOverflow = { ...existing.data.overflow, ...overflowDelta }
        // Remove keys with OVERFLOW_REMOVE sentinel
        for (const [k, v] of Object.entries(overflowDelta)) {
          if (v === undefined) delete mergedOverflow[k]
        }

        repos.topics.updatePatch(topicId, {
          ...domainPatch,
          overflow: mergedOverflow
        } as any)

        // Read back
        const updated = repos.topics.getById(topicId)
        if (!updated.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} was deleted during update`)
        }
        return topicToWireFull(updated.data)
      })
    }, `updateTopicMetadata(${topicId})`)
  }

  /**
   * Soft-delete a topic by setting deletedAt.
   * Missing topic: no-op (returns success).
   */
  softDeleteTopic(topicId: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      this.db.transaction((tx) => {
        const { topics } = createRepositories(tx)
        topics.softDelete(topicId, name)
      })
      return null
    }, `softDeleteTopic(${topicId})`)
  }

  /**
   * Atomically restore a soft-deleted topic and return the restored wire
   * entity (LOCK-532). Returns null when no soft-deleted row exists for the
   * ID at command time (missing topic, or topic not in trash) — in that
   * case NO mutation occurs. Callers must dispatch only the returned row,
   * never a separately listed snapshot.
   */
  restoreTopic(topicId: string): ChatDbResult<JsonObject | null> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        const existing = repos.topics.getById(topicId)
        if (!existing.found || existing.data.deletedAt == null) {
          // No deleted row was restored — explicit null, no mutation.
          return null
        }

        repos.topics.restore(topicId)

        const restored = repos.topics.getById(topicId)
        if (!restored.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} disappeared during restore`)
        }
        return topicToWireFull(restored.data)
      })
    }, `restoreTopic(${topicId})`)
  }

  /**
   * List soft-deleted topics with optional assistant filter.
   * DeletedAt descending with deterministic tie-break (id ascending).
   * Returns paginated result.
   */
  listTrashTopics(
    assistantId?: string,
    limit?: number,
    cursor?: string
  ): ChatDbResult<{ items: JsonObject[]; nextCursor?: string; hasMore: boolean }> {
    return wrapResult(() => {
      const { topics } = this.repos()
      const page = topics.listTrashPage(
        { limit: limit ?? 20, direction: 'desc', cursor },
        assistantId ? { assistantId } : undefined
      )
      return {
        items: page.items.map(topicToWireFull),
        // Omit nextCursor entirely on the last page: `undefined` is not a
        // valid JSON wire value and fails result envelope validation.
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
        hasMore: page.hasMore
      }
    }, `listTrashTopics()`)
  }

  /**
   * Hard-delete a topic with full FK cascade (messages → blocks →
   * file_references, segments → memberships). Returns file cleanup facts.
   *
   * Uses root transaction: collect affected file IDs before cascade,
   * then delete topic, then compute remaining counts.
   *
   * Missing topic: no-op with empty cleanup result.
   */
  hardDeleteTopic(topicId: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check topic exists
        const existing = repos.topics.getById(topicId)
        if (!existing.found) {
          return { affectedFileIds: [], remainingReferenceCounts: {} }
        }

        // Collect affected file IDs before cascade deletion
        const messages = repos.messages.listByTopic(topicId)
        const messageIds = messages.map((m) => m.id)
        const refsBeforeDelete = repos.fileRefs.listByMessages(messageIds)
        const affectedFileIds = collectAffectedFileIds(refsBeforeDelete)

        // FK cascade: topic → messages → blocks → file_references
        // Also topic → topic_segments → topic_segment_messages
        repos.topics.hardDelete(topicId)

        // Compute remaining counts after cascade
        return buildFileCleanupResult(repos, affectedFileIds)
      })
    }, `hardDeleteTopic(${topicId})`)
  }

  /**
   * Purge all soft-deleted topics with deletedAt < cutoffTimestamp.
   * All eligible topics are purged atomically in one transaction.
   * Returns aggregated file cleanup facts across all purged topics.
   *
   * Per LOCK-5113: the cutoff is generated by the caller. No Main timer.
   */
  purgeExpiredTopics(cutoffTimestamp: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // List ALL deleted topics with deletedAt < cutoff (paginate internally)
        const allAffectedFileIds: string[] = []
        let cursor: string | undefined
        let hasMore = true

        while (hasMore) {
          const page = repos.topics.listTrashPage({ limit: 100, direction: 'desc', cursor })

          for (const topic of page.items) {
            if (topic.deletedAt && topic.deletedAt < cutoffTimestamp) {
              // Collect affected file IDs before cascade
              const messages = repos.messages.listByTopic(topic.id)
              const messageIds = messages.map((m) => m.id)
              const refs = repos.fileRefs.listByMessages(messageIds)
              const ids = collectAffectedFileIds(refs)
              allAffectedFileIds.push(...ids)

              // FK cascade: hard delete
              repos.topics.hardDelete(topic.id)
            }
          }

          cursor = page.nextCursor
          hasMore = page.hasMore && page.items.length > 0
        }

        // Deduplicate affected file IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)]
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })
    }, `purgeExpiredTopics(${cutoffTimestamp})`)
  }

  /**
   * Empty an assistant's trash atomically (LOCK-531).
   *
   * ONE root SQLite transaction hard-deletes every topic of the assistant
   * that is still soft-deleted at transaction time (FK cascade: messages →
   * blocks → file_references, segments → memberships) and returns one
   * aggregate FileCleanupResult. Any mid-operation failure rolls back the
   * entire transaction — no partial commit.
   */
  emptyTrashTopics(assistantId: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        const allAffectedFileIds: string[] = []
        let cursor: string | undefined
        let hasMore = true

        // Drain the assistant's trash pages inside the transaction. Deleting
        // listed rows is safe with keyset pagination: the next page is
        // selected relative to the cursor tuple, not to row offsets.
        while (hasMore) {
          const page = repos.topics.listTrashPage({ limit: 100, direction: 'desc', cursor }, { assistantId })

          for (const topic of page.items) {
            // Collect affected file IDs before cascade
            const messages = repos.messages.listByTopic(topic.id)
            const messageIds = messages.map((m) => m.id)
            const refs = repos.fileRefs.listByMessages(messageIds)
            allAffectedFileIds.push(...collectAffectedFileIds(refs))

            // FK cascade: hard delete
            repos.topics.hardDelete(topic.id)
          }

          cursor = page.nextCursor
          hasMore = page.hasMore && page.items.length > 0
        }

        // Deduplicate affected file IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)]
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })
    }, `emptyTrashTopics(${assistantId})`)
  }

  transferTopicOwnership(topicId: string, assistantId: string): ChatDbResult<null> {
    return wrapResult(() => {
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        repos.topics.updatePatch(topicId, { assistantId } as any)
        for (const message of repos.messages.listByTopic(topicId)) {
          repos.messages.update(topicId, message.id, { assistantId } as any)
        }
      })
      return null
    }, `transferTopicOwnership(${topicId}, ${assistantId})`)
  }

  resetAssistantTopics(
    assistantId: string,
    replacementTopicId: string
  ): ChatDbResult<{ cleanup: FileCleanupResult; replacementTopic: JsonObject }> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const affectedFileIds: string[] = []
        let activeCursor: string | undefined
        let trashCursor: string | undefined
        let hasMoreActive = true
        let hasMoreTrash = true
        while (hasMoreActive || hasMoreTrash) {
          const activePage = hasMoreActive
            ? repos.topics.listPage({ limit: 100, direction: 'asc', cursor: activeCursor })
            : { items: [], nextCursor: undefined, hasMore: false }
          const trashPage = hasMoreTrash
            ? repos.topics.listTrashPage({ limit: 100, direction: 'asc', cursor: trashCursor })
            : { items: [], nextCursor: undefined, hasMore: false }
          for (const topic of [...activePage.items, ...trashPage.items]) {
            if (topic.assistantId !== assistantId || topic.id === replacementTopicId) continue
            const messageIds = repos.messages.listByTopic(topic.id).map((message) => message.id)
            affectedFileIds.push(...collectAffectedFileIds(repos.fileRefs.listByMessages(messageIds)))
            repos.topics.hardDelete(topic.id)
          }
          activeCursor = activePage.nextCursor
          trashCursor = trashPage.nextCursor
          hasMoreActive = activePage.hasMore && activePage.items.length > 0
          hasMoreTrash = trashPage.hasMore && trashPage.items.length > 0
        }
        const replacementTopic = repos.topics.ensure(replacementTopicId, assistantId)
        return {
          cleanup: buildFileCleanupResult(repos, [...new Set(affectedFileIds)]),
          replacementTopic: topicToWireFull(replacementTopic)
        }
      })
    }, `resetAssistantTopics(${assistantId})`)
  }

  // =========================================================================
  // Phase 5.1B: Compound mutations
  // =========================================================================

  /**
   * Atomically ensure/create a target topic and insert ordered
   * messages+blocks. Each entry is a message with its blocks, appended
   * in array order. File references are synced for all file/image blocks.
   *
   * Rejects any existing message ID that is owned by a different topic.
   *
   * Atomicity: one root SQLite transaction (LOCK-5106).
   */
  cloneMessagesToTopic(
    targetTopicId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>,
    assistantId?: string
  ): ChatDbResult<null> {
    return wrapResult(() => {
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure target topic exists
        repos.topics.ensure(targetTopicId, assistantId)

        for (const entry of entries) {
          const messageData = wireToMessage(entry.message)
          messageData.topicId = targetTopicId
          const blockDataList = entry.blocks.map(wireToBlock)

          // Enforce block ownership
          for (const block of blockDataList) {
            block.messageId = messageData.id
          }

          // Check if message already exists
          const existing = repos.messages.getById(messageData.id)

          if (existing.found) {
            // Reject cross-topic ownership: message must belong to target topic
            if (existing.data.topicId !== targetTopicId) {
              throw new ChatDbConflictError(
                `Message ${messageData.id} belongs to topic ${existing.data.topicId}, ` +
                  `cannot clone into topic ${targetTopicId}`
              )
            }
            // Same topic: preserve position, update metadata only
            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.sortOrder
            if (Object.keys(patch).length > 0) {
              repos.messages.update(targetTopicId, messageData.id, patch)
            }
          } else {
            // New: append at end
            repos.messages.append(messageData)
          }

          // Upsert blocks + sync file references
          if (blockDataList.length > 0) {
            repos.blocks.upsertMany(blockDataList)
            this.syncFileReferences(repos, blockDataList)
          }
        }
      })

      return null
    }, `cloneMessagesToTopic(${targetTopicId}, ${entries.length} entries)`)
  }

  /**
   * Atomically reset message state for resend and delete designated blocks.
   *
   * - Resolves every block ID through its parent message to verify topic ownership.
   * - Rejects any block ID whose parent message does not belong to request topic.
   * - Deletes owned blocks and resets each message's status, sortOrder, and clears model.
   * - Returns file cleanup facts for deleted blocks.
   *
   * Atomicity: one root SQLite transaction.
   */
  resetMessagesForResend(
    topicId: string,
    messages: Array<{ message: JsonObject; blocks: JsonObject[] }> | string[],
    blockIdsToDelete: string[]
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Phase 1: Resolve every block through its parent message and verify ownership.
        // Reject any block whose parent message does not belong to request topic.
        const ownedBlockIds: string[] = []
        if (blockIdsToDelete.length > 0) {
          for (const blockId of blockIdsToDelete) {
            const block = repos.blocks.getById(blockId)
            if (!block.found) {
              throw new ChatDbConflictError(`Block ${blockId} does not exist`)
            }
            // Resolve block → message → topic ownership
            const msg = repos.messages.getInTopic(block.data.messageId, topicId)
            if (!msg.found) {
              throw new ChatDbConflictError(
                `Block ${blockId} belongs to message ${block.data.messageId} which is not in topic ${topicId}`
              )
            }
            ownedBlockIds.push(blockId)
          }
        }

        // Phase 2: Collect affected file IDs from owned blocks only
        let affectedFileIds: string[] = []
        if (ownedBlockIds.length > 0) {
          const allRefs: FileReferenceData[] = []
          for (const blockId of ownedBlockIds) {
            const refs = repos.fileRefs.listByBlock(blockId)
            allRefs.push(...refs)
          }
          affectedFileIds = collectAffectedFileIds(allRefs)

          // Delete owned blocks (FK cascade removes file_references)
          repos.blocks.deleteMany(ownedBlockIds)
        }

        // Phase 3: Persist complete reset payloads, preserving existing identity.
        for (const item of messages) {
          const entry =
            typeof item === 'string' ? { message: { id: item, status: null, blocks: [] }, blocks: [] } : item
          const messageData = wireToMessage(entry.message)
          messageData.topicId = topicId
          const blockDataList = entry.blocks.map(wireToBlock)
          for (const block of blockDataList) block.messageId = messageData.id
          const existing = repos.messages.getInTopic(messageData.id, topicId)
          if (!existing.found) {
            repos.messages.append(messageData)
          } else {
            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.sortOrder
            repos.messages.update(topicId, messageData.id, patch)
          }
          if (blockDataList.length > 0) {
            repos.blocks.upsertMany(blockDataList)
            this.syncFileReferences(repos, blockDataList)
          }
        }

        // Phase 4: Normalize message orders after changes
        repos.messages.replaceOrder(
          topicId,
          repos.messages.listByTopic(topicId).map((m) => m.id)
        )

        return buildFileCleanupResult(repos, affectedFileIds)
      })
    }, `resetMessagesForResend(${topicId}, ${messages.length} msgs)`)
  }

  /**
   * Delete a batch of messages with segment membership cleanup in the
   * same transaction. Segment memberships are removed; empty segments
   * are deleted per existing repository semantics.
   *
   * Ownership enforcement: only messages owned by the request topic are
   * processed. Foreign/missing IDs are silently skipped (consistent with
   * deleteMessages semantics). File refs are collected from owned IDs
   * only, so foreign IDs never appear in the cleanup result.
   *
   * Returns file cleanup facts for blocks whose file_references cascade.
   *
   * Atomicity: one root SQLite transaction.
   */
  deleteMessagesWithSegments(topicId: string, messageIds: string[]): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Phase 1: Filter to owned messages BEFORE collecting refs
        const ownedIds: string[] = []
        for (const id of messageIds) {
          const existing = repos.messages.getInTopic(id, topicId)
          if (existing.found) ownedIds.push(id)
        }

        // Phase 2: Collect affected file IDs from owned messages only
        const refs = repos.fileRefs.listByMessages(ownedIds)
        const affectedFileIds = collectAffectedFileIds(refs)

        // Phase 3: Remove segment memberships for owned messages
        for (const seg of repos.segments.listByTopic(topicId)) {
          const segMsgIds = repos.segments.getMessageIds(seg.id)
          const toRemove = ownedIds.filter((id) => segMsgIds.includes(id))
          if (toRemove.length > 0) {
            repos.segments.removeMessages(seg.id, toRemove)
          }
        }

        // Phase 4: Delete owned messages (FK cascade: blocks → file_references)
        if (ownedIds.length > 0) {
          repos.messages.deleteMany(ownedIds)
        }

        return buildFileCleanupResult(repos, affectedFileIds)
      })
    }, `deleteMessagesWithSegments(${topicId}, ${messageIds.length} msgs)`)
  }

  /**
   * Atomically insert an ordered batch of messages+blocks at a specified
   * position, preserving dense sort order.
   *
   * Each entry is a message with its blocks. Entries are inserted at
   * insertIndex in array order. Existing messages preserve their position.
   *
   * For existing messages that already have blocks, harvests prior file
   * references before syncFileReferences to produce accurate cleanup facts.
   * Insert-only entries return no cleanup (empty arrays).
   *
   * Rejects any existing message ID that is owned by a different topic.
   *
   * Returns file cleanup facts: affectedFileIds (from prior refs on
   * existing blocks that were replaced) and remainingReferenceCounts.
   *
   * Atomicity: one root SQLite transaction.
   */
  pasteMessagesToTopic(
    topicId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>,
    insertIndex?: number
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure topic exists
        repos.topics.ensure(topicId)

        const allAffectedFileIds: string[] = []

        // Compute the starting insert position
        let nextIndex = insertIndex !== undefined ? insertIndex : repos.messages.listByTopic(topicId).length

        for (const entry of entries) {
          const messageData = wireToMessage(entry.message)
          messageData.topicId = topicId
          const blockDataList = entry.blocks.map(wireToBlock)

          // Enforce block ownership
          for (const block of blockDataList) {
            block.messageId = messageData.id
          }

          // Check if message already exists
          const existing = repos.messages.getById(messageData.id)

          if (existing.found) {
            // Reject cross-topic ownership
            if (existing.data.topicId !== topicId) {
              throw new ChatDbConflictError(
                `Message ${messageData.id} belongs to topic ${existing.data.topicId}, ` +
                  `cannot paste into topic ${topicId}`
              )
            }
            // Existing: preserve position, update metadata
            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.sortOrder
            if (Object.keys(patch).length > 0) {
              repos.messages.update(topicId, messageData.id, patch)
            }

            // Harvest prior file references for existing blocks before sync
            for (const block of blockDataList) {
              const priorRefs = repos.fileRefs.listByBlock(block.id)
              const priorFileIds = collectAffectedFileIds(priorRefs)
              allAffectedFileIds.push(...priorFileIds)
            }
          } else {
            // New: insert at position
            repos.messages.insertAt(messageData, nextIndex)
            nextIndex++
          }

          // Upsert blocks + sync file references
          if (blockDataList.length > 0) {
            repos.blocks.upsertMany(blockDataList)
            this.syncFileReferences(repos, blockDataList)
          }
        }

        // Deduplicate affected IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)].sort()
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })
    }, `pasteMessagesToTopic(${topicId}, ${entries.length} entries)`)
  }

  /**
   * Clear all messages, blocks/file_refs, memberships, and segments
   * for a topic atomically. Returns file cleanup facts.
   *
   * This is an enhanced clearMessages that returns structured
   * file cleanup information for caller-side deletion decisions.
   *
   * Atomicity: one root SQLite transaction.
   */
  clearTopicWithSegments(topicId: string): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Check topic exists
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          return { affectedFileIds: [], remainingReferenceCounts: {} }
        }

        // Collect affected file IDs before cascade
        const messages = repos.messages.listByTopic(topicId)
        const messageIds = messages.map((m) => m.id)
        const refs = repos.fileRefs.listByMessages(messageIds)
        const affectedFileIds = collectAffectedFileIds(refs)

        // clearTopic cascades: messages → blocks → file_references,
        // and also deletes topic_segments + topic_segment_messages
        repos.messages.clearTopic(topicId)

        return buildFileCleanupResult(repos, affectedFileIds)
      })
    }, `clearTopicWithSegments(${topicId})`)
  }

  // =========================================================================
  // Phase 5.1B-2: Search
  // =========================================================================

  /**
   * Search message blocks using FTS5 normalized projection with exact
   * regex filtering (LOCK-5125).
   *
   * Returns minimal JSON-safe result data (LOCK-5128).
   * Deleted topics are NOT filtered — matching existing behavior.
   */
  searchMessages(request: SearchMessagesRequest): ChatDbResult<SearchMessagesResponse> {
    return wrapResult(
      () => {
        if (!this.sqlite) {
          throw new Error('Search requires raw SQLite handle')
        }
        const searchRepo = new SearchRepository(this.sqlite)
        return searchRepo.search(request)
      },
      `searchMessages(${request.keywords.substring(0, 50)})`
    )
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
