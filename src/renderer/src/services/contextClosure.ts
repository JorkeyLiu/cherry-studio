import type { FetchContextClosureRequest, FetchContextClosureResponse } from '@shared/chatDb'

/**
 * Fail-closed validation for context closure responses (R-06).
 *
 * Rejects:
 * - wrong completeness/topic/anchor
 * - malformed first/last/count
 * - missing anchor row (messages do not contain anchor per resolution priority)
 * - viewport window masquerading as closure
 * - every empty anchor-based closure (LOCK-R06-004: missing topic/anchor is NOT_FOUND, never empty success)
 * No count bounds invented (unbounded closure).
 *
 * Recognized-role policy (LOCK-R06-005): only user/assistant/system participate
 * in turn semantics. Nullable/unknown/tool roles are ignored for turn
 * construction and cannot independently resolve as non-user anchors — aligned
 * with buildContextTurns and Main authoritative grouping.
 */
export function isValidContextClosureResponse(
  request: FetchContextClosureRequest,
  response: FetchContextClosureResponse | unknown
): boolean {
  if (!response || typeof response !== 'object') return false
  const r = response as Record<string, unknown>
  // LOCK-001: exact response root keys — only messages, blocks, closure; fail-closed on unknown root (mirrors Shared)
  const allowedRootKeys = new Set(['messages', 'blocks', 'closure'])
  for (const key of Object.keys(r)) {
    if (!allowedRootKeys.has(key)) return false
  }
  // Masquerading viewport window: must not have window property (already covered by root check, kept for explicit fail-closed)
  if ('window' in r) return false
  const closure = (r as unknown as FetchContextClosureResponse).closure
  const messages = (r as unknown as FetchContextClosureResponse).messages
  const blocks = (r as unknown as FetchContextClosureResponse).blocks
  if (!closure || typeof closure !== 'object') return false
  if (!Array.isArray(messages) || !Array.isArray(blocks)) return false
  const c = closure as unknown as Record<string, unknown>
  if (c.completeness !== 'context-closure') return false
  if (typeof c.topicId !== 'string' || c.topicId !== request.topicId) return false
  if (typeof c.anchorGroupKey !== 'string' || c.anchorGroupKey !== request.anchorGroupKey) return false
  if (typeof c.returnedCount !== 'number' || !Number.isInteger(c.returnedCount) || c.returnedCount < 0) return false
  if (c.returnedCount !== (messages as unknown[]).length) return false
  // LOCK-R06-004: anchor-based closure success is always non-empty; empty is NOT_FOUND
  if (c.returnedCount === 0) return false
  // first/last coherence (non-empty only; empty already rejected)
  if (typeof c.firstMessageId !== 'string' || c.firstMessageId.length === 0) return false
  if (typeof c.lastMessageId !== 'string' || c.lastMessageId.length === 0) return false
  const firstId = (messages[0] as Record<string, unknown>)?.id
  const lastId = (messages[(messages as unknown[]).length - 1] as Record<string, unknown>)?.id
  if (c.firstMessageId !== firstId) return false
  if (c.lastMessageId !== lastId) return false
  // LOCK-001: authoritative counts and boundary — integer >=1, selected<=total, boundary null iff selected===total else non-empty and exactly firstMessageId
  const totalTurnCount = c.totalTurnCount
  const selectedTurnCount = c.selectedTurnCount
  const boundaryMessageId = c.boundaryMessageId
  if (typeof totalTurnCount !== 'number' || !Number.isInteger(totalTurnCount) || totalTurnCount < 1) return false
  if (typeof selectedTurnCount !== 'number' || !Number.isInteger(selectedTurnCount) || selectedTurnCount < 1)
    return false
  if (selectedTurnCount > totalTurnCount) return false
  // unknown keys rejected where current validators enforce keys — fail closed if extra keys beyond expected set present
  // Existing validator already checks for allowed closure keys in shared contracts; renderer mirrors that strictly for new fields
  const allowedClosureKeys = new Set([
    'completeness',
    'topicId',
    'anchorGroupKey',
    'firstMessageId',
    'lastMessageId',
    'returnedCount',
    'totalTurnCount',
    'selectedTurnCount',
    'boundaryMessageId'
  ])
  for (const key of Object.keys(c)) {
    if (!allowedClosureKeys.has(key)) return false
  }
  if (selectedTurnCount === totalTurnCount) {
    if (boundaryMessageId !== null) return false
  } else {
    if (typeof boundaryMessageId !== 'string' || boundaryMessageId.length === 0) return false
    if (boundaryMessageId !== c.firstMessageId) return false
  }
  // missing anchor row: messages must contain a row that resolves to anchorGroupKey
  // Resolution priority: user id, assistant askId, recognized non-user id (assistant/system only)
  // LOCK-R06-005: nullable/unknown/tool roles never resolve as own-id anchors
  const anchor = request.anchorGroupKey
  let found = false
  for (const m of messages as unknown as Record<string, unknown>[]) {
    const role = m.role as string | undefined
    const id = m.id as string | undefined
    if (role === 'user' && id === anchor) {
      found = true
      break
    }
  }
  if (!found) {
    for (const m of messages as unknown as Record<string, unknown>[]) {
      const role = m.role as string | undefined
      const askId = m.askId as string | undefined
      if (role === 'assistant' && typeof askId === 'string' && askId.length > 0 && askId === anchor) {
        found = true
        break
      }
    }
  }
  if (!found) {
    for (const m of messages as unknown as Record<string, unknown>[]) {
      const role = m.role as string | undefined
      const id = m.id as string | undefined
      if ((role === 'assistant' || role === 'system') && id === anchor) {
        found = true
        break
      }
    }
  }
  if (!found) return false

  // block/message references together: every block.messageId must be in messages set
  const messageIds = new Set((messages as unknown as Record<string, unknown>[]).map((m) => m.id as string))
  for (const b of blocks as unknown as Record<string, unknown>[]) {
    const mid = b.messageId
    if (typeof mid !== 'string' || !messageIds.has(mid)) return false
  }

  // completeness distinctness handled above; no hasMore, no 1..100 bound check
  return true
}

