import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { FileCleanupResult, MessageBlockEntry } from '@shared/chatDb'

import type { SendDiagnosticsContext } from './sendTimingDiagnostics'

/**
 * Message exchange data structure for persisting user-assistant conversations
 */
export interface MessageExchange {
  user?: {
    message: Message
    blocks: MessageBlock[]
  }
  assistant?: {
    message: Message
    blocks: MessageBlock[]
  }
}

/**
 * Unified interface for message data operations
 * Implementations can be backed by Dexie, IPC, or other storage mechanisms
 */
export interface MessageDataSource {
  // ============ Read Operations ============
  /**
   * Fetch all messages and blocks for a topic
   */
  fetchMessages(
    topicId: string,
    forceReload?: boolean
  ): Promise<{
    messages: Message[]
    blocks: MessageBlock[]
  }>

  /**
   * Get raw topic data (just id and messages)
   */
  getRawTopic(topicId: string): Promise<{ id: string; messages: Message[] } | undefined>

  // ============ Write Operations ============
  /**
   * Append a single message with its blocks.
   *
   * `sendContext` is optional diagnostic-only correlation metadata (LOCK-004):
   * when supplied by the ordinary send path, the append consumes the next
   * ordinal from that send's own context. It never affects persistence.
   */
  appendMessage(
    topicId: string,
    message: Message,
    blocks: MessageBlock[],
    insertIndex?: number,
    sendContext?: SendDiagnosticsContext
  ): Promise<void>

  /**
   * Update an existing message
   */
  updateMessage(topicId: string, messageId: string, updates: Partial<Message>): Promise<void>

  /**
   * Update existing message and its blocks.
   * Returns FileCleanupResult when blocks are deleted, for post-commit
   * consumption by the caller.
   */
  updateMessageAndBlocks(
    topicId: string,
    messageUpdates: Partial<Message> & Pick<Message, 'id'>,
    blocksToUpdate: MessageBlock[],
    blockIdsToDelete?: string[]
  ): Promise<FileCleanupResult>

  /**
   * PERF-100: switch the selected answer within one multi-model answer group.
   *
   * ONE Main SQLite transaction validates that every supplied `messageIds`
   * belongs to the topic (missing/cross-topic rejects the whole operation,
   * no partial write), then persists `foldSelected=true` for
   * `selectedMessageId` and `foldSelected=false` for every other supplied
   * ID — exactly one selected message among the group, atomically.
   *
   * The caller supplies the FULL answer-group IDs; group coherence is the
   * caller's responsibility. Dispatches `updateTopicUpdatedAt` exactly once
   * after a successful selection (the thunk must NOT dispatch it again).
   */
  selectAnswerMessage(topicId: string, selectedMessageId: string, messageIds: string[]): Promise<void>

  /**
   * Delete a single message and its blocks
   */
  deleteMessage(topicId: string, messageId: string): Promise<void>

  /**
   * Delete multiple messages and their blocks
   */
  deleteMessages(topicId: string, messageIds: string[]): Promise<void>

  /**
   * Atomically insert an ordered batch of message+block entries at a
   * position in one Main SQLite transaction (PERF-100 batch paste).
   *
   * Entries are inserted at `insertIndex` (zero-based; absent = append at
   * end) in array order. Existing messages keep their position and only
   * receive a metadata patch. Returns the aggregate FileCleanupResult.
   */
  pasteMessagesToTopic(topicId: string, entries: MessageBlockEntry[], insertIndex?: number): Promise<FileCleanupResult>

  // ============ Block Operations ============
  /**
   * Update multiple blocks
   */
  updateBlocks(blocks: MessageBlock[]): Promise<void>

  /**
   * Update single block
   */
  updateSingleBlock?(blockId: string, updates: Partial<MessageBlock>): Promise<void>

  /**
   * Bulk add blocks (for cloning operations)
   */
  bulkAddBlocks?(blocks: MessageBlock[]): Promise<void>

  /**
   * Delete multiple blocks
   */
  deleteBlocks(blockIds: string[]): Promise<FileCleanupResult>

  // ============ Batch Operations ============
  /**
   * Check if topic exists
   */
  topicExists(topicId: string): Promise<boolean>

  /**
   * Create or ensure topic exists
   */
  ensureTopic(topicId: string, assistantId?: string, name?: string | null): Promise<void>

  // ============ File Operations (Optional) ============

  /**
   * Update file reference count
   * @param fileId - The file ID to update
   * @param delta - The change in reference count (positive or negative)
   * @param deleteIfZero - Whether to delete the file when count reaches 0
   */
  updateFileCount?(fileId: string, delta: number, deleteIfZero?: boolean): Promise<void>

  /**
   * Update multiple file reference counts
   */
  updateFileCounts?(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void>
}
