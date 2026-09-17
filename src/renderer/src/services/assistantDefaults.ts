import { DEFAULT_CONTEXTCOUNT, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import type { AssistantSettings } from '@renderer/types'

/**
 * Cycle-free default assistant settings template.
 *
 * Extracted from AssistantService so capability-adjacent modules
 * (parameterBuilder) can read tool-call defaults without importing the
 * store/AssistantService chain (that edge created a deterministic
 * collection-time TDZ through store/assistants → SqliteMessageDataSource).
 * Single source of truth: AssistantService re-exports this object.
 */
export const DEFAULT_ASSISTANT_SETTINGS = {
  maxTokens: DEFAULT_MAX_TOKENS,
  enableMaxTokens: false,
  temperature: DEFAULT_TEMPERATURE,
  enableTemperature: false,
  topP: 1,
  enableTopP: false,
  contextCount: DEFAULT_CONTEXTCOUNT,
  streamOutput: true,
  defaultModel: undefined,
  customParameters: [],
  reasoning_effort: 'default',
  reasoning_effort_cache: undefined,
  qwenThinkMode: undefined,
  // It would gracefully fallback to prompt if not supported by model.
  toolUseMode: 'function',
  maxToolCalls: 20,
  enableMaxToolCalls: true,
  contextWindowAnchor: {}
} as const satisfies AssistantSettings