/**
 * Cache hit is valid only when topicId and anchorGroupKey match the current renderer anchor
 * and the cached response is context-closure with coherent IDs/count.
 * Same-anchor + same-generation validated: generation is publication-aware via explicit
 * invalidation; stale/in-flight is caller responsibility.
 * LOCK-R06-004: empty closures are never valid hits (regardless of null bounds).
 * Optional fingerprint check (LOCK-R06-006): when both cached and current fingerprints
 * are supplied, a same-length authoritative mutation (different fingerprint) fails the hit.
 */
export function isValidContextClosureCacheHit(
  cached: FetchContextClosureResponse | null | undefined,
  currentTopicId: string,
  currentAnchorGroupKey: string | null,
  currentFingerprint?: string | null,
  cachedFingerprint?: string | null
): boolean {
  if (!cached || !cached.closure) return false
  if (!currentAnchorGroupKey) return false
  // LOCK-001: exact root keys — only messages, blocks, closure
  const allowedRootKeys = new Set(['messages', 'blocks', 'closure'])
  for (const key of Object.keys(cached as unknown as Record<string, unknown>)) {
    if (!allowedRootKeys.has(key)) return false
  }
  if (!Array.isArray((cached as unknown as Record<string, unknown>).messages)) return false
  if (!Array.isArray((cached as unknown as Record<string, unknown>).blocks)) return false
  if (cached.closure.completeness !== 'context-closure') return false
  if (cached.closure.topicId !== currentTopicId) return false
  if (cached.closure.anchorGroupKey !== currentAnchorGroupKey) return false
  if (typeof cached.closure.returnedCount !== 'number' || cached.closure.returnedCount < 0) return false
  if (cached.closure.returnedCount !== cached.messages.length) return false
  // LOCK-R06-004: reject every empty anchor-based closure
  if (cached.closure.returnedCount === 0) return false
  if (cached.closure.firstMessageId === null || cached.closure.lastMessageId === null) return false
  // LOCK-001: authoritative counts and boundary — integer >=1, selected<=total, boundary null iff selected===total else firstMessageId
  const totalTurnCount = (cached.closure as unknown as Record<string, unknown>).totalTurnCount as number
  const selectedTurnCount = (cached.closure as unknown as Record<string, unknown>).selectedTurnCount as number
  const boundaryMessageId = (cached.closure as unknown as Record<string, unknown>).boundaryMessageId
  if (typeof totalTurnCount !== 'number' || !Number.isInteger(totalTurnCount) || totalTurnCount < 1) return false
  if (typeof selectedTurnCount !== 'number' || !Number.isInteger(selectedTurnCount) || selectedTurnCount < 1)
    return false
  if (selectedTurnCount > totalTurnCount) return false
  const allowedCacheKeys = new Set([
    'completeness',
    'topicId',
    'anchorGroupKey',
    'firstMessageId',
    'lastMessageId',
    'returnedCount',
    'totalTurnCount',
    'selectedTurnCount',
    'boundaryMessageId'
  ])
  for (const key of Object.keys(cached.closure as unknown as Record<string, unknown>)) {
    if (!allowedCacheKeys.has(key)) return false
  }
  if (selectedTurnCount === totalTurnCount) {
    if (boundaryMessageId !== null) return false
  } else {
    if (typeof boundaryMessageId !== 'string' || boundaryMessageId.length === 0) return false
    if (boundaryMessageId !== cached.closure.firstMessageId) return false
  }
  // LOCK-R06-006: fingerprint freshness — same-length mutation invalidates
  if (
    typeof currentFingerprint === 'string' &&
    typeof cachedFingerprint === 'string' &&
    currentFingerprint.length > 0 &&
    cachedFingerprint.length > 0 &&
    currentFingerprint !== cachedFingerprint
  ) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Per-topic closure cache (dedicated, not viewport)
// ---------------------------------------------------------------------------

const closureCache = new Map<string, FetchContextClosureResponse>()
const loadGenerations = new Map<string, number>()
let globalLoadSeq = 0
// LOCK-R06-006: deterministic authoritative message fingerprint per topic+anchor
const closureFingerprints = new Map<string, string>()
// Generation snapshot stored at cache publication time (full-closure freshness, covers outside-viewport same-length mutations)
const cachedGenerations = new Map<string, number>()
// Global epoch for block mutations: advances even when no cache entry exists (covers uncached in-flight fetches)
// B-09 local diagnostics: bounded scalar hit/miss counters (renderer-local, no content retention)
let closureCacheHitCount = 0
let closureCacheMissCount = 0

let globalBlockGeneration = 0

/**
 * Deterministic fingerprint of authoritative message entities for closure freshness.
 * Changes when ordering/IDs/roles/askId/status/blocks association change at the same
 * topic and anchor. Local, cheap, no persistence/IPC generation protocol.
 * Excludes volatile block content — message-level only. Block-content-only changes
 * without message identity changes are a residual risk (see verification note).
 */
export function computeClosureFingerprint(
  messages: ReadonlyArray<{
    id: string
    role?: string | null
    askId?: string | null
    status?: string | null
    updatedAt?: string | null
    blocks?: readonly string[] | null
  }>
): string {
  if (messages.length === 0) return 'empty'
  // Deterministic ordered serialization; \x1f/\x1e are unlikely in ids
  let out = ''
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown>
    const id = (m.id as string) ?? ''
    const role = (m.role as string | null) ?? ''
    const askId = (m.askId as string | null) ?? ''
    const status = (m.status as string | null) ?? ''
    const updatedAt = (m.updatedAt as string | null) ?? ''
    const blocks = Array.isArray(m.blocks) ? (m.blocks as string[]).join(',') : ''
    out += id + '\x1f' + role + '\x1f' + askId + '\x1f' + status + '\x1f' + updatedAt + '\x1f' + blocks
    if (i !== messages.length - 1) out += '\x1e'
  }
  return out
}

