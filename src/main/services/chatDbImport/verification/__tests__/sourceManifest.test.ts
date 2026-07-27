/**
 * SourceVerificationManifestBuilder tests (LOCK-4301/4302).
 *
 * Covers, without a database:
 * - stagePageDelta purity: uncommitted deltas never appear in evidence.
 * - Commit merges IDs, digests, ownership/order, memberships, counts.
 * - `files` deltas contribute a diagnostic record count only.
 * - Duplicate evidence rejection (defensive).
 * - finalize() exact-once; commits after finalize rejected.
 * - Deep-frozen snapshot immutability.
 */

import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:crypto')

import type { MessageBlockData, MessageData, TopicData, TopicSegmentData } from '../../../chatDb/domain/types'
import { canonicalDigest } from '../canonicalJson'
import type { StagedPageEvidence } from '../sourceManifest'
import { SourceManifestError, SourceVerificationManifestBuilder } from '../sourceManifest'

// ---------------------------------------------------------------------------
// Fixtures — target-equivalent projected DTOs (as produced by StagedPage)
// ---------------------------------------------------------------------------

function topicDto(id: string, deletedAt: string | null = null): TopicData {
  return { id, assistantId: null, name: null, createdAt: null, updatedAt: null, deletedAt, overflow: {} }
}

function messageDto(id: string, topicId: string, sortOrder: number, overflow: Record<string, unknown>): MessageData {
  return {
    id,
    topicId,
    role: 'user',
    content: null,
    status: 'success',
    askId: null,
    model: null,
    modelId: null,
    assistantId: 'asst-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: null,
    sortOrder,
    overflow
  }
}

function blockDto(id: string, messageId: string, sortOrder: number): MessageBlockData {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `content of ${id}`,
    status: 'success',
    createdAt: '2020-01-01T00:00:01.000Z',
    updatedAt: null,
    sortOrder,
    overflow: {}
  }
}

function segmentDto(id: string, topicId: string): TopicSegmentData {
  return {
    id,
    topicId,
    name: `Segment ${id}`,
    createdAt: '2020-01-02T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
    sortOrder: 0,
    overflow: {}
  }
}

