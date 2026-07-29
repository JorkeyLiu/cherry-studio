import { loggerService } from '@logger'
import db from '@renderer/databases'
import store from '@renderer/store'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { FileCleanupResult } from '@shared/chatDb'

import { AgentMessageDataSource } from './AgentMessageDataSource'
import { SqliteMessageDataSource } from './SqliteMessageDataSource'
import type { MessageDataSource } from './types'
import { buildAgentSessionTopicId, isAgentSessionTopicId } from './types'

const logger = loggerService.withContext('DbService')

export type DbSourceType = 'sqlite' | 'agent'

interface FileCountSource {
  updateFileCount(fileId: string, delta: number, deleteIfZero?: boolean): Promise<void>
  updateFileCounts(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void>
}

const fileCountSource: FileCountSource = {
  async updateFileCount(fileId, delta, deleteIfZero = false) {
    await db.transaction('rw', db.files, async () => {
      const file = await db.files.get(fileId)
      if (!file) return
      const count = Math.max(0, file.count + delta)
      if (deleteIfZero && count === 0) await db.files.delete(fileId)
      else await db.files.update(fileId, { count })
    })
  },
  async updateFileCounts(files) {
    for (const file of files) await this.updateFileCount(file.id, file.delta, file.deleteIfZero)
  }
}

class DbService implements MessageDataSource {
  private static instance: DbService
  private readonly ordinarySource = new SqliteMessageDataSource()
  private readonly agentSource = new AgentMessageDataSource()

  static getInstance(): DbService {
    if (!DbService.instance) DbService.instance = new DbService()
    return DbService.instance
  }

  private source(topicId: string): MessageDataSource {
    if (isAgentSessionTopicId(topicId)) {
      logger.silly(`Using AgentMessageDataSource for topic ${topicId}`)
      return this.agentSource
    }
    return this.ordinarySource
  }

  private resolveMessageTopicId(messageId: string): string | undefined {
    const message = store.getState().messages.entities[messageId]
    if (message) return message.topicId
    const agentInfo = this.agentSource.getStreamingCacheInfo(messageId)
    return agentInfo ? buildAgentSessionTopicId(agentInfo.sessionId) : undefined
  }

  fetchMessages(topicId: string, forceReload?: boolean) {
    return this.source(topicId).fetchMessages(topicId, forceReload)
  }
  getRawTopic(topicId: string) {
    return this.source(topicId).getRawTopic(topicId)
  }
  appendMessage(topicId: string, message: Message, blocks: MessageBlock[], insertIndex?: number) {
    return this.source(topicId).appendMessage(topicId, message, blocks, insertIndex)
  }
  updateMessage(topicId: string, messageId: string, updates: Partial<Message>) {
    return this.source(topicId).updateMessage(topicId, messageId, updates)
  }
  updateMessageAndBlocks(
    topicId: string,
    updates: Partial<Message> & Pick<Message, 'id'>,
    blocks: MessageBlock[],
    blockIdsToDelete: string[] = []
  ): Promise<FileCleanupResult> {
    return this.source(topicId).updateMessageAndBlocks(topicId, updates, blocks, blockIdsToDelete)
  }
  deleteMessage(topicId: string, messageId: string) {
    return this.source(topicId).deleteMessage(topicId, messageId)
  }
  deleteMessages(topicId: string, messageIds: string[]) {
    return this.source(topicId).deleteMessages(topicId, messageIds)
  }
  clearMessages(topicId: string) {
    return this.source(topicId).clearMessages(topicId)
  }
  topicExists(topicId: string) {
    return this.source(topicId).topicExists(topicId)
  }
  ensureTopic(topicId: string, assistantId?: string) {
    return this.ordinarySource.ensureTopic(topicId, assistantId)
  }

  async updateBlocks(blocks: MessageBlock[]): Promise<void> {
    const agentBlocks: MessageBlock[] = []
    const ordinaryBlocks: MessageBlock[] = []
    for (const block of blocks) {
      const topicId = this.resolveMessageTopicId(block.messageId)
      if (topicId && isAgentSessionTopicId(topicId)) agentBlocks.push(block)
      else ordinaryBlocks.push(block)
    }
    if (agentBlocks.length) await this.agentSource.updateBlocks(agentBlocks)
    if (ordinaryBlocks.length) await this.ordinarySource.updateBlocks(ordinaryBlocks)
  }