/**
 * Route-scoped closure cache key: main route is exactly `topicId`
 * (persisted compatibility); branch routes use `topicId:branchId` so
 * per-route context closures never collide under one logical topic.
 * Mirrors `anchorKeyForRoute` without importing anchorService (cycle-free).
 */
export function closureKeyForRoute(topicId: string, branchId?: string | null): string {
  return typeof branchId === 'string' && branchId.length > 0 ? `${topicId}:${branchId}` : topicId
}

export function getCachedContextClosure(topicId: string, branchId?: string | null): FetchContextClosureResponse | null {
  return closureCache.get(closureKeyForRoute(topicId, branchId)) ?? null
}

export function getCachedClosureFingerprint(topicId: string, branchId?: string | null): string | null {
  return closureFingerprints.get(closureKeyForRoute(topicId, branchId)) ?? null
}

export function getCachedClosureGeneration(topicId: string, branchId?: string | null): number | undefined {
  return cachedGenerations.get(closureKeyForRoute(topicId, branchId))
}

export function getCurrentClosureGeneration(topicId: string, branchId?: string | null): number {
  return loadGenerations.get(closureKeyForRoute(topicId, branchId)) ?? 0
}

export function getAllCachedTopicIds(): string[] {
  return Array.from(closureCache.keys())
}

