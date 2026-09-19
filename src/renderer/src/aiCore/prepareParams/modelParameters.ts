/**
 * 模型基础参数处理模块
 * 处理温度、TopP、超时等基础参数的获取逻辑
 */

import { loggerService } from '@logger'
import {
  isClaude46SeriesModel,
  isSupportAdaptiveThinkingClaudeModel,
  isSupportedFlexServiceTier,
  isSupportedThinkingTokenClaudeModel
} from '@renderer/config/models'
import {
  DEFAULT_ASSISTANT_SETTINGS,
  getAssistantSettings,
  getProviderByModel
} from '@renderer/services/AssistantService'
import { type Assistant, type Model } from '@renderer/types'
import type { AiSdkParam } from '@renderer/types/aiCoreTypes'
import { DEFAULT_TIMEOUT } from '@shared/config/constant'

import { getThinkingBudget } from '../utils/reasoning'

const logger = loggerService.withContext('modelParameters')

/**
 * Retrieves the temperature parameter.
 *
 * Unit B (user-intent lazy execution): the user toggle drives sending. Only
 * generic type/finite-value guards remain here; no model-name or capability
 * metadata suppression/rewrite. Upstream rejection surfaces through the
 * existing APICallError chain.
 */
export function getTemperature(assistant: Assistant, _model: Model): number | undefined {
  const enableTemperature = assistant.settings?.enableTemperature ?? DEFAULT_ASSISTANT_SETTINGS.enableTemperature
  if (!enableTemperature) {
    return undefined
  }

  const temperature = assistant.settings?.temperature ?? DEFAULT_ASSISTANT_SETTINGS.temperature
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    logger.info('Invalid temperature value, disabling temperature')
    return undefined
  }

  return temperature
}

/**
 * Retrieves the TopP parameter.
 *
 * Unit B: same contract as temperature — user toggle drives sending, only
 * generic type/finite-value guards remain. No silent model-based suppression,
 * clamping, or mutual-exclusion rewrites.
 */
export function getTopP(assistant: Assistant, _model: Model): number | undefined {
  const enableTopP = assistant.settings?.enableTopP ?? DEFAULT_ASSISTANT_SETTINGS.enableTopP
  if (!enableTopP) {
    return undefined
  }

  const topP = assistant.settings?.topP ?? DEFAULT_ASSISTANT_SETTINGS.topP
  if (typeof topP !== 'number' || !Number.isFinite(topP)) {
    logger.info('Invalid topP value, disabling topP')
    return undefined
  }

  return topP
}

/**
 * Filters AI SDK standard parameters extracted from custom parameters.
 *
 * Unit B: no model-name based dropping (e.g. topK). Custom standard params
 * are forwarded as-is; upstream rejection surfaces through the existing error
 * chain. Only the reference itself is preserved for structural compatibility.
 */
export function filterStandardParams(
  standardParams: Partial<Record<AiSdkParam, any>>,
  _model: Model
): Partial<Record<AiSdkParam, any>> {
  return standardParams
}

/**
 * 获取超时设置
 */
export function getTimeout(model: Model): number {
  if (isSupportedFlexServiceTier(model)) {
    return 15 * 1000 * 60
  }
  return DEFAULT_TIMEOUT
}

export function getMaxTokens(assistant: Assistant, model: Model): number | undefined {
  // NOTE: ai-sdk会把maxToken和budgetToken加起来
  const assistantSettings = getAssistantSettings(assistant)
  const enabledMaxTokens = assistantSettings.enableMaxTokens ?? false
  let maxTokens = assistantSettings.maxTokens

  // If user hasn't enabled enableMaxTokens, return undefined to let the API use its default value.
  // Note: Anthropic API requires max_tokens, but that's handled by the Anthropic client with a fallback.
  if (!enabledMaxTokens || maxTokens === undefined) {
    return undefined
  }

  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API access.
    return undefined
  }
  // Claude 4.6 / Opus 4.7+ use adaptive thinking and do not send budgetTokens, so the
  // AI SDK does not add budget back to maxOutputTokens. Skip the subtraction to avoid
  // incorrectly reducing max_tokens.
  if (
    isSupportedThinkingTokenClaudeModel(model) &&
    !isClaude46SeriesModel(model) &&
    !isSupportAdaptiveThinkingClaudeModel(model) &&
    ['anthropic', 'aws-bedrock'].includes(provider.type)
  ) {
    const { reasoning_effort: reasoningEffort } = assistantSettings
    const budget = getThinkingBudget(maxTokens, reasoningEffort, model.id)
    if (budget) {
      maxTokens -= budget
    }
  }
  return maxTokens
}
