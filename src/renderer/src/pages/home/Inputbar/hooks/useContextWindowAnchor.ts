import { getAssistantSettings } from '@renderer/services/AssistantService'
import { dbService } from '@renderer/services/db'
import store from '@renderer/store'
import type { Assistant, AssistantSettings, ContextWindowAnchor } from '@renderer/types'
import { useCallback } from 'react'

/**
 * The single persisted anchor mutation surface of the Inputbar: the
 * TokenCount re-anchor interaction.
 *
 * Authority path: clicking TokenCount is an explicit re-anchor (CW-4) resolved
 * by one `chatdb:resolve-context-closure` (intent `reanchor-default`) call in
 * Main against full ordered turns. No `buildContextTurns`, no loaded-viewport
 * authority decisions. Main never persists settings; this hook persists only
 * the non-stale returned anchor (removing the key on empty). Transport
 * failures and NOT_FOUND preserve current settings.
 *
 * Resolver messages/blocks are caller-local and never enter normal Redux.
 * There is deliberately NO effect here (and none in the Inputbar) that
 * synchronizes anchors to message loading or message-list changes. Changing
 * `contextCount` alone never moves an existing anchor; re-anchoring happens
 * only on the explicit click.
 */
export function useContextWindowAnchor(
  assistant: Assistant,
  topicId: string,
  _topicMessagesOrUpdate?: unknown,
  _maybeUpdate?: (settings: Partial<AssistantSettings>) => void
): { onReanchor: () => Promise<void> } {
  const updateAssistantSettings: (settings: Partial<AssistantSettings>) => void =
    typeof _maybeUpdate === 'function'
      ? _maybeUpdate
      : typeof _topicMessagesOrUpdate === 'function'
        ? (_topicMessagesOrUpdate as (settings: Partial<AssistantSettings>) => void)
        : () => {}

  const onReanchor = useCallback(async () => {
    const settings = getAssistantSettings(assistant)
    const preAnchor = settings.contextWindowAnchor?.[topicId] as unknown as ContextWindowAnchor | undefined
    const preKey = preAnchor?.kind === 'active' ? preAnchor.groupKey : null
    const contextCount = settings.contextCount ?? null
    let resolved: string | null | undefined
    try {
      const response = await dbService.resolveContextClosure({
        topicId,
        intent: 'reanchor-default',
        contextCount,
        currentAnchorGroupKey: preKey
      })
      resolved = response.resolvedAnchorGroupKey
    } catch {
      return
    }
    // Stale guard: re-read the latest persisted anchor; if it changed during
    // the call, drop the stale result without dispatch.
    let freshKey: string | null = preKey
    try {
      const freshAssistant = (
        store.getState() as { assistants: { assistants: Assistant[] } }
      ).assistants.assistants.find((a) => a.id === assistant.id)
      if (freshAssistant) {
        const freshSettings = getAssistantSettings(freshAssistant)
        const freshAnchor = freshSettings.contextWindowAnchor?.[topicId] as unknown as ContextWindowAnchor | undefined
        freshKey = freshAnchor?.kind === 'active' ? freshAnchor.groupKey : null
      }
    } catch {
      freshKey = preKey
    }
    if (freshKey !== preKey) {
      return
    }
    if (resolved === freshKey) {
      return
    }
    if (resolved === null || resolved === undefined) {
      if (freshKey === null) return
      const latestAssistant = (() => {
        try {
          return (store.getState() as { assistants: { assistants: Assistant[] } }).assistants.assistants.find(
            (a) => a.id === assistant.id
          )
        } catch {
          return undefined
        }
      })()
      const baseMap = latestAssistant
        ? (getAssistantSettings(latestAssistant).contextWindowAnchor ?? {})
        : (settings.contextWindowAnchor ?? {})
      const updated = { ...baseMap }
      delete updated[topicId]
      updateAssistantSettings({ contextWindowAnchor: updated })
      return
    }
    const latestAssistant = (() => {
      try {
        return (store.getState() as { assistants: { assistants: Assistant[] } }).assistants.assistants.find(
          (a) => a.id === assistant.id
        )
      } catch {
        return undefined
      }
    })()
    const baseMap = latestAssistant
      ? (getAssistantSettings(latestAssistant).contextWindowAnchor ?? {})
      : (settings.contextWindowAnchor ?? {})
    updateAssistantSettings({ contextWindowAnchor: { ...baseMap, [topicId]: { kind: 'active', groupKey: resolved } } })
  }, [assistant, topicId, updateAssistantSettings])

  return { onReanchor }
}
