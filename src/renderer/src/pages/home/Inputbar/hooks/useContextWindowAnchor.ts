import { getAssistantSettings } from '@renderer/services/AssistantService'
import { buildContextTurns } from '@renderer/services/contextTurnService'
import { resolveAnchorReanchorDecision } from '@renderer/services/contextWindowService'
import type { Assistant, AssistantSettings } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { useCallback } from 'react'

/**
 * The single persisted anchor mutation surface of the Inputbar: the
 * TokenCount re-anchor interaction.
 *
 * Anchor semantics (`docs/context-window.md`): `contextWindowAnchor[topicId]`
 * is the stable persisted topic context start. Clicking TokenCount is an
 * explicit re-anchor (CW-4): the anchor moves to the CURRENT default window
 * position derived from the current topic turns and the CURRENT `contextCount`.
 * An empty topic is a no-op (empty topics have no anchor), and the
 * interaction never leaves a non-empty initialized topic anchorless.
 *
 * There is deliberately NO effect here (and none in the Inputbar) that
 * synchronizes anchors to message loading, message-list changes, or default
 * computation. Changing `contextCount` alone never moves an existing anchor;
 * re-anchoring happens only on the explicit click.
 */
export function useContextWindowAnchor(
  assistant: Assistant,
  topicId: string,
  topicMessages: Message[],
  updateAssistantSettings: (settings: Partial<AssistantSettings>) => void
): { onReanchor: () => void } {
  const onReanchor = useCallback(() => {
    const settings = getAssistantSettings(assistant)
    const turns = buildContextTurns(topicMessages)
    const decision = resolveAnchorReanchorDecision(settings.contextWindowAnchor, topicId, turns, settings.contextCount)
    if (decision.changed) {
      updateAssistantSettings({ contextWindowAnchor: decision.anchorMap })
    }
  }, [assistant, topicId, topicMessages, updateAssistantSettings])

  return { onReanchor }
}
