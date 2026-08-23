import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import { computeClosureFingerprint, getFreshValidatedClosure } from '@renderer/services/contextClosure'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { createNoModelError } from '@renderer/utils/noModelError'
import type { ModelMessage } from 'ai'
import { findLast, isEmpty } from 'lodash'

import { getDefaultModel } from './AssistantService'

const logger = loggerService.withContext('ConversationService')

export class ConversationService {
  static async prepareMessagesForModel(
    messages: Message[],
    assistant: Assistant,
    topicId?: string
  ): Promise<{ modelMessages: ModelMessage[]; uiMessages: Message[] }> {
    const lastUserMessage = findLast(messages, (m) => m.role === 'user')
    if (!lastUserMessage) {
      return {
        modelMessages: [],
        uiMessages: []
      }
    }

    // R-06: attempt freshness-gated closure cache for single resolver semantics (centralized helper).
    // Structural + anchor + generation/fingerprint freshness; fail-closed to viewport when freshness cannot be proven.
    let contextMessages: Message[] = messages
    if (topicId) {
      const anchorGroupKey = getAssistantSettings(assistant).contextWindowAnchor?.[topicId]?.groupKey ?? null
      if (anchorGroupKey) {
        const currentFp = computeClosureFingerprint(messages as any)
        const fresh = getFreshValidatedClosure(topicId, anchorGroupKey, currentFp)
        if (fresh) {
          contextMessages = fresh.messages as unknown as Message[]
        }
      }
    }
    // Use the unified pipeline — same filtering as computeContextInfo
    const { uiMessages: uiMessagesFromPipeline } = computeContextInfo(contextMessages, assistant, topicId)
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
      modelMessages: await convertMessagesToSdkMessages(uiMessages, model),
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
