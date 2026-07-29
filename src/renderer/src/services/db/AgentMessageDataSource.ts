/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import store from '@renderer/store'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { FileCleanupResult } from '@shared/chatDb'

import type { MessageDataSource } from './types'
import { extractSessionId } from './types'

const logger = loggerService.withContext('AgentMessageDataSource')

/**
 * IPC-based implementation of MessageDataSource
 * Handles agent session messages through backend communication
 */
export class AgentMessageDataSource implements MessageDataSource {
  // ============ Read Operations ============

  async fetchMessages(topicId: string): Promise<{
    messages: Message[]
    blocks: MessageBlock[]
  }> {
    logger.warn(`fetchMessages: agent IPC removed, returning empty for ${topicId}`)
    return { messages: [], blocks: [] }
  }

  // ============ Write Operations ============
  // oxlint-disable-next-line no-unused-vars
  async appendMessage(
    topicId: string,
    _message: Message,
    _blocks: MessageBlock[],
    _insertIndex?: number
  ): Promise<void> {
    logger.warn(`appendMessage: agent IPC removed, skipping for ${topicId}`)
  }

  // oxlint-disable-next-line no-unused-vars
  async updateMessage(topicId: string, messageId: string, _updates: Partial<Message>): Promise<void> {
    logger.warn(`updateMessage: agent IPC removed, skipping for ${topicId}/${messageId}`)
  }

  // oxlint-disable-next-line no-unused-vars
  async updateMessageAndBlocks(
    topicId: string,
    messageUpdates: Partial<Message> & Pick<Message, 'id'>,
    _blocksToUpdate: MessageBlock[],
    _blockIdsToDelete?: string[]
  ): Promise<FileCleanupResult> {
    logger.warn(`updateMessageAndBlocks: agent IPC removed, skipping for ${topicId}/${messageUpdates.id}`)
    return { affectedFileIds: [], remainingReferenceCounts: {} }
  }

  // oxlint-disable-next-line no-unused-vars
  async deleteMessage(topicId: string, _messageId: string): Promise<void> {
    // Agent session messages cannot be deleted individually
    logger.warn(`deleteMessage called for agent session ${topicId}, operation not supported`)

    // In a full implementation, you might want to:
    // 1. Implement soft delete in backend
    // 2. Or just hide from UI without actual deletion
  }

  // oxlint-disable-next-line no-unused-vars
  async deleteMessages(topicId: string, _messageIds: string[]): Promise<void> {
    // Agent session messages cannot be deleted in batch
    logger.warn(`deleteMessages called for agent session ${topicId}, operation not supported`)

    // In a full implementation, you might want to:
    // 1. Implement batch soft delete in backend
    // 2. Update local state accordingly
  }

  // oxlint-disable-next-line no-unused-vars
  async deleteMessagesByAskId(topicId: string, _askId: string): Promise<void> {
    // Agent session messages cannot be deleted
    logger.warn(`deleteMessagesByAskId called for agent session ${topicId}, operation not supported`)
  }

  // ============ Block Operations ============

  // oxlint-disable-next-line no-unused-vars
  async updateBlocks(blocks: MessageBlock[]): Promise<void> {
    logger.warn(`updateBlocks: agent IPC removed, skipping for ${blocks.length} blocks`)
  }

  // oxlint-disable-next-line no-unused-vars
  async deleteBlocks(_blockIds: string[]): Promise<FileCleanupResult> {
    // Blocks cannot be deleted individually for agent sessions
    logger.warn('deleteBlocks called for agent session, operation not supported')
    return { affectedFileIds: [], remainingReferenceCounts: {} }
  }

  // ============ Batch Operations ============

  async clearMessages(topicId: string): Promise<FileCleanupResult> {
    const sessionId = extractSessionId(topicId)

    if (!window.electron?.ipcRenderer) {
      logger.warn('IPC renderer not available for clear messages')
      return { affectedFileIds: [], remainingReferenceCounts: {} }
    }

    // In a full implementation, you would call a backend endpoint to clear session
    // For now, we'll just log the attempt
    logger.info(`Clear messages requested for agent session ${sessionId}`)
    return { affectedFileIds: [], remainingReferenceCounts: {} }

    // You might want to implement:
    // await window.electron.ipcRenderer.invoke(
    //   IpcChannel.AgentMessage_ClearSession,
    //   { sessionId }
    // )
  }

  async topicExists(topicId: string): Promise<boolean> {
    try {
      const sessionId = extractSessionId(topicId)

      if (!window.electron?.ipcRenderer) {
        return false
      }
      return sessionId != null
    } catch (error) {
      return false
    }
  }

  async ensureTopic(topicId: string): Promise<void> {
    // Agent sessions are created externally, not by the chat interface
    // This is a no-op for agent sessions
    const sessionId = extractSessionId(topicId)
    logger.info(`ensureTopic called for agent session ${sessionId}, no action needed`)
  }

  async getRawTopic(topicId: string): Promise<{ id: string; messages: Message[] } | undefined> {
    try {
      // For agent sessions, fetch messages from backend and return in raw topic format
      const { messages } = await this.fetchMessages(topicId)
      return {
        id: topicId,
        messages
      }
    } catch (error) {
      logger.error(`Failed to get raw topic for agent session ${topicId}:`, error as Error)
      return undefined
    }
  }

  // ============ Additional Methods for Interface Compatibility ============

  async updateSingleBlock(blockId: string, updates: Partial<MessageBlock>): Promise<void> {
    const state = store.getState()
    const existingBlock = state.messageBlocks.entities[blockId]

    if (!existingBlock) {
      logger.warn(`Block ${blockId} not found in store for updateSingleBlock`)
      return
    }

    const mergedBlock = { ...existingBlock, ...updates } as MessageBlock
    await this.updateBlocks([mergedBlock])
  }

  /**
   * Get streaming cache info for a message ID if available.
   * Stub implementation — agent IPC removed.
   */
  getStreamingCacheInfo(_messageId: string): { sessionId: string; message?: Message } | undefined {
    return undefined
  }

  // oxlint-disable-next-line no-unused-vars
  async bulkAddBlocks(_blocks: MessageBlock[]): Promise<void> {
    // Agent session blocks are added through persistExchange
    logger.warn(`bulkAddBlocks called for agent session, operation not supported individually`)
  }

  // oxlint-disable-next-line no-unused-vars
  async updateFileCount(fileId: string, _delta: number, _deleteIfZero?: boolean): Promise<void> {
    // Agent sessions don't manage file reference counts locally
    logger.warn(`updateFileCount called for agent session file ${fileId}, operation not supported`)
  }

  // oxlint-disable-next-line no-unused-vars
  async updateFileCounts(_files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void> {
    // Agent sessions don't manage file reference counts locally
    logger.warn(`updateFileCounts called for agent session, operation not supported`)
  }
}
