import { loggerService } from '@logger'
import type { MessageBlock } from '@renderer/types/newMessage'

const logger = loggerService.withContext('ExecutionOverlay')

/**
 * Execution-owned UI overlay for context presentation (route B).
 *
 * One entry per live execution, registered by the execution lifecycle in
 * `fetchAndProcessAssistantResponseImpl` — never by a mounted page. Each entry
 * is pinned to a fixed route + assistant message + resend attempt, carries a
 * unique local execution id and a per-execution monotonic sequence, and holds
 * only immutable snapshots captured from its own `AssistantExecutionState`
 * (copy-on-write there; deep-copied here on capture).
 *
 * Rules (no Main authority stamps, no new timers):
 * - Notification piggybacks the existing streaming cadence (throttle/RAF
 *   mirror + immediate terminal-adjacent writes). There is no per-token
 *   recompute of the whole closure and no new timer/RAF ownership here.
 * - Overlay composition only covers accepted closure members; structural
 *   changes still require a new authoritative Main closure. Initial
 *   unpublished bodies never affect other routes (route-key isolation).
 * - A terminal Main-transaction ack records a local terminal checkpoint
 *   (monotonic ticket + structural generation at ack). A later accepted
 *   closure retires the overlay only when the closure was published after
 *   that checkpoint (cached generation newer) AND carries the terminal
 *   member. Older in-flight reads can never retire it; terminal-persist
 *   failure never records a checkpoint.
 * - Bounded memory: live entries die with their execution; terminal bodies
 *   are retained only while their route has subscribers and at most
 *   `MAX_RETAINED_TERMINALS_PER_ROUTE` per route. Routes with zero
 *   subscribers keep no terminal bodies — the next read restores directly
 *   from the Main authoritative closure.
 * - Concurrent executions never share state and never race on wallclock:
 *   supersession is registration order (last registered wins) with active
 *   executions preferred over retained terminals.
 */

export interface RegisterExecutionOverlayParams {
  topicId: string
  route: string | null
  messageId: string
  resendAttemptId?: string
  /** Immutable snapshot supplier (deep copy at capture time). */
  snapshot: () => { blocks: MessageBlock[] }
}

export interface ExecutionOverlayHandle {
  id: number
  /** Advance the per-execution sequence; captures a snapshot only when the route has subscribers. */
  notifyDelta: () => number
  /** Record a successful terminal Main-transaction persist (success/error terminal alike). */
  recordTerminalPersisted: (status: string) => void
  /** End the execution: drop snapshots, retire terminal retention, stop notifications. */
  dispose: () => void
}

interface Entry {
  id: number
  order: number
  routeKey: string
  topicId: string
  route: string | null
  messageId: string
  resendAttemptId?: string
  seq: number
  snapshotBlocks: Map<string, MessageBlock> | null
  terminal: { status: string; genAtAck: number; ticket: number } | null
  disposed: boolean
  snapshot: () => { blocks: MessageBlock[] }
}

const MAX_RETAINED_TERMINALS_PER_ROUTE = 2

let nextExecutionId = 1
let nextOrder = 1
let nextTerminalTicket = 1
const entries = new Map<number, Entry>()
const routeVersions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
const composedCache = new Map<string, { version: number; memberKey: string; result: Map<string, MessageBlock> }>()

/** Test/diagnostic reset: drops every entry, version, listener, and composed cache. */
export function resetExecutionOverlayForTests(): void {
  entries.clear()
  routeVersions.clear()
  listeners.clear()
  composedCache.clear()
  nextExecutionId = 1
  nextOrder = 1
  nextTerminalTicket = 1
}

export function routeKeyForExecutionOverlay(topicId: string, route: string | null): string {
  return typeof route === 'string' && route.length > 0 ? `${topicId}:${route}` : topicId
}

/** Reader resolved lazily to avoid a module cycle (contextClosure never imports this module). */
let cachedGenerationReader: null | ((topicId: string, branchId?: string | null) => number | undefined) = null
let loadGenerationReader: null | ((topicId: string, branchId?: string | null) => number) = null
async function ensureGenerationReaders(): Promise<void> {
  if (cachedGenerationReader && loadGenerationReader) return
  try {
    const mod = await import('@renderer/services/contextClosure')
    // Assign only when still unset: an explicit seam (tests) installed while
    // the import was in flight must not be overwritten by the late default.
    if (!cachedGenerationReader) cachedGenerationReader = mod.getCachedClosureGeneration
    if (!loadGenerationReader) loadGenerationReader = mod.getClosureLoadGeneration
  } catch (error) {
    logger.warn('ExecutionOverlay: generation readers unavailable; handoff stays retained.', error as Error)
  }
}
void ensureGenerationReaders()

