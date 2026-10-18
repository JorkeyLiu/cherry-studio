import { loggerService } from '@logger'
import { isValidWindowResponse } from '@renderer/services/windowCoverage'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'

import { NAVIGATION_VISUALLY_NEWER_GROUPS, NAVIGATION_VISUALLY_OLDER_GROUPS } from './messageNavigation'
import { clampWindowCount, rebaseRouteWindow, unionWindowMessages } from './messageWindow'

const loaderLogger = loggerService.withContext('messageNavigationLoader')

/**
 * Unified stable-ID navigation loader (renderer-only).
 *
 * Responsibility is strictly `ensure target loaded`:
 * - Resident fast path performs zero reads.
 * - Missing targets issue exactly one `around` window read anchored at the
 *   target ID with the canonical navigation quotas (before=10, after=19,
 *   clamped through the existing window constants).
 * - All reads flow through the caller's injected `readAroundWindow`, which the
 *   production Messages wiring binds to `runTopicWindowRead(topicId,'around',…)`.
 * - Classification (authoritative vs retryable): `resident` (zero reads),
 *   `loaded` (validated + assembled), `not-found` only for explicit ChatDb
 *   NOT_FOUND / ERR_NOT_FOUND / TOPIC_NOT_FOUND, `cancelled` for caller-owned
 *   stale guards, `error` for transport/unknown/malformed (retryable, preserves
 *   pending).
 * - Assembly for non-resident targets is route-order only (resident fast path
 *   above makes any anchor-resident branch unreachable, so none exists here):
 *   `unionWindowMessages` splices a window that shares a resident neighbour at
 *   that neighbour, and a window that shares none (fully disjoint) takes the
 *   existing authoritative route-window rebase (`rebaseRouteWindow`, reported as
 *   `rebased`) — never a global `sortOrder`/id sort, which would fabricate a
 *   route order the authority never published.
 *
 * No DOM, no routing, no store publication, no new persistent state.
 * Logging is privacy-safe: no topic/message IDs, error object only.
 */

export const NAVIGATION_LOADER_BEFORE = clampWindowCount(NAVIGATION_VISUALLY_OLDER_GROUPS)
export const NAVIGATION_LOADER_AFTER = clampWindowCount(NAVIGATION_VISUALLY_NEWER_GROUPS)

export function buildNavigationAroundRequest(topicId: string, anchorMessageId: string): FetchMessagesWindowRequest {
  return {
    kind: 'around',
    topicId,
    anchorMessageId,
    before: NAVIGATION_LOADER_BEFORE,
    after: NAVIGATION_LOADER_AFTER
  }
}

export type EnsureMessageLoadedResult =
  | { status: 'resident' }
  | {
      status: 'loaded'
      messages: Message[]
      blocks: MessageBlock[]
      mutableMessageIds: string[]
      /**
       * True when the around window shared no resident neighbour and the read
       * took the authoritative route-window rebase (the projection is exactly
       * Main's window order) instead of an invented route order.
       */
      rebased?: boolean
    }
  | { status: 'not-found' }
  | { status: 'cancelled' }
  | { status: 'error' }

export interface EnsureMessageLoadedDeps {
  /** Current loaded projection for the target topic (stable-ID ordered). */
  getExistingMessages: () => Message[]
  /**
   * Executes one around-window read. Production binds this to
   * `runTopicWindowRead(topicId, 'around', () => dbService.fetchMessagesWindow(request))`
   * so same-topic reads stay FIFO-serialized; tests inject a stub.
   */
  readAroundWindow: (request: FetchMessagesWindowRequest) => Promise<FetchMessagesWindowResponse>
  /** Caller-owned staleness (topic/epoch/generation/deletion/resident). Checked before fetch. */
  isStaleBeforeFetch?: () => boolean
  /** Caller-owned staleness. Checked after fetch, before validation/merge. */
  isStaleAfterFetch?: () => boolean
}

const containsId = (messages: Message[], id: string): boolean => messages.some((m) => m.id === id)

const NOT_FOUND_CODES = new Set(['NOT_FOUND', 'ERR_NOT_FOUND', 'TOPIC_NOT_FOUND'])

