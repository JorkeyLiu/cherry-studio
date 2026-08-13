import { getAssistantSettings } from '@renderer/services/AssistantService'
import { resolveContextStartOverrideReset } from '@renderer/services/contextWindowService'
import type { Assistant, AssistantSettings } from '@renderer/types'
import { useCallback } from 'react'

/**
 * The single persisted context-start override mutation surface of the Inputbar.
 *
 * Override semantics: `contextStartOverride[topicId]` holds only a
 * user-specified context start; a derived anchor is never persisted. With no
 * override the effective window start (the resolved anchor) is derived
 * dynamically by `computeContextInfo` from the assistant's default
 * `contextCount` and the current messages.
 *
 * There is deliberately NO effect here (and none in the Inputbar) that
 * synchronizes overrides to message loading, message-list changes, or default
 * computation. A transient empty topic on startup can therefore never create,
 * replace, or delete a persisted override.
 *
 * The only mutation is reset — clicking TokenCount deletes the override for the
 * topic, after which the existing default computation determines the effective
 * context start. The reset mutates the persisted override only; the resolved
 * anchor is recomputed by the resolver, never stored here.
 */
export function useContextStartOverride(
  assistant: Assistant,
  topicId: string,
  updateAssistantSettings: (settings: Partial<AssistantSettings>) => void
): { onResetOverride: () => void } {
  const onResetOverride = useCallback(() => {
    const settings = getAssistantSettings(assistant)
    const decision = resolveContextStartOverrideReset(settings.contextStartOverride, topicId)
    if (decision.changed) {
      updateAssistantSettings({ contextStartOverride: decision.overrides })
    }
  }, [assistant, topicId, updateAssistantSettings])

  return { onResetOverride }
}
