/**
 * 知识库编排插件（knowledge orchestration）
 *
 * 仅负责知识库意图识别与工具注入：
 * 1. onRequestStart: 分析是否需要知识库搜索
 * 2. transformParams: 根据意图分析结果动态添加知识库工具
 *
 * 不包含外部网络搜索、提供商原生检索、全局记忆/MCP 能力。
 */
import {
  type AiPlugin,
  type AiRequestContext,
  definePlugin,
  type StreamTextParams,
  type StreamTextResult
} from '@cherrystudio/ai-core'
import { loggerService } from '@logger'
import { SEARCH_SUMMARY_PROMPT_KNOWLEDGE_ONLY } from '@renderer/config/prompts'
import { fetchGenerate } from '@renderer/services/ApiService'
import { getDefaultModel, getProviderByModel } from '@renderer/services/AssistantService'
import type { Assistant } from '@renderer/types'
import type { ExtractResults } from '@renderer/utils/extract'
import { extractInfoFromXML } from '@renderer/utils/extract'
import type { ModelMessage } from 'ai'
import { isEmpty } from 'lodash'

import { knowledgeSearchTool } from '../tools/KnowledgeSearchTool'

const logger = loggerService.withContext('KnowledgeOrchestrationPlugin')

export const getMessageContent = (message: ModelMessage) => {
  if (typeof message.content === 'string') return message.content
  return message.content.reduce((acc, part) => {
    if (part.type === 'text') {
      return acc + part.text + '\n'
    }
    return acc
  }, '')
}

async function analyzeKnowledgeIntent(
  lastUserMessage: ModelMessage,
  assistant: Assistant,
  options: {
    shouldKnowledgeSearch?: boolean
    lastAnswer?: ModelMessage
    context: AiRequestContext
    topicId: string
  }
): Promise<ExtractResults | undefined> {
  const { shouldKnowledgeSearch = false, lastAnswer, context } = options

  if (!lastUserMessage) return undefined
  if (!shouldKnowledgeSearch) return undefined

  const prompt = SEARCH_SUMMARY_PROMPT_KNOWLEDGE_ONLY
  const chatHistory = lastAnswer ? `assistant: ${getMessageContent(lastAnswer)}` : ''
  const question = getMessageContent(lastUserMessage) || ''
  const formattedPrompt = prompt.replace('{chat_history}', chatHistory).replace('{question}', question)

  const model = assistant.model || getDefaultModel()
  if (!model) {
    logger.error('No model configured for knowledge orchestration')
    return getFallbackResult()
  }
  const provider = getProviderByModel(model)

  if (!provider || isEmpty(provider.apiKey)) {
    logger.error('Provider not found or missing API key')
    return getFallbackResult()
  }
  try {
    logger.info('Starting knowledge intent analysis', {
      modelId: model.id,
      topicId: options.topicId,
      requestId: context.requestId
    })

    const result = await fetchGenerate({
      model,
      prompt: formattedPrompt,
      content: ''
    }).finally(() => {
      logger.info('Knowledge intent analysis call completed', {
        modelId: model.id,
        topicId: options.topicId,
        requestId: context.requestId
      })
    })

    if (!result.trim()) {
      logger.warn('Knowledge intent analysis returned empty result, using fallback')
      return getFallbackResult()
    }

    const parsedResult = extractInfoFromXML(result)
    logger.debug('Knowledge intent analysis result', { parsedResult })

    return {
      websearch: undefined,
      knowledge: parsedResult?.knowledge
    }
  } catch (e: unknown) {
    logger.error('Knowledge intent analysis failed', e as Error)
    return getFallbackResult()
  }

  function getFallbackResult(): ExtractResults {
    const fallbackContent = getMessageContent(lastUserMessage)
    return {
      websearch: undefined,
      knowledge: shouldKnowledgeSearch
        ? {
            question: [fallbackContent || 'search'],
            rewrite: fallbackContent || 'search'
          }
        : undefined
    }
  }
}

/**
 * 知识库编排插件
 */
export const knowledgeOrchestrationPlugin = (
  assistant: Assistant,
  topicId: string
): AiPlugin<StreamTextParams, StreamTextResult> => {
  const intentAnalysisResults: { [requestId: string]: ExtractResults } = {}
  const userMessages: { [requestId: string]: ModelMessage } = {}

  return definePlugin<StreamTextParams, StreamTextResult>({
    name: 'knowledge-orchestration',
    enforce: 'pre',
    onRequestStart: async (context) => {
      if (!assistant.knowledge_bases?.length) return

      try {
        const messages = context.originalParams.messages
        if (!messages || messages.length === 0) {
          return
        }

        const lastUserMessage = messages[messages.length - 1]
        const lastAssistantMessage = messages.length >= 2 ? messages[messages.length - 2] : undefined

        userMessages[context.requestId] = lastUserMessage

        const knowledgeBaseIds = assistant.knowledge_bases?.map((base) => base.id)
        const hasKnowledgeBase = !isEmpty(knowledgeBaseIds)
        const knowledgeRecognition = assistant.knowledgeRecognition || 'off'
        const shouldKnowledgeSearch = hasKnowledgeBase && knowledgeRecognition === 'on'

        if (shouldKnowledgeSearch) {
          const analysisResult = await analyzeKnowledgeIntent(lastUserMessage, assistant, {
            shouldKnowledgeSearch,
            lastAnswer: lastAssistantMessage,
            context,
            topicId
          })

          if (analysisResult) {
            intentAnalysisResults[context.requestId] = analysisResult
          }
        }
      } catch (error) {
        logger.error('Knowledge intent analysis failed:', error as Error)
      }
    },

    transformParams: async (params, context) => {
      try {
        const analysisResult = intentAnalysisResults[context.requestId]

        if (!params.tools) {
          params.tools = {}
        }

        const knowledgeBaseIds = assistant.knowledge_bases?.map((base) => base.id)
        const hasKnowledgeBase = !isEmpty(knowledgeBaseIds)
        const knowledgeRecognition = assistant.knowledgeRecognition || 'off'
        const shouldKnowledgeSearch = hasKnowledgeBase && knowledgeRecognition === 'on'

        if (shouldKnowledgeSearch) {
          const needsKnowledgeSearch =
            analysisResult?.knowledge &&
            analysisResult.knowledge.question &&
            analysisResult.knowledge.question[0] !== 'not_needed'

          if (needsKnowledgeSearch && analysisResult.knowledge) {
            const userMessage = userMessages[context.requestId]
            params.tools['builtin_knowledge_search'] = knowledgeSearchTool(
              assistant,
              analysisResult.knowledge,
              topicId,
              getMessageContent(userMessage)
            )
          }
        }

        return params
      } catch (error) {
        logger.error('Knowledge tool configuration failed:', error as Error)
        return params
      }
    },

    onRequestEnd: async (context) => {
      try {
        delete intentAnalysisResults[context.requestId]
        delete userMessages[context.requestId]
      } catch (error) {
        logger.error('Knowledge orchestration cleanup failed:', error as Error)
      }
    }
  })
}

export default knowledgeOrchestrationPlugin
