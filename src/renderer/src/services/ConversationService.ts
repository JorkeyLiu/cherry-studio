import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import type { Assistant, ContextWindowMode, TopicAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { filterAdjacentUserMessaegs, filterLastAssistantMessage } from '@renderer/utils/messageUtils/filters'
import type { ModelMessage } from 'ai'
import { findLast, isEmpty, takeRight } from 'lodash'

import { resolveAnchorSliceStart } from './anchorService'
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
    anchor?: TopicAnchor
  ): Message[] {
    const messagesAfterContextClear = filterAfterContextClearMessages(messages)
    const usefulMessages = filterUsefulMessages(messagesAfterContextClear)
    // Run the error-only filter before trimming trailing assistant responses so the pair is removed together.
    const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)
    const withoutTrailingAssistant = filterLastAssistantMessage(withoutErrorOnlyPairs)
    const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)

    let limitedByContext: Message[]
    if (contextWindowMode === 'fixed' && anchor !== undefined) {
      if (anchor.kind === 'vacant') {
        // vacant: 全量不截断
        limitedByContext = withoutAdjacentUsers
      } else {
        // active: 从 groupKey 对应的组起点 slice 到尾
        const sliceStart = resolveAnchorSliceStart(withoutAdjacentUsers, anchor.groupKey)
        if (sliceStart >= 0) {
          limitedByContext = withoutAdjacentUsers.slice(sliceStart)
        } else {
          // 组被过滤掉了，退化为全量不截断（等同 vacant 行为）
          limitedByContext = withoutAdjacentUsers
        }
      }
    } else {
      // Sliding mode: keep the last contextCount + 2 messages
      limitedByContext = takeRight(withoutAdjacentUsers, contextCount + 2)
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
    const { contextCount, contextWindowMode, topicContextWindowMode, fixedWindowAnchor } =
      getAssistantSettings(assistant)
    // This logic is extracted from the original ApiService.fetchChatCompletion
    // const contextMessages = filterContextMessages(messages)
    const lastUserMessage = findLast(messages, (m) => m.role === 'user')
    if (!lastUserMessage) {
      return {
        modelMessages: [],
        uiMessages: []
      }
    }

    const anchor = topicId ? fixedWindowAnchor?.[topicId] : undefined
    const topicMode = topicId ? topicContextWindowMode?.[topicId] : undefined
    const effectiveMode = topicMode ?? contextWindowMode
    const uiMessagesFromPipeline = ConversationService.filterMessagesPipeline(
      messages,
      contextCount,
      effectiveMode,
      anchor
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
