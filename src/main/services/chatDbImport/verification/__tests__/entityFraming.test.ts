/**
 * Direct entityFraming unit tests (Phase 4.3.4, LOCK-4302).
 *
 * The shared framing module is the single source of truth for how every
 * projected/reconstructed domain record is framed and digested by BOTH the
 * source manifest builder and the candidate verifier. These tests pin that
 * contract directly, per entity:
 * - every canonical column is explicitly PRESENT in the framed record
 *   (null when null) — never dropped;
 * - explicit null vs absent stays distinguishable in overflow;
 * - the overflow digest is independent evidence (dimension ⑩): column
 *   changes never move it, overflow changes always move it;
 * - structured model/tool digests are independent evidence (dimension ⑨):
 *   unrelated overflow changes never move them, and a present-null slot is
 *   distinguishable from an absent slot;
 * - record digests equal canonicalDigest(framed record) by construction
 *   and are insensitive to key insertion order.
 */

import type {
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicData,
  TopicSegmentData
} from '@main/services/chatDb/domain/types'
import { describe, expect, it } from 'vitest'

import { canonicalDigest, canonicalStringify } from '../canonicalJson'
import {
  digestBlock,
  digestFileReference,
  digestMessage,
  digestSegment,
  digestTopic,
  frameBlockRecord,
  frameFileReferenceRecord,
  frameMessageRecord,
  frameSegmentRecord,
  frameTopicRecord
} from '../entityFraming'

// ---------------------------------------------------------------------------
// Fixtures — fully-populated and all-null variants per entity
// ---------------------------------------------------------------------------

function topic(overrides: Partial<TopicData> = {}): TopicData {
  return {
    id: 't-1',
    assistantId: null,
    name: null,
    createdAt: null,
    updatedAt: null,
    deletedAt: '2021-06-01T00:00:00.000Z',
    overflow: {},
    ...overrides
  }
}

function message(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: 'm-1',
    topicId: 't-1',
    role: 'user',
    content: null,
    status: 'success',
    askId: null,
    model: null,
    modelId: 'gpt-4o',
    assistantId: 'asst-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: null,
    sortOrder: 3,
    overflow: { blocks: ['b-1'] },
    ...overrides
  }
}

function block(overrides: Partial<MessageBlockData> = {}): MessageBlockData {
  return {
    id: 'b-1',
    messageId: 'm-1',
    type: 'main_text',
    content: 'hello',
    status: 'success',
    createdAt: '2020-01-01T00:00:01.000Z',
    updatedAt: null,
    sortOrder: 0,
    overflow: {},
    ...overrides
  }
}

function fileReference(overrides: Partial<FileReferenceData> = {}): FileReferenceData {
  return {
    id: 'fr-1',
    blockId: 'b-1',
    fileId: 'file-1',
    fileName: 'doc.pdf',
    filePath: null,
    fileType: 'file',
    count: null,
    overflow: { file: { id: 'file-1', size: 10 } },
    ...overrides
  }
}

