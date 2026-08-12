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
import { AiSdkToChunkAdapter } from '@renderer/aiCore/chunk/AiSdkToChunkAdapter'
import { getModel } from '@renderer/hooks/useModel'
import { buildGroupList, transferAnchorsAfterDeletion } from '@renderer/services/anchorService'
import { transformMessagesAndFetch } from '@renderer/services/ApiService'
import { dbService } from '@renderer/services/db'
import { createSendDiagnosticsContext, type SendDiagnosticsContext } from '@renderer/services/db/sendTimingDiagnostics'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { endSpan } from '@renderer/services/SpanManagerService'
import { createStreamProcessor, type StreamProcessorCallbacks } from '@renderer/services/StreamProcessingService'
import store from '@renderer/store'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import { type Assistant, type FileMetadata, type Model, type Topic } from '@renderer/types'
import { ChunkType } from '@renderer/types/chunk'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import {
  AssistantMessageStatus,
  MessageBlockStatus,
  MessageBlockType,
  UserMessageStatus
} from '@renderer/types/newMessage'
import { uuid } from '@renderer/utils'
import { addAbortController } from '@renderer/utils/abortController'
import {
  createAssistantMessage,
  createTranslationBlock,
  resetAssistantMessage
} from '@renderer/utils/messageUtils/create'
import { getTopicQueue, waitForTopicQueue } from '@renderer/utils/queue'
import type { FileCleanupResult } from '@shared/chatDb'
import { defaultAppHeaders } from '@shared/utils'
import type { TextStreamPart } from 'ai'
import { t } from 'i18next'
import { throttle } from 'lodash'
import { LRUCache } from 'lru-cache'

import type { AppDispatch, RootState } from '../index'
import { removeManyBlocks, updateOneBlock, upsertManyBlocks, upsertOneBlock } from '../messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '../newMessage'
import { loadTopicSegmentsThunk } from './topicSegmentThunk'
// import {
//   bulkAddBlocksV2,
//   deleteMessageFromDBV2,
//   deleteMessagesFromDBV2,
//   loadTopicMessagesThunkV2,
//   saveMessageAndBlocksToDBV2,
//   updateBlocksV2,
//   updateFileCountV2,
//   updateMessageV2,
//   updateSingleBlockV2
// } from './messageThunk.v2'

const logger = loggerService.withContext('MessageThunk')

const finishTopicLoading = async (topicId: string) => {
  await waitForTopicQueue(topicId)
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
  store.dispatch(newMessagesActions.setTopicFulfilled({ topicId, fulfilled: true }))
}

// TODO: 后续可以将db操作移到Listener Middleware中
// export const saveMessageAndBlocksToDB = async (message: Message, blocks: MessageBlock[], messageIndex: number = -1) => {
//   return saveMessageAndBlocksToDBV2(message.topicId, message, blocks, messageIndex)
// }

const updateExistingMessageAndBlocksInDB = async (
  updatedMessage: Partial<Message> & Pick<Message, 'id' | 'topicId'>,
  updatedBlocks: MessageBlock[]
) => {
  try {
    // Always update blocks if provided
    if (updatedBlocks.length > 0) {
      await updateBlocks(updatedBlocks)
    }

    // Check if there are message properties to update beyond id and topicId
    const messageKeysToUpdate = Object.keys(updatedMessage).filter((key) => key !== 'id' && key !== 'topicId')

    if (messageKeysToUpdate.length > 0) {
      const messageUpdatesPayload = messageKeysToUpdate.reduce<Partial<Message>>((acc, key) => {
        acc[key] = updatedMessage[key]
        return acc
      }, {})

      await updateMessage(updatedMessage.topicId, updatedMessage.id, messageUpdatesPayload)

      store.dispatch(updateTopicUpdatedAt({ topicId: updatedMessage.topicId }))
    }
  } catch (error) {
    logger.error(`[updateExistingMsg] Failed to update message ${updatedMessage.id}:`, error as Error)
  }
}

/**
 * 消息块节流器。
 * 每个消息块有独立节流器，并发更新时不会互相影响
 */
const blockUpdateThrottlers = new LRUCache<string, ReturnType<typeof throttle>>({
  max: 100,
  ttl: 1000 * 60 * 5,
  updateAgeOnGet: true,
  dispose: (throttler, id) => {
    throttler.cancel()
    const rafId = blockUpdateRafs.get(id)
    if (rafId) {
      cancelAnimationFrame(rafId)
      blockUpdateRafs.delete(id)
    }
  }
})

/**
 * 消息块 RAF 缓存。
 * 用于管理 RAF 请求创建和取消。
 */
const blockUpdateRafs = new LRUCache<string, number>({
  max: 100,
  ttl: 1000 * 60 * 5,
  updateAgeOnGet: true,
  dispose: (rafId) => {
    cancelAnimationFrame(rafId)
  }
})

/**
 * 获取或创建消息块专用的节流函数。
 */
const getBlockThrottler = (id: string) => {
  if (!blockUpdateThrottlers.has(id)) {
    const throttler = throttle(async (blockUpdate: any) => {
      const existingRAF = blockUpdateRafs.get(id)
      if (existingRAF) {
        cancelAnimationFrame(existingRAF)
      }

      const rafId = requestAnimationFrame(() => {
        store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
        blockUpdateRafs.delete(id)
      })

      blockUpdateRafs.set(id, rafId)
      await updateSingleBlock(id, blockUpdate)
    }, 150)

    blockUpdateThrottlers.set(id, throttler)
  }

  return blockUpdateThrottlers.get(id)!
}

/**
 * 更新单个消息块。
 */
export const throttledBlockUpdate = (id: string, blockUpdate: any) => {
  const throttler = getBlockThrottler(id)
  // store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
  throttler(blockUpdate)
}

/**
 * 取消单个块的节流更新，移除节流器和 RAF。
 */
export const cancelThrottledBlockUpdate = (id: string) => {
  const rafId = blockUpdateRafs.get(id)
  if (rafId) {
    cancelAnimationFrame(rafId)
    blockUpdateRafs.delete(id)
  }

  const throttler = blockUpdateThrottlers.get(id)
  if (throttler) {
    throttler.cancel()
    blockUpdateThrottlers.delete(id)
  }
}

// 新增: 通用的、非节流的函数，用于保存消息和块的更新到数据库
const saveUpdatesToDB = async (
  messageId: string,
  topicId: string,
  messageUpdates: Partial<Message>, // 需要更新的消息字段
  blocksToUpdate: MessageBlock[] // 需要更新/创建的块
) => {
  try {
    const messageDataToSave: Partial<Message> & Pick<Message, 'id' | 'topicId'> = {
      id: messageId,
      topicId,
      ...messageUpdates
    }
    await updateExistingMessageAndBlocksInDB(messageDataToSave, blocksToUpdate)
  } catch (error) {
    logger.error(`[DB Save Updates] Failed for message ${messageId}:`, error as Error)
  }
}

