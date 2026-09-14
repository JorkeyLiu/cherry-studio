import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { computeClosureFingerprint, getFreshValidatedClosure } from '@renderer/services/contextClosure'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import type { BlockOverlay } from '@renderer/services/requestBlockOverlay'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
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
    authorityUser?: AuthorityUserSnapshot
  ): Promise<{ modelMessages: ModelMessage[]; uiMessages: Message[] }> {
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

    // R-06: attempt freshness-gated closure cache for single resolver semantics (centralized helper).
    // Structural + anchor + generation/fingerprint freshness; fail-closed to viewport when freshness cannot be proven.
    // Authority overlay never routes through the closure cache: the closure is
    // keyed on loaded-projection fingerprints and must not swallow the
    // request-local authority user.
    let contextMessages: Message[] = effectiveMessages
    if (topicId && !authorityUser) {
      const anchorGroupKey = getAssistantSettings(assistant).contextWindowAnchor?.[topicId]?.groupKey ?? null
      if (anchorGroupKey) {
        const currentFp = computeClosureFingerprint(effectiveMessages as any)
        const fresh = getFreshValidatedClosure(topicId, anchorGroupKey, currentFp)
        if (fresh) {
          contextMessages = fresh.messages as unknown as Message[]
        }
      }
    }
    // Use the unified pipeline — same filtering as computeContextInfo
    const { uiMessages: uiMessagesFromPipeline } = computeContextInfo(contextMessages, assistant, topicId, overlay)
    const model = assistant.model || getDefaultModel()
    if (!model) {
      // Unconfigured model slot: emit the stable NoModelError marker so
      // ErrorBlock classifies it as `no_model` with the provider-settings
      // recovery action. Same category as the ApiService resolver guard.
      throw createNoModelError()
    }
    logger.debug('uiMessagesFromPipeline', uiMessagesFromPipeline)

    // Fallback: ensure at least the last user message is present to avoid empty payloads
    let uiMessages = uiMessagesFromPipeline
    if ((!uiMessages || uiMessages.length === 0) && lastUserMessage) {
      uiMessages = [lastUserMessage]
    }

    return {
      modelMessages: await convertMessagesToSdkMessages(uiMessages, model, overlay),
      uiMessages
    }
  }

  static needsWebSearch(assistant: Assistant): boolean {
    return !!assistant.webSearchProviderId
  }

  static needsKnowledgeSearch(assistant: Assistant): boolean {
    return !isEmpty(assistant.knowledge_bases)
  }
}
