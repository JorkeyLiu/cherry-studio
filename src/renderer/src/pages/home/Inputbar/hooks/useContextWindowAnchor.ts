import { anchorKeyForRoute } from '@renderer/services/anchorService'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import {
  ensureClosureGeneration,
  getClosureLoadGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  isValidContextClosureResponse,
  setCachedContextClosure
} from '@renderer/services/contextClosure'
import { dbService } from '@renderer/services/db'
import { bindClosureReadReceipt, captureClosureReadReceipt } from '@renderer/services/executionOverlayReadReceipt'
import { captureDeletionGeneration, isDeletionStale } from '@renderer/services/topicDeletionInvalidation'
import store from '@renderer/store'
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
 * No ordinary-block writes happen on this path: the cache publication
 * follows the existing generation/global/deletion structural guards so stale
 * structural responses never overwrite newer state, and UI bodies come from
 * the closure snapshot composed with the execution-owned overlay (route B).
 * A same-block streaming content delta advances only the content revision,
 * which must NOT abort the resolved anchor. All fallible
 * validation/preparation happens before any publish; the synchronous
 * publish block (cache set → anchor persist, no await between) never leaves
 * a persisted new anchor without its cache.
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
    // Route-scoped anchor: branch routes anchor under their own route key.
    let route: string | null = null
    try {
      const st = store.getState() as unknown as {
        topicBranch?: { activeBranchIdByTopic?: Record<string, string | null> }
      }
      const active = st.topicBranch?.activeBranchIdByTopic?.[topicId]
      route = typeof active === 'string' && active.length > 0 ? active : null
    } catch {
      route = null
    }
    const anchorKey = anchorKeyForRoute(topicId, route)
    const settings = getAssistantSettings(assistant)
    const preAnchor = settings.contextWindowAnchor?.[anchorKey] as unknown as ContextWindowAnchor | undefined
    const preKey = preAnchor?.kind === 'active' ? preAnchor.groupKey : null
    const contextCount = settings.contextCount ?? null
    // In-flight freshness guards (mirrors useContextClosure): a mutation or
    // hard-deletion during the resolve discards cache publication.
    ensureClosureGeneration(topicId, route)
    const generationAtFetch = getClosureLoadGeneration(topicId, route)
    const globalAtFetch = getGlobalBlockGeneration()
    const deletionGenAtFetch = captureDeletionGeneration(topicId)
    // Read receipt: capture synchronously before the resolve dispatch (no await
    // between) so terminals acked while the resolve is in flight stay excluded.
    const readReceipt = captureClosureReadReceipt(topicId, route)
    let resolved: string | null | undefined
    let closureResponse: { messages: unknown[]; blocks: unknown[]; closure: unknown } | null = null
    try {
      const response = await dbService.resolveContextClosure({
        topicId,
        branchId: route,
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
        const freshAnchor = freshSettings.contextWindowAnchor?.[anchorKey] as unknown as ContextWindowAnchor | undefined
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
      delete updated[anchorKey]
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
        contextWindowAnchor: { ...baseMap, [anchorKey]: { kind: 'active', groupKey: resolved } }
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
      // All fallible validation/preparation before any publish. No
      // ordinary-block writes happen here: UI bodies come from the closure
      // snapshot composed with the execution-owned overlay, so a same-block
      // streaming delta changes nothing on this path and must NOT abort the
      // resolved anchor.
      const valid = isValidContextClosureResponse({ topicId, branchId: route, anchorGroupKey: resolved }, fullResponse)
      if (!valid) return
      if (getClosureLoadGeneration(topicId, route) !== generationAtFetch) return
      if (getGlobalBlockGeneration() !== globalAtFetch) return
      if (isDeletionStale(topicId, deletionGenAtFetch)) return
      // Re-read structural freshness immediately before the synchronous
      // publish (covers races between validation and publish with no await
      // in between).
      if (getClosureLoadGeneration(topicId, route) !== generationAtFetch) return
      if (getGlobalBlockGeneration() !== globalAtFetch) return
      if (isDeletionStale(topicId, deletionGenAtFetch)) return
      // Synchronous publish: cache → anchor (visible only when the cache is
      // already readable for the new anchor). No blocks dispatch: this path
      // triggers no middleware bump/invalidation.
      try {
        setCachedContextClosure(topicId, fullResponse, route)
        // Pair this exact response with its read witness before publication:
        // cache + persist carry the same object. Unpublishable/invalid reads
        // return above and are never bound, so they can never retire an overlay.
        bindClosureReadReceipt(fullResponse, readReceipt)
      } catch {
        return
      }
      // The authoritative closure must be readable for the new anchor in this
      // same boundary (viewport-independent); otherwise the anchor stays
      // invisible (fail-closed).
      if (!getFreshValidatedClosure(topicId, resolved, undefined, route)) return
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