// 新增: 辅助函数，用于获取并保存单个更新后的 Block 到数据库
const saveUpdatedBlockToDB = async (
  blockId: string | null,
  messageId: string,
  topicId: string,
  getState: () => RootState
) => {
  if (!blockId) {
    logger.warn('[DB Save Single Block] Received null/undefined blockId. Skipping save.')
    return
  }
  const state = getState()
  const blockToSave = state.messageBlocks.entities[blockId]
  if (blockToSave) {
    await saveUpdatesToDB(messageId, topicId, {}, [blockToSave]) // Pass messageId, topicId, empty message updates, and the block
  } else {
    logger.warn(`[DB Save Single Block] Block ${blockId} not found in state. Cannot save.`)
  }
}

// Removed persistAgentExchange and createPersistedMessagePayload functions
// These are no longer needed since messages are saved immediately via appendMessage
// and updated during streaming via updateMessageAndBlocks

// --- Helper Function for Multi-Model Dispatch ---
// 多模型创建和发送请求的逻辑，用于用户消息多模型发送和重发
const dispatchMultiModelResponses = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  triggeringMessage: Message, // userMessage or messageToResend
  assistant: Assistant,
  mentionedModels: Model[],
  sendContext?: SendDiagnosticsContext // LOCK-004: per-send correlation context
) => {
  const assistantMessageStubs: Message[] = []
  const tasksToQueue: { assistantConfig: Assistant; messageStub: Message }[] = []

  for (const mentionedModel of mentionedModels) {
    const assistantForThisMention = { ...assistant, model: mentionedModel }
    const assistantMessage = createAssistantMessage(assistant.id, topicId, {
      askId: triggeringMessage.id,
      model: mentionedModel,
      modelId: mentionedModel.id,
      traceId: triggeringMessage.traceId
    })
    assistantMessageStubs.push(assistantMessage)
    tasksToQueue.push({
      assistantConfig: assistantForThisMention,
      messageStub: assistantMessage
    })
  }

  // LOCK-005: Persist all stubs via appendMessage BEFORE Redux dispatch
  // and queueing. Failures must not expose unpersisted stubs.
  for (const stub of assistantMessageStubs) {
    await saveMessageAndBlocksToDB(topicId, stub, [], -1, sendContext)
  }

  // Now safe to dispatch to Redux
  for (const stub of assistantMessageStubs) {
    dispatch(newMessagesActions.addMessage({ topicId, message: stub }))
  }

  const queue = getTopicQueue(topicId)
  for (const task of tasksToQueue) {
    void queue.add(async () => {
      await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, task.assistantConfig, task.messageStub)
    })
  }
}

