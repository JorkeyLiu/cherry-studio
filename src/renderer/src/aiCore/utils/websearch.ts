import type { WebSearchPluginConfig } from '@cherrystudio/ai-core/core/plugins/built-in/webSearchPlugin'
import type { AppProviderId } from '@renderer/aiCore/types'
import { isOpenAIDeepResearchModel, isOpenAIWebSearchChatCompletionOnlyModel } from '@renderer/config/models'
import type { CherryWebSearchConfig } from '@renderer/store/websearch'
import type { Model } from '@renderer/types'
import { mapRegexToPatterns } from '@renderer/utils/blacklistMatchPattern'

/**
 * Generic OpenAI-compatible websearch params.
 *
 * Only the approved protocol-standard Chat Completions shape
 * (`web_search_options`) is emitted, and only for models whose model-id
 * heuristic says they need it. Unknown/generic compatible models have no
 * built-in search params: user override or exact model metadata must opt in
 * via capability detection before this is called.
 */
export function getWebSearchParams(model: Model): Record<string, any> {
  if (isOpenAIWebSearchChatCompletionOnlyModel(model)) {
    return {
      web_search_options: {}
    }
  }
  return {}
}

/**
 * range in [0, 100]
 * @param maxResults
 */
function mapMaxResultToOpenAIContextSize(
  maxResults: number
): NonNullable<WebSearchPluginConfig['openai']>['searchContextSize'] {
  if (maxResults <= 33) return 'low'
  if (maxResults <= 66) return 'medium'
  return 'high'
}

export function buildProviderBuiltinWebSearchConfig(
  providerId: AppProviderId,
  webSearchConfig: CherryWebSearchConfig,
  model?: Model
): WebSearchPluginConfig | undefined {
  switch (providerId) {
    case 'openai': {
      const searchContextSize = isOpenAIDeepResearchModel(model)
        ? 'medium'
        : mapMaxResultToOpenAIContextSize(webSearchConfig.maxResults)
      return {
        openai: {
          searchContextSize
        }
      }
    }
    case 'openai-chat': {
      const searchContextSize = isOpenAIDeepResearchModel(model)
        ? 'medium'
        : mapMaxResultToOpenAIContextSize(webSearchConfig.maxResults)
      return {
        'openai-chat': {
          searchContextSize
        }
      }
    }
    case 'anthropic': {
      const blockedDomains = mapRegexToPatterns(webSearchConfig.excludeDomains)
      const anthropicSearchOptions: NonNullable<WebSearchPluginConfig['anthropic']> = {
        maxUses: webSearchConfig.maxResults,
        blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined
      }
      return {
        anthropic: anthropicSearchOptions
      }
    }
    default: {
      return {}
    }
  }
}
