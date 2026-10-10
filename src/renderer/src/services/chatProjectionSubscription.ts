/**
 * chatProjectionSubscription — renderer subscription for authoritative Main → renderer
 * chat-projection invalidation hints (`chatdb:chat-projection-invalidated`).
 *
 * The hint is NEVER data authority: it carries only stable assistant/topic/
 * branch IDs resolved from the committed Main authority. Every hint consumes
 * the FULL directory via the read-only `listLiveAssistantTopics` API (PROJ-10)
 * and merges by stable ID with `updateTopics` replace — preserving the
 * legitimately selected topic and the active branch route (no synthetic
 * default, no hijack-to-first; the existing `useActiveTopic` sync owns
 * selection fallback when the active topic itself was deleted).
 *
 * Message projection reuses the existing windowed mechanism only: the
 * currently selected resident route reloads once per hint (bounded, never
 * whole-history) via `loadTopicMessagesThunk(topicId, forceReload=true,
 * refreshAnchor)` — which resolves the active route, bumps the resident
 * generation, and stages window + segments under the same generation guards.
 * A stable around-anchor from the persisted route viewport snapshot (or the
 * resident loaded order) preserves the open window; latest is only the
 * no-anchor fallback. Nothing else pulls message history. Coarse hints
 * (empty topicIds) still reconcile the open resident route when its
 * assistant is named — directory-only would falsely claim completeness.
 *
 * Branch scope uses only the known renderer branch catalog (no new Main
 * lookups): a root change (empty branchIds) affects every route of the
 * named topic; otherwise only a proven unrelated sibling is skipped, and an
 * unknown catalog conservatively invalidates while preserving the window.
 *
 * Execution-overlay protection (PROJ): the resident reload never competes
 * with an in-flight request execution on the open route. When
 * `loadingByTopic[currentTopic]` is true (streaming/execution active), the
 * resident reload defers into ONE bounded current-route pending invalidation
 * (coalesced, never per-hint), flushed once on the existing store lifecycle
 * transition to loading=false for the SAME route. Directory reconcile still
 * runs while busy (full replace, no selection hijack); only the resident
 * windowed reload defers. Origin exclusion in Main already removes the
 * origin's own local-commit boomerang; this deferral covers remote hints
 * arriving while the local request produces. No persistent state, no new
 * owner, no poll timer — the store subscription lives only until flush or
 * route change, reading the actual `loadingByTopic` request flag (never a
 * separate projection-fetch flag). A route change while busy discards the
 * older pending projection (no stale apply); unknown flags conservatively
 * reload immediately.
 *
 * Pre-ready hints queue in transient module sets and flush after the
 * rehydrate startup sweep; no persistent state, no new IPC owner. The
 * per-assistant sequence ledger coalesces in-flight directory reads so the
 * final hint is never missed.
 *
 * Stale guards: per-assistant monotonic request sequence — a superseded
 * in-flight directory read discards before dispatch; an assistant deleted
 * while Main was in flight is never resurrected; unknown assistants
 * (assistant-config domain) are never created here. A construction race
 * (local catalog membership drifting while the Main read is in flight)
 * discards the stale response and re-reads the same assistant bounded
 * (max 3, seq-coalesced, no poll) so a locally added selected topic is never
 * dropped by an older directory.
 */

import { loggerService } from '@logger'
import type { ChatProjectionInvalidationEvent, TopicWire } from '@shared/chatDb'
import { validateChatProjectionInvalidationEvent } from '@shared/chatDb'

import store from '../store'
import { updateTopics } from '../store/assistants'
import { dbService } from './db'
import { topicWireToTopic } from './db/topicTrashLifecycle'
import { isImportProjectionReady } from './importProjectionReadiness'

const logger = loggerService.withContext('ChatProjectionSubscription')

let unsubscribe: (() => void) | null = null

/** Per-assistant request sequence for stale-inflight coalescing. */
const assistantSeq = new Map<string, number>()

/** Transient pre-ready hint coalescing (module-only, never persisted). */
const pendingAssistantIds = new Set<string>()
const pendingTopicIds = new Set<string>()
const pendingBranchIds = new Set<string>()

