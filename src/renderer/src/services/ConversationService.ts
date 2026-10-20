import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { isValidContextClosureResponse } from '@renderer/services/contextClosure'
import { computeContextInfo, filterContextUiMessages } from '@renderer/services/contextInfoService'
import { dbService } from '@renderer/services/db'
import type { BlockOverlay } from '@renderer/services/requestBlockOverlay'
import { buildBlockOverlay, mergeBlockOverlays } from '@renderer/services/requestBlockOverlay'
import type { Assistant } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { filterEmptyMessages } from '@renderer/utils/messageUtils/filters'
import { createNoModelError } from '@renderer/utils/noModelError'
import type { ModelMessage } from 'ai'
import { findLast, isEmpty } from 'lodash'

import { getDefaultModel } from './AssistantService'

const logger = loggerService.withContext('ConversationService')

/**
 * Authority user snapshot for semantic resend/regenerate request conversion.
 * Carries the Main-authoritative user message + blocks so the last-user
 * content resolves without injecting window-outside blocks into Redux.
 */
export interface AuthorityUserSnapshot {
  message: Message
  blocks: BlockOverlay
}

export class ConversationService {
  static async prepareMessagesForModel(
    messages: Message[],
    assistant: Assistant,
    topicId?: string,
    authorityUser?: AuthorityUserSnapshot,
    branchId?: string | null
  ): Promise<{ modelMessages: ModelMessage[]; uiMessages: Message[] }> {
    // Trigger boundary: the initiating last-user request. The caller slice is
    // already clipped to the triggering user (messageThunk); the full
    // authority closure below must never include later queued user turns or
    // the assistant stub after this trigger.
    let triggerId: string | undefined
    if (authorityUser) {
      triggerId = authorityUser.message.id
    } else {
      const lastUserMessage = findLast(messages, (m) => m.role === 'user')
      if (!lastUserMessage) {
        return {
          modelMessages: [],
          uiMessages: []
        }
      }
      triggerId = lastUserMessage.id
    }
    if (!triggerId) {
      return {
        modelMessages: [],
        uiMessages: []
      }
    }

    // No-topic local helpers (summary/translate/ephemeral): retain the
    // existing bounded projection behavior. No authority read, no anchor.
    if (!topicId) {
      let effectiveMessages = messages
      let overlay: BlockOverlay | undefined
      if (authorityUser) {
        overlay = authorityUser.blocks
        const hasUser = effectiveMessages.some((m) => m.id === authorityUser.message.id)
        if (!hasUser) {
          effectiveMessages = [...effectiveMessages, authorityUser.message]
        }
      }
      const lastUserMessage = findLast(effectiveMessages, (m) => m.role === 'user')
      if (!lastUserMessage) {
        return {
          modelMessages: [],
          uiMessages: []
        }
      }
      const { uiMessages: uiMessagesFromPipeline } = computeContextInfo(
        effectiveMessages,
        assistant,
        topicId,
        overlay,
        branchId ?? null
      )
      const model = assistant.model || getDefaultModel()
      if (!model) {
        throw createNoModelError()
      }
      logger.debug('uiMessagesFromPipeline', uiMessagesFromPipeline)
      let uiMessages = uiMessagesFromPipeline
      if ((!uiMessages || uiMessages.length === 0) && lastUserMessage) {
        uiMessages = [lastUserMessage]
      }
      return {
        modelMessages: await convertMessagesToSdkMessages(uiMessages, model, overlay),
        uiMessages
      }
    }

    // Topic request path: actual outbound window correctness. The request
    // preparation acquires a caller-local Main complete effective-route
    // anchor-to-end closure before constructing model messages whenever the
    // topic carries a persisted active-route anchor. Pinned branchId (never
    // the current active) addresses the effective route. No UI cache warmup,
    // no ephemeral cache publish, no viewport/Redux full hydration.
    // The persisted anchor snapshot is captured once here; the Main single
    // response is the current transaction for this request (request-local
    // snapshot per ADR). Persisted anchors are never reread, overwritten, or
    // default-derived in this service.
    const pinnedRoute = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
    const anchorKey = pinnedRoute ? `${topicId}:${pinnedRoute}` : topicId
    const anchorGroupKey = getAssistantSettings(assistant).contextWindowAnchor?.[anchorKey]?.groupKey ?? null
    if (!anchorGroupKey) {
      // Initialized topics establish the anchor before queueing (send await);
      // a missing anchor here is fail-closed, never a silent viewport default.
      throw new Error(
        `[ConversationService] missing persisted context anchor for route ${anchorKey}; refusing partial viewport request`
      )
    }

    let closureResponse: Awaited<ReturnType<typeof dbService.fetchContextClosure>>
    try {
      closureResponse = await dbService.fetchContextClosure({
        topicId,
        branchId: pinnedRoute,
        anchorGroupKey
      })
    } catch (error) {
      // Real authority read failure must NOT fall back to a partial
      // projection; it errors via the existing request error path
      // (transformMessagesAndFetch emits the ERROR chunk).
      throw error
    }
    if (!isValidContextClosureResponse({ topicId, anchorGroupKey, branchId: pinnedRoute }, closureResponse as any)) {
      throw new Error(
        `[ConversationService] invalid context closure for route ${anchorKey}; refusing partial viewport request`
      )
    }
    const closureMessages = closureResponse.messages as unknown as Message[]
    const closureBlocks = closureResponse.blocks as unknown as MessageBlock[]
    // Readonly request-local overlay from the closure blocks, merged with the
    // authority-user override (override wins) so fresh triggering data
    // resolves off-viewport blocks without mutating Redux.
    const closureOverlay = buildBlockOverlay(closureBlocks)
    const overlay = mergeBlockOverlays(closureOverlay, authorityUser?.blocks)

    // Clip the full closure through the triggering user inclusive (stable ID),
    // keeping the existing last-assistant/filter policy downstream. Future
    // queued users and assistant stubs after the trigger are excluded.
    const triggerIndex = closureMessages.findIndex((m) => m?.id === triggerId)
    let requestMessages: Message[]
    let preAnchorAvailability = false
    if (triggerIndex === -1) {
      if (authorityUser && authorityUser.message.id === triggerId) {
        // Retry/regenerate target precedes the current anchor: preserve the
        // explicitly designed lastUser-availability semantic (at least the
        // triggering user is sent) without widening the anchor or deriving a
        // silent default. The anchor window (future relative to the target)
        // is not included.
        requestMessages = [authorityUser.message]
        preAnchorAvailability = true
      } else {
        throw new Error(
          `[ConversationService] triggering user ${triggerId} not in authority closure for route ${anchorKey}; refusing partial viewport request`
        )
      }
    } else if (authorityUser && authorityUser.message.id === triggerId) {
      // Fresh triggering object (edited resend) at the same stable position.
      requestMessages = [...closureMessages.slice(0, triggerIndex), authorityUser.message]
    } else {
      requestMessages = closureMessages.slice(0, triggerIndex + 1)
    }

    // Message conversion boundary: the validated closure is already the
    // authoritative anchor-to-end slice, and the trigger clip above already
    // bounded it. Only the shared message-level filter pipeline runs here — no
    // turn regrouping, no anchor re-resolution, no window re-derivation from
    // this bounded slice, and no token-estimation list (never consumed on the
    // request path).
    let uiMessages: Message[]
    if (preAnchorAvailability) {
      const nonEmpty = filterEmptyMessages(requestMessages, overlay)
      uiMessages = nonEmpty.length > 0 ? nonEmpty : requestMessages
    } else {
      // Turn participation: context turns are built from user/assistant/system
      // rows, so a row with a nullable/unknown role is in authority order but in
      // no turn and is never part of the request window.
      const contextTurnMessages = requestMessages.filter(
        (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system'
      )
      uiMessages = filterContextUiMessages(contextTurnMessages, overlay)
      if (uiMessages.length === 0) {
        const triggerMessage = requestMessages.find((m) => m?.id === triggerId)
        if (triggerMessage) {
          uiMessages = [triggerMessage]
        }
      }
    }

    const model = assistant.model || getDefaultModel()
    if (!model) {
      // Unconfigured model slot: emit the stable NoModelError marker so
      // ErrorBlock classifies it as `no_model` with the provider-settings
      // recovery action. Same category as the ApiService resolver guard.
      throw createNoModelError()
    }
    logger.debug('uiMessagesFromPipeline', uiMessages)

    return {
      modelMessages: await convertMessagesToSdkMessages(uiMessages, model, overlay),
      uiMessages
    }
  }

  static needsKnowledgeSearch(assistant: Assistant): boolean {
    return !isEmpty(assistant.knowledge_bases)
  }
}
