/**
 * Shared deterministic 10,000-message benchmark fixture (LOCK-B2).
 *
 * Extracted from the Phase 4.2 import benchmark so the Phase 4.3.4
 * verification benchmark exercises the IDENTICAL source stream through the
 * same data plane. Pure page builders — no randomness, no filesystem, no
 * retained pages (each page is built lazily and dropped after processing).
 *
 * Test-support module only (not a test file; vitest collects only
 * *.test.ts / *.spec.ts).
 */

import type { JsonObject } from '@shared/chatDb'
import type { ReadPageResponse } from '@shared/chatImport/types'

import type { ChatImportDataPlane } from '../importDataPlane'

// ---------------------------------------------------------------------------
// Fixture dimensions (LOCK-B2) — all deterministic, no randomness
// ---------------------------------------------------------------------------

/** Topics in the source stream. */
export const TOPIC_COUNT = 25
/** Embedded messages per topic. */
export const MESSAGES_PER_TOPIC = 400
/** Exactly 10,000 messages (LOCK-B2). */
export const TOTAL_MESSAGES = TOPIC_COUNT * MESSAGES_PER_TOPIC
/** Topics per source page → 5 topic pages of 2,000 embedded messages each. */
export const TOPICS_PER_PAGE = 5
/** Every Nth message carries a second (sibling) block. */
export const EXTRA_BLOCK_EVERY = 10
/** Extra sibling blocks: 1,000 (file/image/tool cycling). */
export const EXTRA_BLOCK_COUNT = TOTAL_MESSAGES / EXTRA_BLOCK_EVERY
/** Total candidate blocks: 10,000 base + 1,000 extras. */
export const TOTAL_BLOCKS = TOTAL_MESSAGES + EXTRA_BLOCK_COUNT
/** Globally ID-paginated block page size → 11 block pages. */
export const BLOCK_PAGE_SIZE = 1000
/** Every Nth message carries a structured model + unknown overflow key. */
export const STRUCTURED_MODEL_EVERY = 100
/** Ordered members per per-topic segment. */
export const SEGMENT_MEMBER_COUNT = 10
/** 25 per-topic segments + 1 empty segment (LOCK-B2). */
export const TOTAL_SEGMENTS = TOPIC_COUNT + 1
export const TOTAL_MEMBERSHIPS = TOPIC_COUNT * SEGMENT_MEMBER_COUNT
/** Source `files` rows streamed (count-diagnostic only), 2 pages of 500. */
export const SOURCE_FILE_RECORDS = EXTRA_BLOCK_COUNT
export const FILES_PAGE_SIZE = 500

export const BENCH_CREATED_AT = '2020-01-01T00:00:00.000Z'
export const STRUCTURED_MODEL = { id: 'bench-model', name: 'Bench Model', provider: 'bench', group: 'bench' }

/** file/image extras project file references; tool extras do not. */
export const EXPECTED_FILE_REFERENCES = (() => {
  let n = 0
  for (let e = 0; e < EXTRA_BLOCK_COUNT; e++) {
    if (e % 3 !== 2) n++ // 0 → file, 1 → image, 2 → tool
  }
  return n
})()

/** 5 topic + 11 block + 1 segment + 2 files pages. */
export const EXPECTED_PAGE_COUNT =
  TOPIC_COUNT / TOPICS_PER_PAGE + TOTAL_BLOCKS / BLOCK_PAGE_SIZE + 1 + SOURCE_FILE_RECORDS / FILES_PAGE_SIZE

// ---------------------------------------------------------------------------
// Deterministic ID scheme (zero-padded so global ID order is lexicographic)
// ---------------------------------------------------------------------------

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}
export const topicIdOf = (t: number): string => `t-${pad(t, 2)}`
export const messageIdOf = (g: number): string => `m-${pad(g, 5)}`
export const baseBlockIdOf = (g: number): string => `b-${pad(g, 5)}`
/** Extras use an `x-` prefix, sorting after every base `b-` ID, so globally
 *  ID-paginated block pages split sibling blocks across pages (LOCK-B2). */
export const extraBlockIdOf = (e: number): string => `x-${pad(e, 4)}`
export const fileIdOf = (e: number): string => `file-${pad(e, 4)}`
export const hasExtraBlock = (g: number): boolean => g % EXTRA_BLOCK_EVERY === 0
export const extraTypeOf = (e: number): 'file' | 'image' | 'tool' => (['file', 'image', 'tool'] as const)[e % 3]

// ---------------------------------------------------------------------------
// Fixture page builders (built lazily per page; not retained — LOCK-B6)
// ---------------------------------------------------------------------------

export function page(tableName: string, items: JsonObject[], hasMore: boolean): ReadPageResponse {
  return { tableName, items, cursor: hasMore ? 'next' : null, hasMore }
}

