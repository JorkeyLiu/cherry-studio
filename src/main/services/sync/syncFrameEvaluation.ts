/**
 * Local frame evaluation helper for sync baseline candidate/apply.
 * Implements SYNC-DATA-035 filtering + incomplete + deterministic suffix append
 * without altering public wire protocol (baselineWire). Shared between capture
 * and apply so logic does not diverge.
 *
 * Representation boundary (normalized baseline snapshot):
 * - Persisted source table (`sync_parent_order_frame`) keeps the raw local winner
 *   (exact `orderedChildIds` + `frameClock` as first written). This is the
 *   authoritative per-parent single winning raw frame.
 * - Capture (`syncBaseline.ts`) derives the normalized baseline frame for the
 *   candidate: `effective = filtered winning list + deterministic suffix` where
 *   suffix = live children with `membershipClock > frameClock` sorted by
 *   `membershipClock` asc then `childId` UTF-8 lex. The candidate emits this
 *   effective full-set sequence under the original winning `frameClock`; the
 *   clock is never altered during normalization. Candidate `orderedChildIds`
 *   is therefore the ADR-required EFFECTIVE full sequence, not a retransmission
 *   of stale/dead raw IDs.
 * - Apply (`syncBaselineApply.ts`) after entity/tombstone/membership merge and
 *   with current target live state known, re-evaluates the existing local raw
 *   winner to its current semantic effective sequence, then merges incoming
 *   normalized baseline frame by `frameClock`:
 *     * higher clock wins and incoming normalized sequence is persisted as the
 *       new canonical snapshot for that clock;
 *     * lower clock loses, fixed-point uses existing winner;
 *     * equal clock: if incoming effective equals the existing frame's semantic
 *       effective under the merged state, accept idempotently (optionally
 *       normalize stored content while retaining clock); if semantically
 *       different, fail closed. Raw byte comparison alone is never used.
 *   Arrival-order independence follows from always re-evaluating the selected
 *   raw winner against merged current state deterministically.
 *
 * Only the materialized `sortOrder` is updated atomically inside the same
 * transaction; `frameClock` is never mutated during normalization.
 */

export const ORDER_FRAME_VERSION = 'parent-order-frame-v1' as const
export type OrderFrameKind = 'topicMessage' | 'messageBlock'

export interface Clock {
  timestamp: number
  operationId: string
}

export function compareUtf8ByteLex(a: string, b: string): number {
  const ba = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  const len = Math.min(ba.length, bb.length)
  for (let i = 0; i < len; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i]
  }
  return ba.length - bb.length
}

export function compareClock(a: Clock, b: Clock): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  return compareUtf8ByteLex(a.operationId, b.operationId)
}

export function compareDeletionClock(
  a: { timestamp: number; operationId: string | null },
  b: { timestamp: number; operationId: string | null }
): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  if (a.operationId === null && b.operationId === null) return 0
  if (a.operationId === null && b.operationId !== null) return 1 // (T,null) > (T,nonNull)
  if (a.operationId !== null && b.operationId === null) return -1
  return compareUtf8ByteLex(a.operationId as string, b.operationId as string)
}

export function isTombstoneWinningOverLive(
  tomb: { timestamp: number; operationId: string | null },
  live: Clock
): boolean {
  // Legacy null tombstone suppresses equal-T live operations conservatively.
  if (tomb.operationId === null) return live.timestamp <= tomb.timestamp
  if (live.timestamp !== tomb.timestamp) return live.timestamp < tomb.timestamp
  return compareUtf8ByteLex(live.operationId, tomb.operationId) <= 0
}

export function isTombstoneBeatsTombstone(
  a: { timestamp: number; operationId: string | null },
  b: { timestamp: number; operationId: string | null }
): boolean {
  return compareDeletionClock(a, b) > 0
}

