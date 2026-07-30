import { loggerService } from '@logger'
import { createSelector } from '@reduxjs/toolkit'
import { deleteSingleMessage } from '@renderer/services/ClipboardService'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { appendMessageTrace, pauseTrace, restartTrace } from '@renderer/services/SpanManagerService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import store, { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import { updateOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import {
  appendAssistantResponseThunk,
  clearTopicMessagesThunk,
  cloneMessagesToNewTopicThunk,
  deleteSingleMessageThunk,
  initiateTranslationThunk,
  regenerateAssistantResponseThunk,
  resendMessageThunk,
  resendUserMessageWithEditThunk,
  updateMessageAndBlocksThunk,
  updateTranslationBlockThunk
} from '@renderer/store/thunk/messageThunk'
import { type Assistant, type Model, objectKeys, type Topic, type TranslateLanguageCode } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { abortCompletion } from '@renderer/utils/abortController'
import { estimateMessageBlocksUsage } from '@renderer/utils/messageUtils/usage'
import { difference, throttle } from 'lodash'
import { useCallback } from 'react'

const logger = loggerService.withContext('UseMessageOperations')

const selectMessagesState = (state: RootState) => state.messages

export const selectNewTopicLoading = createSelector(
  [selectMessagesState, (_, topicId: string) => topicId],
  (messagesState, topicId) => messagesState.loadingByTopic[topicId] || false
)

export const selectNewDisplayCount = createSelector(
  [selectMessagesState],
  (messagesState) => messagesState.displayCount
)

/**
 * Hook 提供针对特定主题的消息操作方法。 / Hook providing various operations for messages within a specific topic.
 * @param topic 当前主题对象。 / The current topic object.
 * @returns 包含消息操作函数的对象。 / An object containing message operation functions.
 */