export function buildMessage(g: number): JsonObject {
  const topicIndex = Math.floor(g / MESSAGES_PER_TOPIC)
  const blocks = hasExtraBlock(g)
    ? [extraBlockIdOf(g / EXTRA_BLOCK_EVERY), baseBlockIdOf(g)] // extra first: deliberate non-ID sibling order
    : [baseBlockIdOf(g)]
  const message: JsonObject = {
    id: messageIdOf(g),
    topicId: topicIdOf(topicIndex),
    role: g % 2 === 0 ? 'user' : 'assistant',
    status: 'success',
    assistantId: 'asst-bench',
    createdAt: BENCH_CREATED_AT,
    blocks
  }
  if (g % STRUCTURED_MODEL_EVERY === 0) {
    message.model = { ...STRUCTURED_MODEL }
    message.benchUnknownKey = { globalIndex: g }
  }
  return message
}

/** Topic page p: 5 topics, each embedding its 400 messages in REVERSED
 *  array order (non-ID order) so sortOrder = array index is provable. */
export function buildTopicPage(p: number): JsonObject[] {
  const topics: JsonObject[] = []
  for (let t = p * TOPICS_PER_PAGE; t < (p + 1) * TOPICS_PER_PAGE; t++) {
    const messages: JsonObject[] = []
    for (let i = 0; i < MESSAGES_PER_TOPIC; i++) {
      const g = t * MESSAGES_PER_TOPIC + (MESSAGES_PER_TOPIC - 1 - i)
      messages.push(buildMessage(g))
    }
    topics.push({ id: topicIdOf(t), messages })
  }
  return topics
}

export function buildBlockRow(sortedIndex: number): JsonObject {
  if (sortedIndex < TOTAL_MESSAGES) {
    const g = sortedIndex
    return {
      id: baseBlockIdOf(g),
      messageId: messageIdOf(g),
      type: 'main_text',
      content: `bench message ${g}`,
      status: 'success',
      createdAt: BENCH_CREATED_AT
    }
  }
  const e = sortedIndex - TOTAL_MESSAGES
  const messageId = messageIdOf(e * EXTRA_BLOCK_EVERY)
  const type = extraTypeOf(e)
  if (type === 'tool') {
    return {
      id: extraBlockIdOf(e),
      messageId,
      type: 'tool',
      content: { toolName: 'bench', callIndex: e },
      status: 'success',
      createdAt: BENCH_CREATED_AT,
      toolId: `tool-${e}`
    }
  }
  return {
    id: extraBlockIdOf(e),
    messageId,
    type,
    content: null,
    file: { id: fileIdOf(e), name: `f${e}.bin`, path: `/bench/f${e}.bin`, type, size: e },
    benchExtraKey: e,
    status: 'success',
    createdAt: BENCH_CREATED_AT
  }
}

/** Block page b (globally ID-sorted: all b-* ascending, then all x-*). */
export function buildBlockPage(b: number): JsonObject[] {
  const items: JsonObject[] = []
  for (let i = b * BLOCK_PAGE_SIZE; i < Math.min((b + 1) * BLOCK_PAGE_SIZE, TOTAL_BLOCKS); i++) {
    items.push(buildBlockRow(i))
  }
  return items
}

/** 25 per-topic segments (members = first 10 topic messages, REVERSED order)
 *  plus one empty segment (LOCK-B2). */
export function buildSegmentsPage(): JsonObject[] {
  const segments: JsonObject[] = []
  for (let t = 0; t < TOPIC_COUNT; t++) {
    const messageIds: string[] = []
    for (let i = SEGMENT_MEMBER_COUNT - 1; i >= 0; i--) {
      messageIds.push(messageIdOf(t * MESSAGES_PER_TOPIC + i))
    }
    segments.push({
      id: `s-${pad(t, 2)}`,
      topicId: topicIdOf(t),
      name: `Bench segment ${t}`,
      messageIds,
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      color: '#123456'
    })
  }
  segments.push({
    id: 's-empty',
    topicId: topicIdOf(0),
    name: 'Empty bench segment',
    messageIds: [],
    createdAt: BENCH_CREATED_AT,
    updatedAt: BENCH_CREATED_AT
  })
  return segments
}

export function buildFilesPage(p: number): JsonObject[] {
  const items: JsonObject[] = []
  for (let e = p * FILES_PAGE_SIZE; e < Math.min((p + 1) * FILES_PAGE_SIZE, SOURCE_FILE_RECORDS); e++) {
    items.push({ id: fileIdOf(e), name: `f${e}.bin`, size: e })
  }
  return items
}

/** Stream every page through the data plane in LOCK-D1 entity order. */
export function streamAllPages(plane: ChatImportDataPlane): void {
  const topicPages = TOPIC_COUNT / TOPICS_PER_PAGE
  for (let p = 0; p < topicPages; p++) {
    plane.processPage(page('topics', buildTopicPage(p), p < topicPages - 1))
  }
  const blockPages = Math.ceil(TOTAL_BLOCKS / BLOCK_PAGE_SIZE)
  for (let b = 0; b < blockPages; b++) {
    plane.processPage(page('message_blocks', buildBlockPage(b), b < blockPages - 1))
  }
  plane.processPage(page('topic_segments', buildSegmentsPage(), false))
  const filesPages = Math.ceil(SOURCE_FILE_RECORDS / FILES_PAGE_SIZE)
  for (let p = 0; p < filesPages; p++) {
    plane.processPage(page('files', buildFilesPage(p), p < filesPages - 1))
  }
}
