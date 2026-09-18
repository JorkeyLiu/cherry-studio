import { getAssistantSettings } from '@renderer/services/AssistantService'
import {
  getClosureLoadGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  isValidContextClosureResponse,
  setCachedContextClosure
} from '@renderer/services/contextClosure'
import { dbService } from '@renderer/services/db'
import { captureDeletionGeneration, isDeletionStale } from '@renderer/services/topicDeletionInvalidation'
import store from '@renderer/store'
import { withClosureTopics } from '@renderer/store/closureOwnership'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import type { Assistant, AssistantSettings, ContextWindowAnchor } from '@renderer/types'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { useCallback } from 'react'

/**
 * The single persisted anchor mutation surface of the Inputbar: the
 * TokenCount re-anchor interaction.
 *
 * Authority path: clicking TokenCount is an explicit re-anchor (CW-4) resolved
 * by one `chatdb:resolve-context-closure` (intent `reanchor-default`,
 * `detail: 'closure'`) call in Main. Fail-closed: the new anchor becomes
 * visible to the UI only when the full same-snapshot closure response is
 * complete/valid, generation/global/deletion guards pass, and the
 * authoritative closure is published in the same synchronous boundary
 * BEFORE the anchor persist — so Chat's shared projection derives the new
 * anchor's authoritative current/max on its first committed render without
 * an intermediate bounded-fallback frame. Anchor-only, invalid, stale, or
 * cache-unpublishable responses never persist the new anchor alone.
 * No `buildContextTurns`, no loaded-viewport authority decisions. Main never
 * persists settings; empty resolver results remove the key. Transport
 * failures and NOT_FOUND preserve current settings.
 *
 * Closure blocks are hydrated via scoped `withClosureTopics` ownership; the
 * cache publication follows the existing generation/global/deletion freshness
 * guards so stale responses never overwrite newer state. All fallible
 * validation/preparation happens before any dispatch; the synchronous
 * publish block (blocks dispatch → cache set → anchor persist, no await
 * between) never leaves a dispatched new anchor without its cache. Anchor
 * is last because the blocks dispatch bumps/invalidates via
 * closureInvalidationMiddleware — the cache snapshot must follow the bump.
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
    // In-flight freshness guards (mirrors useContextClosure): a mutation or
    // hard-deletion during the resolve discards cache publication.
    const generationAtFetch = getClosureLoadGeneration(topicId)
    const globalAtFetch = getGlobalBlockGeneration()
    const deletionGenAtFetch = captureDeletionGeneration(topicId)
    let resolved: string | null | undefined
    let closureResponse: { messages: unknown[]; blocks: unknown[]; closure: unknown } | null = null
    try {
      const response = await dbService.resolveContextClosure({
        topicId,
        intent: 'reanchor-default',
        contextCount,
        currentAnchorGroupKey: preKey,
        detail: 'closure'
      })
      resolved = response.resolvedAnchorGroupKey
      const candidate = response as unknown as Record<string, unknown>
      if (
        candidate &&
        typeof candidate === 'object' &&
        'closure' in candidate &&
        Array.isArray(candidate.messages) &&
        Array.isArray(candidate.blocks)
      ) {
        closureResponse = {
          messages: candidate.messages as unknown[],
          blocks: candidate.blocks as unknown[],
          closure: candidate.closure
        }
      }
    } catch {
      return
    }
    if (isDeletionStale(topicId, deletionGenAtFetch)) {
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
    const persistAnchor = () => {
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
      updateAssistantSettings({
        contextWindowAnchor: { ...baseMap, [topicId]: { kind: 'active', groupKey: resolved } }
      })
    }
    // Fail-closed synchronous publish, anchor LAST with no await between
    // steps. Only a complete/valid same-snapshot closure for the new anchor
    // may make the anchor visible; anchor-only/invalid/stale/unpublishable
    // responses return without persisting so the UI keeps the old
    // authoritative projection (no solo new-anchor fallback frame).
    // No timeout, hiding, or debounce.
    if (closureResponse && typeof resolved === 'string' && resolved.length > 0) {
      const fullResponse = {
        messages: closureResponse.messages,
        blocks: closureResponse.blocks,
        closure: closureResponse.closure
      } as unknown as FetchContextClosureResponse
      // All fallible validation/preparation before any dispatch.
      const valid = isValidContextClosureResponse({ topicId, anchorGroupKey: resolved }, fullResponse)
      if (!valid) return
      if (getClosureLoadGeneration(topicId) !== generationAtFetch) return
      if (getGlobalBlockGeneration() !== globalAtFetch) return
      if (isDeletionStale(topicId, deletionGenAtFetch)) return
      let blocksAction: unknown = null
      try {
        if (Array.isArray(closureResponse.blocks) && closureResponse.blocks.length > 0) {
          blocksAction = withClosureTopics(upsertManyBlocks(closureResponse.blocks as any), topicId)
        }
      } catch {
        return
      }
      // Re-read immediately before the synchronous publish (covers races
      // between validation and publish with no await in between).
      if (getClosureLoadGeneration(topicId) !== generationAtFetch) return
      if (getGlobalBlockGeneration() !== globalAtFetch) return
      if (isDeletionStale(topicId, deletionGenAtFetch)) return
      // Synchronous publish: blocks (bumps/invalidates via middleware) →
      // cache (snapshots post-bump generation) → anchor (visible only when
      // the cache is already readable for the new anchor).
      try {
        if (blocksAction) {
          store.dispatch(blocksAction as any)
        }
      } catch {
        return
      }
      try {
        setCachedContextClosure(topicId, fullResponse)
      } catch {
        return
      }
      // The authoritative closure must be readable for the new anchor in this
      // same boundary; otherwise the anchor stays invisible (fail-closed).
      if (!getFreshValidatedClosure(topicId, resolved)) return
      persistAnchor()
      return
    }
    // Anchor-only (no closure payload), invalid, expired, or empty-string:
    // never persist the new anchor alone — keeping the old authoritative
    // counts avoids the bounded-fallback jitter that a solo persist would
    // necessarily produce.
    return
  }, [assistant, topicId, updateAssistantSettings])

  return { onReanchor }
}