export function setCachedContextClosure(
  topicId: string,
  response: FetchContextClosureResponse,
  branchId?: string | null
): void {
  const key = closureKeyForRoute(topicId, branchId)
  closureCache.set(key, response)
  cachedGenerations.set(key, loadGenerations.get(key) ?? 0)
}

export function setCachedContextClosureWithFingerprint(
  topicId: string,
  response: FetchContextClosureResponse,
  fingerprint: string,
  branchId?: string | null
): void {
  const key = closureKeyForRoute(topicId, branchId)
  closureCache.set(key, response)
  closureFingerprints.set(key, fingerprint)
  cachedGenerations.set(key, loadGenerations.get(key) ?? 0)
}

export function clearCachedContextClosure(topicId: string, branchId?: string | null): void {
  // Bare-topic clear (branchId omitted) removes every route of that topic so
  // topic deletion never leaves a branch closure behind. Route-scoped clear
  // removes only that route.
  if (branchId === undefined) {
    const prefix = `${topicId}:`
    for (const key of Array.from(closureCache.keys())) {
      if (key === topicId || key.startsWith(prefix)) closureCache.delete(key)
    }
    for (const key of Array.from(closureFingerprints.keys())) {
      if (key === topicId || key.startsWith(prefix)) closureFingerprints.delete(key)
    }
    for (const key of Array.from(cachedGenerations.keys())) {
      if (key === topicId || key.startsWith(prefix)) cachedGenerations.delete(key)
    }
    return
  }
  const key = closureKeyForRoute(topicId, branchId)
  closureCache.delete(key)
  closureFingerprints.delete(key)
  cachedGenerations.delete(key)
  // loadGenerations preserved — mutation generation remains to invalidate in-flight
}

export function clearAllContextClosureCache(): void {
  closureCache.clear()
  closureFingerprints.clear()
  cachedGenerations.clear()
  // loadGenerations and globalBlockGeneration preserved for generation continuity; use resetAllClosureStateForTests to fully reset
}

/**
 * B-09: Enforce active-route-only retention for context-closure cache.
 *
 * On activation of a route, atomically removes cached closures,
 * fingerprints and cached generations for all other routes/topics while
 * preserving load generations and the global block generation.
 * Does not invalidate/bump the active cache merely due to trimming;
 * in-flight stale publication protection (generation/global checks) remains intact.
 * Bare-topic call (branchId omitted) retains every route of that topic for
 * backward compatibility with callers that are not yet route-aware.
 */
