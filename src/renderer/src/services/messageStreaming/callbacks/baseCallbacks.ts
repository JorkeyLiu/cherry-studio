import { loggerService } from '@logger'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import i18n from '@renderer/i18n'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { computeClosureFingerprint, getFreshValidatedClosure } from '@renderer/services/contextClosure'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { NotificationService } from '@renderer/services/NotificationService'
import { estimateMessagesUsage } from '@renderer/services/TokenService'
import { updateOneBlock } from '@renderer/store/messageBlock'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Assistant } from '@renderer/types'
import { ERROR_I18N_KEY_REQUEST_TIMEOUT, ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import type {
  MessageBlock,
  PlaceholderMessageBlock,
  Response,
  ThinkingMessageBlock,
  ToolMessageBlock
} from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { uuid } from '@renderer/utils'
import { isAbortError, isTimeoutError, serializeError } from '@renderer/utils/error'
import { createBaseMessageBlock, createErrorBlock } from '@renderer/utils/messageUtils/create'
import { findAllBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { isFocused, isOnHomePage } from '@renderer/utils/window'
import type { AISDKError } from 'ai'
import { NoOutputGeneratedError } from 'ai'

import type { BlockManager } from '../BlockManager'

const logger = loggerService.withContext('BaseCallbacks')
interface BaseCallbacksDependencies {
  blockManager: BlockManager
  dispatch: any
  getState: any
  topicId: string
  assistantMsgId: string
  saveUpdatesToDB: any
  /**
   * Single-transaction final checkpoint for onComplete (Fix B). Fail-loud:
   * rejects on DB failure so the success-final Redux commit below never runs
   * forked from DB. Execution-attempt binding lives in the closure.
   */
  saveFinalUpdatesAtomically: (
    messageId: string,
    topicId: string,
    messageUpdates: any,
    blocksToUpdate: MessageBlock[]
  ) => Promise<unknown>
  assistant: Assistant
  getCurrentThinkingInfo?: () => { blockId: string | null; millsec: number }
}

export const createBaseCallbacks = (deps: BaseCallbacksDependencies) => {
  const {
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId,
    saveUpdatesToDB,
    saveFinalUpdatesAtomically,
    assistant,
    getCurrentThinkingInfo
  } = deps

  const startTime = Date.now()
  const notificationService = NotificationService.getInstance()

  // 通用的 block 查找函数
  const findBlockIdForCompletion = (message?: any) => {
    // 优先使用 BlockManager 中的 activeBlockInfo
    const activeBlockInfo = blockManager.activeBlockInfo

    if (activeBlockInfo) {
      return activeBlockInfo.id
    }

    // 如果没有活跃的block，从message中查找最新的block作为备选
    const targetMessage = message || getState().messages.entities[assistantMsgId]
    if (targetMessage) {
      const allBlocks = findAllBlocks(targetMessage)
      if (allBlocks.length > 0) {
        return allBlocks[allBlocks.length - 1].id // 返回最新的block
      }
    }

    // 最后的备选方案：从 blockManager 获取占位符块ID
    return blockManager.initialPlaceholderBlockId
  }

  return {
    onLLMResponseCreated: async () => {
      const baseBlock = createBaseMessageBlock(assistantMsgId, MessageBlockType.UNKNOWN, {
        status: MessageBlockStatus.PROCESSING
      })
      await blockManager.handleBlockTransition(baseBlock as PlaceholderMessageBlock, MessageBlockType.UNKNOWN)
    },

    onError: async (error: AISDKError) => {
      logger.debug('onError', error)
      if (NoOutputGeneratedError.isInstance(error)) {
        return
      }
      const isErrorTypeAbort = isAbortError(error)
      const isErrorTypeTimeout = isTimeoutError(error)
      const serializableError = serializeError(error)
      if (isErrorTypeAbort) {
        serializableError.i18nKey = ERROR_I18N_KEY_STREAM_PAUSED
      } else if (isErrorTypeTimeout) {
        serializableError.i18nKey = ERROR_I18N_KEY_REQUEST_TIMEOUT
      }

      const duration = Date.now() - startTime
      // 发送错误通知（除了中止错误）
      if (!isErrorTypeAbort) {
        const timeOut = duration > 30 * 1000
        if ((!isOnHomePage() && timeOut) || (!isFocused() && timeOut)) {
          await notificationService.send({
            id: uuid(),
            type: 'error',
            title: i18n.t('notification.assistant'),
            message: serializableError.message ?? '',
            silent: false,
            timestamp: Date.now(),
            source: 'assistant'
          })
        }
      }

      const possibleBlockId = findBlockIdForCompletion()

      if (possibleBlockId) {
        // 更改上一个block的状态为ERROR/PAUSED
        const changes: Partial<ThinkingMessageBlock> = {
          status: isErrorTypeAbort ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR
        }
        // 如果是 thinking block，保留实际思考时间
        if (blockManager.lastBlockType === MessageBlockType.THINKING) {
          const thinkingInfo = getCurrentThinkingInfo?.()
          if (thinkingInfo?.blockId === possibleBlockId && thinkingInfo?.millsec && thinkingInfo.millsec > 0) {
            changes.thinking_millsec = thinkingInfo.millsec
          }
        }
        blockManager.smartBlockUpdate(possibleBlockId, changes, blockManager.lastBlockType!, true)
      }

      // Fix: 更新所有仍处于 STREAMING 状态的 blocks 为 PAUSED/ERROR
      // 这修复了停止回复时思考计时器继续运行的问题
      const currentMessage = getState().messages.entities[assistantMsgId]
      const updatedBlockIds: string[] = []
      if (currentMessage) {
        const allBlockRefs = findAllBlocks(currentMessage)
        const blockState = getState().messageBlocks
        // 获取当前思考信息（如果有），用于保留实际思考时间
        const thinkingInfo = getCurrentThinkingInfo?.()
        for (const blockRef of allBlockRefs) {
          const block = blockState.entities[blockRef.id]
          if (!block) continue

          // 更新非 possibleBlockId 的 STREAMING blocks（possibleBlockId 已在上面处理）
          // 跳过 TOOL 类型 blocks，它们在下面的 tool block 分支中统一处理
          if (
            block.id !== possibleBlockId &&
            block.status === MessageBlockStatus.STREAMING &&
            block.type !== MessageBlockType.TOOL
          ) {
            const changes: Partial<ThinkingMessageBlock> = {
              status: isErrorTypeAbort ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR
            }
            if (
              block.type === MessageBlockType.THINKING &&
              thinkingInfo?.blockId === block.id &&
              thinkingInfo?.millsec &&
              thinkingInfo.millsec > 0
            ) {
              changes.thinking_millsec = thinkingInfo.millsec
            }
            dispatch(updateOneBlock({ id: block.id, changes }))
            updatedBlockIds.push(block.id)
          }

          // Fix: 更新所有仍处于非完成状态的 tool blocks 的 rawMcpToolResponse.status
          // 当用户点击停止时，tool blocks 的 UI 状态依赖 rawMcpToolResponse.status，
          // 而不是 MessageBlockStatus，所以需要单独更新
          if (block.type === MessageBlockType.TOOL) {
            const toolBlock = block as ToolMessageBlock
            const toolResponse = toolBlock.metadata?.rawMcpToolResponse
            const toolStatus = toolResponse?.status
            if (
              toolResponse &&
              toolStatus &&
              toolStatus !== 'done' &&
              toolStatus !== 'error' &&
              toolStatus !== 'cancelled'
            ) {
              dispatch(
                updateOneBlock({
                  id: block.id,
                  changes: {
                    status: isErrorTypeAbort ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR,
                    metadata: {
                      ...toolBlock.metadata,
                      rawMcpToolResponse: {
                        ...toolResponse,
                        status: isErrorTypeAbort ? 'cancelled' : 'error'
                      }
                    }
                  }
                })
              )
              updatedBlockIds.push(block.id)
            }
          }
        }
      }

      const errorBlock = createErrorBlock(assistantMsgId, serializableError, { status: MessageBlockStatus.SUCCESS })
      await blockManager.handleBlockTransition(errorBlock, MessageBlockType.ERROR)
      const messageErrorUpdate = {
        status: isErrorTypeAbort ? AssistantMessageStatus.SUCCESS : AssistantMessageStatus.ERROR
      }
      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId: assistantMsgId,
          updates: messageErrorUpdate
        })
      )

      // 从更新后的 state 中获取需要持久化的 blocks
      const blocksToSave = updatedBlockIds
        .map((id) => getState().messageBlocks.entities[id])
        .filter(Boolean) as MessageBlock[]
      await saveUpdatesToDB(assistantMsgId, topicId, messageErrorUpdate, blocksToSave)

      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, {
        id: assistantMsgId,
        topicId,
        status: isErrorTypeAbort ? 'pause' : 'error',
        error: error.message
      })
    },

    onComplete: async (status: AssistantMessageStatus, response?: Response) => {
      // Terminal write ordering: quiesce FIRST, before any terminal block
      // marking or atomic persist. A pre-quiesce smartBlockUpdate(SUCCESS)
      // would dispatch SUCCESS and then let a trailing throttled RAF flushed
      // inside quiesce overwrite Redux back to STREAMING; the post-quiesce
      // reader would then persist STREAMING while Redux already showed
      // SUCCESS (and Main would legally skip the non-terminal write).
      // So no smartBlockUpdate/dispatch of terminal state happens before the
      // barrier below — DB-first after quiesce is the only terminal commit.
      // F2 finalization quiescence: drain every throttled trailing write and
      // in-flight DB write this execution produced BEFORE the success-final
      // message write, so the Main issuer (which re-verifies DB post-state in
      // the same transaction) can never observe a partially flushed state.
      // Scoped to this execution's blocks via the BlockManager barrier — no
      // global wait, no cross-message blocking.
      await blockManager.quiesceWrites()

      if (response && response.metrics) {
        if (response.metrics.completion_tokens === 0 && response.usage?.completion_tokens) {
          response = {
            ...response,
            metrics: {
              ...response.metrics,
              completion_tokens: response.usage.completion_tokens
            }
          }
        }
      }

      // Fix B: single-transaction success-final checkpoint. Re-read the
      // LATEST Redux AFTER quiesce (never a pre-quiesce snapshot):
      // the assistant message's current block list (this round's dynamic ids,
      // in order) plus every associated block entity become ONE
      // updateMessageAndBlocks call, so Main verifies closure and mints
      // promotion membership atomically — no cross-tx window where block
      // success is committed while a transient parent closure rolls back.
      // Unsupported tool/file blocks ride along as ordinary chat data in the
      // same tx; Main sync filtering semantics are unchanged. Fail-loud: a
      // persistence failure is logged and rethrown, so the success Redux
      // commit and MESSAGE_COMPLETE below never run forked from DB.
      const latestState = getState()
      const latestAssistantMsg = latestState.messages.entities[assistantMsgId]
      if (!latestAssistantMsg) {
        const missingError = new Error(
          `[onComplete] Assistant message ${assistantMsgId} missing from Redux after quiesce; skipping final persist`
        )
        logger.error(missingError.message, missingError)
        throw missingError
      }

      if (status === 'success') {
        const orderedMsgs = selectMessagesForTopic(latestState, topicId)
        let contextMsgs = orderedMsgs
        const anchorGroupKey = getAssistantSettings(assistant).contextWindowAnchor?.[topicId]?.groupKey ?? null
        if (anchorGroupKey) {
          const currentFp = computeClosureFingerprint(orderedMsgs as any)
          const fresh = getFreshValidatedClosure(topicId, anchorGroupKey, currentFp)
          if (fresh) {
            contextMsgs = fresh.messages as any
          }
        }
        const { uiMessages } = computeContextInfo(contextMsgs, assistant, topicId)
        const finalContextWithAssistant = [...uiMessages, latestAssistantMsg]

        const possibleBlockId = findBlockIdForCompletion(latestAssistantMsg)

        // Fail-closed terminal target validation: the target must be a live
        // member of message.blocks with a live entity. Never warn+omit, never
        // overwrite message.blocks with a filtered list that drops the
        // reference.
        const latestBlockEntities = latestState.messageBlocks.entities
        const referencedIds = [...(latestAssistantMsg.blocks ?? [])]
        if (!possibleBlockId || !referencedIds.includes(possibleBlockId) || !latestBlockEntities[possibleBlockId]) {
          const missingTargetError = new Error(
            `[onComplete] Terminal block ${possibleBlockId ?? '<none>'} missing from message ${assistantMsgId} blocks after quiesce; refusing final persist`
          )
          logger.error(missingTargetError.message, missingTargetError)
          throw missingTargetError
        }
        // Every referenced block must resolve — no silent omission that would
        // fork message.blocks from the persisted block set.
        for (const blockId of referencedIds) {
          if (!latestBlockEntities[blockId]) {
            const missingRefError = new Error(
              `[onComplete] Block ${blockId} missing from Redux after quiesce; refusing final persist without dropping the reference`
            )
            logger.error(missingRefError.message, missingRefError)
            throw missingRefError
          }
        }

        const duration = Date.now() - startTime
        const content = getMainTextContent(latestAssistantMsg)

        const timeOut = duration > 30 * 1000
        // 发送长时间运行消息的成功通知
        if ((!isOnHomePage() && timeOut) || (!isFocused() && timeOut)) {
          await notificationService.send({
            id: uuid(),
            type: 'success',
            title: i18n.t('notification.assistant'),
            message: content.length > 50 ? content.slice(0, 47) + '...' : content,
            silent: false,
            timestamp: Date.now(),
            source: 'assistant',
            channel: 'system'
          })
        }

        // 更新topic的name
        void Promise.resolve(autoRenameTopic(assistant, topicId)).catch((error: unknown) =>
          logger.error('autoRenameTopic failed', error as Error)
        )

        // 处理usage估算
        // For OpenRouter, always use the accurate usage data from API, don't estimate
        const isOpenRouter = assistant.model?.provider === 'openrouter'
        if (
          !isOpenRouter &&
          response &&
          (response.usage?.total_tokens === 0 ||
            response?.usage?.prompt_tokens === 0 ||
            response?.usage?.completion_tokens === 0)
        ) {
          const usage = await estimateMessagesUsage({ assistant, messages: finalContextWithAssistant })
          response.usage = usage
        }

        // Final payload: keep every latest block in message order; force the
        // terminal target to SUCCESS in the COMMITTED payload only (Redux
        // still shows whatever quiesce left until the DB-first commit below
        // succeeds). Other blocks keep their latest terminal state as-is.
        const finalBlocks: MessageBlock[] = referencedIds.map((blockId) => {
          const block = latestBlockEntities[blockId] as MessageBlock
          if (blockId === possibleBlockId) {
            return { ...block, status: MessageBlockStatus.SUCCESS } as MessageBlock
          }
          return block
        })
        const finalMessageUpdates = {
          status,
          metrics: response?.metrics,
          usage: response?.usage,
          blocks: referencedIds
        }
        try {
          await saveFinalUpdatesAtomically(assistantMsgId, topicId, finalMessageUpdates, finalBlocks)
        } catch (error) {
          logger.error(`[onComplete] Final atomic persist failed for message ${assistantMsgId}:`, error as Error)
          throw error
        }
        // Redux AFTER the successful commit (DB-first): block first, then
        // message — exactly what the single transaction persisted.
        dispatch(updateOneBlock({ id: possibleBlockId, changes: { status: MessageBlockStatus.SUCCESS } }))
        dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId: assistantMsgId,
            updates: finalMessageUpdates
          })
        )

        void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { id: assistantMsgId, topicId, status })
        logger.debug('onComplete finished')
        return
      }

      const latestBlockEntities = latestState.messageBlocks.entities
      const finalBlocks: MessageBlock[] = []
      for (const blockId of latestAssistantMsg.blocks ?? []) {
        const block = latestBlockEntities[blockId]
        if (block) {
          finalBlocks.push(block)
        } else {
          const missingRefError = new Error(
            `[onComplete] Block ${blockId} missing from Redux after quiesce; refusing final persist without dropping the reference`
          )
          logger.error(missingRefError.message, missingRefError)
          throw missingRefError
        }
      }
      const finalMessageUpdates = {
        status,
        metrics: response?.metrics,
        usage: response?.usage,
        blocks: [...(latestAssistantMsg.blocks ?? [])]
      }
      try {
        await saveFinalUpdatesAtomically(assistantMsgId, topicId, finalMessageUpdates, finalBlocks)
      } catch (error) {
        logger.error(`[onComplete] Final atomic persist failed for message ${assistantMsgId}:`, error as Error)
        throw error
      }
      // Redux AFTER the successful commit (DB-first): the store converges to
      // exactly what the single transaction persisted.
      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId: assistantMsgId,
          updates: finalMessageUpdates
        })
      )

      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { id: assistantMsgId, topicId, status })
      logger.debug('onComplete finished')
    }
  }
}
