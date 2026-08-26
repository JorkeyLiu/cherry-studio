/**
 * Phase 4 C-01 — Logical Retained Payload Calibration (measurement-only)
 *
 * Canonical `phase4-logical-payload-v1` accounting is now **shared pure
 * cross-runtime infrastructure** (`packages/shared/chatDb/logicalPayload.ts`).
 * This file retains **measurement-specific synthetic calibration profiles**
 * and re-exports the shared canonical contract for Main calibration helper
 * import compatibility. No runtime cache retention, eviction, TTL, LRU,
 * admission, heap-capacity policy, or app runtime behavior is implemented
 * (LOCK-C01-001). Synthetic helpers live under `src/main/services/chatDb/__tests__`
 * per measurement-only governance.
 *
 * Canonical rules remain verbatim B-02 and are implemented once in the shared
 * module with browser-and-Node-compatible UTF-8 accounting (TextEncoder).
 * This re-export preserves exact public behavior of Main calibration helpers
 * (LOCK-201) without duplicating the canonical implementation.
 */

// Re-export shared pure accounting contract (single source of truth, LOCK-201/203)
// eslint-disable-next-line simple-import-sort/imports -- keep shared re-export grouping explicit
import {
  aggregateLogicalPayload,
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  canonicalizeLogicalPayload,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION
} from '@shared/chatDb/logicalPayload'
import type {
  AggregateAccounting,
  CanonicalPayloadResult,
  LogicalPayloadCompleteness,
  LogicalPayloadTopicInput
} from '@shared/chatDb/logicalPayload'

export {
  aggregateLogicalPayload,
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  canonicalizeLogicalPayload,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION
}
export type { AggregateAccounting, CanonicalPayloadResult, LogicalPayloadCompleteness, LogicalPayloadTopicInput }
// Canonical serializer is also part of the shared contract — re-export for
// existing Main test imports (determinism/edge-case coverage)
export { canonicalJsonStringify } from '@shared/chatDb/logicalPayload'

// ---------------------------------------------------------------------------
// Deterministic synthetic calibration profiles (measurement-specific, Main-local)
// ---------------------------------------------------------------------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export interface SyntheticTopicOptions {
  topicId: string
  messageCount: number
  blockContentSize: number
  segmentCount?: number
  generation?: number
  includeSortOrder?: boolean
}

/**
 * Create a deterministic synthetic topic for calibration. Each message has one
 * main_text block with content = 'a'.repeat(blockContentSize). Content is
 * deterministic ASCII; use `blockContentWithUnicode` for UTF-8 stability tests
 * separately. Messages/blocks/segments are projection-complete enough to represent
 * real renderer retained entities (deterministic finite fields: assistantId,
 * blocks references, topicId matching, messageIds, etc.) while retaining
 * practical profile sizes and binding outcomes.
 */
export function createSyntheticTopic(options: SyntheticTopicOptions): LogicalPayloadTopicInput {
  const { topicId, messageCount, blockContentSize, segmentCount = 0, generation = 0, includeSortOrder = true } = options
  const messages: Record<string, unknown>[] = []
  const blocks: Record<string, unknown>[] = []
  const segments: Record<string, unknown>[] = []

  const content = 'a'.repeat(blockContentSize)

  for (let i = 0; i < messageCount; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    const msg: Record<string, unknown> = {
      id: msgId,
      topicId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      assistantId: `assistant-${pad(i % 3, 2)}`,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      sortOrder: includeSortOrder ? i : undefined
    }
    // Omit sortOrder when not included to mimic absent field (not undefined in JSON)
    if (!includeSortOrder) delete msg.sortOrder
    messages.push(msg)

    blocks.push({
      id: blockId,
      messageId: msgId,
      type: 'main_text',
      content,
      status: 'success',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    })
  }

  for (let s = 0; s < segmentCount; s++) {
    segments.push({
      id: `${topicId}-segment-${pad(s, 3)}`,
      topicId,
      name: `Segment ${s}`,
      messageIds: messages.slice(0, Math.min(2, messages.length)).map((m) => String(m.id)),
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    })
  }

  return {
    topicId,
    messages,
    blocks,
    segments,
    completeness: { chatData: true, segments: true, residentTopic: true },
    applicabilityGeneration: generation
  }
}

/** 9 topics × 10 msgs each ~ ~1.5 KiB per topic → aggregate <<32 MiB, count 9>8 => count-first */
export function createSyntheticCountFirstProfile(): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < 9; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `synthetic-count-first-topic-${pad(t, 2)}`,
        messageCount: 10,
        blockContentSize: 1024,
        segmentCount: 1
      })
    )
  }
  return topics
}

/** 4 topics × 550 msgs × 16 KiB content → ~8.9 MiB per topic → aggregate ~35.6 MiB >32 MiB, count 4≤8 => byte-first */
export function createSyntheticByteFirstProfile(): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < 4; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `synthetic-byte-first-topic-${pad(t, 2)}`,
        messageCount: 550,
        blockContentSize: 16 * 1024,
        segmentCount: 0
      })
    )
  }
  return topics
}

/**
 * 1 topic × 2800 msgs × 14 KiB content → ~38 MiB single-topic >32 MiB => B-05 oversized
 * Memory: ~2800*14KiB=~38.2 MiB content plus JSON overhead crosses B-05 with margin.
 */
export function createSyntheticOversizedSingleProfile(): LogicalPayloadTopicInput[] {
  return [
    createSyntheticTopic({
      topicId: 'synthetic-oversized-single-topic-00',
      messageCount: 2800,
      blockContentSize: 14 * 1024,
      segmentCount: 0
    })
  ]
}

