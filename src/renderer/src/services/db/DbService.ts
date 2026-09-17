import db from '@renderer/databases'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type {
  DeleteMessagesWithDependentsResponse,
  FetchAnswerGroupResponse,
  FetchClipboardGroupsRequest,
  FetchClipboardGroupsResponse,
  FetchContextClosureRequest,
  FetchContextClosureResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FetchTopicActivityResponse,
  FetchTopicNamingContextResponse,
  FetchWholeTopicSnapshotResponse,
  FileCleanupResult,
  InsertMessageGroup,
  MessageBlockEntry,
  RegenerateAssistantMessageRequest,
  ReorderAnswerGroupResponse,
  ResendUserMessagesRequest,
  ResetMessagesForResendResponse,
  ResolveContextClosureRequest,
  ResolveContextClosureResult,
  SelectAnswerMessageResponse,
  SemanticResendResponse,
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
  private _ordinarySource: SqliteMessageDataSource | null = null
  private get ordinarySource(): SqliteMessageDataSource {
    if (!this._ordinarySource) this._ordinarySource = new SqliteMessageDataSource()
    return this._ordinarySource
  }

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
  fetchContextClosure(request: FetchContextClosureRequest): Promise<FetchContextClosureResponse> {
    if (!this.ordinarySource.fetchContextClosure) throw new Error('fetchContextClosure unavailable')
    return this.ordinarySource.fetchContextClosure(request)
  }
  resolveContextClosure(request: ResolveContextClosureRequest): Promise<ResolveContextClosureResult> {
    if (!this.ordinarySource.resolveContextClosure) throw new Error('resolveContextClosure unavailable')
    return this.ordinarySource.resolveContextClosure(request)
  }
  fetchWholeTopicSnapshot(topicId: string): Promise<{
    messages: Message[]
    blocks: MessageBlock[]
    snapshot: FetchWholeTopicSnapshotResponse['snapshot']
  }> {
    if (!this.ordinarySource.fetchWholeTopicSnapshot) throw new Error('fetchWholeTopicSnapshot unavailable')
    return this.ordinarySource.fetchWholeTopicSnapshot(topicId)
  }
  fetchClipboardGroups(request: FetchClipboardGroupsRequest): Promise<FetchClipboardGroupsResponse> {
    if (!this.ordinarySource.fetchClipboardGroups) throw new Error('fetchClipboardGroups unavailable')
    return this.ordinarySource.fetchClipboardGroups(request)
  }
  fetchTopicNamingContext(topicId: string): Promise<{
    topic: FetchTopicNamingContextResponse['topic']
    messageCount: number
    firstMessage: Message | null
    latestMessages: Message[]
    blocks: MessageBlock[]
    naming: FetchTopicNamingContextResponse['naming']
  }> {
    if (!this.ordinarySource.fetchTopicNamingContext) throw new Error('fetchTopicNamingContext unavailable')
    return this.ordinarySource.fetchTopicNamingContext(topicId)
  }
  fetchTopicActivity(topicId: string): Promise<FetchTopicActivityResponse> {
    if (!this.ordinarySource.fetchTopicActivity) throw new Error('fetchTopicActivity unavailable')
    return this.ordinarySource.fetchTopicActivity(topicId)
  }
  getRawTopic(topicId: string) {
    return this.ordinarySource.getRawTopic(topicId)
  }
  appendMessage(
    topicId: string,
    message: Message,
    blocks: MessageBlock[],
    insertIndex?: number,
    sendContext?: SendDiagnosticsContext,
    resendAttemptId?: string
  ) {
    return this.ordinarySource.appendMessage(topicId, message, blocks, insertIndex, sendContext, resendAttemptId)
  }
  updateMessage(topicId: string, messageId: string, updates: Partial<Message>, resendAttemptId?: string) {
    return this.ordinarySource.updateMessage(topicId, messageId, updates, resendAttemptId)
  }
  updateMessageAndBlocks(
    topicId: string,
    updates: Partial<Message> & Pick<Message, 'id'>,
    blocks: MessageBlock[],
    blockIdsToDelete: string[] = [],
    resendAttemptId?: string
  ): Promise<FileCleanupResult> {
    return this.ordinarySource.updateMessageAndBlocks(topicId, updates, blocks, blockIdsToDelete, resendAttemptId)
  }
  selectAnswerMessage(topicId: string, selectedMessageId: string): Promise<SelectAnswerMessageResponse> {
    return this.ordinarySource.selectAnswerMessage(topicId, selectedMessageId)
  }
  deleteMessagesWithDependents(topicId: string, messageIds: string[]): Promise<DeleteMessagesWithDependentsResponse> {
    if (!this.ordinarySource.deleteMessagesWithDependents) throw new Error('deleteMessagesWithDependents unavailable')
    return this.ordinarySource.deleteMessagesWithDependents(topicId, messageIds)
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

  updateBlocks(blocks: MessageBlock[], streamDiag?: StreamWriteDiagnostics, resendAttemptId?: string): Promise<void> {
    return this.ordinarySource.updateBlocks(blocks, streamDiag, resendAttemptId)
  }

  updateSingleBlock(
    blockId: string,
    updates: Partial<MessageBlock>,
    streamDiag?: StreamWriteDiagnostics,
    resendAttemptId?: string
  ) {
    return this.ordinarySource.updateSingleBlock(blockId, updates, streamDiag, resendAttemptId)
  }
  bulkAddBlocks(blocks: MessageBlock[], resendAttemptId?: string) {
    return this.ordinarySource.bulkAddBlocks(blocks, resendAttemptId)
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
  reorderAnswerGroup(
    topicId: string,
    anchorMessageId: string,
    orderedMessageIds: string[]
  ): Promise<ReorderAnswerGroupResponse> {
    return this.ordinarySource.reorderAnswerGroup(topicId, anchorMessageId, orderedMessageIds)
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
  insertMessageGroups(topicId: string, groups: InsertMessageGroup[]) {
    if (!this.ordinarySource.insertMessageGroups) throw new Error('insertMessageGroups unavailable')
    return this.ordinarySource.insertMessageGroups(topicId, groups)
  }

  resetMessagesForResend(
    topicId: string,
    messages: Array<{ message: any; blocks: any[] }>,
    blockIdsToDelete: string[]
  ): Promise<ResetMessagesForResendResponse> {
    return this.ordinarySource.resetMessagesForResend(topicId, messages, blockIdsToDelete)
  }
  resendUserMessages(request: ResendUserMessagesRequest): Promise<SemanticResendResponse> {
    if (!this.ordinarySource.resendUserMessages) throw new Error('resendUserMessages unavailable')
    return this.ordinarySource.resendUserMessages(request)
  }
  regenerateAssistantMessage(request: RegenerateAssistantMessageRequest): Promise<SemanticResendResponse> {
    if (!this.ordinarySource.regenerateAssistantMessage) throw new Error('regenerateAssistantMessage unavailable')
    return this.ordinarySource.regenerateAssistantMessage(request)
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