export function enforceContextClosureRetention(activeTopicId: string, branchId?: string | null): void {
  if (!activeTopicId || typeof activeTopicId !== 'string') return
  const retainAllRoutesOfTopic = branchId === undefined
  const activeKey = closureKeyForRoute(activeTopicId, branchId)
  // Collect union of keys to ensure no orphan fingerprint/generation retained without closure
  const toInspect = new Set<string>([
    ...closureCache.keys(),
    ...closureFingerprints.keys(),
    ...cachedGenerations.keys()
  ])
  for (const id of toInspect) {
    if (retainAllRoutesOfTopic) {
      if (id === activeTopicId || id.startsWith(`${activeTopicId}:`)) continue
      // Legacy keys without route separator that are not this topic are pruned.
      // Route keys of other topics never share the prefix (topicIds are UUIDs).
      if (id !== activeTopicId && !id.startsWith(`${activeTopicId}:`)) {
        closureCache.delete(id)
        closureFingerprints.delete(id)
        cachedGenerations.delete(id)
      }
      continue
    }
    if (id !== activeKey) {
      closureCache.delete(id)
      closureFingerprints.delete(id)
      cachedGenerations.delete(id)
    }
  }
}

export function resetAllClosureStateForTests(): void {
  closureCache.clear()
  closureFingerprints.clear()
  cachedGenerations.clear()
  loadGenerations.clear()
  globalLoadSeq = 0
  globalBlockGeneration = 0
  closureCacheHitCount = 0
  closureCacheMissCount = 0
}

/**
 * B-09 local diagnostics: resettable hit/miss counters without clearing cache.
 * Test-safe, local-only, no persistence or IPC.
 */
export function resetContextClosureDiagnosticsForTests(): void {
  closureCacheHitCount = 0
  closureCacheMissCount = 0
}

/**
 * Bump generation and invalidate cached entries for a topic.
 * Covers full closure freshness including same-length mutations outside viewport.
 * Conservative: clears cache so next read must refetch; in-flight publishes
 * detect generation mismatch and discard.
 * Bare-topic call invalidates every route of that topic (branch-safe).
 */
export function bumpAndInvalidate(topicId: string, branchId?: string | null): void {
  if (branchId === undefined) {
    const prefix = `${topicId}:`
    const keys = new Set<string>([...closureCache.keys(), ...loadGenerations.keys()])
    let touched = false
    for (const key of keys) {
      if (key === topicId || key.startsWith(prefix)) {
        bumpClosureGenerationForKey(key)
        closureCache.delete(key)
        closureFingerprints.delete(key)
        cachedGenerations.delete(key)
        touched = true
      }
    }
    if (!touched) {
      bumpClosureGenerationForKey(topicId)
    }
    return
  }
  const key = closureKeyForRoute(topicId, branchId)
  bumpClosureGenerationForKey(key)
  closureCache.delete(key)
  closureFingerprints.delete(key)
  cachedGenerations.delete(key)
}

export function bumpAndInvalidateAll(): void {
  globalBlockGeneration += 1
  const ids = Array.from(closureCache.keys())
  for (const id of ids) {
    // Cache keys are already route keys; invalidate each route directly.
    const parts = id.split(':')
    void parts
    bumpClosureGenerationForKey(id)
    closureCache.delete(id)
    closureFingerprints.delete(id)
    cachedGenerations.delete(id)
  }
}

export function getGlobalBlockGeneration(): number {
  return globalBlockGeneration
}

export function bumpGlobalBlockGeneration(): number {
  globalBlockGeneration += 1
  return globalBlockGeneration
}

export function getClosureLoadGeneration(topicId: string, branchId?: string | null): number {
  return loadGenerations.get(closureKeyForRoute(topicId, branchId)) ?? 0
}

function bumpClosureGenerationForKey(key: string): number {
  const next = (loadGenerations.get(key) ?? 0) + 1
  loadGenerations.set(key, next)
  return next
}

export function bumpClosureGeneration(topicId: string, branchId?: string | null): number {
  return bumpClosureGenerationForKey(closureKeyForRoute(topicId, branchId))
}

export function nextGlobalLoadSeq(): number {
  globalLoadSeq += 1
  return globalLoadSeq
}

/**
 * Centralized freshness-gated cache read (LOCK-R06-006).
 *
 * Combines structural validation, same topic/anchor validation, and
 * full-closure freshness (generation + optional fingerprint) in one helper.
 * Fail-closed: returns null when structural invalid, anchor/topic mismatch,
 * empty, or freshness cannot be proven (generation mismatch or fingerprint mismatch).
 * Callers must fallback to viewport when null.
 *
 * B-09 local diagnostics: increments hit/miss counters (bounded scalars, no content).
 *
 * @param topicId current topic
 * @param anchorGroupKey current renderer anchor (null => null)
 * @param currentFingerprint optional current viewport fingerprint for same-length visible mutation detection; generation alone covers outside-viewport
 */