// --- End Helper Function ---
// 发送和处理助手响应的实现函数，话题提示词在此拼接
const fetchAndProcessAssistantResponseImpl = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  origAssistant: Assistant,
  assistantMessage: Message // Pass the prepared assistant message (new or reset)
) => {
  const topic = origAssistant.topics.find((t) => t.id === topicId)
  const assistant = topic?.prompt
    ? { ...origAssistant, prompt: `${origAssistant.prompt}\n${topic.prompt}` }
    : origAssistant
  const assistantMsgId = assistantMessage.id
  let callbacks: StreamProcessorCallbacks = {}
  try {
    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

    // 创建 BlockManager 实例
    const blockManager = new BlockManager({
      dispatch,
      getState,
      saveUpdatedBlockToDB,
      saveUpdatesToDB,
      assistantMsgId,
      topicId,
      throttledBlockUpdate,
      cancelThrottledBlockUpdate
    })

    const allMessagesForTopic = selectMessagesForTopic(getState(), topicId)

    let messagesForContext: Message[] = []
    const userMessageId = assistantMessage.askId
    const userMessageIndex = allMessagesForTopic.findIndex((m) => m?.id === userMessageId)

    if (userMessageIndex === -1) {
      logger.error(
        `[fetchAndProcessAssistantResponseImpl] Triggering user message ${userMessageId} (askId of ${assistantMsgId}) not found. Falling back.`
      )
      const assistantMessageIndexFallback = allMessagesForTopic.findIndex((m) => m?.id === assistantMsgId)
      messagesForContext = (
        assistantMessageIndexFallback !== -1
          ? allMessagesForTopic.slice(0, assistantMessageIndexFallback)
          : allMessagesForTopic
      ).filter((m) => m && !m.status?.includes('ing'))
    } else {
      const contextSlice = allMessagesForTopic.slice(0, userMessageIndex + 1)
      messagesForContext = contextSlice.filter((m) => m && !m.status?.includes('ing'))
    }

    // Ensure at least the triggering user message is present to avoid empty payloads
    if ((!messagesForContext || messagesForContext.length === 0) && userMessageId) {
      const stateAfter = getState()
      const maybeUserMessage = stateAfter.messages.entities[userMessageId]
      if (maybeUserMessage) {
        messagesForContext = [maybeUserMessage]
      }
    }

    callbacks = createCallbacks({
      blockManager,
      dispatch,
      getState,
      topicId,
      assistantMsgId,
      saveUpdatesToDB,
      assistant
    })
    const streamProcessorCallbacks = createStreamProcessor(callbacks)

    const abortController = new AbortController()
    logger.silly('Add Abort Controller', { id: userMessageId })
    addAbortController(userMessageId!, () => abortController.abort())

    await transformMessagesAndFetch(
      {
        messages: messagesForContext,
        assistant,
        topicId,
        blockManager,
        assistantMsgId,
        callbacks,
        options: {
          signal: abortController.signal,
          headers: defaultAppHeaders()
        }
      },
      streamProcessorCallbacks
    )
  } catch (error: any) {
    logger.error('Error in fetchAndProcessAssistantResponseImpl:', error)
    endSpan({
      topicId,
      error: error,
      modelName: assistant.model?.name
    })
    // 统一错误处理：确保 loading 状态被正确设置，避免队列任务卡住
    try {
      callbacks.onError?.(error)
    } catch (callbackError) {
      logger.error('Error in onError callback:', callbackError as Error)
    } finally {
      // 确保无论如何都设置 loading 为 false（onError 回调中已设置，这里是保险）
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }
}

/**
 * 发送消息并处理助手回复
 * @param userMessage 已创建的用户消息
 * @param userMessageBlocks 用户消息关联的消息块
 * @param assistant 助手对象
 * @param topicId 主题ID
 */
export const sendMessage =
  (userMessage: Message, userMessageBlocks: MessageBlock[], assistant: Assistant, topicId: Topic['id']) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    // LOCK-004: one correlation context per send, threaded explicitly through
    // this send's user and assistant append calls. Ordinals are 1 for the user
    // append and 2+ for assistant stubs/multi-model appends of THIS send only;
    // overlapping sends never share or clobber each other's context.
    const sendContext = createSendDiagnosticsContext()
    try {
      if (userMessage.blocks.length === 0) {
        logger.warn('sendMessage: No blocks in the provided message.')
        return
      }

      await saveMessageAndBlocksToDB(topicId, userMessage, userMessageBlocks, -1, sendContext)
      dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
      if (userMessageBlocks.length > 0) {
        dispatch(upsertManyBlocks(userMessageBlocks))
      }
      dispatch(updateTopicUpdatedAt({ topicId }))

      const queue = getTopicQueue(topicId)

      const mentionedModels = userMessage.mentions

      if (mentionedModels && mentionedModels.length > 0) {
        await dispatchMultiModelResponses(
          dispatch,
          getState,
          topicId,
          userMessage,
          assistant,
          mentionedModels,
          sendContext
        )
      } else {
        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessage.id,
          model: assistant.model,
          traceId: userMessage.traceId
        })
        await saveMessageAndBlocksToDB(topicId, assistantMessage, [], -1, sendContext)
        dispatch(
          newMessagesActions.addMessage({
            topicId,
            message: assistantMessage
          })
        )

        void queue.add(async () => {
          await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, assistant, assistantMessage)
        })
      }
    } catch (error) {
      logger.error('Error in sendMessage thunk:', error as Error)
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Loads messages and their blocks for a specific topic from the database
 * and updates the Redux store.
 */
// export const loadTopicMessagesThunk =
//   (topicId: string, forceReload: boolean = false) =>
//   async (dispatch: AppDispatch, getState: () => RootState) => {
//     return loadTopicMessagesThunkV2(topicId, forceReload)(dispatch, getState)
//   }

/**
 * Thunk to delete a single message and its associated blocks.
 * If deleting a user message, cascades to all assistant messages with matching askId,
 * and transfers anchors for all affected assistants.
 */
export const deleteSingleMessageThunk =
  (topicId: string, messageId: string) => async (dispatch: AppDispatch, getState: () => RootState) => {
    const currentState = getState()
    const messageToDelete = currentState.messages.entities[messageId]
    if (!messageToDelete || messageToDelete.topicId !== topicId) {
      logger.error(`[deleteSingleMessage] Message ${messageId} not found in topic ${topicId}.`)
      return
    }

    // Snapshot oldGroupList before deletion for anchor transfer
    const messageIdsBefore = currentState.messages.messageIdsByTopic[topicId] || []
    const entitiesBefore = currentState.messages.entities
    const oldGroupList = buildGroupList(messageIdsBefore, (id) => entitiesBefore[id])

    let idsToDelete: string[]

    if (messageToDelete.role === 'user') {
      // Cascade: collect all assistant messages that reference this user message
      const allTopicMessages = selectMessagesForTopic(currentState, topicId)
      const assistantIds = allTopicMessages.filter((m) => m.askId === messageId).map((m) => m.id)
      idsToDelete = [messageId, ...assistantIds]
    } else {
      // Assistant: only delete the single message, no anchor transfer needed
      idsToDelete = [messageId]
    }

    // Collect block IDs for all messages being deleted
    const allBlockIds: string[] = []
    for (const id of idsToDelete) {
      const msg = currentState.messages.entities[id]
      if (msg?.blocks) {
        allBlockIds.push(...msg.blocks)
      }
    }

    try {
      // DB commit first (LOCK-001), consume cleanup once, then Redux.
      // deleteMessagesWithSegments is atomic and returns FileCleanupResult.
      const cleanup = await dbService.deleteMessagesWithSegments(topicId, idsToDelete)

      // Cancel throttled block updates (file cleanup handled post-commit)
      allBlockIds.forEach((id) => cancelThrottledBlockUpdate(id))

      // Consume file cleanup exactly once after commit
      await consumeFileCleanupResult(cleanup)

      // Redux mutations AFTER successful SQLite commit
      dispatch(newMessagesActions.removeMessages({ topicId, messageIds: idsToDelete }))
      if (allBlockIds.length > 0) {
        dispatch(removeManyBlocks(allBlockIds))
      }

      // Transfer anchors if user message was deleted (cascade)
      if (messageToDelete.role === 'user') {
        const newState = getState()
        const messageIdsAfter = newState.messages.messageIdsByTopic[topicId] || []
        const entitiesAfter = newState.messages.entities
        const newGroupList = buildGroupList(messageIdsAfter, (id) => entitiesAfter[id])

        transferAnchorsAfterDeletion(dispatch, getState, topicId, oldGroupList, newGroupList)
      }
    } catch (error) {
      logger.error(`[deleteSingleMessage] Failed to delete message ${messageId}:`, error as Error)
    }
  }

/**
 * Thunk to resend a user message by regenerating its associated assistant responses.
 * Finds all assistant messages responding to the given user message, resets them,
 * and queues them for regeneration without deleting other messages.
 */
export const resendMessageThunk =
  (topicId: Topic['id'], userMessageToResend: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()
      // Use selector to get all messages for the topic
      const allMessagesForTopic = selectMessagesForTopic(state, topicId)

      // Filter to find the assistant messages to reset
      const assistantMessagesToReset = allMessagesForTopic.filter(
        (m) => m.askId === userMessageToResend.id && m.role === 'assistant'
      )

      // Clear cached search results for the user message being resent
      // This ensures that the regenerated responses will not use stale search results
      try {
        window.keyv.remove(`web-search-${userMessageToResend.id}`)
        window.keyv.remove(`knowledge-search-${userMessageToResend.id}`)
      } catch (error) {
        logger.warn(`Failed to clear keyv cache for message ${userMessageToResend.id}:`, error as Error)
      }

      const resetDataList: Message[] = []

      if (assistantMessagesToReset.length === 0 && !userMessageToResend?.mentions?.length) {
        // 没有相关的助手消息且没有提及模型时，使用助手模型创建一条消息

        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessageToResend.id,
          model: assistant.model
        })
        assistantMessage.traceId = userMessageToResend.traceId
        resetDataList.push(assistantMessage)
      }

      // 处理存在相关的助手消息的情况
      const allBlockIdsToDelete: string[] = []
      // 先处理已有的重传
      for (const originalMsg of assistantMessagesToReset) {
        const modelToSet =
          assistantMessagesToReset.length === 1 && !userMessageToResend?.mentions?.length
            ? assistant.model
            : originalMsg.model
        const blockIdsToDelete = [...(originalMsg.blocks || [])]
        const resetMsg = resetAssistantMessage(originalMsg, {
          status: AssistantMessageStatus.PENDING,
          updatedAt: new Date().toISOString(),
          model: modelToSet
        })

        resetDataList.push(resetMsg)
        allBlockIdsToDelete.push(...blockIdsToDelete)
      }

      // 再处理新的重传（用户消息提及，但是现有助手消息中不存在提及的模型）
      const originModelSet = new Set(assistantMessagesToReset.map((m) => m.model).filter((m) => m !== undefined))
      const mentionedModelSet = new Set(userMessageToResend.mentions ?? [])
      const newModelSet = new Set([...mentionedModelSet].filter((m) => !originModelSet.has(m)))
      for (const model of newModelSet) {
        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessageToResend.id,
          model: model,
          modelId: model.id
        })
        resetDataList.push(assistantMessage)
      }

      try {
        const cleanup = await dbService.resetMessagesForResend(
          topicId,
          resetDataList.map((message) => ({ message, blocks: [] })),
          allBlockIdsToDelete
        )
        const currentMessages = selectMessagesForTopic(getState(), topicId)
        for (const message of resetDataList) {
          if (currentMessages.some((existing) => existing.id === message.id)) {
            dispatch(newMessagesActions.updateMessage({ topicId, messageId: message.id, updates: message }))
          }
        }
        for (const message of resetDataList) {
          if (!currentMessages.some((existing) => existing.id === message.id)) {
            dispatch(newMessagesActions.addMessage({ topicId, message }))
          }
        }
        // Cancel throttled block updates (file cleanup handled by consumeFileCleanupResult)
        allBlockIdsToDelete.forEach((id) => cancelThrottledBlockUpdate(id))
        if (allBlockIdsToDelete.length > 0) {
          dispatch(removeManyBlocks(allBlockIdsToDelete))
        }
        await consumeFileCleanupResult(cleanup)
      } catch (dbError) {
        logger.error('[resendMessageThunk] Error updating database:', dbError as Error)
        // LOCK-005: Rethrow DB persistence failure so callers (MessageEditor)
        // can keep the editor open for retry. Redux is never mutated on this path.
        throw dbError
      }

      const queue = getTopicQueue(topicId)
      for (const resetMsg of resetDataList) {
        const assistantConfigForThisRegen = {
          ...assistant,
          ...(resetMsg.model ? { model: resetMsg.model } : {})
        }
        void queue.add(async () => {
          await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, assistantConfigForThisRegen, resetMsg)
        })
      }
    } catch (error) {
      logger.error(`[resendMessageThunk] Error resending user message ${userMessageToResend.id}:`, error as Error)
      // LOCK-005: Rethrow so callers (MessageEditor) can keep the editor open for retry.
      throw error
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Thunk to resend a user message after its content has been edited.
 * Updates the user message's text block and then triggers the regeneration
 * of its associated assistant responses using resendMessageThunk.
 *
 * LOCK-005: Awaits resendMessageThunk and rethrows failures so callers
 * (MessageEditor) can keep the editor open for retry.
 */
export const resendUserMessageWithEditThunk =
  (topicId: Topic['id'], originalMessage: Message, assistant: Assistant) => async (dispatch: AppDispatch) => {
    // Trigger the regeneration logic for associated assistant messages
    // LOCK-005: Await and rethrow — no fire-and-forget.
    await dispatch(resendMessageThunk(topicId, originalMessage, assistant))
  }

/**
 * Thunk to regenerate a specific assistant response.
 */
export const regenerateAssistantResponseThunk =
  (topicId: Topic['id'], assistantMessageToRegenerate: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()

      // 1. Use selector to get all messages for the topic
      const allMessagesForTopic = selectMessagesForTopic(state, topicId)

      const askId = assistantMessageToRegenerate.askId

      if (!askId) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${assistantMessageToRegenerate.id} does not have an askId.`
        )
        return // Stop if askId is missing
      }

      if (!state.messages.entities[askId]) {
        logger.error(
          `[appendAssistantResponseThunk] Original user query (askId: ${askId}) not found in entities. Cannot create assistant response without corresponding user message.`
        )

        // Show error popup instead of creating error message block
        window.toast.error(t('error.missing_user_message'))

        return
      }

      // 2. Find the original user query (Restored Logic)
      const originalUserQuery = allMessagesForTopic.find((m) => m.id === assistantMessageToRegenerate.askId)
      if (!originalUserQuery) {
        logger.error(
          `[regenerateAssistantResponseThunk] Original user query (askId: ${assistantMessageToRegenerate.askId}) not found for assistant message ${assistantMessageToRegenerate.id}. Cannot regenerate.`
        )
        return
      }

      // 3. Verify the assistant message itself exists in entities
      const messageToResetEntity = state.messages.entities[assistantMessageToRegenerate.id]
      if (!messageToResetEntity) {
        // No need to check topicId again as selector implicitly handles it
        logger.error(
          `[regenerateAssistantResponseThunk] Assistant message ${assistantMessageToRegenerate.id} not found in entities despite being in the topic list. State might be inconsistent.`
        )
        return
      }

      // 4. Get Block IDs to delete
      const blockIdsToDelete = [...(messageToResetEntity.blocks || [])]

      // 5. Persist the reset and block deletion before mutating Redux.
      const resetAssistantMsg = resetAssistantMessage(
        messageToResetEntity,
        // Grouped message (mentioned model message) should not reset model and modelId, always use the original model
        assistantMessageToRegenerate.modelId
          ? {
              status: AssistantMessageStatus.PENDING,
              updatedAt: new Date().toISOString()
            }
          : {
              status: AssistantMessageStatus.PENDING,
              updatedAt: new Date().toISOString(),
              model: assistant.model
            }
      )

      const cleanup = await dbService.resetMessagesForResend(
        topicId,
        [{ message: resetAssistantMsg, blocks: [] }],
        blockIdsToDelete
      )
      await consumeFileCleanupResult(cleanup)
      // Cancel throttled block updates (file cleanup handled by consumeFileCleanupResult)
      blockIdsToDelete.forEach((id) => cancelThrottledBlockUpdate(id))
      dispatch(
        newMessagesActions.updateMessage({ topicId, messageId: resetAssistantMsg.id, updates: resetAssistantMsg })
      )
      if (blockIdsToDelete.length > 0) {
        dispatch(removeManyBlocks(blockIdsToDelete))
      }

      // 8. Add fetch/process call to the queue
      const queue = getTopicQueue(topicId)
      const assistantConfigForRegen = {
        ...assistant,
        ...(resetAssistantMsg.model ? { model: resetAssistantMsg.model } : {})
      }
      void queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForRegen,
          resetAssistantMsg
        )
      })
    } catch (error) {
      logger.error(
        `[regenerateAssistantResponseThunk] Error regenerating response for assistant message ${assistantMessageToRegenerate.id}:`,
        error as Error
      )
      // dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    } finally {
      void finishTopicLoading(topicId)
    }
  }

// --- Thunk to initiate translation and create the initial block ---
export const initiateTranslationThunk =
  (
    messageId: string,
    topicId: string,
    targetLanguage: string,
    sourceBlockId?: string, // Optional: If known
    sourceLanguage?: string // Optional: If known
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<string | undefined> => {
    // Return the new block ID
    try {
      const state = getState()
      const originalMessage = state.messages.entities[messageId]

      if (!originalMessage) {
        logger.error(`[initiateTranslationThunk] Original message ${messageId} not found.`)
        return undefined
      }

      // 1. Create the initial translation block (streaming state)
      const newBlock = createTranslationBlock(
        messageId,
        '', // Start with empty content
        targetLanguage,
        {
          status: MessageBlockStatus.STREAMING, // Set to STREAMING
          sourceBlockId,
          sourceLanguage
        }
      )

      // 2. Update Redux State
      const updatedBlockIds = [...(originalMessage.blocks || []), newBlock.id]
      dispatch(upsertOneBlock(newBlock)) // Add the new block
      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId,
          updates: { blocks: updatedBlockIds } // Update message's block list
        })
      )

      // 3. Update Database
      // Get the final message list from Redux state *after* updates
      await dbService.updateMessageAndBlocks(topicId, { id: messageId, blocks: updatedBlockIds }, [newBlock])
      return newBlock.id // Return the ID
    } catch (error) {
      logger.error(`[initiateTranslationThunk] Failed for message ${messageId}:`, error as Error)
      return undefined
      // Optional: Dispatch an error action or show notification
    }
  }

// --- Thunk to update the translation block with new content ---
export const updateTranslationBlockThunk =
  (blockId: string, accumulatedText: string, isComplete: boolean = false) =>
  async (dispatch: AppDispatch) => {
    // Logger.log(`[updateTranslationBlockThunk] 更新翻译块 ${blockId}, isComplete: ${isComplete}`)
    try {
      const status = isComplete ? MessageBlockStatus.SUCCESS : MessageBlockStatus.STREAMING
      const changes: Partial<MessageBlock> = {
        content: accumulatedText,
        status: status
      }

      // 更新Redux状态
      dispatch(updateOneBlock({ id: blockId, changes }))

      await updateSingleBlock(blockId, changes)
      // Logger.log(`[updateTranslationBlockThunk] Successfully updated translation block ${blockId}.`)
    } catch (error) {
      logger.error(`[updateTranslationBlockThunk] Failed to update translation block ${blockId}:`, error as Error)
    }
  }

/**
 * Thunk to append a new assistant response (using a potentially different model)
 * in reply to the same user query as an existing assistant message.
 */
export const appendAssistantResponseThunk =
  (
    topicId: Topic['id'],
    existingAssistantMessageId: string, // ID of the assistant message the user interacted with
    newModel: Model, // The new model selected by the user
    assistant: Assistant, // Base assistant configuration
    traceId?: string
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()

      // 1. Find the existing assistant message to get the original askId
      const existingAssistantMsg = state.messages.entities[existingAssistantMessageId]
      if (!existingAssistantMsg) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${existingAssistantMessageId} not found.`
        )
        return // Stop if the reference message doesn't exist
      }
      if (existingAssistantMsg.role !== 'assistant') {
        logger.error(
          `[appendAssistantResponseThunk] Message ${existingAssistantMessageId} is not an assistant message.`
        )
        return // Ensure it's an assistant message
      }
      const askId = existingAssistantMsg.askId
      if (!askId) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${existingAssistantMessageId} does not have an askId.`
        )
        return // Stop if askId is missing
      }

      // (Optional but recommended) Verify the original user query exists
      if (!state.messages.entities[askId]) {
        logger.error(
          `[appendAssistantResponseThunk] Original user query (askId: ${askId}) not found in entities. Cannot create assistant response without corresponding user message.`
        )

        // Show error popup instead of creating error message block
        window.toast.error(t('error.missing_user_message'))

        return
      }

      // 2. Create the new assistant message stub
      const newAssistantMessageStub = createAssistantMessage(assistant.id, topicId, {
        askId: askId, // Crucial: Use the original askId
        model: newModel,
        modelId: newModel.id,
        traceId: traceId
      })

      // 3. Update Redux Store
      const currentTopicMessageIds = getState().messages.messageIdsByTopic[topicId] || []
      const existingMessageIndex = currentTopicMessageIds.findIndex((id) => id === existingAssistantMessageId)
      const insertAtIndex = existingMessageIndex !== -1 ? existingMessageIndex + 1 : currentTopicMessageIds.length

      // 4. Update Database (Save the stub to the topic's message list)
      await saveMessageAndBlocksToDB(topicId, newAssistantMessageStub, [], insertAtIndex)

      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message: newAssistantMessageStub,
          index: insertAtIndex
        })
      )

      void dispatch(updateMessageAndBlocksThunk(topicId, { id: existingAssistantMessageId, foldSelected: false }, []))
      void dispatch(updateMessageAndBlocksThunk(topicId, { id: newAssistantMessageStub.id, foldSelected: true }, []))

      // 5. Prepare and queue the processing task
      const assistantConfigForThisCall = {
        ...assistant,
        model: newModel
      }
      const queue = getTopicQueue(topicId)
      void queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForThisCall,
          newAssistantMessageStub // Pass the newly created stub
        )
      })
    } catch (error) {
      logger.error(`[appendAssistantResponseThunk] Error appending assistant response:`, error as Error)
      // Optionally dispatch an error action or notification
      // Resetting loading state should be handled by the underlying fetchAndProcessAssistantResponseImpl
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Inserts a pair of user and assistant messages after a specified message.
 * Creates messages with default content and persists to DB and Redux.
 * @param topicId The ID of the topic
 * @param afterMessageId The ID of the message after which to insert
 * @param assistantId The ID of the assistant
 */
export const insertMessagesThunk =
  (topicId: string, afterMessageId: string, assistantId: string) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    try {
      const state = getState()
      const topicMessages = selectMessagesForTopic(state, topicId)

      if (!topicMessages || topicMessages.length === 0) {
        logger.error(`[insertMessagesThunk] Topic ${topicId} not found or is empty.`)
        return
      }

      // Find the index of the message after which to insert
      const afterMessageIndex = topicMessages.findIndex((msg) => msg.id === afterMessageId)
      if (afterMessageIndex === -1) {
        logger.error(`[insertMessagesThunk] Message ${afterMessageId} not found in topic ${topicId}.`)
        return
      }

      // If the clicked message is part of a multi-model assistant group (has askId),
      // insert after the LAST message in the same group to avoid splitting the group
      let insertIndex = afterMessageIndex + 1
      const afterMessage = topicMessages[afterMessageIndex]
      if (afterMessage?.role === 'assistant' && afterMessage.askId) {
        for (let i = afterMessageIndex + 1; i < topicMessages.length; i++) {
          if (topicMessages[i].role === 'assistant' && topicMessages[i].askId === afterMessage.askId) {
            insertIndex = i + 1
          } else {
            break
          }
        }
      }
      const now = new Date().toISOString()

      // Create user message with block
      const userMessageId = uuid()
      const userBlockId = uuid()
      const userBlock: MessageBlock = {
        id: userBlockId,
        messageId: userMessageId,
        type: MessageBlockType.MAIN_TEXT,
        content: t('chat.message.insert.newUserMessage'),
        status: MessageBlockStatus.SUCCESS,
        createdAt: now
      }
      const userMessage: Message = {
        id: userMessageId,
        role: 'user',
        assistantId,
        topicId,
        createdAt: now,
        status: UserMessageStatus.SUCCESS,
        blocks: [userBlockId]
      }

      // Create assistant message with block
      const assistantMessageId = uuid()
      const assistantBlockId = uuid()
      const assistantBlock: MessageBlock = {
        id: assistantBlockId,
        messageId: assistantMessageId,
        type: MessageBlockType.MAIN_TEXT,
        content: t('chat.message.insert.newAssistantMessage'),
        status: MessageBlockStatus.SUCCESS,
        createdAt: now
      }
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        assistantId,
        topicId,
        createdAt: now,
        status: AssistantMessageStatus.SUCCESS,
        blocks: [assistantBlockId],
        askId: userMessageId
      }

      // Add blocks to Redux
      dispatch(upsertOneBlock(userBlock))
      dispatch(upsertOneBlock(assistantBlock))

      // Insert messages to Redux at the correct position
      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message: userMessage,
          index: insertIndex
        })
      )
      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message: assistantMessage,
          index: insertIndex + 1
        })
      )

      // Persist to database
      await saveMessageAndBlocksToDB(topicId, userMessage, [userBlock], insertIndex)
      await saveMessageAndBlocksToDB(topicId, assistantMessage, [assistantBlock], insertIndex + 1)

      logger.info(`[insertMessagesThunk] Inserted messages after ${afterMessageId} at index ${insertIndex}`)
    } catch (error) {
      logger.error(`[insertMessagesThunk] Error inserting messages:`, error as Error)
      throw error
    }
  }

/**
 * Clones messages from a source topic up to a specified index into a *pre-existing* new topic.
 * Generates new unique IDs for all cloned messages and blocks.
 * Updates the DB and Redux message/block state for the new topic.
 * Assumes the newTopic object already exists in Redux topic state and DB.
 * @param sourceTopicId The ID of the topic to branch from.
 * @param branchPointIndex The index *after* which messages should NOT be copied (slice endpoint).
 * @param newTopic The newly created Topic object (created and added to Redux/DB by the caller).
 */
export const cloneMessagesToNewTopicThunk =
  (
    sourceTopicId: string,
    branchPointIndex: number,
    newTopic: Topic // Receive newTopic object
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<boolean> => {
    if (!newTopic || !newTopic.id) {
      logger.error(`[cloneMessagesToNewTopicThunk] Invalid newTopic provided.`)
      return false
    }
    try {
      const state = getState()
      const sourceMessages = selectMessagesForTopic(state, sourceTopicId)

      if (!sourceMessages || sourceMessages.length === 0) {
        logger.error(`[cloneMessagesToNewTopicThunk] Source topic ${sourceTopicId} not found or is empty.`)
        return false
      }

      // 1. Slice messages to clone
      const messagesToClone = sourceMessages.slice(0, branchPointIndex)
      if (messagesToClone.length === 0) {
        logger.warn(`[cloneMessagesToNewTopicThunk] No messages to branch (index ${branchPointIndex}).`)
        return true // Nothing to clone, operation considered successful but did nothing.
      }

      // 2. Prepare for cloning: Maps and Arrays
      const clonedMessages: Message[] = []
      const clonedBlocks: MessageBlock[] = []
      const filesToUpdateCount: FileMetadata[] = []
      const originalToNewMsgIdMap = new Map<string, string>() // Map original message ID -> new message ID

      // 3. First pass: Create ID mappings for all messages
      for (const oldMessage of messagesToClone) {
        const newMsgId = uuid()
        originalToNewMsgIdMap.set(oldMessage.id, newMsgId) // Store mapping for all cloned messages
      }

      // 4. Second pass: Clone Messages and Blocks with New IDs using complete mapping
      for (const oldMessage of messagesToClone) {
        const newMsgId = originalToNewMsgIdMap.get(oldMessage.id)!

        let newAskId: string | undefined = undefined // Initialize newAskId
        if (oldMessage.role === 'assistant' && oldMessage.askId) {
          // If it's an assistant message with an askId, find the NEW ID of the user message it references
          const mappedNewAskId = originalToNewMsgIdMap.get(oldMessage.askId)
          if (mappedNewAskId) {
            newAskId = mappedNewAskId // Use the new ID
          } else {
            // This happens if the user message corresponding to askId was *before* the branch point index
            // and thus wasn't included in messagesToClone or the map.
            // In this case, the link is broken in the new topic.
            logger.warn(
              `[cloneMessages] Could not find new ID mapping for original askId ${oldMessage.askId} (likely outside branch). Setting askId to undefined for new assistant message ${newMsgId}.`
            )
            // newAskId remains undefined
          }
        }

        // --- Clone Blocks ---
        const newBlockIds: string[] = []
        if (oldMessage.blocks && oldMessage.blocks.length > 0) {
          for (const oldBlockId of oldMessage.blocks) {
            const oldBlock = state.messageBlocks.entities[oldBlockId]
            if (oldBlock) {
              const newBlockId = uuid()
              const newBlock = {
                ...oldBlock,
                id: newBlockId,
                messageId: newMsgId // Link block to the NEW message ID
              }
              clonedBlocks.push(newBlock)
              newBlockIds.push(newBlockId)

              if (newBlock.type === MessageBlockType.FILE || newBlock.type === MessageBlockType.IMAGE) {
                const fileInfo = (newBlock as FileMessageBlock | ImageMessageBlock).file
                if (fileInfo) {
                  filesToUpdateCount.push(fileInfo)
                }
              }
            } else {
              logger.warn(
                `[cloneMessagesToNewTopicThunk] Block ${oldBlockId} not found in state for message ${oldMessage.id}. Skipping block clone.`
              )
            }
          }
        }

        // --- Create New Message Object ---
        const newMessage: Message = {
          ...oldMessage,
          id: newMsgId,
          topicId: newTopic.id, // Use the NEW topic ID provided
          blocks: newBlockIds // Use the NEW block IDs
        }
        if (newMessage.role === 'assistant') {
          newMessage.askId = newAskId // Use the mapped/updated askId
        }
        clonedMessages.push(newMessage)
      }

      // 5. Update Database (Atomic Transaction)
      // Entry assembly is O(M+B): group cloned blocks by message ID once
      // instead of filtering the whole block list per message (O(M·B)).
      // Block order within each message is preserved (array push order).
      const blocksByMessageId = new Map<string, MessageBlock[]>()
      for (const block of clonedBlocks) {
        const list = blocksByMessageId.get(block.messageId)
        if (list) {
          list.push(block)
        } else {
          blocksByMessageId.set(block.messageId, [block])
        }
      }
      await dbService.cloneMessagesToTopic(
        newTopic.id,
        clonedMessages.map((message) => ({
          message,
          blocks: blocksByMessageId.get(message.id) ?? []
        })),
        newTopic.assistantId
      )
      {
        // Update file counts
        const uniqueFiles = [...new Map(filesToUpdateCount.map((f) => [f.id, f])).values()]
        for (const file of uniqueFiles) {
          await updateFileCount(file.id, 1, false)
        }
      }

      // --- Update Redux State ---
      dispatch(
        newMessagesActions.messagesReceived({
          topicId: newTopic.id,
          messages: clonedMessages
        })
      )
      if (clonedBlocks.length > 0) {
        dispatch(upsertManyBlocks(clonedBlocks))
      }

      return true // Indicate success
    } catch (error) {
      logger.error(`[cloneMessagesToNewTopicThunk] Failed to clone messages:`, error as Error)
      return false // Indicate failure
    }
  }

/**
 * Thunk to edit properties of a message and/or its associated blocks.
 * Persists ALL changes in a SINGLE atomic SQLite transaction FIRST,
 * then commits Redux state on success.
 *
 * LOCK-001: SQLite-authoritative ordering — one atomic persistence
 * precedes committed Redux edit state; failure propagates so callers
 * (editor) can keep the editing surface open and avoid divergent state.
 *
 * Accepts optional blockIdsToDelete for blocks that should be removed
 * atomically in the same transaction as message patch and block upserts.
 */
export const updateMessageAndBlocksThunk =
  (
    topicId: string,
    // Allow messageUpdates to be optional or just contain the ID if only blocks are updated
    messageUpdates: (Partial<Message> & Pick<Message, 'id'>) | null, // ID is always required for context
    blockUpdatesList: MessageBlock[], // Block updates to upsert
    blockIdsToDelete: string[] = [] // Block IDs to delete atomically in the same transaction
  ) =>
  async (dispatch: AppDispatch): Promise<FileCleanupResult> => {
    const messageId = messageUpdates?.id

    if (messageUpdates && !messageId) {
      logger.error('[updateMessageAndBlocksThunk] Message ID is required.')
      return { affectedFileIds: [], remainingReferenceCounts: {} }
    }

    // 1. Atomic SQLite persistence (LOCK-001)
    // One IPC command: message patch + block upserts + block deletions in a single transaction.
    // If this fails, the error propagates and Redux is never touched.
    const cleanup = await dbService.updateMessageAndBlocks(
      topicId,
      messageUpdates ?? { id: messageId! },
      blockUpdatesList,
      blockIdsToDelete
    )

    // 2. Commit to Redux AFTER successful SQLite persistence
    if (messageUpdates && messageId) {
      // Strip identity fields for Redux patch (LOCK-002: id, topicId, sortOrder must not be in changes)
      // oxlint-disable-next-line @typescript-eslint/no-unused-vars
      const {
        id: _id,
        topicId: _tid,
        sortOrder: _so,
        ...actualMessageChanges
      } = messageUpdates as Record<string, unknown>

      // Only dispatch message update if there are actual changes beyond identity fields
      if (Object.keys(actualMessageChanges).length > 0) {
        dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId,
            updates: actualMessageChanges
          })
        )
      }
    }

    if (blockUpdatesList.length > 0) {
      dispatch(upsertManyBlocks(blockUpdatesList))
    }

    if (blockIdsToDelete.length > 0) {
      dispatch(removeManyBlocks(blockIdsToDelete))
    }

    dispatch(updateTopicUpdatedAt({ topicId }))

    return cleanup
  }

export const removeBlocksThunk =
  (topicId: string, messageId: string, blockIdsToRemove: string[]) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    if (!blockIdsToRemove.length) {
      logger.warn('[removeBlocksThunk] No block IDs provided to remove.')
      return
    }

    try {
      const state = getState()
      const message = state.messages.entities[messageId]

      if (!message) {
        logger.error(`[removeBlocksThunk] Message ${messageId} not found in state.`)
        return
      }
      const blockIdsToRemoveSet = new Set(blockIdsToRemove)

      const updatedBlockIds = (message.blocks || []).filter((id) => !blockIdsToRemoveSet.has(id))

      // LOCK-002: Only send minimal identity + changed field to SQLite.
      // Strip all contract-forbidden identity/order fields (id, topicId, sortOrder).
      const messagePatch = { id: messageId, blocks: updatedBlockIds }

      const cleanup = await dbService.updateMessageAndBlocks(topicId, messagePatch, [], blockIdsToRemove)
      await consumeFileCleanupResult(cleanup)
      // Cancel throttled block updates (file cleanup handled by consumeFileCleanupResult)
      blockIdsToRemove.forEach((id) => cancelThrottledBlockUpdate(id))

      dispatch(newMessagesActions.updateMessage({ topicId, messageId, updates: { blocks: updatedBlockIds } }))

      // File cleanup already consumed; Redux-only block removal
      if (blockIdsToRemove.length > 0) {
        dispatch(removeManyBlocks(blockIdsToRemove))
      }

      dispatch(updateTopicUpdatedAt({ topicId }))
    } catch (error) {
      logger.error(`[removeBlocksThunk] Failed to remove blocks from message ${messageId}:`, error as Error)
      throw error
    }
  }

//以下内容从原 messageThunk.v2.ts 迁移过来，原文件已经删除
//原因：v2.ts并不是v2数据重构的一部分，而相关命名对v2重构造成重大误解，故两文件合并，以消除误解

/**
 * Load messages for a topic using unified DbService
 */
export const loadTopicMessagesThunk =
  (topicId: string, forceReload: boolean = false) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState()

    dispatch(newMessagesActions.setCurrentTopicId(topicId))

    // Skip if already cached with valid data and not forcing reload
    const cachedIds = state.messages.messageIdsByTopic[topicId]
    if (!forceReload && cachedIds && cachedIds.length > 0) {
      return
    }

    try {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

      const { messages, blocks } = await dbService.fetchMessages(topicId)

      logger.silly('Loaded messages via DbService', {
        topicId,
        messageCount: messages.length,
        blockCount: blocks.length
      })

      // Update Redux state with fetched data
      if (blocks.length > 0) {
        dispatch(upsertManyBlocks(blocks))
      }
      dispatch(newMessagesActions.messagesReceived({ topicId, messages }))

      // Load topic segments for this topic
      void dispatch(loadTopicSegmentsThunk(topicId))
    } catch (error) {
      logger.error(`Failed to load messages for topic ${topicId}:`, error as Error)
      // Could dispatch an error action here if needed
    } finally {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }

/**
 * Get raw topic data using unified DbService
 * Returns topic with messages array
 */
export const getRawTopic = async (topicId: string): Promise<{ id: string; messages: Message[] } | undefined> => {
  try {
    const rawTopic = await dbService.getRawTopic(topicId)
    logger.silly('Retrieved raw topic via DbService', {
      topicId,
      found: !!rawTopic
    })
    return rawTopic
  } catch (error) {
    logger.error('Failed to get raw topic:', { topicId, error })
    return undefined
  }
}

/**
 * Update file reference count
 */
export const updateFileCount = async (fileId: string, delta: number, deleteIfZero: boolean = false): Promise<void> => {
  try {
    // Pass all parameters to dbService, including deleteIfZero
    await dbService.updateFileCount(fileId, delta, deleteIfZero)
    logger.silly('Updated file count', { fileId, delta, deleteIfZero })
  } catch (error) {
    logger.error('Failed to update file count:', { fileId, delta, error })
    throw error
  }
}

/**
 * Delete multiple messages from database.
 * Uses atomic deleteMessagesWithSegments returning FileCleanupResult.
 * LOCK-001: caller must consume FileCleanupResult exactly once post-commit before Redux changes.
 */
export const deleteMessagesFromDB = async (topicId: string, messageIds: string[]): Promise<FileCleanupResult> => {
  try {
    // Atomic compound deletion returns FileCleanupResult.
    const cleanup = await dbService.deleteMessagesWithSegments(topicId, messageIds)
    logger.silly('Deleted messages via deleteMessagesWithSegments', {
      topicId,
      count: messageIds.length,
      affectedFileCount: cleanup.affectedFileIds.length
    })
    return cleanup
  } catch (error) {
    logger.error('Failed to delete messages:', { topicId, messageIds, error })
    throw error
  }
}

/**
 * Save a message and its blocks to database
 *
 * `sendContext` is optional diagnostic-only correlation metadata (LOCK-004):
 * the ordinary send path threads its own per-send context through so each
 * append carries the correct correlation id/ordinal. Callers that omit it
 * (resend, regenerate, insert, channel) stay uninstrumented.
 */
export const saveMessageAndBlocksToDB = async (
  topicId: string,
  message: Message,
  blocks: MessageBlock[],
  messageIndex: number = -1,
  sendContext?: SendDiagnosticsContext
): Promise<void> => {
  try {
    const blockIds = blocks.map((block) => block.id)
    const shouldSyncBlocks =
      blockIds.length > 0 && (!message.blocks || blockIds.some((id, index) => message.blocks?.[index] !== id))

    const messageWithBlocks = shouldSyncBlocks ? { ...message, blocks: blockIds } : message
    // Direct call without conditional logic, now with messageIndex
    await dbService.appendMessage(topicId, messageWithBlocks, blocks, messageIndex, sendContext)
    logger.silly('Saved message and blocks via DbService', {
      topicId,
      messageId: message.id,
      blockCount: blocks.length,
      messageIndex
    })
  } catch (error) {
    logger.error('Failed to save message and blocks:', {
      topicId,
      messageId: message.id,
      error
    })
    throw error
  }
}

/**
 * Update a message in the database
 */
export const updateMessage = async (topicId: string, messageId: string, updates: Partial<Message>): Promise<void> => {
  try {
    await dbService.updateMessage(topicId, messageId, updates)
    logger.silly('Updated message via DbService', { topicId, messageId })
  } catch (error) {
    logger.error('Failed to update message:', { topicId, messageId, error })
    throw error
  }
}

/**
 * Update a single message block
 */
export const updateSingleBlock = async (blockId: string, updates: Partial<MessageBlock>): Promise<void> => {
  try {
    await dbService.updateSingleBlock(blockId, updates)
    logger.silly('Updated single block via DbService', { blockId })
  } catch (error) {
    logger.error('Failed to update single block:', { blockId, error })
    throw error
  }
}

/**
 * Bulk add message blocks (for new blocks)
 */
export const bulkAddBlocks = async (blocks: MessageBlock[]): Promise<void> => {
  try {
    await dbService.bulkAddBlocks(blocks)
    logger.silly('Bulk added blocks via DbService', { count: blocks.length })
  } catch (error) {
    logger.error('Failed to bulk add blocks:', { count: blocks.length, error })
    throw error
  }
}

/**
 * Update multiple message blocks (upsert operation)
 */
export const updateBlocks = async (blocks: MessageBlock[]): Promise<void> => {
  try {
    await dbService.updateBlocks(blocks)
    logger.silly('Updated blocks via DbService', { count: blocks.length })
  } catch (error) {
    logger.error('Failed to update blocks:', { count: blocks.length, error })
    throw error
  }
}

// ---------------------------------------------------------------------------
// IM Channel stream rendering
// ---------------------------------------------------------------------------
// Reuses the same BlockManager + AiSdkToChunkAdapter pipeline used for SSE
// streaming. IPC chunks are wrapped into a ReadableStream and fed into the
// existing stream processing infrastructure.
//
// Persistence is handled by the same saveUpdatesToDB / saveUpdatedBlockToDB
// functions used for ordinary chat messages (writes to SQLite). When the
// renderer is watching, the backend skips its own persistHeadlessExchange to
// avoid duplicate writes.
// ---------------------------------------------------------------------------

export type ChannelStreamController = {
  pushChunk: (chunk: TextStreamPart<Record<string, any>>) => void
  complete: () => void
  error: (err: Error) => void
  assistantMessageId: string
}

/**
 * Dispatches an IM channel user message to Redux and persists to DB.
 * Call this BEFORE setupChannelStream so the user message appears first.
 */
export const addChannelUserMessage = (
  dispatch: AppDispatch,
  topicId: string,
  agentId: string,
  text: string,
  images?: Array<{ data: string; media_type: string }>
) => {
  const now = new Date().toISOString()
  const userMsgId = uuid()
  const blockId = uuid()

  const allBlocks: MessageBlock[] = [
    {
      id: blockId,
      messageId: userMsgId,
      type: MessageBlockType.MAIN_TEXT,
      content: text,
      status: MessageBlockStatus.SUCCESS,
      createdAt: now
    }
  ]

  if (images && images.length > 0) {
    for (const img of images) {
      allBlocks.push({
        id: uuid(),
        messageId: userMsgId,
        type: MessageBlockType.IMAGE,
        url: `data:${img.media_type};base64,${img.data}`,
        status: MessageBlockStatus.SUCCESS,
        createdAt: now
      } as MessageBlock)
    }
  }

  const userMessage: Message = {
    id: userMsgId,
    role: 'user',
    assistantId: agentId,
    topicId,
    createdAt: now,
    status: UserMessageStatus.SUCCESS,
    blocks: allBlocks.map((b) => b.id)
  }

  for (const block of allBlocks) {
    dispatch(upsertOneBlock(block))
  }
  dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))

  dbService.appendMessage(topicId, userMessage, allBlocks).catch((err) => {
    logger.error('Failed to persist channel user message', err as Error)
  })
}

/**
 * Sets up the streaming pipeline for rendering IM channel responses in real-time.
 * Creates the assistant message immediately — call addChannelUserMessage first
 * to ensure correct message ordering.
 */
export const setupChannelStream = (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  agentId: string,
  modelId?: string
): ChannelStreamController => {
  const model: Model | undefined =
    (modelId ? getModel(modelId) : undefined) ??
    (modelId ? { id: modelId, provider: '', name: '', group: '' } : undefined)
  const assistantMessage = createAssistantMessage(agentId, topicId, {
    ...(model ? { modelId: model.id, model } : {})
  })
  dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
  dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))
  dbService.appendMessage(topicId, assistantMessage, []).catch((err) => {
    logger.error('Failed to persist initial channel assistant message', err as Error)
  })

  let streamController: ReadableStreamDefaultController<TextStreamPart<Record<string, any>>> | null = null
  const stream = new ReadableStream<TextStreamPart<Record<string, any>>>({
    start(controller) {
      streamController = controller
    }
  })

  const assistant: Assistant = { id: agentId, name: '', prompt: '', topics: [], type: 'claude-code', model }

  const blockManager = new BlockManager({
    dispatch,
    getState,
    saveUpdatedBlockToDB,
    saveUpdatesToDB,
    assistantMsgId: assistantMessage.id,
    topicId,
    throttledBlockUpdate,
    cancelThrottledBlockUpdate
  })

  const callbacks = createCallbacks({
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId: assistantMessage.id,
    saveUpdatesToDB,
    assistant
  })

  const streamProcessorCallbacks = createStreamProcessor(callbacks)
  streamProcessorCallbacks({ type: ChunkType.LLM_RESPONSE_CREATED })

  const adapter = new AiSdkToChunkAdapter(streamProcessorCallbacks, [], false, false)
  adapter
    .processStream({
      fullStream: stream,
      text: Promise.resolve('')
    })
    .catch((err) => {
      logger.error('Channel stream processing failed', err as Error)
    })
    .finally(() => {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    })

  return {
    assistantMessageId: assistantMessage.id,
    pushChunk(chunk: TextStreamPart<Record<string, any>>) {
      streamController?.enqueue(chunk)
    },
    complete() {
      streamController?.close()
    },
    error(err: Error) {
      streamController?.error(err)
    }
  }
}