export function isValidUnicodeScalarString(str: string): boolean {
  let i = 0
  const len = str.length
  while (i < len) {
    const cp = str.codePointAt(i)!
    if (cp >= 0xd800 && cp <= 0xdfff) return false
    if (cp > 0x10ffff) return false
    i += cp > 0xffff ? 2 : 1
  }
  return true
}

export function validateOperationIdStrict(op: unknown, context: string): string {
  if (
    typeof op !== 'string' ||
    op.length === 0 ||
    op.length > 256 ||
    op.includes(':') ||
    !isValidUnicodeScalarString(op)
  ) {
    throw new Error(`malformed operationId for ${context}`)
  }
  return op
}

export function validateTimestampStrict(ts: unknown, context: string): number {
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0 || ts > 9007199254740991) {
    throw new Error(`malformed timestamp for ${context}`)
  }
  return ts
}

export function validateIdStrict(id: unknown, context: string): string {
  if (typeof id !== 'string' || id.length === 0 || !isValidUnicodeScalarString(id)) {
    throw new Error(`malformed id for ${context}`)
  }
  return id
}

export function validateOrdinaryIdStrict(id: unknown, context: string): string {
  return validateIdStrict(id, context)
}

export function validateFrameVersionStrict(version: unknown, context: string): void {
  if (version !== ORDER_FRAME_VERSION) throw new Error(`malformed frameVersion for ${context}: ${String(version)}`)
}

export function validateFrameKindStrict(kind: unknown, context: string): OrderFrameKind {
  if (kind !== 'topicMessage' && kind !== 'messageBlock')
    throw new Error(`malformed frame kind for ${context}: ${String(kind)}`)
  return kind as OrderFrameKind
}

