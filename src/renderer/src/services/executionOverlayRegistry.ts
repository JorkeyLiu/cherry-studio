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
 * - A terminal Main-transaction ack records a local terminal token: the
 *   per-execution sequence at ack time. The ack never reads the closure
 *   cache. A later accepted closure retires the overlay only when the read
 *   that produced it captured an explicit witness already containing that
 *   exact execution identity + terminal sequence AND the closure carries the
 *   terminal member. Older in-flight reads, reads issued before the ack, and
 *   witness-less reads can never retire it; terminal-persist failure never
 *   records a token.
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
  terminal: { status: string; terminalSeq: number } | null
  disposed: boolean
  snapshot: () => { blocks: MessageBlock[] }
}

const MAX_RETAINED_TERMINALS_PER_ROUTE = 2

let nextExecutionId = 1
let nextOrder = 1
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
}

export function routeKeyForExecutionOverlay(topicId: string, route: string | null): string {
  return typeof route === 'string' && route.length > 0 ? `${topicId}:${route}` : topicId
}

/** Route-scoped execution identity for a terminal persist checkpoint. */
export interface TerminalWitnessEntry {
  executionId: number
  terminalSeq: number
  messageId: string
  resendAttemptId?: string
}

/**
 * Local terminal-read witness: the set of execution identities whose terminal
 * Main-transaction ack had observably completed before one closure read
 * started. Renderer-local ordering evidence only — never a Main commit
 * revision, never a cross-window guarantee. Exact per-execution identity +
 * per-execution terminal sequence; no wallclock, no namespace-global Main
 * version. Running executions and terminals acked after the capture are
 * excluded; a read with no/unknown witness must fail closed (retain).
 */
export interface TerminalReadWitness {
  routeKey: string
  terminals: readonly TerminalWitnessEntry[]
}

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
      // Local terminal token only: the per-execution sequence at ack time.
      // Never reads the closure cache — ordering evidence comes from the
      // read-side witness captured before each closure read.
      entry.terminal = { status, terminalSeq: entry.seq }
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
      // carrying an explicit witness for this exact execution may still
      // retire it. Unsubscribe drops it.
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
/**
  * Capture a terminal-read witness for one route: the exact execution
  * identities (plus immutable terminal token per execution sequence) whose
  * terminal ack had observably completed before this call. Must be called
  * synchronously at read-issue time, with no await before the read dispatch,
  * so terminals acked while the read is in flight are excluded. Bounded: one
  * small entry per existing terminal on this route, no body copy.
  */
export function captureTerminalReadWitness(routeKey: string): TerminalReadWitness {
  const terminals: TerminalWitnessEntry[] = []
  for (const entry of entries.values()) {
    if (entry.routeKey !== routeKey || !entry.terminal) continue
    terminals.push({
      executionId: entry.id,
      terminalSeq: entry.terminal.terminalSeq,
      messageId: entry.messageId,
      resendAttemptId: entry.resendAttemptId
    })
  }
  return { routeKey, terminals }
}

/**
 * Terminal handoff: retire retained overlays once a newly accepted closure
 * proves (via the read-side witness) it was read after the terminal ack.
 * A closure retires an entry only when ALL hold on the fixed route: the
 * witness is for this exact route, it contains this exact execution identity
 * with the matching terminal token, and the closure carries the terminal
 * message id. Reads issued before the ack, terminals acked mid-read, failed /
 * invalid reads (never bound), witness-less reads, and reads for another
 * route always retain. Returns true when at least one entry retired.
 * Renderer-local ordering only — never a Main commit revision, never a
 * cross-window guarantee. Pure check: notification still flows only through
 * the existing route subscription (call from an effect, never during render).
 */
export function tryHandoffAfterClosure(
  topicId: string,
  route: string | null,
  closure: { messages: ReadonlyArray<{ id?: unknown }> },
  witness?: TerminalReadWitness | null
): boolean {
  const routeKey = routeKeyForExecutionOverlay(topicId, route)
  if (!witness || witness.routeKey !== routeKey) return false
  const byExecution = new Map<number, TerminalWitnessEntry>()
  for (const t of witness.terminals) {
    if (!byExecution.has(t.executionId)) {
      byExecution.set(t.executionId, t)
    }
  }
  let retired = false
  const memberIds = new Set((closure.messages ?? []).map((m) => m?.id))
  for (const entry of Array.from(entries.values())) {
    if (entry.routeKey !== routeKey || !entry.terminal) continue
    if (!memberIds.has(entry.messageId)) continue
    const w = byExecution.get(entry.id)
    if (!w) continue
    if (w.terminalSeq !== entry.terminal.terminalSeq) continue
    if (w.messageId !== entry.messageId || w.resendAttemptId !== entry.resendAttemptId) continue
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
