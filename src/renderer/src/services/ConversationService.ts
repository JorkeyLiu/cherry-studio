import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import type { Assistant, ContextWindowMode, Message } from '@renderer/types'
import { filterAdjacentUserMessaegs, filterLastAssistantMessage } from '@renderer/utils/messageUtils/filters'
import type { ModelMessage } from 'ai'
import { isEmpty } from 'lodash-es'

import { getAssistantSettings, getDefaultModel } from './AssistantService'
import {
  filterAfterContextClearMessages,
  filterEmptyMessages,
  filterErrorOnlyMessagesWithRelated,
  filterUsefulMessages,
  filterUserRoleStartMessages
} from './MessagesService'

const logger = loggerService.withContext('ConversationService')

export class ConversationService {
  /**
   * Applies the filtering pipeline that prepares UI messages for model consumption.
   * This keeps the logic testable and prevents future regressions when the pipeline changes.
   */
  static filterMessagesPipeline(
    messages: Message[],
    contextCount: number,
    contextWindowMode?: ContextWindowMode,
    anchorMessageId?: string
  ): Message[] {
    const messagesAfterContextClear = filterAfterContextClearMessages(messages)
    const usefulMessages = filterUsefulMessages(messagesAfterContextClear)
    // Run the error-only filter before trimming trailing assistant responses so the pair is removed together.
    const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)
    const withoutTrailingAssistant = filterLastAssistantMessage(withoutErrorOnlyPairs)
    const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)

    let limitedByContext: Message[]
    if (contextWindowMode === 'fixed' && anchorMessageId) {
      const anchorIndex = withoutAdjacentUsers.findIndex((m) => m.id === anchorMessageId)
      if (anchorIndex >= 0) {
        limitedByContext = withoutAdjacentUsers.slice(anchorIndex)
      } else {
        // Anchor message not found (deleted?), fallback to sliding
        limitedByContext = withoutAdjacentUsers.slice(-(contextCount + 2))
      }
    } else {
      // Sliding mode: keep the last contextCount + 2 messages
      limitedByContext = withoutAdjacentUsers.slice(-(contextCount + 2))
    }

    const contextClearFiltered = filterAfterContextClearMessages(limitedByContext)
    const nonEmptyMessages = filterEmptyMessages(contextClearFiltered)
    const userRoleStartMessages = filterUserRoleStartMessages(nonEmptyMessages)
    return userRoleStartMessages
  }

  static async prepareMessagesForModel(
    messages: Message[],
    assistant: Assistant,
    topicId?: string
  ): Promise<{ modelMessages: ModelMessage[]; uiMessages: Message[] }> {
    const { contextCount, contextWindowMode, fixedWindowAnchor } = getAssistantSettings(assistant)
    // This logic is extracted from the original ApiService.fetchChatCompletion
    // const contextMessages = filterContextMessages(messages)
    const lastUserMessage = messages.findLast((m) => m.role === 'user')
    if (!lastUserMessage) {
      return {
        modelMessages: [],
        uiMessages: []
      }
    }

    const anchorMessageId = topicId ? fixedWindowAnchor?.[topicId] : undefined
    const uiMessagesFromPipeline = ConversationService.filterMessagesPipeline(
      messages,
      contextCount,
      contextWindowMode,
      anchorMessageId
    )
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