/**
 * Authoritative not-found check against the `ChatDbResultError` code contract.
 * Structural (code + name) rather than `instanceof` to avoid pulling the full
 * SQLite datasource module (and its store side effects) into this loader.
 */
const isAuthoritativeNotFound = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && NOT_FOUND_CODES.has(code)
}

export const ensureMessageLoaded = async (
  topicId: string,
  targetId: string,
  deps: EnsureMessageLoadedDeps
): Promise<EnsureMessageLoadedResult> => {
  if (!topicId || !targetId) {
    loaderLogger.warn('[ensureMessageLoaded] missing stable target, fail-closed as not-found')
    return { status: 'not-found' }
  }

  const existing = deps.getExistingMessages() ?? []
  if (containsId(existing, targetId)) return { status: 'resident' }

  if (deps.isStaleBeforeFetch?.()) return { status: 'cancelled' }

  const request = buildNavigationAroundRequest(topicId, targetId)

  let response: FetchMessagesWindowResponse
  try {
    response = await deps.readAroundWindow(request)
  } catch (error) {
    if (deps.isStaleAfterFetch?.()) return { status: 'cancelled' }
    if (isAuthoritativeNotFound(error)) {
      loaderLogger.warn('[ensureMessageLoaded] authoritative not-found', error as Error)
      return { status: 'not-found' }
    }
    loaderLogger.error('[ensureMessageLoaded] window read failed (retryable)', error as Error)
    return { status: 'error' }
  }

  if (deps.isStaleAfterFetch?.()) return { status: 'cancelled' }

  if (!isValidWindowResponse(request, response)) {
    loaderLogger.error('[ensureMessageLoaded] malformed window response', response?.window as unknown as Error)
    return { status: 'error' }
  }
  if (response.window.topicId !== topicId || response.window.kind !== 'around') {
    loaderLogger.error('[ensureMessageLoaded] window topic/kind mismatch')
    return { status: 'error' }
  }
  if (response.window.anchorMessageId !== targetId) {
    loaderLogger.error('[ensureMessageLoaded] window anchor mismatch')
    return { status: 'error' }
  }

  const incoming = (response.messages ?? []) as unknown as Message[]
  const blocks = (response.blocks ?? []) as unknown as MessageBlock[]
  if (!incoming.some((m) => m?.id === targetId)) {
    loaderLogger.error('[ensureMessageLoaded] anchor missing in window response')
    return { status: 'error' }
  }

  // Target was not resident (fast path above), so the around window can only
  // splice into the resident order through a SHARED resident neighbour. When the
  // window shares none (fully disjoint), no route-order position is provable:
  // the read then takes the existing authoritative route-window rebase instead
  // of inventing an order (never a global `sortOrder`/id sort — on a branch
  // route that field is an owner-local layer index).
  const union = unionWindowMessages(existing, incoming)
  let merged: Message[]
  let rebased = false
  if (union.status === 'merged') {
    merged = union.messages
  } else {
    rebased = true
    const plan = rebaseRouteWindow(
      existing.map((m) => m.id),
      incoming,
      { hasMoreBefore: response.window.hasMoreBefore, hasMoreAfter: response.window.hasMoreAfter }
    )
    const byId = new Map(incoming.map((m) => [m.id, m]))
    merged = plan.nextIds.flatMap((id) => {
      const message = byId.get(id)
      return message ? [message] : []
    })
    loaderLogger.info('[ensureMessageLoaded] disjoint window: authoritative route-window rebase (no fabricated order)')
  }

  if (!merged.some((m) => m?.id === targetId)) {
    loaderLogger.error('[ensureMessageLoaded] anchor missing after merge')
    return { status: 'error' }
  }

  // Main-authoritative per-window capability rides with the merged publish
  // so the atomic `messagesWindowMerged` commit can union it without an
  // intermediate all-immutable frame. Missing/invalid lists fail closed as
  // empty (union contributes nothing; route-mismatch adopts empty).
  const rawMutable = (response as unknown as { mutableMessageIds?: unknown }).mutableMessageIds
  const mutableMessageIds = Array.isArray(rawMutable)
    ? [...new Set(rawMutable.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []

  return { status: 'loaded', messages: merged, blocks, mutableMessageIds, ...(rebased ? { rebased: true } : {}) }
}
