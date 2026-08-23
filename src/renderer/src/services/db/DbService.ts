import db from '@renderer/databases'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type {
  FetchAnswerGroupResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FileCleanupResult,
  MessageBlockEntry,
  StreamWriteDiagnostics
} from '@shared/chatDb'

import { fileLock } from '../FileLock'
import type { SendDiagnosticsContext } from './sendTimingDiagnostics'
import { SqliteMessageDataSource } from './SqliteMessageDataSource'
import type { MessageDataSource } from './types'

interface FileCountSource {
  updateFileCount(fileId: string, delta: number, deleteIfZero?: boolean): Promise<void>
  updateFileCounts(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void>
}

/**
 * LOCK-001: fileCountSource routes every read-modify-write through fileLock
 * so that concurrent delete/orphan/add operations on the same file ID are
 * serialized. updateFileCounts delegates per-ID safely.
 */
const fileCountSource: FileCountSource = {
  async updateFileCount(fileId, delta, deleteIfZero = false) {
    await fileLock.run(fileId, async () => {
      await db.transaction('rw', db.files, async () => {
        const file = await db.files.get(fileId)
        if (!file) return
        const count = Math.max(0, file.count + delta)
        if (deleteIfZero && count === 0) await db.files.delete(fileId)
        else await db.files.update(fileId, { count })
      })
    })
  },
  async updateFileCounts(files) {
    for (const file of files) await this.updateFileCount(file.id, file.delta, file.deleteIfZero)
  }
}

class DbService implements MessageDataSource {
  private static instance: DbService
  private readonly ordinarySource = new SqliteMessageDataSource()

  static getInstance(): DbService {
    if (!DbService.instance) DbService.instance = new DbService()
    return DbService.instance
  }

  fetchMessages(topicId: string, forceReload?: boolean) {
    return this.ordinarySource.fetchMessages(topicId, forceReload)
  }
  fetchMessagesWindow(request: FetchMessagesWindowRequest): Promise<FetchMessagesWindowResponse> {
    if (!this.ordinarySource.fetchMessagesWindow) throw new Error('fetchMessagesWindow unavailable')
    return this.ordinarySource.fetchMessagesWindow(request)
  }
  fetchAnswerGroup(topicId: string, anchorMessageId: string): Promise<FetchAnswerGroupResponse> {
    if (!this.ordinarySource.fetchAnswerGroup) throw new Error('fetchAnswerGroup unavailable')
    return this.ordinarySource.fetchAnswerGroup(topicId, anchorMessageId)
  }
  getRawTopic(topicId: string) {
    return this.ordinarySource.getRawTopic(topicId)
  }
  appendMessage(
    topicId: string,
    message: Message,
    blocks: MessageBlock[],
    insertIndex?: number,
    sendContext?: SendDiagnosticsContext
  ) {
    return this.ordinarySource.appendMessage(topicId, message, blocks, insertIndex, sendContext)
  }
  updateMessage(topicId: string, messageId: string, updates: Partial<Message>) {
    return this.ordinarySource.updateMessage(topicId, messageId, updates)
  }
  updateMessageAndBlocks(
    topicId: string,
    updates: Partial<Message> & Pick<Message, 'id'>,
    blocks: MessageBlock[],
    blockIdsToDelete: string[] = []
  ): Promise<FileCleanupResult> {
    return this.ordinarySource.updateMessageAndBlocks(topicId, updates, blocks, blockIdsToDelete)
  }
  selectAnswerMessage(topicId: string, selectedMessageId: string, messageIds: string[]): Promise<void> {
    return this.ordinarySource.selectAnswerMessage(topicId, selectedMessageId, messageIds)
  }
  deleteMessage(topicId: string, messageId: string) {
    return this.ordinarySource.deleteMessage(topicId, messageId)
  }
  deleteMessages(topicId: string, messageIds: string[]) {
    return this.ordinarySource.deleteMessages(topicId, messageIds)
  }
  pasteMessagesToTopic(topicId: string, entries: MessageBlockEntry[], insertIndex?: number) {
    return this.ordinarySource.pasteMessagesToTopic(topicId, entries, insertIndex)
  }
  topicExists(topicId: string) {
    return this.ordinarySource.topicExists(topicId)
  }
  ensureTopic(topicId: string, assistantId?: string, name?: string | null) {
    return this.ordinarySource.ensureTopic(topicId, assistantId, name)
  }

  updateBlocks(blocks: MessageBlock[], streamDiag?: StreamWriteDiagnostics): Promise<void> {
    return this.ordinarySource.updateBlocks(blocks, streamDiag)
  }

  updateSingleBlock(blockId: string, updates: Partial<MessageBlock>, streamDiag?: StreamWriteDiagnostics) {
    return this.ordinarySource.updateSingleBlock(blockId, updates, streamDiag)
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
  softDeleteTopic(topicId: string, name?: string | null) {
    return this.ordinarySource.softDeleteTopic(topicId, name)
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
  branchMessagesToTopic(sourceTopicId: string, targetTopicId: string, anchorMessageId: string, assistantId?: string) {
    if (!this.ordinarySource.branchMessagesToTopic) throw new Error('branchMessagesToTopic unavailable')
    return this.ordinarySource.branchMessagesToTopic(sourceTopicId, targetTopicId, anchorMessageId, assistantId)
  }
  insertMessagesAfterAnchor(topicId: string, afterMessageId: string, entries: MessageBlockEntry[]) {
    if (!this.ordinarySource.insertMessagesAfterAnchor) throw new Error('insertMessagesAfterAnchor unavailable')
    return this.ordinarySource.insertMessagesAfterAnchor(topicId, afterMessageId, entries)
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
}

export const dbService = DbService.getInstance()
export { DbService }
