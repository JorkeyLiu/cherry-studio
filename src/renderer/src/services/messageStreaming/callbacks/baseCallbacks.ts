import { loggerService } from '@logger'
import { autoRenameTopic } from '@renderer/hooks/useTopic'
import i18n from '@renderer/i18n'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { computeClosureFingerprint, getFreshValidatedClosure } from '@renderer/services/contextClosure'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { NotificationService } from '@renderer/services/NotificationService'
import { estimateMessagesUsage } from '@renderer/services/TokenService'
import store from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { updateOneBlock } from '@renderer/store/messageBlock'
import { selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { newMessagesActions } from '@renderer/store/newMessage'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Assistant } from '@renderer/types'
import { ERROR_I18N_KEY_REQUEST_TIMEOUT, ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import type {
  Message,
  MessageBlock,
  PlaceholderMessageBlock,
  Response,
  ThinkingMessageBlock
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
import type { AssistantExecutionState } from '../executionState'

const logger = loggerService.withContext('BaseCallbacks')
interface BaseCallbacksDependencies {
  blockManager: BlockManager
  dispatch: any
  getState: any
  topicId: string
  assistantMsgId: string
  executionState?: AssistantExecutionState
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
  const executionState: AssistantExecutionState = deps.executionState ?? blockManager.executionState

  const startTime = Date.now()
  const notificationService = NotificationService.getInstance()

  const isLoaded = (): boolean => {
    try {
      return !!getState().messages.entities[assistantMsgId]
    } catch {
      return false
    }
  }

  // 通用的 block 查找函数 (local-aware, Redux preferred when loaded)
  const findBlockIdForCompletion = (message?: any) => {
    // 优先使用 BlockManager 中的 activeBlockInfo
    const activeBlockInfo = blockManager.activeBlockInfo

    if (activeBlockInfo) {
      return activeBlockInfo.id
    }

    // Explicit caller snapshot keeps legacy semantics (Redux read-through).
    if (message) {
      const allBlocks = findAllBlocks(message)
      if (allBlocks.length > 0) {
        return allBlocks[allBlocks.length - 1].id
      }
    }

    // Loaded path: latest Redux message (user edits/realtime projection).
    try {
      const reduxMsg = getState().messages.entities[assistantMsgId]
      if (reduxMsg) {
        const allBlocks = findAllBlocks(reduxMsg)
        if (allBlocks.length > 0) {
          return allBlocks[allBlocks.length - 1].id
        }
      }
    } catch {
      // fall through to local
    }

    // Detached path: local execution fact.
    const localIds = executionState.getBlockIds()
    if (localIds.length > 0) {
      return localIds[localIds.length - 1]
    }

    // 最后的备选方案：从 blockManager 获取占位符块ID
    return blockManager.initialPlaceholderBlockId
  }

  const getLocalMainTextContent = (): string => {
    const parts: string[] = []
    for (const block of executionState.getOrderedBlocks()) {
      const typed = block as { type?: string; content?: unknown }
      if (typed.type === MessageBlockType.MAIN_TEXT && typeof typed.content === 'string') {
        parts.push(typed.content)
      }
    }
    return parts.join('\n\n')
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
        const targetType =
          blockManager.lastBlockType ??
          (executionState.getBlock(possibleBlockId) as ThinkingMessageBlock | undefined)?.type ??
          MessageBlockType.UNKNOWN
        if (targetType === MessageBlockType.THINKING) {
          const thinkingInfo = getCurrentThinkingInfo?.()
          if (thinkingInfo?.blockId === possibleBlockId && thinkingInfo?.millsec && thinkingInfo.millsec > 0) {
            changes.thinking_millsec = thinkingInfo.millsec
          }
        }
        blockManager.smartBlockUpdate(possibleBlockId, changes, targetType, true)
      }

      // Fix: 更新所有仍处于 STREAMING 状态的 blocks 为 PAUSED/ERROR
      // Local-first: loaded path keeps Redux iteration; detached path uses the
      // local execution fact so error/paused finals persist without Redux.
      const loadedForError = isLoaded()
      const updatedBlockIds: string[] = []
      const thinkingInfo = getCurrentThinkingInfo?.()
      if (loadedForError) {
        const currentMessage = getState().messages.entities[assistantMsgId]
        if (currentMessage) {
          const allBlockRefs = findAllBlocks(currentMessage)
          const blockState = getState().messageBlocks
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
              executionState.applyBlockPatch(block.id, changes)
              dispatch(withClosureTopics(updateOneBlock({ id: block.id, changes }), topicId))
              updatedBlockIds.push(block.id)
            }

            // Fix: 更新所有仍处于非完成状态的 tool blocks 的 rawMcpToolResponse.status
            if (block.type === MessageBlockType.TOOL) {
              const toolBlock = block
              const toolResponse = toolBlock.metadata?.rawMcpToolResponse
              const toolStatus = toolResponse?.status
              if (
                toolResponse &&
                toolStatus &&
                toolStatus !== 'done' &&
                toolStatus !== 'error' &&
                toolStatus !== 'cancelled'
              ) {
                const toolChanges = {
                  status: isErrorTypeAbort ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR,
                  metadata: {
                    ...toolBlock.metadata,
                    rawMcpToolResponse: {
                      ...toolResponse,
                      status: isErrorTypeAbort ? 'cancelled' : 'error'
                    }
                  }
                }
                executionState.applyBlockPatch(block.id, toolChanges)
                dispatch(withClosureTopics(updateOneBlock({ id: block.id, changes: toolChanges }), topicId))
                updatedBlockIds.push(block.id)
              }
            }
          }
        }
      } else {
        for (const block of executionState.getOrderedBlocks()) {
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
            executionState.applyBlockPatch(block.id, changes)
            updatedBlockIds.push(block.id)
          }
          if (block.type === MessageBlockType.TOOL) {
            const toolBlock = block
            const toolResponse = toolBlock.metadata?.rawMcpToolResponse
            const toolStatus = toolResponse?.status
            if (
              toolResponse &&
              toolStatus &&
              toolStatus !== 'done' &&
              toolStatus !== 'error' &&
              toolStatus !== 'cancelled'
            ) {
              const toolChanges = {
                status: isErrorTypeAbort ? MessageBlockStatus.PAUSED : MessageBlockStatus.ERROR,
                metadata: {
                  ...toolBlock.metadata,
                  rawMcpToolResponse: {
                    ...toolResponse,
                    status: isErrorTypeAbort ? 'cancelled' : 'error'
                  }
                }
              }
              executionState.applyBlockPatch(block.id, toolChanges)
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
      executionState.applyMessagePatch(messageErrorUpdate as Partial<Message>)
      if (isLoaded()) {
        dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId: assistantMsgId,
            updates: messageErrorUpdate
          })
        )
      }

      // Local-first persistence: detached finals use the execution snapshot.
      const reduxEntities = (() => {
        try {
          return getState().messageBlocks.entities
        } catch {
          return {}
        }
      })()
      const blocksToSave = [...new Set(updatedBlockIds)]
        .map((id) => executionState.getBlock(id) ?? reduxEntities[id])
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

      // Request-local source selection: when Redux still holds the message,
      // keep the latest Redux/read-through semantics (user edits/realtime
      // projection); otherwise use the execution-state snapshot. Referenced
      // blocks always come from the same source; missing refs fail closed.
      const latestState = getState()
      const reduxMsg = (() => {
        try {
          return latestState.messages.entities[assistantMsgId]
        } catch {
          return undefined
        }
      })()
      const loaded = !!reduxMsg
      const latestAssistantMsg = loaded ? reduxMsg : executionState.snapshot().message
      if (!latestAssistantMsg) {
        const missingError = new Error(
          `[onComplete] Assistant message ${assistantMsgId} missing from execution state after quiesce; skipping final persist`
        )
        logger.error(missingError.message, missingError)
        throw missingError
      }

      if (status === 'success') {
        // Explicit provisional loaded candidate for usage estimate only; final
        // persistence and context closure authority are unchanged.
        const provisionalLoadedMessages = (selectLoadedMessagesForTopic(latestState, topicId) ?? []) as Message[]
        const orderedMsgs = provisionalLoadedMessages
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
        const resolveFinalBlock = (blockId: string): MessageBlock | undefined =>
          loaded ? (latestBlockEntities[blockId] as MessageBlock | undefined) : executionState.getBlock(blockId)
        if (!possibleBlockId || !referencedIds.includes(possibleBlockId) || !resolveFinalBlock(possibleBlockId)) {
          const missingTargetError = new Error(
            `[onComplete] Terminal block ${possibleBlockId ?? '<none>'} missing from message ${assistantMsgId} blocks after quiesce; refusing final persist`
          )
          logger.error(missingTargetError.message, missingTargetError)
          throw missingTargetError
        }
        // Every referenced block must resolve — no silent omission that would
        // fork message.blocks from the persisted block set.
        for (const blockId of referencedIds) {
          if (!resolveFinalBlock(blockId)) {
            const missingRefError = new Error(
              `[onComplete] Block ${blockId} missing from ${loaded ? 'Redux' : 'execution state'} after quiesce; refusing final persist without dropping the reference`
            )
            logger.error(missingRefError.message, missingRefError)
            throw missingRefError
          }
        }

        const duration = Date.now() - startTime
        const content = loaded ? getMainTextContent(latestAssistantMsg) : getLocalMainTextContent()

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

        // 更新topic的name推迟到最终原子持久化成功之后（见下文 DB-first 提交后），
        // 避免在消息尚未落盘时触发基于 Main 命名上下文的重命名。
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
        // succeeds). Additionally converge any leftover STREAMING thinking
        // blocks to SUCCESS (second-line defense if adapter fallback was missed
        // or a provider sent reasoning without reasoning-end/text-start).
        // Avoid double-completion: only mutate blocks still STREAMING.
        // thinking_millsec comes from the single live clock in
        // thinkingCallbacks (getCurrentThinkingInfo). When no trusted
        // thinkingInfo is available and the block has thinking_millsec 0,
        // keep 0 (or the existing value) — never fabricate with
        // Date.now()-startTime which measures the whole response.
        const thinkingInfoForFinal = getCurrentThinkingInfo?.()
        const finalBlocks: MessageBlock[] = referencedIds.map((blockId) => {
          const block = resolveFinalBlock(blockId) as MessageBlock
          if (block.type === MessageBlockType.THINKING && block.status === MessageBlockStatus.STREAMING) {
            const patch: Partial<ThinkingMessageBlock> = { status: MessageBlockStatus.SUCCESS }
            if (
              thinkingInfoForFinal != null &&
              thinkingInfoForFinal.blockId === blockId &&
              thinkingInfoForFinal.millsec > 0 &&
              Number.isFinite(thinkingInfoForFinal.millsec)
            ) {
              patch.thinking_millsec = thinkingInfoForFinal.millsec
            }
            executionState.applyBlockPatch(blockId, patch)
            return { ...block, ...patch } as MessageBlock
          }
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
        executionState.applyMessagePatch(finalMessageUpdates as Partial<Message>)
        // possibleBlockId already patched inside finalBlocks if it was a
        // streaming thinking block; otherwise ensure it converges.
        const possibleBlockForPatch = resolveFinalBlock(possibleBlockId)
        if (
          possibleBlockForPatch &&
          !(
            possibleBlockForPatch.type === MessageBlockType.THINKING &&
            possibleBlockForPatch.status === MessageBlockStatus.STREAMING
          )
        ) {
          executionState.applyBlockPatch(possibleBlockId, { status: MessageBlockStatus.SUCCESS })
        }
        try {
          await saveFinalUpdatesAtomically(assistantMsgId, topicId, finalMessageUpdates, finalBlocks)
        } catch (error) {
          logger.error(`[onComplete] Final atomic persist failed for message ${assistantMsgId}:`, error as Error)
          throw error
        }
        // Redux AFTER the successful commit (DB-first), only when still
        // loaded: converged thinking blocks + terminal block, then message.
        // Detached executions never inject. Avoid double dispatch for the
        // terminal block when it was already a converged thinking block.
        if (isLoaded()) {
          const convergedThinkingIds = finalBlocks
            .filter(
              (b) =>
                b.type === MessageBlockType.THINKING &&
                b.status === MessageBlockStatus.SUCCESS &&
                (latestState.messageBlocks.entities[b.id] as ThinkingMessageBlock | undefined)?.status ===
                  MessageBlockStatus.STREAMING
            )
            .map((b) => b.id)
          for (const tid of convergedThinkingIds) {
            const committed = finalBlocks.find((b) => b.id === tid) as ThinkingMessageBlock
            const changes: Partial<ThinkingMessageBlock> = { status: MessageBlockStatus.SUCCESS }
            if (committed.thinking_millsec != null) {
              changes.thinking_millsec = committed.thinking_millsec
            }
            dispatch(withClosureTopics(updateOneBlock({ id: tid, changes }), topicId))
          }
          if (!convergedThinkingIds.includes(possibleBlockId)) {
            dispatch(
              withClosureTopics(
                updateOneBlock({ id: possibleBlockId, changes: { status: MessageBlockStatus.SUCCESS } }),
                topicId
              )
            )
          }
          dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId: assistantMsgId,
              updates: finalMessageUpdates
            })
          )
        }

        // 成功终态命名：仅在最终原子持久化成功且已加载 Redux 终态提交之后
        // 触发（仍在 MESSAGE_COMPLETE 之前）。失败/非 success/持久化失败分支
        // 永不触发；fire-and-forget，保留 catch 日志，不 await，不重复调用。
        void Promise.resolve(
          autoRenameTopic(assistant, topicId, selectActiveBranchId(store.getState(), topicId))
        ).catch((error: unknown) => logger.error('autoRenameTopic failed', error as Error))

        void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { id: assistantMsgId, topicId, status })
        logger.debug('onComplete finished')
        return
      }

      const resolveNonSuccessBlock = (blockId: string): MessageBlock | undefined =>
        loaded
          ? (latestState.messageBlocks.entities[blockId] as MessageBlock | undefined)
          : executionState.getBlock(blockId)
      const finalBlocks: MessageBlock[] = []
      for (const blockId of latestAssistantMsg.blocks ?? []) {
        const block = resolveNonSuccessBlock(blockId)
        if (block) {
          finalBlocks.push(block)
        } else {
          const missingRefError = new Error(
            `[onComplete] Block ${blockId} missing from ${loaded ? 'Redux' : 'execution state'} after quiesce; refusing final persist without dropping the reference`
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
      executionState.applyMessagePatch(finalMessageUpdates as Partial<Message>)
      try {
        await saveFinalUpdatesAtomically(assistantMsgId, topicId, finalMessageUpdates, finalBlocks)
      } catch (error) {
        logger.error(`[onComplete] Final atomic persist failed for message ${assistantMsgId}:`, error as Error)
        throw error
      }
      // Redux AFTER the successful commit (DB-first): the store converges to
      // exactly what the single transaction persisted. Detached never injects.
      if (isLoaded()) {
        dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId: assistantMsgId,
            updates: finalMessageUpdates
          })
        )
      }

      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { id: assistantMsgId, topicId, status })
      logger.debug('onComplete finished')
    }
  }
}
