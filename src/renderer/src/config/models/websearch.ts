import { resolveExactProvider } from '@renderer/services/exactProviderResolver'
import type { Model } from '@renderer/types'
import { getLowerBaseModelName, isUserSelectedModelType } from '@renderer/utils'
import { isGeminiProvider, isOpenAICompatibleProvider, isOpenAIProvider } from '@renderer/utils/provider'

export { GEMINI_FLASH_MODEL_REGEX } from './utils'

import { isEmbeddingModel, isRerankModel } from './embedding'
import { isAnthropicModel } from './utils'
import { isTextToImageModel } from './vision'

const CLAUDE_SUPPORTED_WEBSEARCH_REGEX = new RegExp(
  `\\b(?:claude-3(-|\\.)(7|5)-sonnet(?:-[\\w-]+)|claude-3(-|\\.)5-haiku(?:-[\\w-]+)|claude-(haiku|sonnet|opus)-4(?:-[\\w-]+)?)\\b`,
  'i'
)

export const GEMINI_SEARCH_REGEX = new RegExp(
  'gemini-(?:2(?!.*-image-preview).*(?:-latest)?|3(?:\\.\\d+)?-(?:flash|pro)(?:-(?:image-)?preview)?|flash-latest|pro-latest|flash-lite-latest)(?:-[\\w-]+)*$',
  'i'
)

export const PERPLEXITY_SEARCH_MODELS = [
  'sonar-pro',
  'sonar',
  'sonar-reasoning',
  'sonar-reasoning-pro',
  'sonar-deep-research'
]

// Model-id family heuristic formerly gated on the dashscope brand. Provider ids
// are opaque join keys; the qwen search-capable family applies on any protocol.
const QWEN_SEARCH_MODEL_PREFIXES = ['qwen-turbo', 'qwen-max', 'qwen-plus', 'qwq', 'qwen-flash', 'qwen3-max']

export function isWebSearchModel(model?: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)) {
    return false
  }

  // Priority: explicit user override first; then exact external metadata when
  // available (no websearch metadata source today); then protocol + model-id
  // generic heuristics below. Provider ids only locate the owning entry.
  if (isUserSelectedModelType(model, 'web_search') !== undefined) {
    return isUserSelectedModelType(model, 'web_search')!
  }

  const provider = resolveExactProvider(model)

  if (!provider) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id, '/')

  if (isAnthropicModel(model)) {
    return CLAUDE_SUPPORTED_WEBSEARCH_REGEX.test(modelId)
  }

  // TODO: 当其他供应商采用Response端点时，这个地方逻辑需要改进
  if (isOpenAIProvider(provider)) {
    return isOpenAIWebSearchModel(model)
  }

  // Generic OpenAI-compatible has a safe standard emitter only for the
  // Chat Completions `web_search_options` family. All other families
  // (sonar/qwen/hunyuan/gemini-regex/broad OpenAI search) required
  // vendor-private params and must not claim built-in capability here:
  // user explicit `web_search` override (handled above) may still opt in,
  // but request construction emits nothing for them. Early return so the
  // pure model-id fallbacks below never apply to generic connections.
  if (isOpenAICompatibleProvider(provider)) {
    return isOpenAIWebSearchChatCompletionOnlyModel(model)
  }

  // Pure model-id heuristic (formerly perplexity/openrouter brand gates):
  // sonar-family models are built-in search models on non-generic protocols.
  // Generic connections return above and never reach here.
  if (PERPLEXITY_SEARCH_MODELS.includes(modelId)) {
    return true
  }

  if (isGeminiProvider(provider)) {
    return GEMINI_SEARCH_REGEX.test(modelId)
  }

  // Pure model-id family heuristics (formerly hunyuan/dashscope brand gates).
  // Non-generic protocols only; generic returns above with no vendor fallback.
  if (modelId.includes('hunyuan')) {
    return modelId !== 'hunyuan-lite'
  }

  // matches id like qwen-max-0919, qwen-max-latest
  if (QWEN_SEARCH_MODEL_PREFIXES.some((i) => modelId.startsWith(i))) {
    return true
  }

  // Unknown protocols have no built-in search params: no brand fallback.
  // User override or exact model metadata must opt in.
  return false
}

export function isMandatoryWebSearchModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  // Owning entry must exist; capability itself is pure model-id.
  const provider = resolveExactProvider(model)

  if (!provider) {
    return false
  }

  // Generic OpenAI-compatible has no safe mandatory emitter (sonar needs no
  // params on its native endpoint, but generic emits only web_search_options
  // for the chat-completion-only family): never force built-in here so
  // request construction cannot claim a built-in search it cannot emit.
  // User override/external RAG remains available via isWebSearchModel.
  if (isOpenAICompatibleProvider(provider)) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)

  return PERPLEXITY_SEARCH_MODELS.includes(modelId)
}

export function isOpenRouterBuiltInWebSearchModel(model: Model): boolean {
  if (!model) {
    return false
  }

  // Owning entry must exist; capability itself is pure model-id.
  const provider = resolveExactProvider(model)

  if (!provider) {
    return false
  }

  // Generic OpenAI-compatible can emit only web_search_options: the
  // chat-completion-only family qualifies, sonar does not (no safe generic
  // emitter). Non-generic protocols keep the sonar fallback.
  if (isOpenAICompatibleProvider(provider)) {
    return isOpenAIWebSearchChatCompletionOnlyModel(model)
  }

  const modelId = getLowerBaseModelName(model.id)

  return isOpenAIWebSearchChatCompletionOnlyModel(model) || modelId.includes('sonar')
}

export function isOpenAIWebSearchChatCompletionOnlyModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('gpt-4o-search-preview') || modelId.includes('gpt-4o-mini-search-preview')
}

export function isOpenAIWebSearchModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id)

  return (
    modelId.includes('gpt-4o-search-preview') ||
    modelId.includes('gpt-4o-mini-search-preview') ||
    (modelId.includes('gpt-4.1') && !modelId.includes('gpt-4.1-nano')) ||
    (modelId.includes('gpt-4o') && !modelId.includes('gpt-4o-image')) ||
    modelId.includes('o3') ||
    modelId.includes('o4') ||
    (modelId.includes('gpt-5') && !modelId.includes('chat'))
  )
}

export function isHunyuanSearchModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)

  if (modelId.includes('hunyuan')) {
    return modelId !== 'hunyuan-lite'
  }

  return false
}
