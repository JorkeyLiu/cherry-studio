import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
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

    // Use the unified pipeline — same filtering as computeContextInfo
    const { uiMessages: uiMessagesFromPipeline } = computeContextInfo(messages, assistant, topicId)
    logger.debug('uiMessagesFromPipeline', uiMessagesFromPipeline)

    // Fallback: ensure at least the last user message is present to avoid empty payloads
    let uiMessages = uiMessagesFromPipeline
    if ((!uiMessages || uiMessages.length === 0) && lastUserMessage) {
      uiMessages = [lastUserMessage]
    }

    return {
      modelMessages: await convertMessagesToSdkMessages(uiMessages, assistant.model || getDefaultModel()),
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