function segment(overrides: Partial<TopicSegmentData> = {}): TopicSegmentData {
  return {
    id: 's-1',
    topicId: 't-1',
    name: 'Segment',
    createdAt: '2020-01-02T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
    sortOrder: 0,
    overflow: { color: '#ff0000' },
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Record framing — every canonical column explicitly present
// ---------------------------------------------------------------------------

describe('entityFraming — record framing (LOCK-4302)', () => {
  it('frames every topic canonical column, null when null', () => {
    const framed = frameTopicRecord(topic())
    expect(Object.keys(framed).sort()).toEqual([
      'assistantId',
      'createdAt',
      'deletedAt',
      'id',
      'name',
      'overflow',
      'updatedAt'
    ])
    const canonical = canonicalStringify(framed)
    expect(canonical).toContain('"assistantId":null')
    expect(canonical).toContain('"name":null')
    expect(canonical).toContain('"createdAt":null')
    expect(canonical).toContain('"updatedAt":null')
    expect(canonical).toContain('"deletedAt":"2021-06-01T00:00:00.000Z"')
    expect(canonical).toContain('"overflow":{}')
  })

  it('frames every message canonical column, null when null', () => {
    const framed = frameMessageRecord(message())
    expect(Object.keys(framed).sort()).toEqual([
      'askId',
      'assistantId',
      'content',
      'createdAt',
      'id',
      'model',
      'modelId',
      'overflow',
      'role',
      'sortOrder',
      'status',
      'topicId',
      'updatedAt'
    ])
    const canonical = canonicalStringify(framed)
    expect(canonical).toContain('"content":null')
    expect(canonical).toContain('"askId":null')
    expect(canonical).toContain('"model":null')
    expect(canonical).toContain('"updatedAt":null')
    expect(canonical).toContain('"sortOrder":3')
  })

  it('frames every block canonical column, null when null', () => {
    const framed = frameBlockRecord(block({ content: null }))
    expect(Object.keys(framed).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'messageId',
      'overflow',
      'sortOrder',
      'status',
      'type',
      'updatedAt'
    ])
    const canonical = canonicalStringify(framed)
    expect(canonical).toContain('"content":null')
    expect(canonical).toContain('"updatedAt":null')
    expect(canonical).toContain('"sortOrder":0')
  })

  it('frames every file-reference canonical column, null when null', () => {
    const framed = frameFileReferenceRecord(fileReference())
    expect(Object.keys(framed).sort()).toEqual([
      'blockId',
      'count',
      'fileId',
      'fileName',
      'filePath',
      'fileType',
      'id',
      'overflow'
    ])
    const canonical = canonicalStringify(framed)
    expect(canonical).toContain('"filePath":null')
    expect(canonical).toContain('"count":null')
  })

  it('frames every segment canonical column, null when null', () => {
    const framed = frameSegmentRecord(segment({ name: null, createdAt: null, updatedAt: null }))
    expect(Object.keys(framed).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'overflow',
      'sortOrder',
      'topicId',
      'updatedAt'
    ])
    const canonical = canonicalStringify(framed)
    expect(canonical).toContain('"name":null')
    expect(canonical).toContain('"createdAt":null')
    expect(canonical).toContain('"updatedAt":null')
  })
})

// ---------------------------------------------------------------------------
// Digest consistency + determinism
// ---------------------------------------------------------------------------

describe('entityFraming — digest consistency', () => {
  it('record digests equal canonicalDigest of the framed record for every entity', () => {
    expect(digestTopic(topic()).record).toBe(canonicalDigest(frameTopicRecord(topic())))
    expect(digestMessage(message()).record).toBe(canonicalDigest(frameMessageRecord(message())))
    expect(digestBlock(block()).record).toBe(canonicalDigest(frameBlockRecord(block())))
    expect(digestFileReference(fileReference()).record).toBe(canonicalDigest(frameFileReferenceRecord(fileReference())))
    expect(digestSegment(segment()).record).toBe(canonicalDigest(frameSegmentRecord(segment())))
  })

  it('overflow digests equal canonicalDigest of the overflow object alone for every entity', () => {
    const t = topic({ overflow: { pinned: true } })
    const m = message()
    const b = block({ overflow: { citations: [1, 2] } })
    const r = fileReference()
    const s = segment()
    expect(digestTopic(t).overflow).toBe(canonicalDigest(t.overflow))
    expect(digestMessage(m).overflow).toBe(canonicalDigest(m.overflow))
    expect(digestBlock(b).overflow).toBe(canonicalDigest(b.overflow))
    expect(digestFileReference(r).overflow).toBe(canonicalDigest(r.overflow))
    expect(digestSegment(s).overflow).toBe(canonicalDigest(s.overflow))
  })

  it('digests are insensitive to construction key order (canonical determinism)', () => {
    const shuffled = {
      overflow: { z: 1, a: 2 },
      deletedAt: null,
      updatedAt: null,
      createdAt: null,
      name: null,
      assistantId: null,
      id: 't-1'
    } as unknown as TopicData
    const ordered = topic({ deletedAt: null, overflow: { a: 2, z: 1 } })
    expect(digestTopic(shuffled).record).toBe(digestTopic(ordered).record)
    expect(digestTopic(shuffled).overflow).toBe(digestTopic(ordered).overflow)
  })
})