export function validateOrderedChildIdsStrict(ids: unknown, context: string): string[] {
  if (!Array.isArray(ids)) throw new Error(`malformed orderedChildIds for ${context}: not array`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of ids as unknown[]) {
    const id = validateIdStrict(v, `${context} childId`)
    if (seen.has(id)) throw new Error(`duplicate orderedChildId ${id} for ${context}`)
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Validate that orderedChildIdsJson is a strict JSON array of unique non-empty
 * strings with canonical form. Throws on malformed.
 * Ordinary IDs have no 256 upper bound (wire has none); only Unicode scalar valid.
 */
export function validateOrderedChildIdsJson(jsonStr: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error('ordered_child_ids_json is not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('ordered_child_ids_json must be JSON array')
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of parsed as unknown[]) {
    if (typeof v !== 'string' || v.length === 0 || !isValidUnicodeScalarString(v)) {
      throw new Error(`invalid orderedChildId ${String(v).slice(0, 40)}`)
    }
    if (seen.has(v)) throw new Error(`duplicate orderedChildId ${String(v).slice(0, 40)}`)
    seen.add(v)
    out.push(v)
  }
  const canonical = JSON.stringify(out)
  if (canonical !== jsonStr) throw new Error('ordered_child_ids_json not in canonical strict JSON array form')
  return out
}

export function validateFrameRowStrict(
  row: {
    kind: unknown
    parentId: unknown
    frameVersion: unknown
    orderedChildIdsJson: unknown
    timestamp: unknown
    operationId: unknown
  },
  context: string
): { kind: OrderFrameKind; parentId: string; orderedChildIds: string[]; timestamp: number; operationId: string } {
  const kind = validateFrameKindStrict(row.kind, context)
  const parentId = validateIdStrict(row.parentId, `${context} parentId`)
  validateFrameVersionStrict(row.frameVersion, `${context} frameVersion`)
  if (typeof row.orderedChildIdsJson !== 'string') throw new Error(`malformed orderedChildIdsJson for ${context}`)
  const orderedChildIds = validateOrderedChildIdsJson(row.orderedChildIdsJson)
  const timestamp = validateTimestampStrict(row.timestamp, `${context} timestamp`)
  const operationId = validateOperationIdStrict(row.operationId, `${context} operationId`)
  return { kind, parentId, orderedChildIds, timestamp, operationId }
}

/**
 * Evaluate effective order for a single parent.
 * - Filters duplicate later occurrence, dead/unknown/different-parent/excluded ids
 *   without resurrection.
 * - If any live child with membershipClock <= frameClock is absent from filtered
 *   list, marks incomplete (do not throw for capture's stale truth).
 * - Suffix appends live children with membershipClock > frameClock not in filtered,
 *   sorted by membershipClock ascending then childId UTF-8 byte lex.
 * Returns effective sequence and incomplete flag.
 * Throws fail-closed on parent mismatch where knowable or other malformed.
 */
export function evaluateEffectiveOrder(input: {
  kind: OrderFrameKind
  parentId: string
  orderedChildIds: string[]
  frameClock: Clock
  /** Live children for this parent: id -> membershipClock */
  liveChildren: Map<string, Clock>
  /** Lookup for any childId -> actual parentId + existence info for mismatch detection */
  childParentLookup: (
    childId: string
  ) => { parentId: string | null; exists: boolean; isLiveForThisParent?: boolean } | null
  /** Optional extra check for tombstone/excluded? Already via liveChildren */
}): { effective: string[]; filtered: string[]; suffix: string[]; incomplete: boolean; missingIds: string[] } {
  const { orderedChildIds, frameClock, liveChildren, childParentLookup } = input
  const seen = new Set<string>()
  const filtered: string[] = []
  for (const cid of orderedChildIds) {
    if (seen.has(cid)) {
      // duplicate later occurrence filtered
      continue
    }
    seen.add(cid)
    // Check live membership for this parent
    if (liveChildren.has(cid)) {
      // valid live child for this parent
      filtered.push(cid)
      continue
    }
    // Not live for this parent -> determine why
    const info = childParentLookup(cid)
    if (info && info.parentId !== null && info.parentId !== input.parentId && info.exists) {
      // Different parent, knowable -> fail-closed (reparent)
      throw new Error(
        `frame parent mismatch for child ${cid}: frame parent ${input.parentId} vs actual ${info.parentId}`
      )
    }
    // Dead, unknown, excluded, or different-parent unknown -> filter without resurrection
    continue
  }

  // Check incomplete: any live child with clock <= frameClock missing from filtered
  const missing: string[] = []
  for (const [cid, memClock] of liveChildren.entries()) {
    const cmp = compareClock(memClock, frameClock)
    if (cmp <= 0 && !filtered.includes(cid)) {
      missing.push(cid)
    }
  }
  const incomplete = missing.length > 0

  // Suffix: live children with clock > frameClock not in filtered, sorted deterministically
  const suffixCandidates: Array<{ id: string; clock: Clock }> = []
  for (const [cid, memClock] of liveChildren.entries()) {
    if (filtered.includes(cid)) continue
    const cmp = compareClock(memClock, frameClock)
    if (cmp > 0) {
      suffixCandidates.push({ id: cid, clock: memClock })
    }
  }
  suffixCandidates.sort((a, b) => {
    const c = compareClock(a.clock, b.clock)
    if (c !== 0) return c
    return compareUtf8ByteLex(a.id, b.id)
  })
  const suffix = suffixCandidates.map((c) => c.id)
  const effective = [...filtered, ...suffix]
  // Effective should exactly cover liveChildren if complete; if incomplete it will not.
  return { effective, filtered, suffix, incomplete, missingIds: missing }
}

/** Sort frames by kind rank then parentId UTF-8 */
export function sortFramesDeterministically<T extends { kind: OrderFrameKind; parentId: string }>(frames: T[]): T[] {
  const rank = (k: OrderFrameKind): number => (k === 'topicMessage' ? 0 : 1)
  return frames.slice().sort((a, b) => {
    const ra = rank(a.kind)
    const rb = rank(b.kind)
    if (ra !== rb) return ra - rb
    return compareUtf8ByteLex(a.parentId, b.parentId)
  })
}
