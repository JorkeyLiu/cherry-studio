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
import { INITIAL_MESSAGES_COUNT } from '@renderer/config/constant'
import { getModel } from '@renderer/hooks/useModel'
import { setLatestWindowCompleteness } from '@renderer/pages/home/Messages/messageWindow'
import { ensureTopicAnchorEstablished, transferAnchorsWithAuthorityGroupKeys } from '@renderer/services/anchorService'
import { transformMessagesAndFetch } from '@renderer/services/ApiService'
import type { AuthorityUserSnapshot } from '@renderer/services/ConversationService'
import { dbService } from '@renderer/services/db'
import { createSendDiagnosticsContext, type SendDiagnosticsContext } from '@renderer/services/db/sendTimingDiagnostics'
import { ChatDbResultError } from '@renderer/services/db/SqliteMessageDataSource'
import {
  createStreamWriteDiagnosticsContext,
  isStreamAttrRendererMeasureEnabled,
  recordStreamAttrRendererRecord
} from '@renderer/services/db/streamTimingDiagnostics'
import { consumeFileCleanupResult } from '@renderer/services/db/topicTrashLifecycle'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { createAssistantExecutionState } from '@renderer/services/messageStreaming/executionState'
import { WriteBarrier } from '@renderer/services/messageStreaming/writeBarrier'
import { currentPhaseCorrelation, recordPhaseDuration } from '@renderer/services/phaseTimingDiagnostics'
import { buildBlockOverlay } from '@renderer/services/requestBlockOverlay'
import {
  recordResidentReadDiscard,
  recordResidentReadHit,
  recordResidentReadMiss,
  recordStagedLatency
} from '@renderer/services/residentReadDiagnostics'
import { endSpan } from '@renderer/services/SpanManagerService'
import {
  canRecordFirstDataNow,
  consumeFirstDataWindow,
  hasOrdinaryTreeReady,
  instrumentFirstDataWindow
} from '@renderer/services/startupStageDiagnostics'
import { createStreamProcessor, type StreamProcessorCallbacks } from '@renderer/services/StreamProcessingService'
import {
  captureDeletionGeneration,
  getDeletionGeneration,
  isDeletionStale
} from '@renderer/services/topicDeletionInvalidation'
import { isValidWindowResponse } from '@renderer/services/windowCoverage'
import store from '@renderer/store'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import { type Assistant, type FileMetadata, type Model, type Topic } from '@renderer/types'
import { ChunkType } from '@renderer/types/chunk'
import type { GroupAnchor } from '@renderer/types/editMode'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import {
  AssistantMessageStatus,
  MessageBlockStatus,
  MessageBlockType,
  UserMessageStatus
} from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { uuid } from '@renderer/utils'
import { addAbortController } from '@renderer/utils/abortController'
import { createAssistantMessage, createTranslationBlock } from '@renderer/utils/messageUtils/create'
import { NO_MODEL_ERROR_NAME } from '@renderer/utils/noModelError'
import { getTopicQueue, waitForTopicQueue } from '@renderer/utils/queue'
import { runTopicWindowRead } from '@renderer/utils/windowReadQueue'
import type {
  DeleteMessagesWithDependentsResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FileCleanupResult,
  JsonObject,
  SemanticModelSnapshot,
  SemanticResendResponse,
  StreamWriteDiagnostics
} from '@shared/chatDb'
import { elapsedMs } from '@shared/diagnostics/sendTiming'
import { defaultAppHeaders } from '@shared/utils'
import type { TextStreamPart } from 'ai'
import { t } from 'i18next'
import { throttle } from 'lodash'
import { LRUCache } from 'lru-cache'

import type { AppDispatch, RootState } from '../index'
import { removeManyBlocks, updateOneBlock, upsertManyBlocks, upsertOneBlock } from '../messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '../newMessage'
import { bumpGeneration, publishResidentComplete } from '../residentRegistry'
import { replaceSegmentsForTopic } from '../topicSegment'
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

/**
 * Maximum cadence/throttle window for per-block Redux/persistence updates
 * (LOCK-STREAM-CADENCE-001). Kept as a distinct named constant from the
 * Markdown parse cadence (MARKDOWN_PARSE_CADENCE_MS) so each gate can evolve
 * independently. Actual update cadence depends on chunk arrival timing,
 * throttle implementation, and commit scheduling — not all updates within
 * this window will produce a visible state change.
 */
const BLOCK_UPDATE_THROTTLE_MS = 50

const finishTopicLoading = async (topicId: string) => {
  await waitForTopicQueue(topicId)
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
  store.dispatch(newMessagesActions.setTopicFulfilled({ topicId, fulfilled: true }))
}

/**
 * Resend execution attempt threading (SYNC-DATA-055 issuer slice, F1).
 *
 * The Main-authoritative attempt id returned by `resetMessagesForResend` is
 * captured into the resend/regenerate execution closure
 * (`fetchAndProcessAssistantResponseImpl`) as an immutable value and threaded
 * explicitly through BlockManager/callbacks/save helpers: every DB write the
 * execution produces carries exactly that id. No messageId-keyed lookup is
 * used as a write-path source, so a superseded execution's residual writes
 * keep carrying their own (now stale) id and fail closed in Main instead of
 * adopting the superseding execution's id. Ordinary executions pass
 * `undefined` (carrier omitted).
 */

// TODO: 后续可以将db操作移到Listener Middleware中
// export const saveMessageAndBlocksToDB = async (message: Message, blocks: MessageBlock[], messageIndex: number = -1) => {
//   return saveMessageAndBlocksToDBV2(message.topicId, message, blocks, messageIndex)
// }

