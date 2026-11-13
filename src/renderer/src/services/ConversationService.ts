import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { isValidContextClosureResponse } from '@renderer/services/contextClosure'
import { computeContextInfo, filterContextUiMessages } from '@renderer/services/contextInfoService'
import { dbService } from '@renderer/services/db'
import { excludeFoldedMessages, isMessageFolded } from '@renderer/services/foldedSegmentService'
import {
  notifyUnavailableAttachmentsSkipped,
  type RequestAttachmentFilter,
  resolveRequestAttachmentAvailability
} from '@renderer/services/requestAttachmentAvailability'
import type { BlockOverlay } from '@renderer/services/requestBlockOverlay'
import { buildBlockOverlay, mergeBlockOverlays } from '@renderer/services/requestBlockOverlay'
import type { Assistant } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
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

/**
 * Outcome of one request preparation.
 *
 * `nothingSendable` is set when the triggering message provably has nothing
 * left to send (every attachment it carries is unavailable on this device and
 * it has no other content). The caller ends the operation as an explicit no-op:
 * no provider request and no request-error chunk, so no assistant/error block
 * is produced. The trigger-scoped top notice has already been emitted here.
 */
export interface PrepareMessagesResult {
  modelMessages: ModelMessage[]
  uiMessages: Message[]
  nothingSendable?: boolean
  /**
   * The request-local attachment view this preparation resolved. Every consumer
   * of the returned `uiMessages` that reads attachment payloads itself (the
   * dedicated image-generation path collects images straight from these
   * messages) MUST apply the same filter, otherwise a block excluded from the
   * request view would still be read and sent through that side path.
   */
  attachmentFilter?: RequestAttachmentFilter
}

