/**
 * Phase 4 C-01 — Logical Retained Payload Canonical Accounting (shared pure)
 *
 * Shared pure cross-runtime contract for `phase4-logical-payload-v1` canonical
 * frame accounting. This is **measurement-only accounting infrastructure** —
 * no runtime cache retention, eviction, TTL, LRU, admission, heap-capacity
 * policy, or working-set policy is implemented. Bundle remains
 * directional non-adoption for B-01/B-02/B-05 (LOCK-201/202/204).
 *
 * This module is **browser-and-Node compatible** — UTF-8 byte accounting
 * uses `TextEncoder` via {@link utf8ByteLength} (established shared utility),
 * not Node `Buffer`. Parity with prior `Buffer.byteLength(..., 'utf8')`
 * behavior is proved through focused tests (LOCK-203).
 *
 * Canonical rules (verbatim B-02):
 * - Frame: { accountingVersion:"phase4-logical-payload-v1", topicId, messages,
 *   blocks, segments, completeness:{chatData,segments,residentTopic},
 *   applicabilityGeneration }
 * - Canonical output: no whitespace, recursively lexicographic object keys,
 *   actual serialized key order is lexical regardless of explanatory display
 *   order.
 * - Arrays:
 *   messages sorted sortOrder asc then id (missing sortOrder -> absent -> sorts
 *   after present finite values then id);
 *   blocks sorted by parent message position in canonical messages, then
 *   sortOrder asc if present then id — current renderer MessageBlock shape has
 *   no numeric sortOrder/order field, therefore block sortOrder comparison is
 *   omitted and blocks sort by parent position then id (do not defer to Phase 6);
 *   segments sorted by sortOrder asc if present then id, otherwise by id —
 *   current renderer TopicSegment shape has no sortOrder field, therefore
 *   segments sort by id. Missing optional sortOrder treated as absent and sorts
 *   after present finite values then id.
 * - Each entity is its complete renderer projection object canonicalized:
 *   undefined object properties omitted, undefined array slots become null,
 *   null retained, finite numbers as ECMAScript JSON numbers, non-finite
 *   (NaN/Infinity) rejected as invalid, booleans/strings as JSON, no
 *   functions/symbols/bigints permitted.
 * - Reject orphan blocks whose messageId is absent from the frame messages
 *   (LOCK-C01-006). Reject non-finite numbers and unsupported JSON values.
 * - Byte count = UTF-8 bytes of canonical JSON string.
 * - Shared entities are fully duplicated per topic for accounting (per-topic
 *   byte counts are independent).
 *
 * No IPC, preload, Main handler, schema/migration, context-window, Phase 6, or
 * sync changes. Main SQLite authority and ARCH-001..ARCH-012 remain intact.
 * This file must remain free of Node-only APIs (no `Buffer`, `node:*`).
 */

import { utf8ByteLength } from './validation'

export const LOGICAL_PAYLOAD_ACCOUNTING_VERSION = 'phase4-logical-payload-v1' as const

/** 8 topics (B-01) — calibration candidate, not adopted limit or threshold */
export const B01_MAX_TOPICS = 8 as const
/** 32 MiB aggregate logical bytes (B-02) — calibration candidate */
export const B02_MAX_BYTES = 32 * 1024 * 1024 // 33554432
/** B-05 oversized calibration candidate exactly 32 MiB (B-02) */
export const B05_CALIBRATION_CANDIDATE_BYTES = B02_MAX_BYTES

export interface LogicalPayloadCompleteness {
  chatData: boolean
  segments: boolean
  residentTopic: boolean
}

export interface LogicalPayloadTopicInput {
  topicId: string
  messages: Record<string, unknown>[]
  blocks: Record<string, unknown>[]
  segments: Record<string, unknown>[]
  completeness: LogicalPayloadCompleteness
  applicabilityGeneration: number
}

export interface CanonicalPayloadResult {
  canonicalFrame: Record<string, unknown>
  canonicalJson: string
  byteLength: number
}