function emptyEvidence(entity: StagedPageEvidence['entity'], sourceRowCount = 0): StagedPageEvidence {
  return {
    entity,
    topics: [],
    messages: [],
    blocks: [],
    fileReferences: [],
    segments: [],
    memberships: [],
    sourceRowCount
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SourceVerificationManifestBuilder', () => {
  it('staged-but-uncommitted deltas leave the manifest empty (purity)', () => {
    const builder = new SourceVerificationManifestBuilder()
    builder.stagePageDelta({
      ...emptyEvidence('topics', 1),
      topics: [topicDto('t-dropped')],
      messages: [messageDto('m-dropped', 't-dropped', 0, {})]
    })

    const manifest = builder.finalize()
    expect(manifest.topics.count).toBe(0)
    expect(manifest.messages.count).toBe(0)
    expect(manifest.committedPageCount).toBe(0)
    expect(Object.keys(manifest.topics.entries)).toEqual([])
  })

  it('commits IDs, field digests, ownership/order, memberships, and counts', () => {
    const builder = new SourceVerificationManifestBuilder()
    const msg = messageDto('m-1', 't-1', 3, { model: { id: 'gpt-4o' }, blocks: ['b-1'] })
    const blk = blockDto('b-1', 'm-1', 0)
    const seg = segmentDto('s-1', 't-1')

    builder.commitPageDelta(
      builder.stagePageDelta({
        ...emptyEvidence('topics', 1),
        topics: [topicDto('t-1', '2021-06-01T00:00:00.000Z')],
        messages: [msg]
      })
    )
    builder.commitPageDelta(
      builder.stagePageDelta({
        ...emptyEvidence('message_blocks', 1),
        blocks: [blk],
        fileReferences: [
          {
            id: 'fr-b-1-file-1',
            blockId: 'b-1',
            fileId: 'file-1',
            fileName: 'doc.pdf',
            filePath: '/files/doc.pdf',
            fileType: 'file',
            count: 1,
            overflow: {}
          }
        ]
      })
    )
    builder.commitPageDelta(
      builder.stagePageDelta({
        ...emptyEvidence('topic_segments', 1),
        segments: [seg],
        memberships: [{ segmentId: 's-1', messageIds: ['m-b', 'm-a'] }]
      })
    )

    const manifest = builder.finalize()

    // Counts + complete ID sets.
    expect(manifest.topics.count).toBe(1)
    expect(manifest.messages.count).toBe(1)
    expect(manifest.blocks.count).toBe(1)
    expect(manifest.fileReferences.count).toBe(1)
    expect(manifest.segments.count).toBe(1)
    expect(manifest.committedPageCount).toBe(3)

    // Digest framing: full projected record, every column explicit.
    expect(manifest.topics.entries['t-1'].digest).toBe(
      canonicalDigest(topicDto('t-1', '2021-06-01T00:00:00.000Z') as unknown as Record<string, unknown>)
    )
    expect(manifest.messages.entries['m-1'].digest).toBe(canonicalDigest({ ...msg }))
    expect(manifest.blocks.entries['b-1'].digest).toBe(canonicalDigest({ ...blk }))
    expect(manifest.segments.entries['s-1'].digest).toBe(canonicalDigest({ ...seg }))

    // Ownership / order evidence.
    expect(manifest.messages.entries['m-1']).toMatchObject({ topicId: 't-1', sortOrder: 3 })
    expect(manifest.blocks.entries['b-1']).toMatchObject({ messageId: 'm-1', sortOrder: 0 })
    expect(manifest.fileReferences.entries['fr-b-1-file-1'].blockId).toBe('b-1')
    expect(manifest.segments.entries['s-1'].topicId).toBe('t-1')

    // Membership order preserved exactly as given (source array order).
    expect(manifest.memberships.bySegment['s-1']).toEqual(['m-b', 'm-a'])
    expect(manifest.memberships.rowCount).toBe(2)

    // Independent overflow evidence (dimension ⑩): overflow digested alone.
    expect(manifest.topics.entries['t-1'].overflowDigest).toBe(canonicalDigest({}))
    expect(manifest.messages.entries['m-1'].overflowDigest).toBe(
      canonicalDigest({ model: { id: 'gpt-4o' }, blocks: ['b-1'] })
    )
    expect(manifest.blocks.entries['b-1'].overflowDigest).toBe(canonicalDigest({}))
    expect(manifest.fileReferences.entries['fr-b-1-file-1'].overflowDigest).toBe(canonicalDigest({}))
    expect(manifest.segments.entries['s-1'].overflowDigest).toBe(canonicalDigest({}))

    // Independent structured evidence (dimension ⑨): model slot digested
    // alone; block without object content carries an explicit null.
    expect(manifest.messages.entries['m-1'].structuredModelDigest).toBe(canonicalDigest({ id: 'gpt-4o' }))
    expect(manifest.blocks.entries['b-1'].structuredContentDigest).toBeNull()
  })

  it('records independent structured tool-content evidence for blocks (dimension ⑨)', () => {
    const builder = new SourceVerificationManifestBuilder()
    const toolContent = { toolName: 'search', result: { hits: 2 } }
    const toolBlock: MessageBlockData = {
      ...blockDto('b-tool', 'm-1', 0),
      content: null,
      overflow: { content: toolContent }
    }
    const plainMessage = messageDto('m-plain', 't-1', 0, {})

    builder.commitPageDelta(
      builder.stagePageDelta({
        ...emptyEvidence('message_blocks', 1),
        blocks: [toolBlock],
        messages: [plainMessage]
      })
    )

    const manifest = builder.finalize()
    expect(manifest.blocks.entries['b-tool'].structuredContentDigest).toBe(canonicalDigest(toolContent))
    expect(manifest.blocks.entries['b-tool'].overflowDigest).toBe(canonicalDigest({ content: toolContent }))
    // Message without a structured model carries an explicit null slot.
    expect(manifest.messages.entries['m-plain'].structuredModelDigest).toBeNull()
  })

  it('null and absent overflow keys digest differently', () => {
    const builder = new SourceVerificationManifestBuilder()
    const withNull = messageDto('m-1', 't-1', 0, { traceId: null })
    const withAbsent = messageDto('m-2', 't-1', 0, {})
    // Same message id in the digest would differ anyway — compare framing directly.
    expect(canonicalDigest({ ...withNull, id: 'x' })).not.toBe(canonicalDigest({ ...withAbsent, id: 'x' }))
    // And through the builder both records are individually digestable.
    const delta = builder.stagePageDelta({
      ...emptyEvidence('topics', 1),
      messages: [withNull, withAbsent]
    })
    expect(delta.messages).toHaveLength(2)
  })

  it("counts 'files' pages as diagnostic record count only", () => {
    const builder = new SourceVerificationManifestBuilder()
    builder.commitPageDelta(builder.stagePageDelta(emptyEvidence('files', 7)))
    // Non-files page row counts never leak into sourceFiles.
    builder.commitPageDelta(builder.stagePageDelta({ ...emptyEvidence('topics', 5), topics: [topicDto('t-1')] }))

    const manifest = builder.finalize()
    expect(manifest.sourceFiles.recordCount).toBe(7)
    expect(manifest.fileReferences.count).toBe(0)
    expect(manifest.committedPageCount).toBe(2)
  })

  it('rejects duplicate evidence defensively', () => {
    const builder = new SourceVerificationManifestBuilder()
    const delta = builder.stagePageDelta({ ...emptyEvidence('topics', 1), topics: [topicDto('t-1')] })
    builder.commitPageDelta(delta)
    expect(() => builder.commitPageDelta(delta)).toThrowError(SourceManifestError)
    expect(() => builder.commitPageDelta(delta)).toThrowError(/DUPLICATE_EVIDENCE.*t-1/)
  })

  it('finalizes exactly once and rejects later commits', () => {
    const builder = new SourceVerificationManifestBuilder()
    const delta = builder.stagePageDelta({ ...emptyEvidence('topics', 1), topics: [topicDto('t-1')] })
    builder.commitPageDelta(delta)

    const manifest = builder.finalize()
    expect(manifest.topics.count).toBe(1)
    expect(() => builder.finalize()).toThrowError(/FINALIZED/)
    const late = builder.stagePageDelta({ ...emptyEvidence('topics', 1), topics: [topicDto('t-2')] })
    expect(() => builder.commitPageDelta(late)).toThrowError(/FINALIZED/)
  })

  it('returns a deep-frozen snapshot', () => {
    const builder = new SourceVerificationManifestBuilder()
    builder.commitPageDelta(
      builder.stagePageDelta({
        ...emptyEvidence('topics', 1),
        topics: [topicDto('t-1')],
        messages: [messageDto('m-1', 't-1', 0, {})]
      })
    )
    builder.commitPageDelta(
      builder.stagePageDelta({
        ...emptyEvidence('topic_segments', 1),
        segments: [segmentDto('s-1', 't-1')],
        memberships: [{ segmentId: 's-1', messageIds: ['m-1'] }]
      })
    )

    const manifest = builder.finalize()
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.topics)).toBe(true)
    expect(Object.isFrozen(manifest.topics.entries)).toBe(true)
    expect(Object.isFrozen(manifest.topics.entries['t-1'])).toBe(true)
    expect(Object.isFrozen(manifest.messages.entries['m-1'])).toBe(true)
    expect(Object.isFrozen(manifest.memberships)).toBe(true)
    expect(Object.isFrozen(manifest.memberships.bySegment)).toBe(true)
    expect(Object.isFrozen(manifest.memberships.bySegment['s-1'])).toBe(true)
    expect(Object.isFrozen(manifest.sourceFiles)).toBe(true)

    // Strict-mode mutation attempts throw and change nothing.
    expect(() => {
      ;(manifest.topics.entries['t-1'] as { digest: string }).digest = 'tampered'
    }).toThrowError(TypeError)
    expect(() => {
      ;(manifest.memberships.bySegment['s-1'] as string[]).push('m-x')
    }).toThrowError(TypeError)
    expect(manifest.memberships.bySegment['s-1']).toEqual(['m-1'])
  })
})