  updateSingleBlock(blockId: string, updates: Partial<MessageBlock>) {
    const block = store.getState().messageBlocks.entities[blockId]
    const topicId = block ? this.resolveMessageTopicId(block.messageId) : undefined
    return topicId && isAgentSessionTopicId(topicId)
      ? this.agentSource.updateSingleBlock(blockId, updates)
      : this.ordinarySource.updateSingleBlock(blockId, updates)
  }
  bulkAddBlocks(blocks: MessageBlock[]) {
    return this.ordinarySource.bulkAddBlocks(blocks)
  }
  deleteBlocks(blockIds: string[]) {
    return this.ordinarySource.deleteBlocks(blockIds)
  }
  updateTopicMetadata(
    topicId: string,
    name?: string | null,
    pinned?: boolean | null,
    prompt?: string | null,
    isNameManuallyEdited?: boolean | null
  ) {
    return this.ordinarySource.updateTopicMetadata(topicId, name, pinned, prompt, isNameManuallyEdited)
  }
  softDeleteTopic(topicId: string) {
    return this.ordinarySource.softDeleteTopic(topicId)
  }
  restoreTopic(topicId: string) {
    return this.ordinarySource.restoreTopic(topicId)
  }
  listTrashTopics(assistantId?: string, limit?: number, cursor?: string) {
    return this.ordinarySource.listTrashTopics(assistantId, limit, cursor)
  }
  hardDeleteTopic(topicId: string) {
    return this.ordinarySource.hardDeleteTopic(topicId)
  }
  clearTopicWithSegments(topicId: string) {
    return this.ordinarySource.clearTopicWithSegments(topicId)
  }
  transferTopicOwnership(topicId: string, assistantId: string) {
    return this.ordinarySource.transferTopicOwnership(topicId, assistantId)
  }
  resetAssistantTopics(assistantId: string, replacementTopicId: string) {
    return this.ordinarySource.resetAssistantTopics(assistantId, replacementTopicId)
  }
  listSegments(topicId: string) {
    return this.ordinarySource.listSegments(topicId)
  }
  upsertSegment(
    segmentId: string,
    topicId: string,
    name: string | null | undefined,
    messageIds: string[],
    color?: string | null
  ) {
    return this.ordinarySource.upsertSegment(segmentId, topicId, name, messageIds, color)
  }
  deleteSegment(segmentId: string) {
    return this.ordinarySource.deleteSegment(segmentId)
  }
  replaceSegmentMembership(segmentId: string, messageIds: string[]) {
    return this.ordinarySource.replaceSegmentMembership(segmentId, messageIds)
  }
  reorderMessages(topicId: string, messageIds: string[]) {
    return this.ordinarySource.reorderMessages(topicId, messageIds)
  }
  listBlocksByFile(fileId: string) {
    return this.ordinarySource.listBlocksByFile(fileId)
  }
  listFileRefsByFile(fileId: string) {
    return this.ordinarySource.listFileRefsByFile(fileId)
  }
  countFileRefsByFile(fileId: string) {
    return this.ordinarySource.countFileRefsByFile(fileId)
  }
  updateSegmentMetadata(segmentId: string, name?: string | null, color?: string | null) {
    return this.ordinarySource.updateSegmentMetadata(segmentId, name, color)
  }
  cloneMessagesToTopic(targetTopicId: string, entries: Array<{ message: any; blocks: any[] }>, assistantId?: string) {
    return this.ordinarySource.cloneMessagesToTopic(targetTopicId, entries, assistantId)
  }
  resetMessagesForResend(
    topicId: string,
    messages: Array<{ message: any; blocks: any[] }>,
    blockIdsToDelete: string[]
  ) {
    return this.ordinarySource.resetMessagesForResend(topicId, messages, blockIdsToDelete)
  }
  deleteMessagesWithSegments(topicId: string, messageIds: string[]) {
    return this.ordinarySource.deleteMessagesWithSegments(topicId, messageIds)
  }
  updateFileCount(fileId: string, delta: number, deleteIfZero = false) {
    return fileCountSource.updateFileCount(fileId, delta, deleteIfZero)
  }
  updateFileCounts(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>) {
    return fileCountSource.updateFileCounts(files)
  }
  isAgentSession(topicId: string) {
    return isAgentSessionTopicId(topicId)
  }
  getSourceType(topicId: string): DbSourceType {
    return isAgentSessionTopicId(topicId) ? 'agent' : 'sqlite'
  }
}

export const dbService = DbService.getInstance()
export { DbService }