// ---------------------------------------------------------------------------
// Explicit null vs absent
// ---------------------------------------------------------------------------

describe('entityFraming — null vs absent (LOCK-4302)', () => {
  it('an explicit-null overflow key digests differently from an absent key', () => {
    const withNull = topic({ overflow: { traceId: null } })
    const absent = topic({ overflow: {} })
    expect(digestTopic(withNull).overflow).not.toBe(digestTopic(absent).overflow)
    expect(digestTopic(withNull).record).not.toBe(digestTopic(absent).record)
  })

  it('a null canonical column still appears in the record digest input', () => {
    // Framing forces presence: two topics differing only in name null vs a
    // value MUST differ, and the null column is serialized explicitly.
    const withName = topic({ name: 'Named' } as Partial<TopicData>)
    const withoutName = topic()
    expect(digestTopic(withName).record).not.toBe(digestTopic(withoutName).record)
    expect(canonicalStringify(frameTopicRecord(withoutName))).toContain('"name":null')
  })
})

// ---------------------------------------------------------------------------
// Overflow digest independence (dimension ⑩)
// ---------------------------------------------------------------------------

describe('entityFraming — overflow independence (dimension ⑩)', () => {
  it('a canonical column change moves the record digest but never the overflow digest', () => {
    const base = message()
    const mutated = message({ role: 'assistant' })
    expect(digestMessage(mutated).record).not.toBe(digestMessage(base).record)
    expect(digestMessage(mutated).overflow).toBe(digestMessage(base).overflow)
    expect(digestMessage(mutated).structuredModel).toBe(digestMessage(base).structuredModel)
  })

  it('an overflow change moves both the overflow digest and the record digest', () => {
    const base = block({ overflow: { toolId: 'tool-1' } })
    const mutated = block({ overflow: { toolId: 'tool-2' } })
    expect(digestBlock(mutated).overflow).not.toBe(digestBlock(base).overflow)
    // Overflow rides inside the whole-record digest too.
    expect(digestBlock(mutated).record).not.toBe(digestBlock(base).record)
  })

  it('overflow independence holds for every entity with an overflow slot', () => {
    const pairs: Array<[string, string, string, string]> = [
      [
        digestTopic(topic({ overflow: { a: 1 } })).overflow,
        digestTopic(topic({ overflow: { a: 2 } })).overflow,
        digestTopic(topic({ name: 'x', overflow: { a: 1 } } as Partial<TopicData>)).overflow,
        digestTopic(topic({ overflow: { a: 1 } })).overflow
      ],
      [
        digestSegment(segment({ overflow: { color: '#111111' } })).overflow,
        digestSegment(segment({ overflow: { color: '#222222' } })).overflow,
        digestSegment(segment({ name: 'renamed', overflow: { color: '#111111' } })).overflow,
        digestSegment(segment({ overflow: { color: '#111111' } })).overflow
      ],
      [
        digestFileReference(fileReference({ overflow: { file: { id: 'file-1' } } })).overflow,
        digestFileReference(fileReference({ overflow: { file: { id: 'file-2' } } })).overflow,
        digestFileReference(fileReference({ fileName: 'renamed.pdf', overflow: { file: { id: 'file-1' } } })).overflow,
        digestFileReference(fileReference({ overflow: { file: { id: 'file-1' } } })).overflow
      ]
    ]
    for (const [base, overflowMutated, columnMutated, baseAgain] of pairs) {
      expect(overflowMutated).not.toBe(base) // overflow change moves it
      expect(columnMutated).toBe(base) // column change never moves it
      expect(baseAgain).toBe(base) // deterministic
    }
  })
})