export interface PerTopicAccounting {
  topicId: string
  byteLength: number
  canonicalJson: string
  canonicalFrame: Record<string, unknown>
}

export interface AggregateAccounting {
  perTopic: PerTopicAccounting[]
  aggregateBytes: number
  topicCount: number
  isCountBound: boolean
  isByteBound: boolean
  binding: 'count-first' | 'byte-first' | 'both' | 'none'
  oversizedTopicIds: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasFiniteSortOrder(entity: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(entity, 'sortOrder') &&
    typeof entity.sortOrder === 'number' &&
    Number.isFinite(entity.sortOrder)
  )
}

function compareMessages(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aHas = hasFiniteSortOrder(a)
  const bHas = hasFiniteSortOrder(b)
  if (aHas && !bHas) return -1
  if (!aHas && bHas) return 1
  if (aHas && bHas) {
    const diff = (a.sortOrder as number) - (b.sortOrder as number)
    if (diff !== 0) return diff
  }
  const aId = String(a.id ?? '')
  const bId = String(b.id ?? '')
  if (aId < bId) return -1
  if (aId > bId) return 1
  return 0
}

function compareSegments(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aHas = hasFiniteSortOrder(a)
  const bHas = hasFiniteSortOrder(b)
  if (aHas && !bHas) return -1
  if (!aHas && bHas) return 1
  if (aHas && bHas) {
    const diff = (a.sortOrder as number) - (b.sortOrder as number)
    if (diff !== 0) return diff
  }
  const aId = String(a.id ?? '')
  const bId = String(b.id ?? '')
  if (aId < bId) return -1
  if (aId > bId) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Canonical JSON serializer — lexicographic escaped keys, ECMAScript JSON semantics
// ---------------------------------------------------------------------------

/**
 * Direct canonical JSON serializer that does not rely on JSON.stringify for
 * object key ordering. Handles:
 * - recursively lexicographic escaped object keys
 * - integer-like keys in lexicographic order (not numeric)
 * - own `__proto__` as enumerable data property when present
 * - ECMAScript JSON primitive/array semantics: undefined properties omitted,
 *   undefined array slots -> null, non-finite rejected, functions/symbols/bigints rejected
 * - compact output (no whitespace) and exact UTF-8 bytes via caller TextEncoder
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`non-finite number rejected: ${String(value)}`)
    }
    // JSON.stringify for numbers gives ECMAScript JSON number semantics (e.g., -0 -> "0")
    return JSON.stringify(value)
  }
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new Error(`unsupported JSON value: ${t}`)
  }
  if (t === 'undefined') {
    throw new Error(
      'unsupported JSON value: undefined at value position (object properties with undefined are omitted by caller, array slots become null)'
    )
  }
  if (Array.isArray(value)) {
    const arr = value as unknown[]
    const parts: string[] = new Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
      const has = i in arr
      const elem = arr[i]
      if (!has || elem === undefined) {
        parts[i] = 'null'
      } else {
        parts[i] = canonicalJsonStringify(elem)
      }
    }
    return '[' + parts.join(',') + ']'
  }
  if (t === 'object') {
    if (!isPlainObject(value)) {
      const tag = Object.prototype.toString.call(value)
      throw new Error(`unsupported JSON value: non-plain object ${tag}`)
    }
    const obj = value
    // Collect own enumerable string keys; filter undefined (omit) and validate unsupported
    // Use Object.keys which correctly captures own enumerable "__proto__" when it is a data property.
    // Then sort lexicographically (code unit) — not numeric for integer-like keys.
    const rawKeys = Object.keys(obj)
    const keys: string[] = []
    for (const k of rawKeys) {
      const v = obj[k]
      if (v === undefined) continue // omit
      const vt = typeof v
      if (vt === 'function' || vt === 'symbol' || vt === 'bigint') {
        throw new Error(`unsupported JSON value: ${vt} at .${k}`)
      }
      // `undefined` already handled; `null` and others are ok and will be validated recursively
      keys.push(k)
    }
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const parts: string[] = []
    for (const k of keys) {
      const v = obj[k]
      // For safety, ensure v is not undefined (filtered) but if it became undefined via getter side-effect, omit
      if (v === undefined) continue
      const keyStr = JSON.stringify(k) // escaped
      const valStr = canonicalJsonStringify(v)
      parts.push(keyStr + ':' + valStr)
    }
    return '{' + parts.join(',') + '}'
  }
  throw new Error(`unsupported JSON value: ${t}`)
}

// ---------------------------------------------------------------------------
// Frame validation and canonical payload construction
// ---------------------------------------------------------------------------

function assertTopicInput(input: LogicalPayloadTopicInput): void {
  if (typeof input.topicId !== 'string' || input.topicId.length === 0) {
    throw new Error('topicId must be a non-empty string')
  }
  if (!Array.isArray(input.messages)) throw new Error('messages must be an array')
  if (!Array.isArray(input.blocks)) throw new Error('blocks must be an array')
  if (!Array.isArray(input.segments)) throw new Error('segments must be an array')
  if (input.completeness === null || typeof input.completeness !== 'object' || Array.isArray(input.completeness)) {
    throw new Error('completeness must be an object')
  }
  const c = input.completeness
  if (typeof c.chatData !== 'boolean' || typeof c.segments !== 'boolean' || typeof c.residentTopic !== 'boolean') {
    throw new Error('completeness must contain boolean chatData, segments, residentTopic')
  }
  const allowedCompleteness = new Set(['chatData', 'segments', 'residentTopic'])
  for (const k of Object.keys(c)) {
    if (!allowedCompleteness.has(k)) {
      throw new Error(`unsupported completeness key: ${k}`)
    }
  }
  // Completeness composite must equal conjunction (LOCK-C01-006)
  if (c.residentTopic !== (c.chatData && c.segments)) {
    throw new Error(
      `completeness residentTopic must equal chatData && segments: got chatData=${String(c.chatData)} segments=${String(c.segments)} residentTopic=${String(c.residentTopic)}`
    )
  }
  if (
    typeof input.applicabilityGeneration !== 'number' ||
    !Number.isFinite(input.applicabilityGeneration) ||
    !Number.isInteger(input.applicabilityGeneration) ||
    input.applicabilityGeneration < 0
  ) {
    throw new Error('applicabilityGeneration must be a non-negative finite integer')
  }
  // Early validate that each entity is at least a plain object with id where applicable
  for (const m of input.messages) {
    if (!isPlainObject(m)) throw new Error('message must be a plain object')
    if (typeof m.id !== 'string' || String(m.id).length === 0) {
      throw new Error('message id must be a non-empty string')
    }
  }
  for (const b of input.blocks) {
    if (!isPlainObject(b)) throw new Error('block must be a plain object')
    if (typeof b.id !== 'string' || String(b.id).length === 0) {
      throw new Error('block id must be a non-empty string')
    }
    if (typeof b.messageId !== 'string' || String(b.messageId).length === 0) {
      throw new Error('block messageId must be a non-empty string')
    }
  }
  for (const s of input.segments) {
    if (!isPlainObject(s)) throw new Error('segment must be a plain object')
    if (typeof s.id !== 'string' || String(s.id).length === 0) {
      throw new Error('segment id must be a non-empty string')
    }
  }

  // Unique IDs by entity domain
  const dupCheck = (arr: Record<string, unknown>[], label: string) => {
    const seen = new Set<string>()
    for (const e of arr) {
      const id = String(e.id)
      if (seen.has(id)) throw new Error(`duplicate ${label} id rejected: ${id}`)
      seen.add(id)
    }
  }
  dupCheck(input.messages, 'message')
  dupCheck(input.blocks, 'block')
  dupCheck(input.segments, 'segment')

  // Cross-topic entities and references
  const messageIds = new Set<string>(input.messages.map((m) => String(m.id)))
  const blockIds = new Set<string>(input.blocks.map((b) => String(b.id)))
  const blockById = new Map<string, Record<string, unknown>>(input.blocks.map((b) => [String(b.id), b]))
  const messageById = new Map<string, Record<string, unknown>>(input.messages.map((m) => [String(m.id), m]))

  // Message topicId must match frame when present
  for (const m of input.messages) {
    const topicId = m.topicId
    if (topicId !== undefined) {
      if (typeof topicId !== 'string')
        throw new Error(`message topicId must be string when present: ${String(topicId)}`)
      if (topicId !== input.topicId) {
        throw new Error(
          `cross-topic message rejected: message topicId ${String(topicId)} does not match frame topicId ${input.topicId}`
        )
      }
    }
  }
  // Segment topicId must match frame when present
  for (const s of input.segments) {
    const topicId = s.topicId
    if (topicId !== undefined) {
      if (typeof topicId !== 'string')
        throw new Error(`segment topicId must be string when present: ${String(topicId)}`)
      if (topicId !== input.topicId) {
        throw new Error(
          `cross-topic segment rejected: segment topicId ${String(topicId)} does not match frame topicId ${input.topicId}`
        )
      }
    }
  }

  // Every block messageId references a message
  for (const b of input.blocks) {
    const mid = String(b.messageId)
    if (!messageIds.has(mid)) {
      throw new Error(`orphan block rejected: messageId ${mid} absent from frame messages`)
    }
  }

  // Every message blocks reference resolves and belongs to that message with no contradictory membership
  // Track block ownership via message.blocks arrays to detect contradictory membership
  const blockOwnership = new Map<string, string>() // blockId -> owning messageId via message.blocks
  for (const m of input.messages) {
    const mid = String(m.id)
    const rawBlocks = m.blocks
    if (rawBlocks === undefined) continue // compatible with explicit empty marker? Allow missing if messages empty? But projection-complete synthetic has it
    if (!Array.isArray(rawBlocks)) {
      throw new Error(`message blocks must be an array when present: message ${mid}`)
    }
    for (const bid of rawBlocks as unknown[]) {
      if (typeof bid !== 'string' || bid.length === 0) {
        throw new Error(`message blocks reference must be non-empty string: message ${mid} has ${String(bid)}`)
      }
      if (!blockIds.has(bid)) {
        throw new Error(`message blocks reference unresolved: block ${bid} in message ${mid} absent from frame blocks`)
      }
      const actualOwner = String((blockById.get(bid) as Record<string, unknown>).messageId)
      if (actualOwner !== mid) {
        throw new Error(
          `message blocks reference contradictory: block ${bid} belongs to message ${actualOwner} but referenced by message ${mid}`
        )
      }
      const prevOwner = blockOwnership.get(bid)
      if (prevOwner !== undefined && prevOwner !== mid) {
        throw new Error(
          `duplicate block membership rejected: block ${bid} referenced by multiple messages ${prevOwner} and ${mid}`
        )
      }
      blockOwnership.set(bid, mid)
    }
  }
  // Every block must be referenced by its owning message's blocks array (bidirectional membership)
  for (const b of input.blocks) {
    const bid = String(b.id)
    const mid = String(b.messageId)
    const owner = messageById.get(mid)
    if (owner === undefined) continue // already orphan-checked
    const ownerBlocks = owner.blocks
    if (ownerBlocks === undefined) {
      throw new Error(
        `block membership missing: block ${bid} with messageId ${mid} not referenced in its message blocks`
      )
    }
    if (Array.isArray(ownerBlocks)) {
      if (!(ownerBlocks as unknown[]).includes(bid)) {
        throw new Error(
          `block membership missing: block ${bid} with messageId ${mid} not referenced in its message blocks`
        )
      }
    }
  }

  // Every segment messageId resolves (when segment has messageIds array)
  for (const s of input.segments) {
    const sid = String(s.id)
    const rawIds = s.messageIds
    if (rawIds === undefined) continue
    if (!Array.isArray(rawIds)) {
      throw new Error(`segment messageIds must be an array when present: segment ${sid}`)
    }
    for (const mid of rawIds as unknown[]) {
      if (typeof mid !== 'string' || mid.length === 0) {
        throw new Error(`segment messageId must be non-empty string: segment ${sid} has ${String(mid)}`)
      }
      if (!messageIds.has(mid)) {
        throw new Error(`segment messageId unresolved: ${mid} in segment ${sid} absent from frame messages`)
      }
    }
  }
}

/**
 * Build canonical frame, compact JSON, and UTF-8 byte length for a single topic.
 * Throws on orphan blocks, non-finite numbers, unsupported values, duplicate IDs,
 * cross-topic entities, invalid references, and completeness mismatch.
 */
export function canonicalizeLogicalPayload(input: LogicalPayloadTopicInput): CanonicalPayloadResult {
  assertTopicInput(input)

  // Sort copies (do not mutate input)
  const sortedMessages = [...input.messages].sort(compareMessages)

  // Parent position map for block ordering (canonical messages order)
  const posMap = new Map<string, number>()
  sortedMessages.forEach((m, idx) => {
    const id = String(m.id)
    posMap.set(id, idx)
  })

  const sortedBlocks = [...input.blocks].sort((a, b) => {
    const aParent = String(a.messageId)
    const bParent = String(b.messageId)
    const aPos = posMap.get(aParent) ?? Number.MAX_SAFE_INTEGER
    const bPos = posMap.get(bParent) ?? Number.MAX_SAFE_INTEGER
    if (aPos !== bPos) return aPos - bPos
    // Block sortOrder intentionally omitted per spec (current renderer shape has no sortOrder)
    const aId = String(a.id)
    const bId = String(b.id)
    if (aId < bId) return -1
    if (aId > bId) return 1
    return 0
  })

  const sortedSegments = [...input.segments].sort(compareSegments)

  // Build exact frame (keys will be lexicographically sorted by serializer)
  const rawFrame: Record<string, unknown> = {
    accountingVersion: LOGICAL_PAYLOAD_ACCOUNTING_VERSION,
    applicabilityGeneration: input.applicabilityGeneration,
    blocks: sortedBlocks,
    completeness: {
      chatData: input.completeness.chatData,
      segments: input.completeness.segments,
      residentTopic: input.completeness.residentTopic
    },
    messages: sortedMessages,
    segments: sortedSegments,
    topicId: input.topicId
  }

  const canonicalJson = canonicalJsonStringify(rawFrame)
  const canonicalFrame = JSON.parse(canonicalJson) as Record<string, unknown>
  const byteLength = utf8ByteLength(canonicalJson)

  return { canonicalFrame, canonicalJson, byteLength }
}

/**
 * Aggregate accounting across topics (evictable set). Shared entities are fully
 * duplicated per topic — per-topic bytes are independent.
 */
export function aggregateLogicalPayload(topics: LogicalPayloadTopicInput[]): AggregateAccounting {
  const perTopic: PerTopicAccounting[] = topics.map((t) => {
    const r = canonicalizeLogicalPayload(t)
    return {
      topicId: t.topicId,
      byteLength: r.byteLength,
      canonicalJson: r.canonicalJson,
      canonicalFrame: r.canonicalFrame
    }
  })
  const aggregateBytes = perTopic.reduce((acc, cur) => acc + cur.byteLength, 0)
  const topicCount = perTopic.length
  const isCountBound = topicCount > B01_MAX_TOPICS
  const isByteBound = aggregateBytes > B02_MAX_BYTES
  let binding: AggregateAccounting['binding']
  if (isCountBound && isByteBound) binding = 'both'
  else if (isCountBound) binding = 'count-first'
  else if (isByteBound) binding = 'byte-first'
  else binding = 'none'

  const oversizedTopicIds = perTopic.filter((p) => p.byteLength > B05_CALIBRATION_CANDIDATE_BYTES).map((p) => p.topicId)

  return {
    perTopic,
    aggregateBytes,
    topicCount,
    isCountBound,
    isByteBound,
    binding,
    oversizedTopicIds
  }
}