export function useMessageOperations(topic: Topic) {
  const dispatch = useAppDispatch()

  /**
   * 删除单个消息。 / Deletes a single message.
   * Dispatches deleteSingleMessageThunk.
   */
  const deleteMessage = useCallback(
    async (id: string, traceId?: string, modelName?: string) => {
      await dispatch(deleteSingleMessageThunk(topic.id, id))
      void window.api.trace.cleanHistory(topic.id, traceId || '', modelName)
    },
    [dispatch, topic.id]
  )

  /**
   * 编辑消息。 / Edits a message.
   * 使用 newMessagesActions.updateMessage.
   *
   * LOCK-001: Consumes FileCleanupResult exactly once when returned.
   * LOCK-003: Includes file/image attachment usage in the same atomic patch
   * when the caller edits a message with file/image blocks.
   */
  const editMessage = useCallback(
    async (messageId: string, updates: Partial<Omit<Message, 'id' | 'topicId' | 'blocks'>>) => {
      if (!topic?.id) {
        logger.error('[editMessage] Topic prop is not valid.')
        return
      }
      const uiStates = ['multiModelMessageStyle', 'foldSelected'] as const satisfies (keyof Message)[]
      const extraUpdate = difference(objectKeys(updates), uiStates)
      const isUiUpdateOnly = extraUpdate.length === 0
      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: messageId,
        updatedAt: isUiUpdateOnly ? undefined : new Date().toISOString(),
        ...updates
      }

      // LOCK-003: Compute file/image usage for the atomic patch when the
      // message has file/image blocks, so usage is persisted in the same
      // transaction as the text edit — no separate fire-and-forget write.
      if (!isUiUpdateOnly) {
        const state = store.getState()
        const msg = state.messages.entities[messageId]
        if (msg?.blocks && msg.blocks.length > 0) {
          const fileBlocks = msg.blocks
            .map((bid) => state.messageBlocks.entities[bid])
            .filter(
              (b): b is MessageBlock => !!b && (b.type === MessageBlockType.FILE || b.type === MessageBlockType.IMAGE)
            )
          if (fileBlocks.length > 0) {
            const files = fileBlocks
              .map((b) => (b as FileMessageBlock | ImageMessageBlock).file)
              .filter((f) => f !== undefined)
            const mainTextBlock = msg.blocks
              .map((bid) => state.messageBlocks.entities[bid])
              .find((b) => b?.type === MessageBlockType.MAIN_TEXT)
            const content = mainTextBlock?.content || (updates as any).content || ''
            const usage = await estimateUserPromptUsage({ content, files })
            ;(messageUpdates as any).usage = usage
          }
        }
      }

      // Call the thunk with topic.id and only message updates
      const cleanup = await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, []))
      // LOCK-001: Consume FileCleanupResult exactly once at the caller.
      // For block-only upserts (no blockIdsToDelete), the result is empty
      // and consumed trivially.
      await consumeFileCleanupResult(cleanup)
    },
    [dispatch, topic.id]
  )

  /**
   * 重新发送用户消息，触发其所有助手回复的重新生成。 / Resends a user message, triggering regeneration of all its assistant responses.
   * Dispatches resendMessageThunk.
   */
  const resendMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      await restartTrace(message)
      await dispatch(resendMessageThunk(topic.id, message, assistant))
    },
    [dispatch, topic.id]
  )

  /**
   * 清除当前或指定主题的所有消息。 / Clears all messages for the current or specified topic.
   * Dispatches clearTopicMessagesThunk.
   */
  const clearTopicMessages = useCallback(
    async (_topicId?: string) => {
      const topicIdToClear = _topicId || topic.id
      await dispatch(clearTopicMessagesThunk(topicIdToClear))
    },
    [dispatch, topic.id]
  )

  /**
   * 发出事件以表示创建新上下文（清空消息 UI）。 / Emits an event to signal creating a new context (clearing messages UI).
   */
  const createNewContext = useCallback(async () => {
    void EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [])

  const displayCount = useAppSelector(selectNewDisplayCount)

  /**
   * 暂停当前主题正在进行的消息生成。 / Pauses ongoing message generation for the current topic.
   */
  const pauseMessages = useCallback(async () => {
    const state = store.getState()
    const topicMessages = selectMessagesForTopic(state, topic.id)
    if (!topicMessages) return

    const streamingMessages = topicMessages.filter((m) => m.status === 'processing' || m.status === 'pending')
    const askIds = [...new Set(streamingMessages?.map((m) => m.askId).filter((id) => !!id) as string[])]

    for (const askId of askIds) {
      abortCompletion(askId)
    }
    void pauseTrace(topic.id)
    dispatch(newMessagesActions.setTopicLoading({ topicId: topic.id, loading: false }))
  }, [topic.id, dispatch])

  /**
   * 恢复/重发用户消息（目前复用 resendMessage 逻辑）。 / Resumes/Resends a user message (currently reuses resendMessage logic).
   */
  const resumeMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      return resendMessage(message, assistant)
    },
    [resendMessage]
  )

  /**
   * 重新生成指定的助手消息回复。 / Regenerates a specific assistant message response.
   * Dispatches regenerateAssistantResponseThunk.
   */
  const regenerateAssistantMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      await restartTrace(message)
      if (message.role !== 'assistant') {
        logger.warn('regenerateAssistantMessage should only be called for assistant messages.')
        return
      }
      await dispatch(regenerateAssistantResponseThunk(topic.id, message, assistant))
    },
    [dispatch, topic.id]
  )

  /**
   * 使用指定模型追加一个新的助手回复，回复与现有助手消息相同的用户查询。 / Appends a new assistant response using a specified model, replying to the same user query as an existing assistant message.
   * Dispatches appendAssistantResponseThunk.
   */
  const appendAssistantResponse = useCallback(
    async (existingAssistantMessage: Message, newModel: Model, assistant: Assistant) => {
      await appendMessageTrace(existingAssistantMessage, newModel)
      if (existingAssistantMessage.role !== 'assistant') {
        logger.error('appendAssistantResponse should only be called for an existing assistant message.')
        return
      }
      if (!existingAssistantMessage.askId) {
        logger.error('Cannot append response: The existing assistant message is missing its askId.')
        return
      }
      await dispatch(
        appendAssistantResponseThunk(
          topic.id,
          existingAssistantMessage.id,
          newModel,
          assistant,
          existingAssistantMessage.traceId
        )
      )
    },
    [dispatch, topic.id]
  )

  /**
   * 初始化翻译块并返回一个更新函数。 / Initiates a translation block and returns an updater function.
   * @param messageId 要翻译的消息 ID。 / The ID of the message to translate.
   * @param targetLanguage 目标语言代码。 / The target language code.
   * @param sourceBlockId (可选) 源块的 ID。 / (Optional) The ID of the source block.
   * @param sourceLanguage (可选) 源语言代码。 / (Optional) The source language code.
   * @returns 用于更新翻译块的异步函数，如果初始化失败则返回 null。 / An async function to update the translation block, or null if initiation fails.
   */
  const getTranslationUpdater = useCallback(
    async (
      messageId: string,
      targetLanguage: TranslateLanguageCode,
      sourceBlockId?: string,
      sourceLanguage?: TranslateLanguageCode
    ): Promise<((accumulatedText: string, isComplete?: boolean) => void) | null> => {
      if (!topic.id) return null

      const state = store.getState()
      const message = state.messages.entities[messageId]
      if (!message) {
        logger.error(`[getTranslationUpdater] cannot find message: ${messageId}`)
        return null
      }

      let existingTranslationBlockId: string | undefined
      if (message.blocks && message.blocks.length > 0) {
        for (const blockId of message.blocks) {
          const block = state.messageBlocks.entities[blockId]
          if (block && block.type === MessageBlockType.TRANSLATION) {
            existingTranslationBlockId = blockId
            break
          }
        }
      }

      let blockId: string | undefined
      if (existingTranslationBlockId) {
        blockId = existingTranslationBlockId
        const changes: Partial<MessageBlock> = {
          content: '',
          status: MessageBlockStatus.STREAMING,
          metadata: {
            targetLanguage,
            sourceBlockId,
            sourceLanguage
          }
        }
        dispatch(updateOneBlock({ id: blockId, changes }))
        await dispatch(updateTranslationBlockThunk(blockId, '', false))
      } else {
        blockId = await dispatch(
          initiateTranslationThunk(messageId, topic.id, targetLanguage, sourceBlockId, sourceLanguage)
        )
      }

      if (!blockId) {
        logger.error('[getTranslationUpdater] Failed to create translation block.')
        return null
      }

      return throttle(
        (accumulatedText: string, isComplete: boolean = false) => {
          void dispatch(updateTranslationBlockThunk(blockId, accumulatedText, isComplete))
        },
        200,
        { leading: true, trailing: true }
      )
    },
    [dispatch, topic.id]
  )

  /**
   * 创建一个主题分支，克隆消息到新主题。
   * Creates a topic branch by cloning messages to a new topic.
   * @param sourceTopicId 源主题ID / Source topic ID
   * @param branchPointIndex 分支点索引，此索引之前的消息将被克隆 / Branch point index, messages before this index will be cloned
   * @param newTopic 新的主题对象，必须已经创建并添加到Redux store中 / New topic object, must be already created and added to Redux store
   * @returns 操作是否成功 / Whether the operation was successful
   */
  const createTopicBranch = useCallback(
    (sourceTopicId: string, branchPointIndex: number, newTopic: Topic) => {
      logger.info(`Cloning messages from topic ${sourceTopicId} to new topic ${newTopic.id}`)
      return dispatch(cloneMessagesToNewTopicThunk(sourceTopicId, branchPointIndex, newTopic))
    },
    [dispatch]
  )

  /**
   * Updates message blocks by comparing original and edited blocks.
   * Handles adding, updating, and removing blocks in a SINGLE atomic SQLite
   * transaction via updateMessageAndBlocksThunk with blockIdsToDelete.
   *
   * LOCK-001: One atomic persistence before any Redux commit.
   * LOCK-003: Failure propagates — editor remains open, processing resets.
   * LOCK-005: Accepts optional extraMessageUpdates (e.g. usage) to include
   * in the same atomic patch — no separate fire-and-forget write.
   * @param messageId The ID of the message to update
   * @param editedBlocks The complete set of blocks after editing
   * @param extraMessageUpdates Optional additional message fields to patch atomically
   */
  const editMessageBlocks = useCallback(
    async (
      messageId: string,
      editedBlocks: MessageBlock[],
      extraMessageUpdates?: Partial<Message> & Pick<Message, 'id'>,
      onCommit?: (blockIds: readonly string[]) => void
    ) => {
      if (!topic?.id) {
        logger.error('[editMessageBlocks] Topic prop is not valid.')
        return
      }

      // 1. Get the current state of the message and its blocks
      const state = store.getState()
      const message = state.messages.entities[messageId]
      if (!message) {
        logger.error(`[editMessageBlocks] Message not found: ${messageId}`)
        return
      }

      // 2. Get all original blocks
      const originalBlocks = message.blocks
        ? message.blocks.map((blockId) => state.messageBlocks.entities[blockId]).filter((block) => block !== undefined)
        : []

      // 3. Create sets for efficient comparison
      const originalBlockIds = new Set(originalBlocks.map((block) => block.id))
      const editedBlockIds = new Set(editedBlocks.map((block) => block.id))

      // 4. Identify blocks to remove, update, and add
      const blockIdsToRemove = originalBlocks.filter((block) => !editedBlockIds.has(block.id)).map((block) => block.id)

      const blocksToUpdate = editedBlocks
        .filter((block) => originalBlockIds.has(block.id))
        .map((block) => ({
          ...block,
          updatedAt: new Date().toISOString()
        }))

      const blocksToAdd = editedBlocks
        .filter((block) => !originalBlockIds.has(block.id))
        .map((block) => ({
          ...block,
          updatedAt: new Date().toISOString()
        }))

      // 5. Prepare message update with new block IDs (LOCK-002: strip identity/order fields)
      const updatedBlockIds = editedBlocks.map((block) => block.id)
      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: messageId,
        updatedAt: new Date().toISOString(),
        blocks: updatedBlockIds,
        // LOCK-005: Merge caller-supplied extra fields (e.g. usage) into the same patch
        ...(extraMessageUpdates && extraMessageUpdates.id === messageId
          ? Object.fromEntries(
              Object.entries(extraMessageUpdates).filter(([k]) => k !== 'id' && k !== 'topicId' && k !== 'sortOrder')
            )
          : {})
      }

      // 6. ONE atomic SQLite transaction for all operations (LOCK-001)
      // Combines message patch + block upserts (add+update) + block deletions
      // into a single IPC command → single SQLite transaction.
      const allBlocksToPersist = [...blocksToAdd, ...blocksToUpdate]

      if (allBlocksToPersist.length > 0 || blockIdsToRemove.length > 0 || Object.keys(messageUpdates).length > 1) {
        // Dispatch the atomic thunk — on failure, error propagates and Redux is untouched.
        // LOCK-003: Error will be caught by Message.tsx's handleEditSave → MessageEditor resets processing.
        const cleanup = await dispatch(
          updateMessageAndBlocksThunk(topic.id, messageUpdates, allBlocksToPersist, blockIdsToRemove)
        )
        // Notify the editor at the transaction boundary. Later cleanup or resend
        // failures must not retain ownership of files already referenced by SQLite.
        let postCommitError: unknown
        try {
          onCommit?.(editedBlocks.map((block) => block.id))
        } catch (error) {
          postCommitError = error
          logger.error('[editMessageBlocks] Commit notification failed after persistence:', error as Error)
        }

        try {
          // LOCK-001: Consume FileCleanupResult exactly once after successful persistence.
          await consumeFileCleanupResult(cleanup)
        } catch (error) {
          postCommitError ??= error
          logger.error('[editMessageBlocks] Post-commit file cleanup failed:', error as Error)
        }

        if (postCommitError) {
          throw postCommitError
        }
      }
    },
    [dispatch, topic?.id]
  )

  /**
   * Resends a user message after its main text block has been edited.
   * Dispatches resendUserMessageWithEditThunk.
   * LOCK-005: Computes usage from edited blocks and includes it in the same
   * atomic patch via editMessageBlocks extraMessageUpdates — no separate
   * fire-and-forget usage write.
   */
  const resendUserMessageWithEdit = useCallback(
    async (
      message: Message,
      editedBlocks: MessageBlock[],
      assistant: Assistant,
      onCommit?: (blockIds: readonly string[]) => void
    ) => {
      const mainTextBlock = editedBlocks.find((block) => block.type === MessageBlockType.MAIN_TEXT)
      if (!mainTextBlock) {
        logger.error('[resendUserMessageWithEdit] Main text block not found in edited blocks')
        return
      }

      // LOCK-005: Compute usage from edited blocks BEFORE editMessageBlocks
      // so it can be included in the same atomic persistence.
      const usage = await estimateMessageBlocksUsage(editedBlocks)

      // Include usage in the same atomic patch — no separate void editMessage write.
      const extraUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: message.id,
        usage
      }
      await editMessageBlocks(message.id, editedBlocks, extraUpdates, onCommit)

      await restartTrace(message, mainTextBlock.content)

      // LOCK-005: Await resend thunk — rethrow on failure so caller can retry.
      await dispatch(resendUserMessageWithEditThunk(topic.id, message, assistant))
    },
    [dispatch, editMessageBlocks, topic.id]
  )

  /**
   * Removes a specific block from a message.
   * LOCK-001: Consumes FileCleanupResult exactly once after atomic persistence.
   */
  const removeMessageBlock = useCallback(
    async (messageId: string, blockIdToRemove: string) => {
      if (!topic?.id) {
        logger.error('[removeMessageBlock] Topic prop is not valid.')
        return
      }

      const state = store.getState()
      const message = state.messages.entities[messageId]
      if (!message || !message.blocks) {
        logger.error(`[removeMessageBlock] Message not found or has no blocks: ${messageId}`)
        return
      }

      const updatedBlocks = message.blocks.filter((blockId) => blockId !== blockIdToRemove)

      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: messageId,
        updatedAt: new Date().toISOString(),
        blocks: updatedBlocks
      }

      // LOCK-001: Pass blockIdsToDelete so the block is removed from SQLite
      // in the same atomic transaction as the message patch.
      const cleanup = await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, [], [blockIdToRemove]))
      // LOCK-001: Consume FileCleanupResult exactly once at the caller.
      await consumeFileCleanupResult(cleanup)
    },
    [dispatch, topic?.id]
  )

  /**
   * 删除消息并支持撤销操作。
   * Deletes a single message with undo support via ClipboardService.
   */
  const deleteMessageWithUndo = useCallback(
    async (message: Message) => {
      await deleteSingleMessage(dispatch, store.getState, topic.id, message)
    },
    [dispatch, topic.id]
  )

  return {
    displayCount,
    deleteMessage,
    deleteMessageWithUndo,
    editMessage,
    resendMessage,
    regenerateAssistantMessage,
    resendUserMessageWithEdit,
    appendAssistantResponse,
    createNewContext,
    clearTopicMessages,
    pauseMessages,
    resumeMessage,
    getTranslationUpdater,
    createTopicBranch,
    editMessageBlocks,
    removeMessageBlock
  }
}

export const useTopicMessages = (topicId: string) => {
  return useAppSelector((state) => selectMessagesForTopic(state, topicId))
}

export const useTopicLoading = (topic: Topic) => {
  return useAppSelector((state) => selectNewTopicLoading(state, topic.id))
}