// ---------------------------------------------------------------------------
// Structured model/tool digest independence (dimension ⑨)
// ---------------------------------------------------------------------------

describe('entityFraming — structured digests (dimension ⑨)', () => {
  const MODEL = { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', group: 'gpt' }
  const TOOL_CONTENT = { toolName: 'search', result: { hits: 3 } }

  it('message structuredModel digests only overflow.model and is independent of other overflow keys', () => {
    const base = message({ overflow: { model: MODEL, blocks: ['b-1'] } })
    const otherOverflowChange = message({ overflow: { model: MODEL, blocks: ['b-1', 'b-2'] } })
    const modelChange = message({ overflow: { model: { ...MODEL, id: 'tampered' }, blocks: ['b-1'] } })

    expect(digestMessage(base).structuredModel).toBe(canonicalDigest(MODEL))
    expect(digestMessage(otherOverflowChange).structuredModel).toBe(digestMessage(base).structuredModel)
    expect(digestMessage(otherOverflowChange).overflow).not.toBe(digestMessage(base).overflow)
    expect(digestMessage(modelChange).structuredModel).not.toBe(digestMessage(base).structuredModel)
  })

  it('message structuredModel distinguishes absent, explicit-null, and present model slots', () => {
    const absent = message({ overflow: {} })
    const explicitNull = message({ overflow: { model: null } })
    const present = message({ overflow: { model: MODEL } })

    expect(digestMessage(absent).structuredModel).toBeNull()
    expect(digestMessage(explicitNull).structuredModel).toBe(canonicalDigest(null))
    expect(digestMessage(explicitNull).structuredModel).not.toBeNull()
    expect(digestMessage(present).structuredModel).toBe(canonicalDigest(MODEL))
  })

  it('block structuredContent digests only overflow.content and is independent of other overflow keys', () => {
    const base = block({ overflow: { content: TOOL_CONTENT, toolId: 'tool-1' } })
    const otherOverflowChange = block({ overflow: { content: TOOL_CONTENT, toolId: 'tool-2' } })
    const contentChange = block({ overflow: { content: { ...TOOL_CONTENT, result: { hits: 999 } }, toolId: 'tool-1' } })

    expect(digestBlock(base).structuredContent).toBe(canonicalDigest(TOOL_CONTENT))
    expect(digestBlock(otherOverflowChange).structuredContent).toBe(digestBlock(base).structuredContent)
    expect(digestBlock(otherOverflowChange).overflow).not.toBe(digestBlock(base).overflow)
    expect(digestBlock(contentChange).structuredContent).not.toBe(digestBlock(base).structuredContent)
  })

  it('block structuredContent distinguishes absent, explicit-null, and present content slots', () => {
    const absent = block({ overflow: {} })
    const explicitNull = block({ overflow: { content: null } })
    const present = block({ overflow: { content: TOOL_CONTENT } })

    expect(digestBlock(absent).structuredContent).toBeNull()
    expect(digestBlock(explicitNull).structuredContent).toBe(canonicalDigest(null))
    expect(digestBlock(explicitNull).structuredContent).not.toBeNull()
    expect(digestBlock(present).structuredContent).toBe(canonicalDigest(TOOL_CONTENT))
  })

  it('a canonical column change never moves the structured digests', () => {
    const base = block({ overflow: { content: TOOL_CONTENT } })
    const columnMutated = block({ status: 'error', overflow: { content: TOOL_CONTENT } })
    expect(digestBlock(columnMutated).structuredContent).toBe(digestBlock(base).structuredContent)
    expect(digestBlock(columnMutated).record).not.toBe(digestBlock(base).record)
  })
})
