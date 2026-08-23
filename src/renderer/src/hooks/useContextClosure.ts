import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import {
  bumpAndInvalidate,
  computeClosureFingerprint,
  getClosureLoadGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  isValidContextClosureResponse,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { dbService } from '@renderer/services/db'
import store, { useAppDispatch } from '@renderer/store'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { FetchContextClosureRequest, FetchContextClosureResponse } from '@shared/chatDb'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Per-topic context closure cache hook (R-06).
 *
 * - Dedicated per-topic closure cache, separate from viewport MessageWindow.
 * - Async load on topic activation after anchor establishment (anchorGroupKey required).
 * - Same-anchor + same-generation validated; stale/in-flight discarded.
 * - Full-closure freshness via per-topic generation (covers same-length mutations
 *   anywhere in anchor-to-newest, including outside viewport) plus deterministic
 *   fingerprint for visible mutations. Generation is bumped via store
 *   middleware on every authoritative message/block publication — no new IPC.
 * - Staged publication re-reads generation/fingerprint immediately before
 *   upsertManyBlocks and cache publication; discards on mismatch so stale
 *   responses cannot overwrite newer block entities.
 * - No separate persistence, no viewport expansion, no contextCount bound.
 */
export function useContextClosure(topicId: string, anchorGroupKey: string | null) {
  const dispatch = useAppDispatch()
  const topicMessages = useTopicMessages(topicId)
  const [closure, setClosure] = useState<FetchContextClosureResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)
  const topicRef = useRef(topicId)
  const anchorRef = useRef(anchorGroupKey)
  // LOCK-R06-006: fingerprint for visible mutations; generation covers outside-viewport
  const currentFingerprint = useMemo(() => computeClosureFingerprint(topicMessages as any), [topicMessages])

  // Keep refs updated for stale checks inside async
  useEffect(() => {
    topicRef.current = topicId
    anchorRef.current = anchorGroupKey
  }, [topicId, anchorGroupKey])

  // Load or reuse closure with full-closure freshness gate
  useEffect(() => {
    if (!topicId || !anchorGroupKey) {
      setClosure(null)
      return
    }
    // Centralized freshness-gated read: structural + anchor + generation + fingerprint
    const fresh = getFreshValidatedClosure(topicId, anchorGroupKey, currentFingerprint)
    if (fresh) {
      // Additional newest check: if viewport newest not in closure, treat as stale (covers window-truncated add before generation bump)
      if (topicMessages.length > 0) {
        const closureIds = new Set((fresh.messages as any).map((m: any) => m.id))
        const newestId = topicMessages[topicMessages.length - 1]?.id
        if (newestId && !closureIds.has(newestId)) {
          bumpAndInvalidate(topicId)
        } else {
          setClosure(fresh)
          return
        }
      } else {
        setClosure(fresh)
        return
      }
    } else {
      // No fresh cache — if we have a stale closure state, clear it to fallback to viewport
      if (closure) {
        // Only clear state, cache already invalid or missing
        setClosure(null)
      }
    }
    // Need to fetch
    const seq = ++seqRef.current
    const request: FetchContextClosureRequest = { topicId, anchorGroupKey }
    // Capture generation + fingerprint + global block epoch at fetch start for in-flight publication guard (covers uncached topics with active fetches)
    const generationAtFetch = getClosureLoadGeneration(topicId)
    const fingerprintAtFetch = currentFingerprint
    const globalAtFetch = getGlobalBlockGeneration()
    setLoading(true)
    void (async () => {
      try {
        const response = await dbService.fetchContextClosure(request)
        // Fail-closed validation together with block/message refs
        if (!isValidContextClosureResponse(request, response)) {
          if (seq === seqRef.current && topicRef.current === topicId && anchorRef.current === anchorGroupKey) {
            setClosure(null)
          }
          return
        }
        // Stale/in-flight discard: topic or anchor moved, or seq superseded
        if (seq !== seqRef.current) return
        if (topicRef.current !== topicId || anchorRef.current !== anchorGroupKey) return
        // Same-generation check via current store anchor (still same)
        const state = store.getState()
        const asst = state.assistants.assistants.find((a) => a.topics.some((t) => t.id === topicId))
        const currentAnchor = asst?.settings?.contextWindowAnchor?.[topicId]?.groupKey ?? null
        if (currentAnchor !== anchorGroupKey) return

        // Re-read freshness signal immediately before staged publication (covers mutations during fetch)
        const curGenNow = getClosureLoadGeneration(topicId)
        if (curGenNow !== generationAtFetch) return
        if (getGlobalBlockGeneration() !== globalAtFetch) return
        const curFpNow = computeClosureFingerprint(selectMessagesForTopic(store.getState(), topicId) as any)
        if (curFpNow !== fingerprintAtFetch && curFpNow !== 'empty' && fingerprintAtFetch !== 'empty') {
          return
        }

        // Staged publication: re-read once more immediately before upsert to guard against race between check and dispatch
        const genBeforePublish = getClosureLoadGeneration(topicId)
        if (genBeforePublish !== generationAtFetch) return
        if (getGlobalBlockGeneration() !== globalAtFetch) return
        if (response.blocks.length > 0) {
          dispatch(upsertManyBlocks(response.blocks as any))
        }
        // Cache publication stores snapshot of generation at fetch start (which equals current)
        setCachedContextClosureWithFingerprint(topicId, response, fingerprintAtFetch)
        if (seq === seqRef.current && topicRef.current === topicId && anchorRef.current === anchorGroupKey) {
          setClosure(response)
        }
      } catch {
        if (seq === seqRef.current && topicRef.current === topicId && anchorRef.current === anchorGroupKey) {
          setClosure(null)
        }
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    })()
  }, [topicId, anchorGroupKey, dispatch, topicMessages, currentFingerprint])

  // Invalidate hook state when cache becomes stale via generation or fingerprint, or newest missing
  useEffect(() => {
    if (!closure) return
    const fresh = getFreshValidatedClosure(topicId, anchorGroupKey, currentFingerprint)
    if (!fresh) {
      setClosure(null)
      return
    }
    // Newest check fallback when generation not yet bumped but viewport appended beyond closure
    if (topicMessages.length > 0) {
      const closureIds = new Set(closure.messages.map((m: any) => m.id))
      const newestId = topicMessages[topicMessages.length - 1]?.id
      if (newestId && !closureIds.has(newestId)) {
        bumpAndInvalidate(topicId)
        setClosure(null)
      }
    }
  }, [topicMessages, closure, topicId, anchorGroupKey, currentFingerprint])

  return { closure, loading }
}

/**
 * Invalidate closure cache for a topic (call after authoritative publication).
 * Bumps generation so in-flight publishes are discarded and future reads refetch.
 */
export function invalidateContextClosure(topicId: string) {
  bumpAndInvalidate(topicId)
}