/**
 * Bounded current-route pending resident invalidation while a request
 * execution owns the open route. Exactly one entry (coalesced); cleared on
 * flush, route change, or test teardown. Never persisted.
 */
let pendingResident: { topicId: string; assistantIds: string[]; topicIds: string[]; branchIds: string[] } | null = null
let pendingResidentUnsub: (() => void) | null = null
let pendingResidentPrevLoading: boolean | null = null

function dedupIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Request-execution ownership for the open route (streaming/execution). */
function isRequestActive(topicId: string): boolean {
  try {
    return !!store.getState().messages?.loadingByTopic?.[topicId]
  } catch {
    return false
  }
}

function teardownPendingResidentFlush(): void {
  pendingResident = null
  pendingResidentPrevLoading = null
  if (pendingResidentUnsub) {
    try {
      pendingResidentUnsub()
    } catch {
      // best effort
    }
    pendingResidentUnsub = null
  }
}

function flushPendingResident(): void {
  const snapshot = pendingResident
  teardownPendingResidentFlush()
  if (!snapshot) return
  // Current-route guard: a route change while busy discards the older
  // projection — never apply stale to the unrelated current route.
  const currentTopicId = getCurrentTopicId()
  if (!currentTopicId || currentTopicId !== snapshot.topicId) return
  try {
    void reloadCurrentTopicIfAffected(snapshot.topicIds, snapshot.branchIds, snapshot.assistantIds)
  } catch {
    // best-effort flush; never break the store subscriber
  }
}

function ensurePendingResidentFlushSubscription(): void {
  if (pendingResidentUnsub || !pendingResident) return
  pendingResidentPrevLoading = isRequestActive(pendingResident.topicId)
  try {
    pendingResidentUnsub = store.subscribe(() => {
      try {
        const pending = pendingResident
        if (!pending) {
          teardownPendingResidentFlush()
          return
        }
        const currentTopicId = getCurrentTopicId()
        // Route moved while busy: discard the older pending projection.
        if (!currentTopicId || currentTopicId !== pending.topicId) {
          teardownPendingResidentFlush()
          return
        }
        let loading = false
        try {
          loading = !!store.getState().messages?.loadingByTopic?.[pending.topicId]
        } catch {
          loading = false
        }
        const prev = pendingResidentPrevLoading
        pendingResidentPrevLoading = loading
        // Existing lifecycle transition only: active -> settled flushes once.
        if (prev === true && loading === false) {
          flushPendingResident()
        }
      } catch {
        // never break the store subscription dispatch path
      }
    })
  } catch {
    pendingResidentUnsub = null
  }
}

function deferResidentWhileBusy(
  topicId: string,
  topicIds: string[],
  branchIds: string[],
  assistantIds: string[]
): void {
  if (!pendingResident || pendingResident.topicId !== topicId) {
    pendingResident = {
      topicId,
      assistantIds: dedupIds(assistantIds),
      topicIds: dedupIds(topicIds),
      branchIds: dedupIds(branchIds)
    }
  } else {
    const merged = new Set<string>([...pendingResident.assistantIds, ...dedupIds(assistantIds)])
    const mergedTopics = new Set<string>([...pendingResident.topicIds, ...dedupIds(topicIds)])
    const mergedBranches = new Set<string>([...pendingResident.branchIds, ...dedupIds(branchIds)])
    pendingResident = {
      topicId,
      assistantIds: [...merged],
      topicIds: [...mergedTopics],
      branchIds: [...mergedBranches]
    }
  }
  ensurePendingResidentFlushSubscription()
}

function nextSeq(assistantId: string): number {
  const next = (assistantSeq.get(assistantId) ?? 0) + 1
  assistantSeq.set(assistantId, next)
  return next
}

function isCurrentSeq(assistantId: string, seq: number): boolean {
  return (assistantSeq.get(assistantId) ?? 0) === seq
}

function findAssistant(assistantId: string): { id: string; topics?: unknown } | undefined {
  try {
    return (store.getState().assistants?.assistants ?? []).find((a) => a.id === assistantId)
  } catch {
    return undefined
  }
}

