import type { Model } from '@renderer/types'
import { getLowerBaseModelName, isUserSelectedModelType } from '@renderer/utils'

import { isEmbeddingModel, isRerankModel } from './embedding'
import { resolveCapabilityWithOverride, resolveExternalToolCallSupport } from './modelMetadata'
import { isDeepSeekHybridInferenceModel } from './reasoning'
import { isTextToImageModel } from './vision'

// Tool calling models
export const FUNCTION_CALLING_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4',
  'gpt-4.5',
  'gpt-oss(?:-[\\w-]+)',
  'gpt-5(?:-[0-9-]+)?',
  'o(1|3|4)(?:-[\\w-]+)?',
  'claude',
  'qwen',
  'qwen3',
  'hunyuan',
  'deepseek',
  'glm-4(?:-[\\w-]+)?',
  'glm-4.5(?:-[\\w-]+)?',
  'glm-4.7(?:-[\\w-]+)?',
  'glm-5(?:-[\\w-]+)?',
  'learnlm(?:-[\\w-]+)?',
  'gemini(?:-[\\w-]+)?', // 提前排除了gemini的嵌入模型
  'gemma-?4(?:[-.\\w]+)?',
  'grok-3(?:-[\\w-]+)?',
  'grok-4(?:-[\\w-]+)?',
  'grok-build(?:-[\\w-]+)?',
  'doubao-seed-1[.-][68](?:-[\\w-]+)?',
  'doubao-seed-2[.-]0(?:-[\\w-]+)?',
  'doubao-seed-code(?:-[\\w-]+)?',
  'kimi-k2(?:-[\\w-]+)?',
  'ling-\\w+(?:-[\\w-]+)?',
  'ring-\\w+(?:-[\\w-]+)?',
  'minimax-m[23](?:\\.\\d+)?(?:-[\\w-]+)?',
  'mimo-v2\\.5(?:-pro)?(?!-)',
  'mimo-v2-flash',
  'mimo-v2-pro',
  'mimo-v2-omni',
  'glm-5v-turbo'
] as const

const FUNCTION_CALLING_EXCLUDED_MODELS = [
  'aqa(?:-[\\w-]+)?',
  'imagen(?:-[\\w-]+)?',
  'o1-mini',
  'o1-preview',
  'AIDC-AI/Marco-o1',
  'gemini-1(?:\\.[\\w-]+)?',
  'qwen-mt(?:-[\\w-]+)?',
  'gpt-5-chat(?:-[\\w-]+)?',
  'glm-4\\.5v',
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-3(?:\\.\\d+)?-pro-image(?:-[\\w-]+)?',
  'deepseek-v3.2-speciale',
  'deepseek-r1(?:[-:][\\w.-]+)?'
]

export const FUNCTION_CALLING_REGEX = new RegExp(
  `\\b(?!(?:${FUNCTION_CALLING_EXCLUDED_MODELS.join('|')})\\b)(?:${FUNCTION_CALLING_MODELS.join('|')})\\b`,
  'i'
)

const STEPFUN_FUNCTION_CALLING_MODELS = new Set(['step-3.7-flash'])

export function isFunctionCallingModel(model?: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)

  if (isUserSelectedModelType(model, 'function_calling') !== undefined) {
    return isUserSelectedModelType(model, 'function_calling')!
  }

  // Optional models.dev enrichment: validated external `tool_call` outranks
  // the legacy name heuristic; unknown stays permissive (falls through below).
  const externalToolCall = resolveCapabilityWithOverride(
    model,
    'function_calling',
    resolveExternalToolCallSupport(model)
  )
  if (externalToolCall !== undefined) {
    return externalToolCall
  }

  if (STEPFUN_FUNCTION_CALLING_MODELS.has(modelId)) {
    return true
  }

  if (modelId.includes('doubao') || (model.name && getLowerBaseModelName(model.name).includes('doubao'))) {
    return FUNCTION_CALLING_REGEX.test(modelId) || FUNCTION_CALLING_REGEX.test(model.name)
  }

  // 2025/08/26 百炼与火山引擎均不支持 v3.1 函数调用
  // Debranded: capability follows the model family only. Provider ids are
  // opaque join keys and never gate tool calling.
  if (isDeepSeekHybridInferenceModel(model)) {
    return true
  }

  return FUNCTION_CALLING_REGEX.test(modelId)
}
