import type { Assistant } from '@renderer/types'

export const isToolUseModeFunction = (assistant: Assistant) => {
  return assistant.settings?.toolUseMode === 'function'
}

/**
 * 是否使用提示词工具使用
 * @param assistant
 * @returns 是否使用提示词工具使用
 */
export function isPromptToolUse(assistant: Assistant) {
  return assistant.settings?.toolUseMode === 'prompt'
}

/**
 * 是否启用工具使用(function call)
 *
 * Unit B: user-intent driven. Native `function` mode is honored whenever the
 * user selects it; model function-calling metadata never downgrades it.
 * Protocol-level encode failures surface through the existing APICallError
 * chain. `prompt` mode applies only when the user explicitly selects `prompt`.
 * @param assistant
 * @returns 是否启用工具使用
 */
export function isSupportedToolUse(assistant: Assistant) {
  return isToolUseModeFunction(assistant)
}