export class ConversationService {
  static async prepareMessagesForModel(
    messages: Message[],
    assistant: Assistant,
    topicId?: string,
    authorityUser?: AuthorityUserSnapshot,
    branchId?: string | null
  ): Promise<PrepareMessagesResult> {
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
      // Request-local attachment availability: imported/degraded attachments
      // whose payload is missing never abort this request; only provably
      // unavailable attachments are excluded, and the trigger-scoped notice is
      // emitted once. Nothing is persisted.
      const attachmentView = await ConversationService.applyAttachmentAvailability(
        uiMessages,
        overlay,
        lastUserMessage.id
      )
      uiMessages = attachmentView.uiMessages
      if (attachmentView.nothingSendable) {
        return { modelMessages: [], uiMessages, nothingSendable: true }
      }
      return {
        modelMessages: await convertMessagesToSdkMessages(uiMessages, model, overlay, attachmentView.attachmentFilter),
        uiMessages,
        attachmentFilter: attachmentView.attachmentFilter
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
    // Folded (collapsed) groups take no part in an actual request. The
    // exclusion list is Main authority carried by this same closure response
    // (`foldedMessageIds`), never the renderer segment projection: a stale or
    // unloaded catalog can therefore never let a folded body reach a provider,
    // and folding is not claimed absent merely because a window is unloaded.
    // The exclusion is unconditional: a folded member is excluded even when it
    // is the message this request would answer (a historical retry/resend
    // pointing into the group), so folding can never leak a hidden body back
    // into the provider payload. Providers therefore never receive folded
    // bodies, and expanding a group restores participation at its existing
    // position without moving the window origin.
    const authoritativeFoldedIds = closureResponse.closure.foldedMessageIds
    const participatingClosureMessages = excludeFoldedMessages(closureMessages, authoritativeFoldedIds)
    // A request always carries its own prompt. When the trigger itself is a
    // folded member there is nothing to answer from: the fold exclusion wins
    // over the trigger, so this fails closed through the existing request error
    // path instead of sending an empty request (or silently re-injecting the
    // hidden body back in).
    if (isMessageFolded(triggerId, authoritativeFoldedIds)) {
      throw new Error(
        `[ConversationService] triggering message ${triggerId} belongs to a folded context group for route ${anchorKey}; refusing a request without its prompt`
      )
    }

    // Clip the full closure through the triggering user inclusive (stable ID),
    // keeping the existing last-assistant/filter policy downstream. Future
    // queued users and assistant stubs after the trigger are excluded.
    const triggerIndex = participatingClosureMessages.findIndex((m) => m?.id === triggerId)
    let requestMessages: Message[]
    let requestOverlay = overlay
    if (triggerIndex === -1) {
      // Trigger before this route's persisted anchor (insert above the
      // boundary, and a historical resend/edit-resend on the same path). The
      // anchored closure cannot carry it: it starts AT the anchor. This one
      // request is temporary and anchor-free — it carries the authoritative
      // effective-route history above the trigger plus the trigger itself,
      // read at full-route scope and clipped at the trigger. The persisted
      // anchor, the boundary divider and the origin of later regular requests
      // are not read, widened, re-derived, or written here.
      const preAnchorHistory = await ConversationService.readPreAnchorHistory(
        topicId,
        pinnedRoute,
        triggerId,
        anchorKey,
        authorityUser
      )
      // Same authority exclusion set, read in the same snapshot: a fold is
      // respected above the anchor too (never re-enabled by position).
      requestMessages = excludeFoldedMessages(preAnchorHistory.messages, preAnchorHistory.foldedMessageIds)
      requestOverlay = mergeBlockOverlays(buildBlockOverlay(preAnchorHistory.blocks), authorityUser?.blocks)
    } else if (authorityUser && authorityUser.message.id === triggerId) {
      // Fresh triggering object (edited resend) at the same stable position.
      requestMessages = [...participatingClosureMessages.slice(0, triggerIndex), authorityUser.message]
    } else {
      requestMessages = participatingClosureMessages.slice(0, triggerIndex + 1)
    }

    // Message conversion boundary: the validated closure (or, above the
    // anchor, the caller-local complete route read clipped at the trigger) is
    // already the authoritative slice, and the trigger clip above already
    // bounded it. Only the shared message-level filter pipeline runs here — no
    // turn regrouping, no anchor re-resolution, no window re-derivation from
    // this bounded slice, and no token-estimation list (never consumed on the
    // request path).
    // Turn participation: context turns are built from user/assistant/system
    // rows, so a row with a nullable/unknown role is in authority order but in
    // no turn and is never part of the request window.
    const contextTurnMessages = requestMessages.filter(
      (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system'
    )
    let uiMessages = filterContextUiMessages(contextTurnMessages, requestOverlay)
    if (uiMessages.length === 0) {
      const triggerMessage = requestMessages.find((m) => m?.id === triggerId)
      if (triggerMessage) {
        uiMessages = [triggerMessage]
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

    // Request-local attachment availability (same boundary as the local-helper
    // path): imported/degraded attachments whose payload is missing are excluded
    // from this request only, with a single trigger-scoped notice. Genuine
    // failures of present attachments keep aborting in the converter.
    const attachmentView = await ConversationService.applyAttachmentAvailability(uiMessages, requestOverlay, triggerId)
    uiMessages = attachmentView.uiMessages
    if (attachmentView.nothingSendable) {
      return { modelMessages: [], uiMessages, nothingSendable: true }
    }

    return {
      modelMessages: await convertMessagesToSdkMessages(
        uiMessages,
        model,
        requestOverlay,
        attachmentView.attachmentFilter
      ),
      uiMessages,
      attachmentFilter: attachmentView.attachmentFilter
    }
  }
  /**
   * Authoritative history above this route's persisted anchor.
   *
   * The anchored closure starts AT the anchor, so a trigger that precedes the
   * anchor (insert above the boundary, historical resend/edit-resend on the
   * same path) is not in it by construction. Its history therefore comes from
   * the same authority at full-route scope: one caller-local complete
   * effective-route read (never the loaded viewport, never a shared projection
   * hydration, never a `contextCount` window), clipped at the triggering user
   * inclusive. Nothing after the trigger — including the trigger's existing
   * replies — belongs to this request. No anchor is read, derived, widened, or
   * persisted here: the route's persisted anchor, boundary divider, and the
   * origin of later regular requests are untouched.
   *
   * Missing/invalid route history and a trigger that is not on the addressed
   * route both fail closed; the loaded projection is never a substitute.
   */
  private static async readPreAnchorHistory(
    topicId: string,
    pinnedRoute: string | null,
    triggerId: string,
    anchorKey: string,
    authorityUser?: AuthorityUserSnapshot
  ): Promise<{ messages: Message[]; blocks: MessageBlock[]; foldedMessageIds: string[] }> {
    const snapshot = await dbService.fetchWholeTopicSnapshot(topicId, pinnedRoute)
    if (snapshot?.snapshot?.completeness !== 'whole-topic' || snapshot.snapshot.topicId !== topicId) {
      throw new Error(
        `[ConversationService] invalid route history for route ${anchorKey}; refusing partial viewport request`
      )
    }
    // Fold exclusion for this path comes from the same Main snapshot response,
    // never from the renderer segment catalog (which may be unloaded or stale).
    // A missing/invalid list fails closed through the existing request error
    // path rather than risking a leak of folded history.
    const foldedMessageIds = snapshot.snapshot.foldedMessageIds
    if (
      !Array.isArray(foldedMessageIds) ||
      foldedMessageIds.some((id) => typeof id !== 'string' || id.length === 0) ||
      new Set(foldedMessageIds).size !== foldedMessageIds.length
    ) {
      throw new Error(
        `[ConversationService] invalid folded exclusion set for route ${anchorKey}; refusing partial viewport request`
      )
    }
    const routeMessages = snapshot.messages as unknown as Message[]
    const triggerIndex = routeMessages.findIndex((m) => m?.id === triggerId)
    if (triggerIndex === -1) {
      throw new Error(
        `[ConversationService] triggering user ${triggerId} not in authority route ${anchorKey}; refusing partial viewport request`
      )
    }
    const messages = routeMessages.slice(0, triggerIndex + 1)
    if (authorityUser && authorityUser.message.id === triggerId) {
      // Fresh triggering object (edited resend) at the same stable position.
      messages[messages.length - 1] = authorityUser.message
    }
    return { messages, blocks: snapshot.blocks as unknown as MessageBlock[], foldedMessageIds }
  }

  /**
   * Resolve the request-local attachment availability view for one conversion.
   *
   * Attachments that provably have no payload on this device are excluded from
   * the request (never deleted, repaired, or persisted) and the triggering
   * message's skipped attachments produce exactly one aggregated notice.
   * Anything that merely fails to convert stays in the request and keeps the
   * existing attachment error behavior.
   *
   * A triggering message left with nothing to send is reported as
   * `nothingSendable` rather than thrown: an empty provider request must not be
   * issued, and the outcome must not travel the request-error channel (that is
   * what produces an inline failed answer). The caller ends the operation
   * quietly; the top notice above is the whole user-visible result.
   */
  private static async applyAttachmentAvailability(
    uiMessages: Message[],
    overlay: BlockOverlay | undefined,
    triggerId: string | undefined
  ): Promise<{ uiMessages: Message[]; attachmentFilter: RequestAttachmentFilter; nothingSendable: boolean }> {
    const availability = await resolveRequestAttachmentAvailability(uiMessages, overlay, triggerId)
    if (availability.triggerUnavailableAttachmentCount > 0) {
      notifyUnavailableAttachmentsSkipped(availability.triggerUnavailableAttachmentCount)
    }
    return {
      uiMessages: availability.messages,
      attachmentFilter: availability.filter,
      nothingSendable: !availability.triggerHasSendableContent
    }
  }

  static needsKnowledgeSearch(assistant: Assistant): boolean {
    return !isEmpty(assistant.knowledge_bases)
  }
}