const updateExistingMessageAndBlocksInDB = async (
  updatedMessage: Partial<Message> & Pick<Message, 'id' | 'topicId'>,
  updatedBlocks: MessageBlock[],
  resendAttemptId?: string
) => {
  try {
    // Always update blocks if provided
    if (updatedBlocks.length > 0) {
      await updateBlocks(updatedBlocks, undefined, resendAttemptId)
    }

    // Check if there are message properties to update beyond id and topicId
    const messageKeysToUpdate = Object.keys(updatedMessage).filter((key) => key !== 'id' && key !== 'topicId')

    if (messageKeysToUpdate.length > 0) {
      const messageUpdatesPayload = messageKeysToUpdate.reduce<Partial<Message>>((acc, key) => {
        acc[key] = updatedMessage[key]
        return acc
      }, {})

      await updateMessage(updatedMessage.topicId, updatedMessage.id, messageUpdatesPayload, resendAttemptId)

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
 * PERF-STREAM-ATTR-001 (LOCK-STREAM-ATTR-001/003): per-block arrival timestamps
 * consumed by the throttled flush to measure renderer-side scheduling delay
 * (content arrival → DB write flush). Writes are measurement-only records —
 * the map is populated/touched ONLY when the renderer collector is enabled,
 * so default bundles never allocate or mutate it.
 */
const blockThrottleArrivals = new Map<string, number>()

/** Per-call execution context for a throttled block write (F1/F2). */
export interface ThrottledBlockWriteContext {
  /** Immutable execution attempt; absent for ordinary writes (carrier omitted). */
  resendAttemptId?: string
  /** Execution barrier tracking the produced DB-write promise. */
  barrier?: WriteBarrier
  /**
   * Runtime Redux-mirror gate. Evaluated when the throttled write runs (not at
   * call time) so a mid-generation topic eviction stops mirroring without
   * stopping the DB patch. Absent = mirror (legacy/test compat).
   */
  shouldMirrorToRedux?: () => boolean
}

/**
 * 获取或创建消息块专用的节流函数。
 *
 * The trailing invocation reuses the LATEST call args (lodash semantics), so
 * the execution context travels with each call: a trailing write carries the
 * attempt/barrier of the latest update for that block.
 */
const getBlockThrottler = (id: string) => {
  if (!blockUpdateThrottlers.has(id)) {
    const throttler = throttle(async (blockUpdate: any, ctx?: ThrottledBlockWriteContext) => {
      const existingRAF = blockUpdateRafs.get(id)
      if (existingRAF) {
        cancelAnimationFrame(existingRAF)
      }

      const rafId = requestAnimationFrame(() => {
        let shouldMirror = true
        if (ctx?.shouldMirrorToRedux) {
          try {
            shouldMirror = ctx.shouldMirrorToRedux()
          } catch {
            shouldMirror = false
          }
        }
        if (shouldMirror) {
          store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
        }
        blockUpdateRafs.delete(id)
      })

      blockUpdateRafs.set(id, rafId)

      // PERF-STREAM-ATTR-001 (LOCK-STREAM-ATTR-001/003/005): measurement-only
      // schedule-delay record + per-flush correlation context threaded to the
      // DB write so renderer schedule/serialize/IPC records pair with the
      // Main-side records of the same call. Inert when the switch is off.
      let streamDiag: StreamWriteDiagnostics | undefined
      if (isStreamAttrRendererMeasureEnabled()) {
        streamDiag = createStreamWriteDiagnosticsContext()
        const arrival = blockThrottleArrivals.get(id)
        if (arrival !== undefined) {
          recordStreamAttrRendererRecord({
            channel: 'chatdb:update-single-block',
            stage: 'renderer.schedule',
            correlationId: streamDiag.correlationId,
            ordinal: streamDiag.ordinal,
            durationMs: elapsedMs(arrival),
            ok: true
          })
        }
        blockThrottleArrivals.delete(id)
      }
      // F1/F2: the DB write carries the calling execution's attempt, and the
      // produced promise is tracked on the calling execution's barrier when
      // present (flush-triggered trailing writes are therefore awaitable).
      const write = updateSingleBlock(id, blockUpdate, streamDiag, ctx?.resendAttemptId)
      if (ctx?.barrier) {
        await ctx.barrier.track(write)
      } else {
        await write
      }
    }, BLOCK_UPDATE_THROTTLE_MS)

    blockUpdateThrottlers.set(id, throttler)
  }

  return blockUpdateThrottlers.get(id)!
}

/**
 * 更新单个消息块。
 */
export const throttledBlockUpdate = (id: string, blockUpdate: any, ctx?: ThrottledBlockWriteContext) => {
  if (isStreamAttrRendererMeasureEnabled()) {
    blockThrottleArrivals.set(id, performance.now())
  }
  const throttler = getBlockThrottler(id)
  // store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
  throttler(blockUpdate, ctx)
}

/**
 * Flush (never drop) a block's pending throttled trailing write, preserving
 * the last state. Used by F2 finalization quiescence and block completion
 * paths. No-op when nothing is pending.
 */
export const flushThrottledBlockUpdate = (id: string): void => {
  const throttler = blockUpdateThrottlers.get(id)
  if (throttler) {
    throttler.flush()
  }
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

  blockThrottleArrivals.delete(id)
}

// 新增: 通用的、非节流的函数，用于保存消息和块的更新到数据库
// resendAttemptId 来自调用执行的闭包（F1 显式线程化）；缺省 = 普通路径。
export const saveUpdatesToDB = async (
  messageId: string,
  topicId: string,
  messageUpdates: Partial<Message>, // 需要更新的消息字段
  blocksToUpdate: MessageBlock[], // 需要更新/创建的块
  resendAttemptId?: string
) => {
  try {
    const messageDataToSave: Partial<Message> & Pick<Message, 'id' | 'topicId'> = {
      id: messageId,
      topicId,
      ...messageUpdates
    }
    await updateExistingMessageAndBlocksInDB(messageDataToSave, blocksToUpdate, resendAttemptId)
  } catch (error) {
    logger.error(`[DB Save Updates] Failed for message ${messageId}:`, error as Error)
  }
}

// 新增: 辅助函数，用于获取并保存单个更新后的 Block 到数据库
// Local-first: an explicit local block (execution fact) is preferred; the Redux
// lookup is only a fallback for legacy callers. DB writes never depend on Redux.
export const saveUpdatedBlockToDB = async (
  blockId: string | null,
  messageId: string,
  topicId: string,
  getState: () => RootState,
  resendAttemptId?: string,
  localBlock?: MessageBlock
) => {
  if (!blockId) {
    logger.warn('[DB Save Single Block] Received null/undefined blockId. Skipping save.')
    return
  }
  const blockToSave = localBlock ?? getState().messageBlocks.entities[blockId]
  if (blockToSave) {
    await saveUpdatesToDB(messageId, topicId, {}, [blockToSave], resendAttemptId)
  } else {
    logger.warn(`[DB Save Single Block] Block ${blockId} not found in state. Cannot save.`)
  }
}

/**
 * Final atomic persist for streaming onComplete (Fix B).
 *
 * Commits the assistant message final patch (status/metrics/usage/blocks)
 * together with ALL of its final blocks in ONE `updateMessageAndBlocks`
 * SQLite aggregate transaction, so Main verifies closure and mints
 * promotion membership atomically: no cross-transaction window where block
 * success is committed while a transient parent closure rolls back.
 * Unsupported tool/file blocks ride along as ordinary chat data in the same
 * tx; Main sync filtering semantics are unchanged.
 *
 * Explicitly fail-loud (never swallows like the intermediate
 * fire-and-forget helpers): the FileCleanupResult is consumed post-commit
 * per the existing paradigm, and any persistence failure is logged and
 * rethrown so onComplete never dispatches success Redux forked from DB.
 */
export const saveFinalMessageAndBlocksAtomically = async (
  topicId: string,
  messageId: string,
  messageUpdates: Partial<Message>,
  blocksToUpdate: MessageBlock[],
  resendAttemptId?: string
): Promise<FileCleanupResult> => {
  try {
    const cleanup = await dbService.updateMessageAndBlocks(
      topicId,
      { id: messageId, ...messageUpdates } as Partial<Message> & Pick<Message, 'id'>,
      blocksToUpdate,
      [],
      resendAttemptId
    )
    await consumeFileCleanupResult(cleanup)
    return cleanup
  } catch (error) {
    logger.error(`[DB Save Final] Failed atomic final persist for message ${messageId}:`, error as Error)
    throw error
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

/**
 * Build the writable request snapshot from the caller-provided assistant and
 * the fresh Redux assistant.
 *
 * `origAssistant` is the snapshot captured by the caller (`sendMessage`,
 * multi-model mention, append-model, grouped resend/regenerate). It may carry
 * caller-specific request configuration — above all a per-request `model`
 * override — that must survive into the actual request. `freshAssistant` is
 * the assistant re-read from the store, carrying the just-persisted settings
 * surface (`contextWindowAnchor`, `contextCount`) that the first request must
 * resolve (docs/context-window.md CW-6).
 *
 * The merge retains every caller request field and replaces ONLY the
 * Redux-owned settings surface with the fresh values, so the first request
 * observes the same anchor as TokenCount/divider while caller model overrides
 * are preserved. The returned object is an independent top-level snapshot —
 * never the frozen Redux object — because request preparation
 * (ApiService.transformMessagesAndFetch) writes `assistant.prompt`.
 */
export const mergeRequestAssistantSnapshot = (
  origAssistant: Assistant,
  freshAssistant: Assistant,
  topicId: string
): Assistant => {
  const topic = freshAssistant.topics.find((t) => t.id === topicId)
  return {
    ...origAssistant,
    settings: freshAssistant.settings,
    prompt: topic?.prompt ? `${freshAssistant.prompt}\n${topic.prompt}` : freshAssistant.prompt
  }
}

/**
 * Strict renderer-side `SemanticModelSnapshot` construction. The `Model`
 * type declares the four fields, but runtime (unconfigured/legacy) models
 * may miss them — an id-only object must never be forged into a snapshot.
 * Returns a full copy (extra JSON keys preserved) or null when the model
 * lacks any required non-empty field. Single seam for resend/regenerate.
 */
export function toSemanticModelSnapshot(model: unknown): SemanticModelSnapshot | null {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return null
  const rec = model as Record<string, unknown>
  if (
    typeof rec.id !== 'string' ||
    rec.id.length === 0 ||
    typeof rec.provider !== 'string' ||
    rec.provider.length === 0 ||
    typeof rec.name !== 'string' ||
    rec.name.length === 0 ||
    typeof rec.group !== 'string' ||
    rec.group.length === 0
  ) {
    return null
  }
  return { ...rec } as unknown as SemanticModelSnapshot
}

// 发送和处理助手响应的实现函数，话题提示词在此拼接
const fetchAndProcessAssistantResponseImpl = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  origAssistant: Assistant,
  assistantMessage: Message, // Pass the prepared assistant message (new or reset)
  /**
   * Immutable execution attempt for resend/regenerate (F1): captured from the
   * reset response into this execution closure. Every DB write below carries
   * exactly this id; ordinary executions pass undefined (carrier omitted).
   */
  resendAttemptId?: string,
  /**
   * Authority user snapshot for semantic resend/regenerate. When the loaded
   * projection contains the user, the original slice is preserved; otherwise
   * the authority user message acts as the last user with a request-local
   * block overlay (never injected into Redux). Ordinary send/append paths
   * pass undefined with unchanged behavior.
   */
  authorityUser?: { message: Message; blocks: MessageBlock[] }
) => {
  // Re-read the assistant from the store: the caller may have captured a
  // snapshot that predates the first-establishment anchor dispatch in
  // `sendMessage`. Using the fresh settings guarantees the first request,
  // TokenCount, and divider all resolve the same just-persisted anchor
  // (docs/context-window.md CW-6). Falls back to the captured assistant when
  // the id is not in the store (default-assistant edge cases).
  const freshAssistant = getState().assistants.assistants.find((asst) => asst.id === origAssistant.id) ?? origAssistant
  // The request snapshot is a narrow merge: every caller request field
  // (multi-model mention, append-model, grouped resend/regenerate model
  // overrides) is retained from `origAssistant`, while only the Redux-owned
  // settings surface is refreshed with the fresh store values (the
  // just-persisted anchor, docs/context-window.md CW-6). The result is an
  // independently writable top-level object — never the frozen Redux one.
  const assistant = mergeRequestAssistantSnapshot(origAssistant, freshAssistant, topicId)
  const assistantMsgId = assistantMessage.id
  let callbacks: StreamProcessorCallbacks = {}
  // Request-local execution state: the execution fact for this generation.
  // `assistantMessage` is the authority snapshot (semantic reset) or the
  // ordinary stub; initial blocks resolve from matching Redux entities when
  // present (detached semantic resets are usually empty, never injected).
  const executionState = createAssistantExecutionState(assistantMessage, getState)
  // F2: one write barrier per execution; all persistence this execution
  // produces is tracked here for finalization quiescence.
  const writeBarrier = new WriteBarrier()
  // F1: execution-scoped save wrappers binding the immutable closure attempt.
  const saveUpdatesToDBForExec = (
    messageId: string,
    execTopicId: string,
    messageUpdates: Partial<Message>,
    blocksToUpdate: MessageBlock[]
  ): Promise<void> => saveUpdatesToDB(messageId, execTopicId, messageUpdates, blocksToUpdate, resendAttemptId)
  const saveUpdatedBlockToDBForExec = (
    blockId: string | null,
    messageId: string,
    execTopicId: string,
    execGetState: () => RootState,
    _attemptId?: string,
    localBlock?: MessageBlock
  ): Promise<void> =>
    saveUpdatedBlockToDB(
      blockId,
      messageId,
      execTopicId,
      execGetState,
      resendAttemptId,
      localBlock ?? (blockId ? executionState.getBlock(blockId) : undefined)
    )
  // F1/Fix B: execution-scoped final atomic persist binding the immutable
  // closure attempt. onComplete's success-final checkpoint carries exactly
  // this id; ordinary executions pass undefined (carrier omitted).
  const saveFinalUpdatesAtomicallyForExec = (
    messageId: string,
    execTopicId: string,
    messageUpdates: Partial<Message>,
    blocksToUpdate: MessageBlock[]
  ): Promise<FileCleanupResult> =>
    saveFinalMessageAndBlocksAtomically(execTopicId, messageId, messageUpdates, blocksToUpdate, resendAttemptId)
  try {
    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

    // 创建 BlockManager 实例 (request-local execution state; Redux only a mirror)
    const isExecLoaded = () => {
      try {
        return !!getState().messages.entities[assistantMsgId]
      } catch {
        return false
      }
    }
    const blockManager = new BlockManager({
      dispatch,
      getState,
      saveUpdatedBlockToDB: saveUpdatedBlockToDBForExec,
      saveUpdatesToDB: saveUpdatesToDBForExec,
      assistantMsgId,
      topicId,
      resendAttemptId,
      barrier: writeBarrier,
      executionState,
      throttledBlockUpdate: (
        id: string,
        blockUpdate: any,
        attemptId?: string,
        barrier?: WriteBarrier,
        shouldMirror?: () => boolean
      ) =>
        throttledBlockUpdate(id, blockUpdate, {
          resendAttemptId: attemptId ?? resendAttemptId,
          barrier: barrier ?? writeBarrier,
          shouldMirrorToRedux: shouldMirror ?? isExecLoaded
        }),
      flushThrottledBlockUpdate,
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

    // Semantic authority user: preserve the loaded slice when the user is
    // present; otherwise append the authority user as the last user. Blocks
    // resolve via a request-local overlay — never injected into Redux.
    let authoritySnapshot: AuthorityUserSnapshot | undefined
    if (authorityUser) {
      const overlay = buildBlockOverlay(authorityUser.blocks)
      authoritySnapshot = { message: authorityUser.message, blocks: overlay }
      const hasAuthorityUser = messagesForContext.some((m) => m?.id === authorityUser.message.id)
      if (!hasAuthorityUser) {
        messagesForContext = [...messagesForContext, authorityUser.message]
      }
    }

    callbacks = createCallbacks({
      blockManager,
      dispatch,
      getState,
      topicId,
      assistantMsgId,
      saveUpdatesToDB: saveUpdatesToDBForExec,
      saveFinalUpdatesAtomically: saveFinalUpdatesAtomicallyForExec,
      assistant,
      executionState
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
        authorityUser: authoritySnapshot,
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
  // No execution-attempt cleanup needed: the attempt lives only in this
  // execution closure (F1) — later ordinary edits never see it, and a
  // post-issuance stale duplicate fails closed in Main.
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
      const phase = currentPhaseCorrelation()
      const dispatchStartedAt = performance.now()
      dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
      if (phase) recordPhaseDuration('echo.userDispatch', dispatchStartedAt, phase.path)
      if (userMessageBlocks.length > 0) {
        dispatch(upsertManyBlocks(userMessageBlocks))
      }
      dispatch(updateTopicUpdatedAt({ topicId }))

      // First establishment: after the user message is persisted and added to
      // Redux, idempotently persist the topic anchor when it is absent or
      // unresolvable (docs/context-window.md §6). A valid anchor is never
      // recalculated; an empty topic never receives an anchor. This runs
      // BEFORE the assistant response is queued so the first request resolves
      // the same persisted anchor even though its captured assistant snapshot
      // predates this dispatch.
      await ensureTopicAnchorEstablished(dispatch, getState, assistant.id, topicId)

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
 * Reusable semantic delete execution (single + multi-select unified).
 *
 * Cross-process authority: the renderer supplies ONLY stable root IDs.
 * Main expands user dependents, deletes in ONE transaction, and returns the
 * exact expanded deletion set plus block IDs, pre/post user group keys, the
 * post-delete segment catalog, and the full authority undo snapshot
 * (restore groups + affected segment snapshots).
 *
 * DB-first (LOCK-001): Redux/anchor changes happen ONLY after DB success; DB
 * failure leaves Redux and anchors untouched (the error propagates, no undo
 * parts are produced). One consume-cleanup, one loaded-intersection removal
 * (reducers never inject window-outside entities), one full segment replace
 * from the authority catalog (no loaded segment read), and one anchor
 * transfer from the authoritative group keys (no loaded entity lookup).
 *
 * Returns the authority response plus normalized undo parts adapted to the
 * existing `DeleteUndoAction` shapes (`GroupAnchor[]`, `TopicSegment[]`,
 * file deltas derived from the authority block wires), so callers can push
 * undo without reading loaded projection.
 */
export interface DeleteDependentsUndoParts {
  groupAnchors: GroupAnchor[]
  segmentSnapshots: TopicSegment[]
  fileReferenceDeltas: Array<{ fileId: string; delta: number }>
}

export function buildDeleteDependentsUndoParts(
  response: DeleteMessagesWithDependentsResponse,
  preDeleteLoadedMessageIds?: Iterable<string>
): DeleteDependentsUndoParts {
  // Fail-closed: a missing pre-delete set yields an empty intersection, so
  // Redux injects nothing. Full messages/blocks are always kept for Main.
  const loadedSet = new Set(preDeleteLoadedMessageIds ?? [])
  const groupAnchors: GroupAnchor[] = response.restoreGroups.map((group) => {
    const messages = group.entries.map((entry) => entry.message as unknown as Message)
    const blocks = group.entries.flatMap((entry) => entry.blocks as unknown as MessageBlock[])
    const loadedMessageIds = messages.map((m) => m.id).filter((id) => loadedSet.has(id))
    return {
      messages,
      blocks,
      positionIndex: group.positionIndex,
      anchorMessageId: group.anchorMessageId,
      loadedMessageIds
    }
  })
  const now = new Date().toISOString()
  const segmentSnapshots: TopicSegment[] = response.segmentSnapshots.map((wire) => ({
    id: wire.id,
    topicId: wire.topicId,
    name: wire.name ?? '',
    color: wire.color ?? undefined,
    messageIds: [...wire.messageIds],
    createdAt: wire.createdAt ?? now,
    updatedAt: wire.updatedAt ?? now
  }))
  const fileReferenceDeltas: Array<{ fileId: string; delta: number }> = []
  for (const anchor of groupAnchors) {
    for (const block of anchor.blocks) {
      if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
        const file = block.file
        if (file) {
          fileReferenceDeltas.push({ fileId: file.id, delta: -1 })
        }
      }
    }
  }
  return { groupAnchors, segmentSnapshots, fileReferenceDeltas }
}

export const executeDeleteMessagesWithDependents = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  rootIds: string[]
): Promise<{ response: DeleteMessagesWithDependentsResponse; undoParts: DeleteDependentsUndoParts }> => {
  // Capture the pre-delete loaded projection BEFORE any persistence. The
  // intersection below bounds the Redux undo projection; Main always keeps
  // the full authority restore groups.
  const preDeleteLoadedIds = new Set<string>(getState().messages.messageIdsByTopic?.[topicId] ?? [])
  // DB commit first (LOCK-001): Main resolves the full expansion + undo snapshot.
  const response = await dbService.deleteMessagesWithDependents(topicId, rootIds)

  // Cancel throttled block updates for the authoritative deleted blocks.
  response.deletedBlockIds.forEach((id) => cancelThrottledBlockUpdate(id))

  // Consume file cleanup exactly once after commit.
  await consumeFileCleanupResult(response)

  // Redux mutations AFTER successful SQLite commit — reducers naturally
  // affect only the loaded intersection, never injecting window-outside entities.
  dispatch(newMessagesActions.removeMessages({ topicId, messageIds: response.deletedMessageIds }))
  if (response.deletedBlockIds.length > 0) {
    dispatch(removeManyBlocks(response.deletedBlockIds))
  }
  dispatch(
    replaceSegmentsForTopic({
      topicId,
      segments: response.segments as unknown as Parameters<typeof replaceSegmentsForTopic>[0]['segments']
    })
  )

  // Renderer-owned anchor transfer from authoritative group keys.
  transferAnchorsWithAuthorityGroupKeys(
    dispatch,
    getState,
    topicId,
    response.previousUserMessageIds,
    response.remainingUserMessageIds
  )

  return { response, undoParts: buildDeleteDependentsUndoParts(response, preDeleteLoadedIds) }
}

export const deleteMessagesWithDependentsThunk =
  (topicId: string, rootIds: string[]) => async (dispatch: AppDispatch, getState: () => RootState) => {
    return executeDeleteMessagesWithDependents(dispatch, getState, topicId, rootIds)
  }

/**
 * Thin single-message wrapper over the unified plural helper.
 *
 * Keeps the existing non-undo API (plain delete path + trace cleanup in the
 * hook). The existence guard is a single-entity check only — no loaded
 * cascade derivation; Main owns the expansion.
 */
export const deleteSingleMessageThunk =
  (topicId: string, messageId: string) => async (dispatch: AppDispatch, getState: () => RootState) => {
    const currentState = getState()
    const messageToDelete = currentState.messages.entities[messageId]
    if (!messageToDelete || messageToDelete.topicId !== topicId) {
      logger.error(`[deleteSingleMessage] Message ${messageId} not found in topic ${topicId}.`)
      return
    }

    try {
      await executeDeleteMessagesWithDependents(dispatch, getState, topicId, [messageId])
    } catch (error) {
      logger.error(`[deleteSingleMessage] Failed to delete message ${messageId}:`, error as Error)
    }
  }

/**
 * Thunk to resend a user message by regenerating its associated assistant responses.
 * Semantic Main-authoritative path: supplies only stable IDs + assistant/model
 * snapshots; Main resolves the full answer group in one transaction.
 */
export const resendMessageThunk =
  (topicId: Topic['id'], userMessageToResend: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()
      const localUser = state.messages.entities[userMessageToResend.id]
      if (!localUser || localUser.topicId !== topicId) {
        logger.error(`[resendMessageThunk] Local user message ${userMessageToResend.id} not found in topic ${topicId}.`)
        throw new Error(`Local user message ${userMessageToResend.id} not found`)
      }

      // Clear cached search results for the user message being resent
      // This ensures that the regenerated responses will not use stale search results
      try {
        window.keyv.remove(`web-search-${userMessageToResend.id}`)
        window.keyv.remove(`knowledge-search-${userMessageToResend.id}`)
      } catch (error) {
        logger.warn(`Failed to clear keyv cache for message ${userMessageToResend.id}:`, error as Error)
      }

      if (!assistant.model || typeof assistant.model.id !== 'string') {
        logger.error(`[resendMessageThunk] Assistant ${assistant.id} has no usable model for resend.`)
        const noModelError = new Error('Assistant model is not configured for resend')
        noModelError.name = NO_MODEL_ERROR_NAME
        throw noModelError
      }
      const currentModel = toSemanticModelSnapshot(assistant.model)
      if (!currentModel) {
        logger.error(
          `[resendMessageThunk] Assistant ${assistant.id} model lacks full snapshot (id/provider/name/group).`
        )
        const noModelError = new Error('Assistant model is not configured for resend')
        noModelError.name = NO_MODEL_ERROR_NAME
        throw noModelError
      }

      let response: SemanticResendResponse
      try {
        response = await dbService.resendUserMessages({
          topicId,
          userMessageId: userMessageToResend.id,
          assistantId: assistant.id,
          currentModel
        })
      } catch (dbError) {
        logger.error('[resendMessageThunk] Error updating database:', dbError as Error)
        // LOCK-005: Rethrow DB persistence failure so callers (MessageEditor)
        // can keep the editor open for retry. Redux is never mutated on this path.
        throw dbError
      }

      const attemptByMessage = new Map<string, string>()
      for (const entry of response.attempts ?? []) {
        if (typeof entry?.messageId === 'string' && typeof entry?.attemptId === 'string') {
          attemptByMessage.set(entry.messageId, entry.attemptId)
        }
      }
      const createdIds = new Set(response.createdMessageIds ?? [])
      const loadedIds = new Set(getState().messages.messageIdsByTopic[topicId] ?? [])
      const userLoaded = loadedIds.has(response.askId)
      const executionEntries = (response.executionMessages ?? []).map((e) => ({
        message: e.message as unknown as Message,
        attemptId: attemptByMessage.get((e.message as unknown as { id: string }).id)
      }))
      for (const { message } of executionEntries) {
        if (loadedIds.has(message.id)) {
          dispatch(newMessagesActions.updateMessage({ topicId, messageId: message.id, updates: message }))
        } else if (createdIds.has(message.id) && userLoaded) {
          dispatch(newMessagesActions.addMessage({ topicId, message }))
        }
      }
      const loadedBlockIds = new Set(Object.keys(getState().messageBlocks.entities ?? {}))
      const blocksToRemove = (response.removedBlockIds ?? []).filter((id) => loadedBlockIds.has(id))
      blocksToRemove.forEach((id) => cancelThrottledBlockUpdate(id))
      if (blocksToRemove.length > 0) {
        dispatch(removeManyBlocks(blocksToRemove))
      }
      await consumeFileCleanupResult(response)

      const authorityUser = {
        message: response.userMessage as unknown as Message,
        blocks: (response.userBlocks ?? []) as unknown as MessageBlock[]
      }
      const queue = getTopicQueue(topicId)
      for (const { message, attemptId } of executionEntries) {
        const assistantConfigForThisRegen = {
          ...assistant,
          ...(message.model ? { model: message.model } : {})
        }
        void queue.add(async () => {
          await fetchAndProcessAssistantResponseImpl(
            dispatch,
            getState,
            topicId,
            assistantConfigForThisRegen,
            message,
            attemptId,
            authorityUser
          )
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
 * Thunk to regenerate a specific assistant response via the semantic command.
 * Supplies only the stable assistant ID; Main validates selected/askId/user
 * and resets only the selected message in one transaction.
 */
export const regenerateAssistantResponseThunk =
  (topicId: Topic['id'], assistantMessageToRegenerate: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()
      const localSelected = state.messages.entities[assistantMessageToRegenerate.id]
      if (!localSelected || localSelected.topicId !== topicId) {
        logger.error(
          `[regenerateAssistantResponseThunk] Assistant message ${assistantMessageToRegenerate.id} not found in topic ${topicId}.`
        )
        return
      }
      if (!assistantMessageToRegenerate.askId && !localSelected.askId) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${assistantMessageToRegenerate.id} does not have an askId.`
        )
        return
      }
      // Self-model compat: a truthy selected `modelId` preserves the old
      // retain-model path without requiring a configured assistant model.
      // Never forge a model id — omit `currentModel` when the assistant
      // model lacks the full id/provider/name/group snapshot.
      const hasSelfModelId =
        (typeof localSelected.modelId === 'string' && localSelected.modelId.length > 0) ||
        (typeof assistantMessageToRegenerate.modelId === 'string' && assistantMessageToRegenerate.modelId.length > 0)
      const snapshot = toSemanticModelSnapshot(assistant.model)
      const hasUsableAssistantModel = snapshot !== null
      if (!hasSelfModelId && !hasUsableAssistantModel) {
        logger.error(`[regenerateAssistantResponseThunk] Assistant ${assistant.id} has no usable model.`)
        return
      }
      const currentModel = snapshot ?? undefined

      let response: SemanticResendResponse
      try {
        response = await dbService.regenerateAssistantMessage({
          topicId,
          assistantMessageId: assistantMessageToRegenerate.id,
          assistantId: assistant.id,
          ...(currentModel !== undefined && { currentModel })
        })
      } catch (dbError) {
        if (dbError instanceof ChatDbResultError && dbError.code === 'NOT_FOUND') {
          logger.error(
            `[regenerateAssistantResponseThunk] Authority user query not found for assistant message ${assistantMessageToRegenerate.id}.`,
            dbError
          )
          window.toast.error(t('error.missing_user_message'))
          return
        }
        logger.error(
          `[regenerateAssistantResponseThunk] Error regenerating response for assistant message ${assistantMessageToRegenerate.id}:`,
          dbError as Error
        )
        return
      }
      const matchedAttempt = (response.attempts ?? []).find(
        (e) => e?.messageId === assistantMessageToRegenerate.id && typeof e?.attemptId === 'string'
      )
      const attemptForExec =
        matchedAttempt && typeof matchedAttempt.attemptId === 'string' ? matchedAttempt.attemptId : undefined
      const execEntry = (response.executionMessages ?? [])[0]
      if (!execEntry) {
        logger.error(
          `[regenerateAssistantResponseThunk] Empty execution messages for ${assistantMessageToRegenerate.id}.`
        )
        return
      }
      const resetAssistantMsg = execEntry.message as unknown as Message
      await consumeFileCleanupResult(response)
      const loadedBlockIds = new Set(Object.keys(getState().messageBlocks.entities ?? {}))
      const blocksToRemove = (response.removedBlockIds ?? []).filter((id) => loadedBlockIds.has(id))
      blocksToRemove.forEach((id) => cancelThrottledBlockUpdate(id))
      dispatch(
        newMessagesActions.updateMessage({ topicId, messageId: resetAssistantMsg.id, updates: resetAssistantMsg })
      )
      if (blocksToRemove.length > 0) {
        dispatch(removeManyBlocks(blocksToRemove))
      }

      // 8. Add fetch/process call to the queue
      const queue = getTopicQueue(topicId)
      const assistantConfigForRegen = {
        ...assistant,
        ...(resetAssistantMsg.model ? { model: resetAssistantMsg.model } : {})
      }
      const authorityUser = {
        message: response.userMessage as unknown as Message,
        blocks: (response.userBlocks ?? []) as unknown as MessageBlock[]
      }
      void queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForRegen,
          resetAssistantMsg,
          attemptForExec,
          authorityUser
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

      // 3. Local projection placement only (window-relative). Authority
      // position is resolved in Main from the stable anchor below, so this
      // loaded index must never reach persistence.
      const currentTopicMessageIds = getState().messages.messageIdsByTopic[topicId] || []
      const existingMessageIndex = currentTopicMessageIds.findIndex((id) => id === existingAssistantMessageId)
      const insertAtIndex = existingMessageIndex !== -1 ? existingMessageIndex + 1 : currentTopicMessageIds.length

      // 4. Persist the stub via the stable-ID authority capability. Main
      // resolves insertion after the anchor/contiguous assistant group tail
      // in one transaction (cold-window safe: no loaded-relative DB index).
      await dbService.insertMessagesAfterAnchor(topicId, existingAssistantMessageId, [
        { message: newAssistantMessageStub as unknown as JsonObject, blocks: [] }
      ])

      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message: newAssistantMessageStub,
          index: insertAtIndex
        })
      )

      // 4b. The newly appended response becomes the group's single selection.
      // Cross-process authority: the second transaction carries ONLY the new
      // selected ID; Main resolves the complete group (including
      // window-outside members) and persists the single selection atomically.
      // Ordering: the generation queue starts unconditionally right after the
      // stub commit above, so a second-transaction failure can never block the
      // AI streaming pipeline. Selection is then awaited in its own try/catch
      // (never fire-and-forget without catch): failure is logged privacy-safe
      // and the already-committed stub stands as DB truth — the append is NOT
      // rolled back and no success of the selection is claimed.
      // 5. Prepare and queue the processing task (unconditional after stub commit)
      const assistantConfigForThisCall = {
        ...assistant,
        model: newModel
      }
      const queue = getTopicQueue(topicId)
      const requestTask = queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForThisCall,
          newAssistantMessageStub // Pass the newly created stub
        )
      })
      void requestTask

      try {
        await dispatch(selectAnswerMessageThunk(topicId, newAssistantMessageStub.id))
      } catch (error) {
        logger.error(
          `[appendAssistantResponseThunk] Failed to select appended answer; continuing with queued generation:`,
          error as Error
        )
      }
    } catch (error) {
      logger.error(`[appendAssistantResponseThunk] Error appending assistant response:`, error as Error)
      // Optionally dispatch an error action or notification
      // Resetting loading state should be handled by the underlying fetchAndProcessAssistantResponseImpl
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * S6.2c-2: Main-authoritative insert after stable anchor.
 *
 * Eliminates renderer-window-relative insertIndex calculation for the primary
 * message insertion path. Main resolves the stable afterMessageId anchor and
 * assistant answer-group tail atomically before inserting (no numeric insertIndex
 * in request). Preserve two-message user+assistant behavior and askId semantics.
 * Fail closed: no Redux publication if Main fails.
 *
 * Compatibility: the positional appendMessage path remains unchanged for
 * compatibility; this thunk is the primary migrated path.
 */
export const insertMessagesThunk =
  (topicId: string, afterMessageId: string, assistantId: string) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
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

    try {
      // Primary path: Main-authoritative batch insert after stable anchor (no renderer index)
      await dbService.insertMessagesAfterAnchor(topicId, afterMessageId, [
        {
          message: userMessage as unknown as JsonObject,
          blocks: [userBlock as unknown as JsonObject]
        },
        {
          message: assistantMessage as unknown as JsonObject,
          blocks: [assistantBlock as unknown as JsonObject]
        }
      ])

      // Publish to Redux only after Main success (fail closed, no partial)
      dispatch(upsertOneBlock(userBlock))
      dispatch(upsertOneBlock(assistantBlock))

      // Local projection insertion: best-effort window-relative placement for immediate UI.
      // Authority order is already correct in Main; this projection step does not affect authority.
      const state = getState()
      const topicMessages = selectMessagesForTopic(state, topicId)
      let insertIndex: number | null = null
      if (topicMessages && topicMessages.length > 0) {
        const afterIdx = topicMessages.findIndex((msg) => msg.id === afterMessageId)
        if (afterIdx !== -1) {
          let tail = afterIdx
          const afterMsg = topicMessages[afterIdx]
          if (afterMsg?.role === 'assistant' && afterMsg.askId) {
            for (let i = afterIdx + 1; i < topicMessages.length; i++) {
              if (topicMessages[i].role === 'assistant' && topicMessages[i].askId === afterMsg.askId) {
                tail = i
              } else {
                break
              }
            }
          }
          insertIndex = tail + 1
        }
      }
      if (insertIndex !== null) {
        dispatch(newMessagesActions.insertMessageAtIndex({ topicId, message: userMessage, index: insertIndex }))
        dispatch(
          newMessagesActions.insertMessageAtIndex({ topicId, message: assistantMessage, index: insertIndex + 1 })
        )
      } else {
        // Anchor outside current window/projection: append at end for immediate local visibility;
        // authoritative window will converge on next fetch/window read.
        dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
        dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
      }

      logger.info(`[insertMessagesThunk] Inserted messages after ${afterMessageId} via Main-authoritative anchor`)
    } catch (error) {
      logger.error(`[insertMessagesThunk] Error inserting messages:`, error as Error)
      throw error
    }
  }

/**
 * Compatibility-only: renderer-window-relative insert via positional appendMessage.
 * Preserved for backward compatibility; not the primary S6.2c-2 path.
 * New code must use insertMessagesThunk (anchor-based).
 */
export const insertMessagesThunkLegacy =
  (topicId: string, afterMessageId: string, assistantId: string) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    try {
      const state = getState()
      const topicMessages = selectMessagesForTopic(state, topicId)

      if (!topicMessages || topicMessages.length === 0) {
        logger.error(`[insertMessagesThunkLegacy] Topic ${topicId} not found or is empty.`)
        return
      }

      const afterMessageIndex = topicMessages.findIndex((msg) => msg.id === afterMessageId)
      if (afterMessageIndex === -1) {
        logger.error(`[insertMessagesThunkLegacy] Message ${afterMessageId} not found in topic ${topicId}.`)
        return
      }

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

      dispatch(upsertOneBlock(userBlock))
      dispatch(upsertOneBlock(assistantBlock))

      dispatch(newMessagesActions.insertMessageAtIndex({ topicId, message: userMessage, index: insertIndex }))
      dispatch(newMessagesActions.insertMessageAtIndex({ topicId, message: assistantMessage, index: insertIndex + 1 }))

      await saveMessageAndBlocksToDB(topicId, userMessage, [userBlock], insertIndex)
      await saveMessageAndBlocksToDB(topicId, assistantMessage, [assistantBlock], insertIndex + 1)

      logger.info(`[insertMessagesThunkLegacy] Inserted messages after ${afterMessageId} at index ${insertIndex}`)
    } catch (error) {
      logger.error(`[insertMessagesThunkLegacy] Error inserting messages:`, error as Error)
      throw error
    }
  }

/**
 * S6.2c-1: Main-authoritative branch by stable anchor.
 *
 * Resolves the source prefix through a stable anchor in Main SQLite and clones it
 * atomically into the target topic. No renderer slice/index, no window-relative
 * computation. Returns the actual cloned wire for projection.
 */
export const branchMessagesToTopicThunk =
  (sourceTopicId: string, anchorMessageId: string, newTopic: Topic) =>
  async (dispatch: AppDispatch, _getState: () => RootState): Promise<boolean> => {
    if (!newTopic || !newTopic.id) {
      logger.error(`[branchMessagesToTopicThunk] Invalid newTopic provided.`)
      return false
    }
    try {
      const { messages: clonedMessages, blocks: clonedBlocks } = await dbService.branchMessagesToTopic(
        sourceTopicId,
        newTopic.id,
        anchorMessageId,
        newTopic.assistantId
      )

      // File count parity (same as old path): bump Dexie file counts for file/image blocks
      const filesToUpdateCount: FileMetadata[] = []
      for (const block of clonedBlocks) {
        if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
          const fileInfo = block.file
          if (fileInfo) filesToUpdateCount.push(fileInfo)
        }
      }
      if (filesToUpdateCount.length > 0) {
        const uniqueFiles = [...new Map(filesToUpdateCount.map((f) => [f.id, f])).values()]
        for (const file of uniqueFiles) {
          await updateFileCount(file.id, 1, false)
        }
      }

      if (clonedMessages.length > 0) {
        dispatch(
          newMessagesActions.messagesReceived({
            topicId: newTopic.id,
            messages: clonedMessages
          })
        )
      } else {
        // Anchor inclusive guarantees at least one message; empty is a no-op success without dispatch
        dispatch(
          newMessagesActions.messagesReceived({
            topicId: newTopic.id,
            messages: []
          })
        )
      }
      if (clonedBlocks.length > 0) {
        dispatch(upsertManyBlocks(clonedBlocks))
      }
      return true
    } catch (error) {
      logger.error(`[branchMessagesToTopicThunk] Failed to branch messages:`, error as Error)
      return false
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

/**
 * Cross-process authority answer selection.
 *
 * DB-first, single-commit:
 * 1. ONE `selectAnswerMessage` ChatDb command with the selected ID only →
 *    ONE Main root SQLite transaction resolves the complete answer group
 *    (topic/role/askId validated, cross-topic fail-closed) and persists
 *    exactly one foldSelected=true atomically. The data source dispatches
 *    `updateTopicUpdatedAt` exactly once on success — this thunk must NOT
 *    dispatch it again.
 * 2. On success, ONE plural `updateManyMessages` Redux dispatch commits the
 *    authoritative group, intersected with the currently loaded projection
 *    (never injects window-outside entities).
 * 3. On DB failure the error propagates and NO Redux commit happens.
 */
export const selectAnswerMessageThunk =
  (topicId: string, selectedMessageId: string) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    // 1. Atomic Main-authoritative persistence (DB-first, LOCK-001).
    const response = await dbService.selectAnswerMessage(topicId, selectedMessageId)

    // 2. ONE plural Redux commit intersected with the loaded projection.
    const state = getState()
    const loadedIds = state.messages.messageIdsByTopic[topicId] || []
    const loadedSet = new Set(loadedIds)
    const visibleUpdates = response.messageIds
      .filter((id) => loadedSet.has(id))
      .map((messageId) => ({
        messageId,
        updates: { foldSelected: messageId === response.selectedMessageId }
      }))
    if (visibleUpdates.length > 0) {
      dispatch(newMessagesActions.updateManyMessages({ topicId, updates: visibleUpdates }))
    }
    // updateTopicUpdatedAt is dispatched exactly once by the data source.
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

// S6.1 helpers — R-02/R-03 sizing and validation (shared)

function clampWindowLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.floor(raw) : INITIAL_MESSAGES_COUNT
  if (!Number.isFinite(n)) return INITIAL_MESSAGES_COUNT
  return Math.min(100, Math.max(1, n))
}

// Re-export shared validator for tests and consumers; local alias preserves prior import path.
export const validateWindowResponse = isValidWindowResponse

// S6.1 same-topic stale-bootstrap guard — module-private monotonic sequence plus per-topic latest token.
// Prevents overlapping loadTopicMessagesThunk(topicId) latest responses from publishing out of order.
// Viewport generation cannot be reused because bootstrap runs outside Messages.
let loadTopicMessagesRequestSeq = 0
const latestLoadTopicMessagesRequestByTopic = new Map<string, number>()

/**
 * Load messages for a topic using windowed reads (S6.1 R-02 latest).
 *
 * Cold bootstrap uses the existing renderer sizing (displayCount / INITIAL_MESSAGES_COUNT,
 * clamped to the 1..100 validation bounds) for the latest window limit. Only a
 * validated complete window response is staged: blocks then messages are published
 * atomically after stale-topic check. Malformed/mismatched or stale responses
 * fail closed via the existing error path — never masquerading as whole-topic
 * data and never falling back to whole-topic fetch.
 */
export const loadTopicMessagesThunk =
  (topicId: string, forceReload: boolean = false) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    // S7.14-E1 independent eligibility: capture state BEFORE own setCurrentTopicId dispatch.
    // Do not prove eligibility via post-dispatch currentTopicId equality (self-assignment).
    // Use topic existence + pre-dispatch active-topic equality (observable before mutation); fail closed otherwise.
    const stateBefore = getState()
    const trimmedBefore = typeof topicId === 'string' ? topicId.trim() : ''
    let topicExistsBefore = false
    if (trimmedBefore.length > 0) {
      try {
        const assistants = (stateBefore as any).assistants?.assistants
        if (Array.isArray(assistants)) {
          topicExistsBefore = assistants.some(
            (a: any) => Array.isArray(a.topics) && a.topics.some((t: any) => t.id === trimmedBefore)
          )
        }
      } catch {}
    }
    const rawCurrentBefore = (stateBefore as any).messages?.currentTopicId
    const currentBeforeTrimmed = typeof rawCurrentBefore === 'string' ? rawCurrentBefore.trim() : ''
    const activeBefore =
      trimmedBefore.length > 0 && currentBeforeTrimmed.length > 0 && currentBeforeTrimmed === trimmedBefore
    const windowOpenBefore = hasOrdinaryTreeReady() && canRecordFirstDataNow()
    const eligibleBefore = windowOpenBefore && trimmedBefore.length > 0 && topicExistsBefore && activeBefore
    // First startup candidate includes cache-hit/no-topic/unavailable: consume window fail-closed
    // so later History/navigation/force loads cannot emit. Eligible candidates defer to settlement.
    if (windowOpenBefore && !eligibleBefore) {
      consumeFirstDataWindow()
    }

    const state = stateBefore

    dispatch(newMessagesActions.setCurrentTopicId(topicId))

    // Cache-hit requires resident completeness for same generation including empty markers.
    // Any component absence or generation mismatch is a miss. Registry presence/residency,
    // not messageIds.length, decides eligibility — empty complete topics are valid hits.
    // Distinction between absent index (miss) and present empty array (hit if resident) is preserved.
    // Diagnostics: bounded scalar hit/miss reason counters, no IDs/content retained.
    const cachedIds = state.messages.messageIdsByTopic[topicId]
    const hasCachedIndex = cachedIds !== undefined
    if (!forceReload && hasCachedIndex) {
      const deletionGen = getDeletionGeneration(topicId)
      if (deletionGen !== 0) {
        // fall through to fetch — do not early return on potentially stale cache
      } else {
        const registry = (getState() as any).residentRegistry
        if (!registry) {
          // Test environment without registry slice (legacy tests) — preserve legacy hit semantics
          // Legacy: only non-empty cached topics are hits; empty falls through to fetch
          if (cachedIds.length > 0) {
            recordResidentReadHit()
            // S7.14-E1: cache-hit startup candidate closes one-shot window without attribution
            if (eligibleBefore) {
              consumeFirstDataWindow()
            }
            // Supersede any older in-flight same-topic staged load before completing cache-hit activation
            const requestSeq = ++loadTopicMessagesRequestSeq
            latestLoadTopicMessagesRequestByTopic.set(topicId, requestSeq)
            const cachedState = getState()
            const cachedTopicOwner = cachedState.assistants.assistants.find((asst) =>
              asst.topics.some((t) => t.id === topicId)
            )
            if (cachedTopicOwner) {
              await ensureTopicAnchorEstablished(dispatch, getState, cachedTopicOwner.id, topicId)
            }
            return
          }
          // empty legacy -> miss, fall through (reason captured below)
        } else {
          const residentEntry = registry.entries?.[topicId]
          const isResidentHit =
            !!residentEntry && residentEntry.residentTopic && residentEntry.chatData && residentEntry.segments
          if (isResidentHit) {
            recordResidentReadHit()
            // S7.14-E1: cache-hit startup candidate closes one-shot window without attribution
            if (eligibleBefore) {
              consumeFirstDataWindow()
            }
            // Supersede any older in-flight same-topic staged load before completing cache-hit activation
            const requestSeq = ++loadTopicMessagesRequestSeq
            latestLoadTopicMessagesRequestByTopic.set(topicId, requestSeq)
            const cachedState = getState()
            const cachedTopicOwner = cachedState.assistants.assistants.find((asst) =>
              asst.topics.some((t) => t.id === topicId)
            )
            if (cachedTopicOwner) {
              await ensureTopicAnchorEstablished(dispatch, getState, cachedTopicOwner.id, topicId)
            }
            return
          }
          // miss -> fall through to staged fetch (including absent vs empty distinction preserved)
        }
      }
    }

    // Record bounded miss reason for the actual staged-fetch decision (no IDs retained)
    // Forced takes precedence, then missing index, deletion pending, then completeness checks.
    {
      if (forceReload) {
        recordResidentReadMiss('forced')
      } else if (!hasCachedIndex) {
        recordResidentReadMiss('noIndex')
      } else {
        const deletionGenForMiss = getDeletionGeneration(topicId)
        if (deletionGenForMiss !== 0) {
          recordResidentReadMiss('deletion')
        } else {
          const registryForMiss = (getState() as any).residentRegistry
          if (!registryForMiss) {
            // legacy empty (non-empty would have returned hit above)
            recordResidentReadMiss('legacyEmpty')
          } else {
            const entryForMiss = registryForMiss.entries?.[topicId]
            if (!entryForMiss) {
              recordResidentReadMiss('noEntry')
            } else if (!entryForMiss.residentTopic || !entryForMiss.chatData || !entryForMiss.segments) {
              recordResidentReadMiss('incomplete')
            } else {
              // Should have been hit above; fallback generic
              recordResidentReadMiss('incomplete')
            }
          }
        }
      }
    }

    try {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

      // Capture/bump per-topic applicability generation before both reads
      dispatch(bumpGeneration(topicId))
      const generation = ((getState() as any).residentRegistry?.entries?.[topicId]?.applicabilityGeneration ??
        0) as number

      const limitRaw = getState().messages.displayCount ?? INITIAL_MESSAGES_COUNT
      const limit = clampWindowLimit(limitRaw)
      const request: FetchMessagesWindowRequest = { kind: 'latest', topicId, limit }

      const requestSeq = ++loadTopicMessagesRequestSeq
      latestLoadTopicMessagesRequestByTopic.set(topicId, requestSeq)
      const deletionGenAtStart = captureDeletionGeneration(topicId)

      // Stage both latest window and segments under same generation
      const windowPromise: Promise<FetchMessagesWindowResponse> = runTopicWindowRead(topicId, request.kind, () =>
        dbService.fetchMessagesWindow(request)
      )
      // S7.14-E1: renderer.firstData — first eligible active-topic startup window
      // settlement after ordinaryTreeReady, elapsed interval, one-shot numeric-only,
      // default-off fail-closed. Eligibility proven via topic existence + pre-dispatch
      // active-topic equality before own setCurrentTopicId dispatch (independent of
      // self-assignment); settlement-time applicability predicate mirrors the thunk's
      // established stale validation (superseded same-topic sequence, deletion
      // generation, applicability generation, current-topic) so a request the thunk
      // discards is never recorded. Does not change message loading semantics;
      // fail-closed when cannot prove.
      try {
        if (eligibleBefore) {
          instrumentFirstDataWindow(windowPromise as unknown as Promise<unknown>, () => {
            try {
              const cur = getState().messages.currentTopicId
              const curTrim = typeof cur === 'string' ? cur.trim() : ''
              if (curTrim.length === 0 || curTrim !== trimmedBefore) return false
              if (latestLoadTopicMessagesRequestByTopic.get(topicId) !== requestSeq) return false
              if (isDeletionStale(topicId, deletionGenAtStart)) return false
              const currentGeneration = ((getState() as any).residentRegistry?.entries?.[topicId]
                ?.applicabilityGeneration ?? 0) as number
              if (currentGeneration !== generation) return false
              return true
            } catch {
              return false
            }
          })
        }
      } catch {}
      const segmentsPromise: Promise<any[]> = (
        dbService.listSegments ? dbService.listSegments(topicId) : Promise.resolve([])
      ) as Promise<any[]>

      let response: FetchMessagesWindowResponse
      let segmentsRaw: any[]
      const stagedStartMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
      let stagedSuccess = false
      try {
        ;[response, segmentsRaw] = await Promise.all([windowPromise, segmentsPromise])
        stagedSuccess = true
      } catch (e) {
        const stagedEndFail = typeof performance !== 'undefined' ? performance.now() : Date.now()
        recordStagedLatency(Math.max(0, stagedEndFail - stagedStartMs), false)
        logger.error(`[loadTopicMessagesThunk] staged fetch failed for ${topicId}:`, e as Error)
        throw e
      }
      {
        const stagedEndMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
        recordStagedLatency(Math.max(0, stagedEndMs - stagedStartMs), stagedSuccess)
      }

      // Validate stale/deletion/current-topic/request-sequence and generation still current
      if (latestLoadTopicMessagesRequestByTopic.get(topicId) !== requestSeq) {
        recordResidentReadDiscard('superseded')
        logger.warn(`[loadTopicMessagesThunk] stale window discard for ${topicId} (superseded same-topic request)`)
        return
      }

      const currentId = getState().messages.currentTopicId
      if (currentId !== null && currentId !== undefined && currentId !== topicId) {
        recordResidentReadDiscard('currentMoved')
        logger.warn(`[loadTopicMessagesThunk] stale window discard for ${topicId} (current moved)`)
        return
      }

      if (isDeletionStale(topicId, deletionGenAtStart)) {
        recordResidentReadDiscard('deletedDuringFetch')
        logger.warn(`[loadTopicMessagesThunk] stale window discard for ${topicId} (deleted during fetch)`)
        return
      }

      const currentGeneration = ((getState() as any).residentRegistry?.entries?.[topicId]?.applicabilityGeneration ??
        0) as number
      if (currentGeneration !== generation) {
        recordResidentReadDiscard('generationMismatch')
        logger.warn(`[loadTopicMessagesThunk] stale generation discard for ${topicId} (generation mismatch)`)
        return
      }

      if (!validateWindowResponse(request, response!)) {
        recordResidentReadDiscard('malformed')
        logger.error(`[loadTopicMessagesThunk] malformed window response for ${topicId}`, {
          window: (response as any)?.window
        } as unknown as Error)
        throw new Error('malformed window response')
      }

      logger.silly('Loaded window via DbService', {
        topicId,
        kind: response!.window.kind,
        returnedCount: response!.window.returnedCount,
        hasMoreBefore: response!.window.hasMoreBefore,
        hasMoreAfter: response!.window.hasMoreAfter
      })

      const segments = segmentsRaw.map((segment: any) => ({
        ...segment,
        name: segment.name ?? '',
        color: segment.color ?? undefined,
        createdAt: segment.createdAt ?? new Date().toISOString(),
        updatedAt: segment.updatedAt ?? new Date().toISOString()
      }))

      const hasRegistry = !!(getState() as any).residentRegistry
      // Retain authoritative completeness for viewport model (both joint and legacy paths)
      try {
        setLatestWindowCompleteness(topicId, {
          hasMoreBefore: response!.window.hasMoreBefore,
          hasMoreAfter: response!.window.hasMoreAfter
        })
      } catch {
        // best-effort
      }
      if (hasRegistry) {
        // Single controlled Redux publication consumed by relevant projection slices and registry
        dispatch(
          publishResidentComplete({
            topicId,
            generation,
            windowResponse: response!,
            segments
          })
        )
        // Preserve existing topicSegments/ StoreSync projection behavior when joint publication
        // updates segments, without broadcasting/syncing resident registry lifecycle state itself.
        // The joint publication atomically updates local segments via its extraReducer; a separate
        // syncable topicSegments/ action carries the same segments across windows via StoreSync.
        // Local duplicate is idempotent (same segments) and must not invalidate the
        // originating window's just-established residency — inbound StoreSync copies
        // (meta.fromSync:true) still invalidate receiving windows (LOCK-302).
        try {
          const syncAction = replaceSegmentsForTopic({ topicId, segments }) as any
          syncAction.meta = { ...syncAction.meta, isJointFollowUp: true }
          dispatch(syncAction)
        } catch {
          // best-effort StoreSync projection; never break joint publication
        }
      } else {
        // Legacy fallback for test environments without registry slice — preserve old two-dispatch path
        const blocks = response!.blocks as unknown as MessageBlock[]
        const messages = response!.messages as unknown as Message[]
        if (blocks.length > 0) {
          dispatch(upsertManyBlocks(blocks as any))
        }
        dispatch(newMessagesActions.messagesReceived({ topicId, messages } as any))
      }

      const loadedState = getState()
      const topicOwner = loadedState.assistants.assistants.find((asst) => asst.topics.some((t) => t.id === topicId))
      if (topicOwner) {
        await ensureTopicAnchorEstablished(dispatch, getState, topicOwner.id, topicId)
      }
      // Renderer-local retention enforcement after joint publication (admission while pinned).
      // Does not retain content; pinned topics are excluded via policy.
      try {
        const { enforceRetention } = await import('@renderer/services/residentRetention')
        enforceRetention(Date.now(), store as any)
      } catch {
        // best-effort retention enforcement; never break load
      }
    } catch (error) {
      logger.error(`Failed to load messages for topic ${topicId}:`, error as Error)
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
export const updateMessage = async (
  topicId: string,
  messageId: string,
  updates: Partial<Message>,
  resendAttemptId?: string
): Promise<void> => {
  try {
    await dbService.updateMessage(topicId, messageId, updates, resendAttemptId)
    logger.silly('Updated message via DbService', { topicId, messageId })
  } catch (error) {
    logger.error('Failed to update message:', { topicId, messageId, error })
    throw error
  }
}

/**
 * Update a single message block
 */
export const updateSingleBlock = async (
  blockId: string,
  updates: Partial<MessageBlock>,
  streamDiag?: StreamWriteDiagnostics,
  resendAttemptId?: string
): Promise<void> => {
  try {
    await dbService.updateSingleBlock(blockId, updates, streamDiag, resendAttemptId)
    logger.silly('Updated single block via DbService', { blockId })
  } catch (error) {
    logger.error('Failed to update single block:', { blockId, error })
    throw error
  }
}

/**
 * Bulk add message blocks (for new blocks)
 */
export const bulkAddBlocks = async (blocks: MessageBlock[], resendAttemptId?: string): Promise<void> => {
  try {
    await dbService.bulkAddBlocks(blocks, resendAttemptId)
    logger.silly('Bulk added blocks via DbService', { count: blocks.length })
  } catch (error) {
    logger.error('Failed to bulk add blocks:', { count: blocks.length, error })
    throw error
  }
}

/**
 * Update multiple message blocks (upsert operation)
 */
export const updateBlocks = async (
  blocks: MessageBlock[],
  streamDiag?: StreamWriteDiagnostics,
  resendAttemptId?: string
): Promise<void> => {
  try {
    await dbService.updateBlocks(blocks, streamDiag, resendAttemptId)
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

  // Ordinary IM channel execution: no resend attempt, but still wired with a
  // barrier + flush so completion paths share the same quiescence semantics.
  // Request-local execution state, same as ordinary chat (Redux only a mirror).
  const channelBarrier = new WriteBarrier()
  const channelExecutionState = createAssistantExecutionState(assistantMessage, getState)
  const channelIsLoaded = () => {
    try {
      return !!getState().messages.entities[assistantMessage.id]
    } catch {
      return false
    }
  }
  const blockManager = new BlockManager({
    dispatch,
    getState,
    saveUpdatedBlockToDB,
    saveUpdatesToDB,
    assistantMsgId: assistantMessage.id,
    topicId,
    barrier: channelBarrier,
    executionState: channelExecutionState,
    throttledBlockUpdate: (
      id: string,
      blockUpdate: any,
      _attemptId?: string,
      barrier?: WriteBarrier,
      shouldMirror?: () => boolean
    ) =>
      throttledBlockUpdate(id, blockUpdate, {
        barrier: barrier ?? channelBarrier,
        shouldMirrorToRedux: shouldMirror ?? channelIsLoaded
      }),
    flushThrottledBlockUpdate,
    cancelThrottledBlockUpdate
  })

  const callbacks = createCallbacks({
    blockManager,
    dispatch,
    getState,
    topicId,
    assistantMsgId: assistantMessage.id,
    executionState: channelExecutionState,
    saveUpdatesToDB,
    // Ordinary IM channel execution: no resend attempt (carrier omitted), but
    // the same single-transaction final checkpoint as ordinary chat.
    saveFinalUpdatesAtomically: (
      messageId: string,
      channelTopicId: string,
      messageUpdates: Partial<Message>,
      blocksToUpdate: MessageBlock[]
    ): Promise<FileCleanupResult> =>
      saveFinalMessageAndBlocksAtomically(channelTopicId, messageId, messageUpdates, blocksToUpdate),
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