export const SYNTHETIC_PROFILE_IDS = {
  countFirst: 'synthetic-count-first-v1',
  byteFirst: 'synthetic-byte-first-v1',
  oversizedSingle: 'synthetic-oversized-single-v1',
  boundaryExact: 'synthetic-boundary-exact-v1',
  bothBound: 'synthetic-both-bound-v1',
  variedShape: 'synthetic-varied-shape-v1',
  byteBoundary: 'synthetic-byte-boundary-v1',
  b02ExactEquality: 'synthetic-b02-exact-equality-v1'
} as const

/** 8 topics × 10 msgs each ~ ~1.5 KiB per topic → aggregate <32 MiB, count exactly at B-01 limit => none (boundary) */
export function createSyntheticBoundaryExactProfile(): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < 8; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `synthetic-boundary-exact-topic-${pad(t, 2)}`,
        messageCount: 10,
        blockContentSize: 1024,
        segmentCount: 1
      })
    )
  }
  return topics
}

/** 9 topics × 550 msgs × 16 KiB content → both count and byte bound (count 9>8 and aggregate >32 MiB) */
export function createSyntheticBothBoundProfile(): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < 9; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `synthetic-both-bound-topic-${pad(t, 2)}`,
        messageCount: 550,
        blockContentSize: 16 * 1024,
        segmentCount: 0
      })
    )
  }
  return topics
}

/** 3 topics with varied message/block/segment shapes — exercises small/medium/large mix, segment variations */
export function createSyntheticVariedShapeProfile(): LogicalPayloadTopicInput[] {
  const specs: Array<{ messages: number; blockSize: number; segments: number; includeSortOrder?: boolean }> = [
    { messages: 5, blockSize: 256, segments: 0 },
    { messages: 15, blockSize: 2048, segments: 2 },
    { messages: 25, blockSize: 4096, segments: 5, includeSortOrder: false }
  ]
  return specs.map((s, idx) =>
    createSyntheticTopic({
      topicId: `synthetic-varied-shape-topic-${pad(idx, 2)}`,
      messageCount: s.messages,
      blockContentSize: s.blockSize,
      segmentCount: s.segments,
      includeSortOrder: s.includeSortOrder ?? true
    })
  )
}

/** 2 topics × 1 message × 1024 B — small byte payload, both bounds none, exercises minimal shape */
export function createSyntheticByteBoundarySmallProfile(): LogicalPayloadTopicInput[] {
  const topics: LogicalPayloadTopicInput[] = []
  for (let t = 0; t < 2; t++) {
    topics.push(
      createSyntheticTopic({
        topicId: `synthetic-byte-boundary-topic-${pad(t, 2)}`,
        messageCount: 1,
        blockContentSize: 1024,
        segmentCount: 0
      })
    )
  }
  return topics
}

/**
 * Exact B-02 equality: 1 topic × 1 message where canonical bytes == 32 MiB exactly.
 * Computed dynamically: base overhead with empty content plus needed filler to hit
 * B02_MAX_BYTES. Verifies that equality is NOT byte-bound (strict > threshold).
 * Deterministic, fail-closed if calibration fails.
 */
export function createSyntheticB02ExactEqualityProfile(): LogicalPayloadTopicInput[] {
  const topicId = 'synthetic-b02-exact-topic-00'
  const base = createSyntheticTopic({
    topicId,
    messageCount: 1,
    blockContentSize: 0,
    segmentCount: 0
  })
  const { byteLength: baseBytes } = canonicalizeLogicalPayload(base)
  const needed = B02_MAX_BYTES - baseBytes
  if (!Number.isFinite(needed) || needed <= 0) {
    throw new Error(`b02 exact equality calibration failed: baseBytes=${baseBytes} needed=${needed}`)
  }
  const exact = createSyntheticTopic({
    topicId,
    messageCount: 1,
    blockContentSize: needed,
    segmentCount: 0
  })
  const { byteLength } = canonicalizeLogicalPayload(exact)
  if (byteLength !== B02_MAX_BYTES) {
    throw new Error(
      `b02 exact equality calibration failed: expected ${B02_MAX_BYTES} got ${byteLength} (needed ${needed})`
    )
  }
  return [exact]
}

/** Enumerate all deterministic calibration profiles for matrix runs (preserves original 3 as subset). */
export function getLogicalPayloadProfileMatrix(): Array<{ id: string; topics: LogicalPayloadTopicInput[] }> {
  return [
    { id: SYNTHETIC_PROFILE_IDS.countFirst, topics: createSyntheticCountFirstProfile() },
    { id: SYNTHETIC_PROFILE_IDS.byteFirst, topics: createSyntheticByteFirstProfile() },
    { id: SYNTHETIC_PROFILE_IDS.oversizedSingle, topics: createSyntheticOversizedSingleProfile() },
    { id: SYNTHETIC_PROFILE_IDS.boundaryExact, topics: createSyntheticBoundaryExactProfile() },
    { id: SYNTHETIC_PROFILE_IDS.bothBound, topics: createSyntheticBothBoundProfile() },
    { id: SYNTHETIC_PROFILE_IDS.variedShape, topics: createSyntheticVariedShapeProfile() },
    { id: SYNTHETIC_PROFILE_IDS.byteBoundary, topics: createSyntheticByteBoundarySmallProfile() },
    { id: SYNTHETIC_PROFILE_IDS.b02ExactEquality, topics: createSyntheticB02ExactEqualityProfile() }
  ]
}