function findAssistantForTopic(topicId: string): string | null {
  try {
    const assistants = store.getState().assistants?.assistants ?? []
    for (const a of assistants) {
      if (Array.isArray((a as { topics?: Array<{ id: string }> }).topics)) {
        if (((a as { topics: Array<{ id: string }> }).topics ?? []).some((t) => t?.id === topicId)) {
          return (a as { id: string }).id
        }
      }
    }
    return null
  } catch {
    return null
  }
}

function getCurrentTopicId(): string | null {
  try {
    const id = store.getState().messages?.currentTopicId ?? null
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}

function getActiveRoute(topicId: string): string | null {
  try {
    const route = (
      store.getState() as unknown as { topicBranch?: { activeBranchIdByTopic?: Record<string, string | null> } }
    ).topicBranch?.activeBranchIdByTopic?.[topicId]
    return typeof route === 'string' && route.length > 0 ? route : null
  } catch {
    return null
  }
}

function getLoadedIds(topicId: string): string[] {
  try {
    const ids = store.getState().messages?.messageIdsByTopic?.[topicId]
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.length > 0) : []
  } catch {
    return []
  }
}

/**
 * Read the persisted route-local stable viewport snapshot anchor without
 * touching the DOM. Uses the existing viewport key format
 * (`scroll:topic-<id>::<branch|main>`) and the stable row identity
 * (`messageId`/`anchorId`); the offset/position itself is owned by the
 * route viewport controller and is never reinterpreted here.
 */
