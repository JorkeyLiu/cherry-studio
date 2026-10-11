import { useLoadedTopicMessages } from '@renderer/hooks/useMessageOperations'
import {
  bumpAndInvalidate,
  computeClosureFingerprint,
  enforceContextClosureRetention,
  ensureClosureGeneration,
  getClosureLoadGeneration,
  getClosureSemanticToken,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  isValidContextClosureResponse,
  setCachedContextClosureWithFingerprint,
  subscribeClosureInvalidations
} from '@renderer/services/contextClosure'
import { dbService } from '@renderer/services/db'
import { captureDeletionGeneration, isDeletionStale } from '@renderer/services/topicDeletionInvalidation'
import store, { useAppDispatch } from '@renderer/store'
import { markClosureReadOnly, withClosureTopics } from '@renderer/store/closureOwnership'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import type { FetchContextClosureRequest, FetchContextClosureResponse } from '@shared/chatDb'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * Bound reactive semantic signal for a route (viewport-independent).
 *
 * Subscribes to the ephemeral closure-invalidation emitter; snapshot is the
 * per-route `routeGen:globalGen` token so unrelated topics/routes bail out
 * without re-render (no cross-route leak). Read-only hydrations never bump,
 * so they never notify (no hydration loop). Single subscription per hook
 * instance, cleaned by `useSyncExternalStore` on unmount/route change (no
 * leaking listeners). Safe to call before any mutation: pre-mount bumps are
 * already reflected in generation maps, so the first snapshot observes them.
 */
export function useClosureSemanticSignal(topicId: string, branchId?: string | null): string {
  const route = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  return useSyncExternalStore(subscribeClosureInvalidations, () => getClosureSemanticToken(topicId, route))
}

/**
 * Per-topic context closure cache hook (R-06).
 *
 * Viewport-independent: full-route authoritative counts/anchor/boundary are
 * independent of the currently loaded viewport. Pure latest/around/load-more
 * reads never invalidate semantic context and never reject a valid closure
 * because viewport membership changes.
 *
 * - Dedicated per-route closure cache, separate from viewport MessageWindow.
 * - Async load on route activation after anchor establishment (anchorGroupKey required).
 * - Same-route + same-anchor + same-generation validated; stale/in-flight discarded.
 * - Semantic freshness via per-route generation (bumped ONLY by genuine
 *   message/block mutations; read-only window/closure hydrations are exempt
 *   via `meta.closureReadOnly`) plus global block epoch for uncached
 *   in-flight races and deletion generation for hard deletion. No viewport
 *   fingerprint gate, no viewport-newest gate.
 * - Staged publication re-reads generation/global/deletion immediately before
 *   the read-only block hydration and cache publication; discards on mismatch
 *   so stale responses cannot overwrite newer state.
 * - No separate persistence, no viewport expansion, no contextCount bound.
 */
