import { getAssistantSettings } from '@renderer/services/AssistantService'
import { resolveAnchorReset } from '@renderer/services/contextWindowService'
import type { Assistant, AssistantSettings } from '@renderer/types'
import { useCallback } from 'react'

/**
 * The single context-window anchor mutation surface of the Inputbar.
 *
 * Explicit-anchor semantics: `contextWindowAnchor[topicId]` holds only a
 * user-specified context start; a derived default is never persisted. With no
 * explicit anchor the effective window start is derived dynamically by
 * `computeContextInfo` from the assistant's default `contextCount` and the
 * current messages.
 *
 * There is deliberately NO effect here (and none in the Inputbar) that
 * synchronizes anchors to message loading, message-list changes, or default
 * computation. A transient empty topic on startup can therefore never create,
 * replace, or delete a persisted explicit anchor.
 *
 * The only mutation is reset — clicking TokenCount deletes the explicit anchor
 * for the topic, after which the existing default computation determines the
 * effective context start.
 */
export function useContextWindowAnchor(
  assistant: Assistant,
  topicId: string,
  updateAssistantSettings: (settings: Partial<AssistantSettings>) => void
): { onResetAnchor: () => void } {
  const onResetAnchor = useCallback(() => {
    const settings = getAssistantSettings(assistant)
    const decision = resolveAnchorReset(settings.contextWindowAnchor, topicId)
    if (decision.changed) {
      updateAssistantSettings({ contextWindowAnchor: decision.anchors })
    }
  }, [assistant, topicId, updateAssistantSettings])

  return { onResetAnchor }
}