function bumpRouteVersion(routeKey: string): void {
  routeVersions.set(routeKey, (routeVersions.get(routeKey) ?? 0) + 1)
}

function emitRoute(routeKey: string): void {
  bumpRouteVersion(routeKey)
  const set = listeners.get(routeKey)
  if (!set || set.size === 0) return
  for (const listener of Array.from(set)) {
    try {
      listener()
    } catch {
      // best-effort; never break the streaming path
    }
  }
}

function hasSubscribers(routeKey: string): boolean {
  return (listeners.get(routeKey)?.size ?? 0) > 0
}

function pruneTerminals(routeKey: string): void {
  const retained = Array.from(entries.values())
    .filter((e) => e.routeKey === routeKey && e.terminal)
    .sort((a, b) => a.order - b.order)
  while (retained.length > MAX_RETAINED_TERMINALS_PER_ROUTE) {
    const oldest = retained.shift()
    if (oldest) {
      entries.delete(oldest.id)
    }
  }
}

export function subscribeExecutionOverlay(routeKey: string, listener: () => void): () => void {
  let set = listeners.get(routeKey)
  if (!set) {
    set = new Set()
    listeners.set(routeKey, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(routeKey)
    if (current) {
      current.delete(listener)
      if (current.size === 0) {
        listeners.delete(routeKey)
        // No consumer left: release retained terminal bodies and disposed
        // entries for this route. The next read restores directly from the
        // Main authoritative closure.
        for (const entry of Array.from(entries.values())) {
          if (entry.routeKey === routeKey && (entry.terminal || entry.disposed)) {
            entries.delete(entry.id)
          }
        }
        composedCache.delete(routeKey)
      }
    }
  }
}

export function getExecutionOverlayVersion(routeKey: string): number {
  return routeVersions.get(routeKey) ?? 0
}

export function registerExecutionOverlay(params: RegisterExecutionOverlayParams): ExecutionOverlayHandle {
  const id = nextExecutionId++
  const routeKey = routeKeyForExecutionOverlay(params.topicId, params.route)
  const entry: Entry = {
    id,
    order: nextOrder++,
    routeKey,
    topicId: params.topicId,
    route: params.route,
    messageId: params.messageId,
    resendAttemptId: params.resendAttemptId,
    seq: 0,
    snapshotBlocks: null,
    terminal: null,
    disposed: false,
    snapshot: params.snapshot
  }
  entries.set(id, entry)

  const capture = (): void => {
    try {
      const snap = entry.snapshot()
      const map = new Map<string, MessageBlock>()
      for (const block of snap.blocks ?? []) {
        if (block && typeof (block as { id?: unknown }).id === 'string') {
          map.set((block as { id: string }).id, block)
        }
      }
      entry.snapshotBlocks = map
    } catch (error) {
      logger.warn(`ExecutionOverlay: snapshot capture failed for execution ${id}.`, error as Error)
    }
  }

  return {
    id,
    notifyDelta: () => {
      if (entry.disposed) return entry.seq
      entry.seq += 1
      // Snapshots are captured only while a consumer subscribes; the local
      // sequence still advances so a later subscriber recomposes from current state.
      if (hasSubscribers(routeKey)) {
        capture()
        emitRoute(routeKey)
      } else {
        bumpRouteVersion(routeKey)
      }
      return entry.seq
    },
    recordTerminalPersisted: (status: string) => {
      if (entry.disposed) return
      let genAtAck = -1
      try {
        genAtAck = loadGenerationReader ? loadGenerationReader(params.topicId, params.route) : -1
      } catch {
        genAtAck = -1
      }
      entry.terminal = { status, genAtAck, ticket: nextTerminalTicket++ }
      if (hasSubscribers(routeKey)) {
        capture()
      } else {
        // No consumer: keep the checkpoint minimal, never the terminal body.
        entry.snapshotBlocks = null
      }
      pruneTerminals(routeKey)
      emitRoute(routeKey)
    },
    dispose: () => {
      if (entry.disposed) return
      entry.disposed = true
      if (!entry.terminal || !hasSubscribers(routeKey)) {
        // No handoff window: either not a terminal, or nobody holds this
        // route — release the body immediately.
        entry.snapshotBlocks = null
        entries.delete(id)
      }
      // A subscribed terminal keeps its body: a later accepted closure read
      // may still prove (via Main ordering) that it already contains the
      // terminal member and retire it. Unsubscribe drops it.
      pruneTerminals(routeKey)
      emitRoute(routeKey)
    }
  }
}

/**
 * Overlay blocks for the given accepted member block ids on one route.
 * terminals; within a class the last registered execution wins. No wallclock.
 * Returns a stable reference while neither the route version nor the member
 * set changes, so consumers never re-derive or re-estimate spuriously.
 */
export function getComposedOverlayBlocks(
  routeKey: string,
  acceptedMemberBlockIds: readonly string[]
): Map<string, MessageBlock> {
  const version = getExecutionOverlayVersion(routeKey)
  const memberKey = acceptedMemberBlockIds.join('\u0000')
  const cached = composedCache.get(routeKey)
  if (cached && cached.version === version && cached.memberKey === memberKey) {
    return cached.result
  }
  const wanted = new Set(acceptedMemberBlockIds)
  const active = new Map<string, MessageBlock>()
  const terminal = new Map<string, MessageBlock>()
  for (const entry of Array.from(entries.values()).sort((a, b) => a.order - b.order)) {
    // A disposed-but-retained terminal still composes while subscribed: the
    // handoff window keeps the terminal body on screen (no flash/revert)
    // until a newer accepted closure retires it. Entries without a captured
    // body compose nothing.
    if (entry.routeKey !== routeKey || !entry.snapshotBlocks) continue
    const target = entry.terminal ? terminal : active
    for (const [blockId, block] of entry.snapshotBlocks) {
      if (wanted.has(blockId)) {
        target.set(blockId, block)
      }
    }
  }
  const result = new Map<string, MessageBlock>(terminal)
  for (const [blockId, block] of active) {
    result.set(blockId, block)
  }
  composedCache.set(routeKey, { version, memberKey, result })
  return result
}

/**
 * Terminal handoff: retire retained overlays once a newly accepted closure
 * proves (via Main ordering) it already contains the terminal member.
 * A closure retires an entry only when the closure carries the terminal
 * message id AND its cached publication generation is newer than the
 * generation captured at the terminal ack. Reads that started before the ack
 * (or failed revalidations that never produce a new accepted closure) can
 * never retire the overlay, and an entry whose checkpoint is unknown (readers
 * not ready at the ack, failed/invalid ack-time read) never retires via
 * handoff at all. Returns true when at least one entry retired.
 */
export function tryHandoffAfterClosure(
  topicId: string,
  route: string | null,
  closure: { messages: ReadonlyArray<{ id?: unknown }> }
): boolean {
  const routeKey = routeKeyForExecutionOverlay(topicId, route)
  let cachedGen: number | undefined
  try {
    cachedGen = cachedGenerationReader ? cachedGenerationReader(topicId, route) : undefined
  } catch {
    cachedGen = undefined
  }
  let retired = false
  const memberIds = new Set((closure.messages ?? []).map((m) => m?.id))
  for (const entry of Array.from(entries.values())) {
    if (entry.routeKey !== routeKey || !entry.terminal) continue
    if (!memberIds.has(entry.messageId)) continue
    // Unknown checkpoint (generation readers not ready at the ack, or the
    // ack-time read failed/returned an invalid generation): there is no
    // Main-ordering evidence, so always retain — never hand off early.
    // Cleanup still follows the existing unsubscribe/route-leave, prune, and
    // bound rules. A reader becoming ready later does not backfill this
    // entry; only a later ack carrying a valid checkpoint can hand off.
    const ackGen = entry.terminal.genAtAck
    if (!(ackGen >= 0)) continue
    // A closure proves containment only when its cached publication
    // generation is newer than the ack generation. An unreadable or invalid
    // cached generation is no proof — retain.
    if (!(typeof cachedGen === 'number' && cachedGen >= 0 && cachedGen > ackGen)) continue
    entries.delete(entry.id)
    retired = true
  }
  if (retired) {
    composedCache.delete(routeKey)
    emitRoute(routeKey)
  }
  return retired
}

/** Bounded diagnostics: live entries, retained terminals, subscribed routes. No content. */
export function getExecutionOverlayDiagnostics(): {
  liveCount: number
  retainedTerminalCount: number
  subscribedRouteCount: number
  maxRetainedTerminalsPerRoute: number
} {
  let retained = 0
  for (const entry of entries.values()) {
    if (entry.terminal) retained += 1
  }
  return {
    liveCount: entries.size,
    retainedTerminalCount: retained,
    subscribedRouteCount: listeners.size,
    maxRetainedTerminalsPerRoute: MAX_RETAINED_TERMINALS_PER_ROUTE
  }
}

/** Test seam: replace the generation readers without importing contextClosure. */
export function setExecutionOverlayGenerationReadersForTests(readers: {
  getCachedGeneration?: (topicId: string, branchId?: string | null) => number | undefined
  getLoadGeneration?: (topicId: string, branchId?: string | null) => number
}): void {
  cachedGenerationReader = readers.getCachedGeneration ?? null
  loadGenerationReader = readers.getLoadGeneration ?? null
}