export function useContextClosure(topicId: string, anchorGroupKey: string | null, branchId?: string | null) {
  const route = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  const dispatch = useAppDispatch()
  // Reactive semantic invalidation (viewport-independent): per-route
  // routeGen:globalGen token. Length-preserving mutations bump generation
  // without changing viewport length; this token is the refresh signal.
  // Viewport length is NOT a semantic proxy and never gates freshness.
  const semanticSignal = useClosureSemanticSignal(topicId, route)
  // Viewport subscription retained ONLY as a re-check trigger so a genuine
  // mutation (which also updates the viewport) re-validates promptly. The
  // viewport content never gates freshness: pure read growth retains the
  // valid closure, generation mismatch refetches.
  const provisionalLoadedMessages = useLoadedTopicMessages(topicId)
  const viewportTick = Array.isArray(provisionalLoadedMessages) ? provisionalLoadedMessages.length : 0
  const [closure, setClosure] = useState<FetchContextClosureResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)
  const topicRef = useRef(topicId)
  const anchorRef = useRef(anchorGroupKey)
  const routeRef = useRef<string | null>(route)

  // Keep refs updated for stale checks inside async
  useEffect(() => {
    topicRef.current = topicId
    anchorRef.current = anchorGroupKey
    routeRef.current = route
  }, [topicId, anchorGroupKey, route])

  // B-09: active-route-only retention — on activation, atomically prune inactive closures/fingerprints/generations
  useEffect(() => {
    if (!topicId) return
    enforceContextClosureRetention(topicId, route)
  }, [topicId, route])

  // Load or reuse closure with semantic freshness gate (route/anchor/generation only)
  useEffect(() => {
    if (topicId) {
      enforceContextClosureRetention(topicId, route)
    }
    if (!topicId || !anchorGroupKey) {
      setClosure(null)
      return
    }
    // Register route generation at read/fetch start so a bare-topic
    // mutation during an uncached branch fetch still bumps this route
    // (init-only, never invalidates). getFreshValidatedClosure also ensures.
    ensureClosureGeneration(topicId, route)
    // Centralized freshness-gated read: structural + route/anchor + generation (viewport-independent)
    const fresh = getFreshValidatedClosure(topicId, anchorGroupKey, undefined, route)
    if (fresh) {
      setClosure(fresh)
      return
    }
    // No fresh cache — clear stale hook state (cache already invalid or missing)
    // without touching the viewport-derived display (the shared projection
    // renders authority-pending, never a bounded fallback).
    setClosure((prev) => (prev === null ? prev : null))
    // Need to fetch
    const seq = ++seqRef.current
    const request: FetchContextClosureRequest = { topicId, branchId: route, anchorGroupKey }
    // Capture semantic freshness signals at fetch start for the in-flight
    // publication guard (covers uncached topics with active fetches and hard-deletion).
    const generationAtFetch = getClosureLoadGeneration(topicId, route)
    const globalAtFetch = getGlobalBlockGeneration()
    const deletionGenAtFetch = captureDeletionGeneration(topicId)
    setLoading(true)
    void (async () => {
      try {
        const response = await dbService.fetchContextClosure(request)
        // Deletion generation stale discard before validation — hard deletion invalidates before publication
        if (isDeletionStale(topicId, deletionGenAtFetch)) return
        // Fail-closed validation together with block/message refs
        if (!isValidContextClosureResponse(request, response)) {
          if (
            seq === seqRef.current &&
            topicRef.current === topicId &&
            anchorRef.current === anchorGroupKey &&
            routeRef.current === route
          ) {
            setClosure(null)
          }
          return
        }
        // Stale/in-flight discard: topic/route or anchor moved, or seq superseded
        if (seq !== seqRef.current) return
        if (topicRef.current !== topicId || anchorRef.current !== anchorGroupKey || routeRef.current !== route) return
        // Same-generation check via current store anchor (still same) — route-keyed.
        const state = store.getState()
        const asst = state.assistants.assistants.find((a) => a.topics.some((t) => t.id === topicId))
        const routeKey = typeof route === 'string' && route.length > 0 ? `${topicId}:${route}` : topicId
        const currentAnchor = asst?.settings?.contextWindowAnchor?.[routeKey]?.groupKey ?? null
        if (currentAnchor !== anchorGroupKey) return

        // Re-read semantic freshness immediately before staged publication (covers mutations during fetch)
        const curGenNow = getClosureLoadGeneration(topicId, route)
        if (curGenNow !== generationAtFetch) return
        if (getGlobalBlockGeneration() !== globalAtFetch) return
        if (isDeletionStale(topicId, deletionGenAtFetch)) return

        // Staged publication: re-read once more immediately before hydration to guard against races
        const genBeforePublish = getClosureLoadGeneration(topicId, route)
        if (genBeforePublish !== generationAtFetch) return
        if (getGlobalBlockGeneration() !== globalAtFetch) return
        if (isDeletionStale(topicId, deletionGenAtFetch)) return
        if (response.blocks.length > 0) {
          // Closure hydration for this topic only: scoped ownership + explicit
          // read-only marker so this hydration never bumps the semantic
          // generation (no invalidation loop). Other topics' cached closures
          // are never flushed by this publication.
          dispatch(markClosureReadOnly(withClosureTopics(upsertManyBlocks(response.blocks as any), topicId)))
        }
        // Cache publication stores snapshot of generation at fetch start (which equals current).
        // Stored fingerprint is closure-derived (authority), never viewport-derived.
        const closureFp = computeClosureFingerprint(response.messages as any)
        setCachedContextClosureWithFingerprint(topicId, response, closureFp, route)
        if (
          seq === seqRef.current &&
          topicRef.current === topicId &&
          anchorRef.current === anchorGroupKey &&
          routeRef.current === route
        ) {
          setClosure(response)
        }
      } catch {
        if (
          seq === seqRef.current &&
          topicRef.current === topicId &&
          anchorRef.current === anchorGroupKey &&
          routeRef.current === route
        ) {
          setClosure(null)
        }
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    })()
    // viewportTick is a re-check trigger only (see above); fingerprint/newest
    // intentionally play no role in freshness. semanticSignal is the reactive
    // refresh signal for length-preserving mutations (viewport-independent).
  }, [topicId, anchorGroupKey, route, dispatch, viewportTick, semanticSignal])

  // Invalidate hook state when the semantic cache becomes stale via
  // generation (genuine mutation). Pure viewport growth retains the closure.
  useEffect(() => {
    if (!closure) return
    const fresh = getFreshValidatedClosure(topicId, anchorGroupKey, undefined, route)
    if (!fresh) {
      setClosure(null)
    }
  }, [viewportTick, closure, topicId, anchorGroupKey, route, semanticSignal])

  return { closure, loading }
}

/**
 * Invalidate closure cache for a topic (call after authoritative publication).
 * Bumps generation so in-flight publishes are discarded and future reads refetch.
 */
export function invalidateContextClosure(topicId: string, branchId?: string | null) {
  bumpAndInvalidate(topicId, branchId)
}