function readPersistedViewportAnchor(topicId: string, route: string | null): string | null {
  try {
    const keyv =
      typeof window !== 'undefined'
        ? (window as unknown as { keyv?: { get?: (k: string) => unknown } }).keyv
        : undefined
    const get = keyv?.get
    if (typeof get !== 'function') return null
    const routeKey = `topic-${topicId}::${route ?? 'main'}`
    const storageKey = routeKey.startsWith('scroll:') ? routeKey : `scroll:${routeKey}`
    const saved = get.call(keyv, storageKey)
    if (saved && typeof saved === 'object') {
      const rec = saved as Record<string, unknown>
      const messageId = typeof rec.messageId === 'string' ? rec.messageId : null
      const anchorId = typeof rec.anchorId === 'string' ? rec.anchorId : null
      const anchor = messageId ?? anchorId
      if (typeof anchor === 'string' && anchor.length > 0) return anchor
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve the around-anchor for a hint-driven resident refresh: the
 * persisted viewport snapshot anchor first (old first-visible stable ID),
 * then the oldest resident loaded ID. Null means no anchor — the caller
 * falls back to the existing latest reload.
 */
export function resolveHintRefreshAnchorForTests(topicId: string, route: string | null): string | null {
  const snapshotAnchor = readPersistedViewportAnchor(topicId, route)
  if (snapshotAnchor) return snapshotAnchor
  const loaded = getLoadedIds(topicId)
  if (loaded.length > 0) return loaded[0]
  return null
}

/**
 * Canonical branch-scope check using only the known renderer catalog.
 * Returns true when the current route must invalidate (reload preserving
 * the window). Only a proven unrelated sibling skips: both routes known,
 * same parent, different IDs. Empty hint branchIds is a root change and
 * affects every route of the topic — never skipped. Unknown catalog or
 * unknown branch IDs conservatively invalidate (preserve window).
 */
export function isCurrentRouteAffectedByBranchHintForTests(
  topicId: string,
  activeRoute: string | null,
  hintBranchIds: string[]
): boolean {
  if (!Array.isArray(hintBranchIds) || hintBranchIds.length === 0) return true
  let branches: Array<{ id: string; parentBranchId?: string | null }> = []
  try {
    branches =
      (
        store.getState() as unknown as {
          topicBranch?: { branchesByTopic?: Record<string, Array<{ id: string; parentBranchId?: string | null }>> }
        }
      ).topicBranch?.branchesByTopic?.[topicId] ?? []
  } catch {
    return true
  }
  if (!Array.isArray(branches) || branches.length === 0) return true
  const parentOf = new Map<string, string | null>()
  for (const b of branches) {
    if (b && typeof b.id === 'string' && b.id.length > 0) {
      parentOf.set(b.id, b.parentBranchId ?? null)
    }
  }
  const ancestorsOf = (branchId: string | null): Set<string> => {
    const out = new Set<string>()
    let current = branchId
    for (let depth = 0; depth < 64 && typeof current === 'string' && current.length > 0; depth++) {
      if (out.has(current)) break
      out.add(current)
      const parent = parentOf.get(current)
      if (parent === undefined) break
      current = parent
    }
    return out
  }
  const activeAncestors = ancestorsOf(activeRoute)
  const activeKnown = activeRoute === null || parentOf.has(activeRoute)
  for (const hinted of hintBranchIds) {
    if (typeof hinted !== 'string' || hinted.length === 0) continue
    if (hinted === activeRoute) return true
    if (!parentOf.has(hinted)) return true
    if (!activeKnown) return true
    // Owner butterfly: a hinted ancestor affects its descendant routes.
    if (activeRoute !== null && ancestorsOf(activeRoute).has(hinted)) return true
    // A hinted descendant shares the ancestor prefix: conservatively affect
    // the ancestor view (preserve window) rather than risk a missed update.
    if (activeRoute !== null && ancestorsOf(hinted).has(activeRoute)) return true
    if (activeRoute === null) return true
    // Proven unrelated sibling: same parent, different IDs.
    const activeParent = parentOf.get(activeRoute)
    const hintedParent = parentOf.get(hinted)
    if (activeParent !== undefined && hintedParent !== undefined && activeParent === hintedParent) {
      continue
    }
    void activeAncestors
    return true
  }
  // Every hinted branch was a proven unrelated sibling.
  return false
}

/**
 * Snapshot the current Redux topic-ID catalog for one assistant as a stable
 * copy (never a live Immer draft reference). Returns null when the assistant
 * is missing or its topics list is unloaded.
 */
function snapshotAssistantTopicIds(assistantId: string): string[] | null {
  try {
    const assistants = store.getState().assistants?.assistants ?? []
    const found = assistants.find((a) => (a as { id: string }).id === assistantId) as
      | { topics?: Array<{ id?: unknown }> }
      | undefined
    if (!found || !Array.isArray(found.topics)) return null
    const ids: string[] = []
    for (const t of found.topics) {
      if (t && typeof t.id === 'string' && t.id.length > 0) ids.push(t.id)
    }
    return ids
  } catch {
    return null
  }
}

/**
 * Reconcile ONE assistant's topic directory from the authoritative Main
 * snapshot. Full replace by stable ID (PROJ-10); never find-or-create, so a
 * remotely deleted collection stays deleted here.
 *
 * Strict same-assistant binding: the response echo must equal the request,
 * and EVERY row must carry a non-empty `assistantId` equal to the request
 * (actual `TopicWire` nullable type — never the legacy id-only shape). A
 * malformed or cross-assistant row rejects the whole collection (no
 * dispatch, no cross-link) rather than merging a foreign topic.
 *
 * Construction-race guard: the Redux catalog is snapshotted (stable-ID copy)
 * at read start and re-read at apply time. When local membership drifted
 * during the in-flight Main read (optimistic add before SQLite commit, or a
 * local delete), a stale response that misses a locally added ID or still
 * carries a locally removed ID is discarded and the same-assistant directory
 * is re-read bounded (existing per-assistant seq/coalescing, max 3 attempts,
 * no poll timer). A response that already covers the drifted catalog applies
 * directly. Authoritative empty with no drift still applies (deletion wins);
 * no arbitrary ID is preserved forever and no new authority-candidate write
 * is issued here — the bounded re-read eventually applies the latest
 * complete authoritative list. ID-set comparison only (never object
 * identity) so this routine's own `updateTopics` dispatch cannot retrigger.
 */
export async function reconcileAssistantDirectory(assistantId: string): Promise<boolean> {
  if (typeof assistantId !== 'string' || assistantId.length === 0) return false
  const maxAttempts = 3
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startIds = snapshotAssistantTopicIds(assistantId)
    const startSet = startIds ? new Set(startIds) : null
    const seq = nextSeq(assistantId)
    let response: { assistantId: string; topics: TopicWire[] }
    try {
      response = (await dbService.listLiveAssistantTopics(assistantId)) as unknown as {
        assistantId: string
        topics: TopicWire[]
      }
    } catch (error) {
      logger.warn(`chat-projection directory read failed for ${assistantId}`, error as Error)
      return false
    }
    if (!isCurrentSeq(assistantId, seq)) return false
    const current = findAssistant(assistantId)
    if (!current) {
      logger.warn(`chat-projection stale result ignored: assistant ${assistantId} deleted during refresh`)
      return false
    }
    if (!Array.isArray(current.topics)) {
      logger.warn(`chat-projection stale result ignored: assistant ${assistantId} topics unloaded during refresh`)
      return false
    }
    if (!response || typeof response !== 'object' || response.assistantId !== assistantId) {
      logger.warn(`chat-projection assistant mismatch ignored for ${assistantId}`)
      return false
    }
    if (!Array.isArray(response.topics)) {
      logger.warn(`chat-projection malformed directory ignored for ${assistantId}`)
      return false
    }
    const seen = new Set<string>()
    const merged: Array<ReturnType<typeof topicWireToTopic>> = []
    for (const wire of response.topics) {
      if (!wire || typeof wire !== 'object') {
        logger.warn(`chat-projection malformed assistant row ignored for ${assistantId}`)
        return false
      }
      const row = wire
      if (typeof row.id !== 'string' || row.id.length === 0 || seen.has(row.id)) {
        if (typeof row.id !== 'string' || row.id.length === 0) {
          logger.warn(`chat-projection malformed assistant row ignored for ${assistantId}`)
          return false
        }
        continue
      }
      if (typeof row.assistantId !== 'string' || row.assistantId.length === 0 || row.assistantId !== assistantId) {
        logger.warn(`chat-projection cross-assistant row rejected for ${assistantId}`)
        return false
      }
      seen.add(row.id)
      merged.push(topicWireToTopic(row))
    }
    const endIds = snapshotAssistantTopicIds(assistantId)
    if (startSet && endIds) {
      const endSet = new Set(endIds)
      let membershipChanged = startSet.size !== endSet.size
      if (!membershipChanged) {
        for (const id of endSet) {
          if (!startSet.has(id)) {
            membershipChanged = true
            break
          }
        }
      }
      if (membershipChanged) {
        let missingAdded = false
        for (const id of endSet) {
          if (!seen.has(id)) {
            missingAdded = true
            break
          }
        }
        let resurrected = false
        for (const id of startSet) {
          if (!endSet.has(id) && seen.has(id)) {
            resurrected = true
            break
          }
        }
        if (missingAdded || resurrected) {
          if (attempt + 1 < maxAttempts) {
            logger.warn(
              `chat-projection stale directory discarded for ${assistantId} (catalog drifted during read, rereading)`
            )
            continue
          }
          logger.warn(`chat-projection stale directory dropped for ${assistantId} after bounded reread`)
          return false
        }
      }
    }
    try {
      store.dispatch(updateTopics({ assistantId, topics: merged }))
    } catch (error) {
      logger.warn(`chat-projection directory apply failed for ${assistantId}`, error as Error)
      return false
    }
    return true
  }
  return false
}

async function reloadCurrentResidentPreservingWindow(): Promise<void> {
  const currentTopicId = getCurrentTopicId()
  if (!currentTopicId) return
  const route = getActiveRoute(currentTopicId)
  const anchor = resolveHintRefreshAnchorForTests(currentTopicId, route)
  try {
    const { loadTopicMessagesThunk } = await import('../store/thunk/messageThunk')
    await (store.dispatch as unknown as (t: unknown) => Promise<unknown>)(
      (anchor
        ? loadTopicMessagesThunk(currentTopicId, true, { anchorMessageId: anchor })
        : loadTopicMessagesThunk(currentTopicId, true)) as unknown
    )
  } catch (error) {
    logger.warn(`chat-projection resident reload failed for ${currentTopicId}`, error as Error)
  }
}

/**
 * Decide whether the open resident route needs a bounded re-read for one
 * hint. Precise hints (current topic named) honor branch scope; coarse
 * baseline hints (empty topicIds) still reconcile the open route when its
 * assistant is named — directory-only would falsely claim completeness.
 * Exactly one resident re-read per hint, never whole-history.
 */
async function reloadCurrentTopicIfAffected(
  topicIds: string[],
  branchIds: string[],
  assistantIds: string[]
): Promise<void> {
  const currentTopicId = getCurrentTopicId()
  if (!currentTopicId) return
  // Route moved since a busy deferral queued: discard handled by the flush
  // guard; a fresh hint for a non-current topic never touches the open route
  // except via the coarse-baseline path below. A pending entry for a
  // different topic is stale — drop it before evaluating this hint.
  if (pendingResident && pendingResident.topicId !== currentTopicId) {
    teardownPendingResidentFlush()
  }
  const namedPrecise = Array.isArray(topicIds) && topicIds.includes(currentTopicId)
  if (namedPrecise) {
    const route = getActiveRoute(currentTopicId)
    if (!isCurrentRouteAffectedByBranchHintForTests(currentTopicId, route, branchIds)) return
    // Execution overlay: while the open route produces (loadingByTopic),
    // skip the forced reload and keep ONE bounded pending invalidation for
    // this route; the store lifecycle transition flushes it once settled.
    if (isRequestActive(currentTopicId)) {
      deferResidentWhileBusy(currentTopicId, topicIds, branchIds, assistantIds)
      return
    }
    await reloadCurrentResidentPreservingWindow()
    return
  }
  // Coarse baseline: the open route's assistant is named but no topic is.
  if (Array.isArray(topicIds) && topicIds.length === 0) {
    const owner = findAssistantForTopic(currentTopicId)
    if (owner && Array.isArray(assistantIds) && assistantIds.includes(owner)) {
      if (isRequestActive(currentTopicId)) {
        deferResidentWhileBusy(currentTopicId, topicIds, branchIds, assistantIds)
        return
      }
      await reloadCurrentResidentPreservingWindow()
    }
  }
}

function queueHintForStartup(event: ChatProjectionInvalidationEvent): void {
  for (const id of event.assistantIds ?? []) {
    if (typeof id === 'string' && id.length > 0) pendingAssistantIds.add(id)
  }
  for (const id of event.topicIds ?? []) {
    if (typeof id === 'string' && id.length > 0) pendingTopicIds.add(id)
  }
  for (const id of event.branchIds ?? []) {
    if (typeof id === 'string' && id.length > 0) pendingBranchIds.add(id)
  }
}

/**
 * Consume one validated invalidation hint: refresh every named KNOWN
 * assistant directory (unknown assistant configs stay in their own domain),
 * then reload the selected resident route once when affected (precise or
 * coarse-baseline). Pre-ready hints coalesce into transient module sets
 * for the post-rehydrate startup flush — the sequence ledger still records
 * the affected route via the queued sets even though this call skips.
 */
export async function consumeChatProjectionHint(
  event: ChatProjectionInvalidationEvent,
  opts?: { importReady?: () => boolean }
): Promise<void> {
  const ready = opts?.importReady ?? isImportProjectionReady
  let isReady = false
  try {
    isReady = ready()
  } catch {
    isReady = false
  }
  if (!isReady) {
    try {
      queueHintForStartup(event)
    } catch {
      // best-effort queue; never break the hint path
    }
    return
  }
  const assistantIds = Array.isArray(event.assistantIds) ? event.assistantIds : []
  const topicIds = Array.isArray(event.topicIds) ? event.topicIds : []
  const branchIds = Array.isArray(event.branchIds) ? event.branchIds : []
  for (const assistantId of assistantIds) {
    if (typeof assistantId !== 'string' || assistantId.length === 0) continue
    if (!findAssistant(assistantId)) continue
    try {
      await reconcileAssistantDirectory(assistantId)
    } catch {
      // best-effort per assistant; never break the remaining scopes
    }
  }
  await reloadCurrentTopicIfAffected(topicIds, branchIds, assistantIds)
}

export function subscribeChatProjectionEvents(): () => void {
  if (unsubscribe) return unsubscribe
  const api = (typeof window !== 'undefined' ? (window as unknown as { api?: unknown }).api : undefined) as
    | { chatDb?: { onChatProjectionInvalidated?: (cb: (e: unknown) => void) => () => void } }
    | undefined
  const onInvalidated = api?.chatDb?.onChatProjectionInvalidated
  if (typeof onInvalidated !== 'function') {
    logger.warn(
      'Chat projection event subscription unavailable: window.api.chatDb.onChatProjectionInvalidated not exposed'
    )
    return () => {}
  }
  try {
    unsubscribe = onInvalidated((event: unknown) => {
      try {
        validateChatProjectionInvalidationEvent(event)
        void consumeChatProjectionHint(event as ChatProjectionInvalidationEvent)
      } catch (error) {
        logger.warn('Invalid ChatProjectionInvalidationEvent payload, discarding', error as Error)
      }
    })
    logger.info('Subscribed to chatdb:chat-projection-invalidated')
  } catch (error) {
    logger.warn('Failed to subscribe to chat projection events', error as Error)
    return () => {}
  }
  return () => {
    try {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    } catch {
      // best effort
    }
    teardownPendingResidentFlush()
  }
}

/**
 * Startup repair for pre-existing nonempty directories (app restart with an
 * old missing topic): snapshot the LOCAL Main complete directory per
 * nonempty assistant and replace by stable ID. Import-pending boots skip
 * (projection outcome unknown); deleted assistants skip (never resurrect);
 * unloaded (`undefined`) lists skip; really-empty lists stay on the
 * existing ensure path (genuine local init — never resurrected here, and
 * this sweep never find-or-creates). After the sweep, flush any pre-ready
 * queued hints (full directory read + bounded resident refresh) so no
 * final hint is missed while inflight.
 */
export async function reconcileNonemptyAssistantDirectoriesAtStartup(opts?: {
  importReady?: () => boolean
}): Promise<{ repaired: string[] }> {
  const ready = opts?.importReady ?? isImportProjectionReady
  let isReady = false
  try {
    isReady = ready()
  } catch {
    return { repaired: [] }
  }
  if (!isReady) return { repaired: [] }
  let assistants: Array<{ id: string; topics?: unknown }> = []
  try {
    assistants = store.getState().assistants?.assistants ?? []
  } catch {
    return { repaired: [] }
  }
  const repaired: string[] = []
  for (const assistant of assistants) {
    if (!assistant || typeof assistant.id !== 'string' || assistant.id.length === 0) continue
    if (!Array.isArray(assistant.topics) || assistant.topics.length === 0) continue
    try {
      const applied = await reconcileAssistantDirectory(assistant.id)
      if (applied) repaired.push(assistant.id)
    } catch (error) {
      logger.warn(`startup directory reconcile failed for ${assistant.id}`, error as Error)
    }
  }
  // Flush coalesced pre-ready hints (if any) with the same bounded path:
  // full directory reads plus at most one resident refresh.
  if (pendingAssistantIds.size > 0 || pendingTopicIds.size > 0 || pendingBranchIds.size > 0) {
    const flushed = {
      assistantIds: [...pendingAssistantIds],
      topicIds: [...pendingTopicIds],
      branchIds: [...pendingBranchIds],
      reason: 'sync-baseline' as const
    }
    pendingAssistantIds.clear()
    pendingTopicIds.clear()
    pendingBranchIds.clear()
    try {
      await consumeChatProjectionHint(flushed, { importReady: () => true })
    } catch (error) {
      logger.warn('startup queued hint flush failed', error as Error)
    }
  }
  return { repaired }
}

export function getPendingChatProjectionHintForTests(): {
  assistantIds: string[]
  topicIds: string[]
  branchIds: string[]
} {
  return {
    assistantIds: [...pendingAssistantIds],
    topicIds: [...pendingTopicIds],
    branchIds: [...pendingBranchIds]
  }
}

export function getPendingResidentReloadForTests(): {
  topicId: string
  assistantIds: string[]
  topicIds: string[]
  branchIds: string[]
} | null {
  if (!pendingResident) return null
  return {
    topicId: pendingResident.topicId,
    assistantIds: [...pendingResident.assistantIds],
    topicIds: [...pendingResident.topicIds],
    branchIds: [...pendingResident.branchIds]
  }
}

export function isRequestActiveForTests(topicId: string): boolean {
  return isRequestActive(topicId)
}

export function unsubscribeChatProjectionEventsForTests(): void {
  if (unsubscribe) {
    try {
      unsubscribe()
    } catch {}
    unsubscribe = null
  }
  assistantSeq.clear()
  pendingAssistantIds.clear()
  pendingTopicIds.clear()
  pendingBranchIds.clear()
  teardownPendingResidentFlush()
}