export function getFreshValidatedClosure(
  topicId: string,
  anchorGroupKey: string | null,
  currentFingerprint?: string | null,
  branchId?: string | null
): FetchContextClosureResponse | null {
  if (!anchorGroupKey) {
    closureCacheMissCount += 1
    return null
  }
  const key = closureKeyForRoute(topicId, branchId)
  const cached = closureCache.get(key) ?? null
  if (!cached) {
    closureCacheMissCount += 1
    return null
  }
  if (!isValidContextClosureResponse({ topicId, anchorGroupKey, branchId: branchId ?? null }, cached)) {
    closureCacheMissCount += 1
    return null
  }
  // Full-closure freshness: generation must match snapshot at cache time
  const curGen = loadGenerations.get(key) ?? 0
  const storedGen = cachedGenerations.get(key)
  if (storedGen !== undefined) {
    if (storedGen !== curGen) {
      closureCacheMissCount += 1
      return null
    }
  } else if (curGen !== 0) {
    // No snapshot but generation advanced => cannot prove freshness
    closureCacheMissCount += 1
    return null
  }
  // Viewport fingerprint freshness (same-length visible mutations)
  const storedFp = closureFingerprints.get(key) ?? null
  if (
    !isValidContextClosureCacheHit(
      cached,
      topicId,
      anchorGroupKey,
      currentFingerprint ?? undefined,
      storedFp ?? undefined
    )
  ) {
    closureCacheMissCount += 1
    return null
  }
  closureCacheHitCount += 1
  return cached
}

/**
 * B-09 local diagnostics snapshot: bounded scalar counters and retained count.
 * Local-only, no message content, paths, credentials, or sizes.
 */
export interface ContextClosureDiagnostics {
  /** Bounded scalar: cache hits since last reset */
  hitCount: number
  /** Bounded scalar: cache misses since last reset */
  missCount: number
  /** Total accesses (hit + miss) */
  totalAccessCount: number
  /** Current retained topic count (active-topic-only retention) */
  retainedTopicCount: number
  /** Calibration max retained topics (B-09 active-topic-only) */
  maxRetainedTopics: number
}

export const CONTEXT_CLOSURE_MAX_RETAINED_TOPICS = 1

export function getContextClosureDiagnostics(): ContextClosureDiagnostics {
  return {
    hitCount: closureCacheHitCount,
    missCount: closureCacheMissCount,
    totalAccessCount: closureCacheHitCount + closureCacheMissCount,
    retainedTopicCount: closureCache.size,
    maxRetainedTopics: CONTEXT_CLOSURE_MAX_RETAINED_TOPICS
  }
}

/**
 * Validate an arbitrary closure response for freshness against stored generation/fingerprint.
 * Useful for validating hook-provided closure objects that may not be the current cached entry.
 */
export function isValidFreshClosure(
  response: FetchContextClosureResponse | null | undefined,
  topicId: string,
  anchorGroupKey: string | null,
  currentFingerprint?: string | null,
  branchId?: string | null
): boolean {
  if (!response) return false
  if (!anchorGroupKey) return false
  if (!isValidContextClosureResponse({ topicId, anchorGroupKey, branchId: branchId ?? null }, response as any))
    return false
  const key = closureKeyForRoute(topicId, branchId)
  const curGen = loadGenerations.get(key) ?? 0
  const storedGen = cachedGenerations.get(key)
  if (storedGen !== undefined) {
    if (storedGen !== curGen) return false
  } else if (curGen !== 0) {
    return false
  }
  const storedFp = closureFingerprints.get(key) ?? null
  if (
    !isValidContextClosureCacheHit(
      response as any,
      topicId,
      anchorGroupKey,
      currentFingerprint ?? undefined,
      storedFp ?? undefined
    )
  ) {
    return false
  }
  return true
}
