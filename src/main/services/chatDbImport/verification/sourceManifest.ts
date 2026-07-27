/**
 * Source verification manifest — transaction-consistent source evidence
 * for Phase 4.3 deterministic verification (LOCK-4301).
 *
 * The manifest is built EXCLUSIVELY from the Phase 4.2 target-equivalent
 * `StagedPage` projections produced by `ChatImportDataPlane.projectPage()`.
 * It never re-projects source rows (no second projection implementation)
 * and never hashes raw Dexie objects or raw SQL JSON strings (LOCK-4302).
 *
 * Two-step commit protocol (LOCK-4301):
 * 1. `stagePageDelta()` — pure digest computation before the DB write.
 * 2. `commitPageDelta()` — merge into the manifest ONLY after the page's
 *    candidate DB transaction committed. Failed pages never pollute
 *    evidence because their staged delta is simply dropped.
 *
 * Digest framing (LOCK-4302): all record framing lives in the shared
 * `entityFraming` module used by BOTH this builder and the candidate
 * verifier — field lists are never duplicated. Each entity carries the
 * whole-record digest plus an independent overflow digest (dimension ⑩)
 * and, for messages/blocks, an independent structured model/tool digest
 * (dimension ⑨). Relation and order values are ALSO recorded as
 * structured evidence fields so the Phase 4.3 verifier can produce
 * targeted relation/order diagnostics.
 *
 * `finalize()` is exact-once and returns a deep-frozen snapshot.
 *
 * Main-only. Never expose over IPC/preload/renderer (shared wire surface
 * is untouched).
 */

import type {
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicData,
  TopicSegmentData
} from '@main/services/chatDb/domain/types'

import type { ImportEntityName } from '../importDataPlane'
import { digestBlock, digestFileReference, digestMessage, digestSegment, digestTopic } from './entityFraming'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SourceManifestErrorCode = 'FINALIZED' | 'DUPLICATE_EVIDENCE'

/** Rejection raised by the manifest builder. Carries IDs only — no content. */
export class SourceManifestError extends Error {
  readonly code: SourceManifestErrorCode

  constructor(code: SourceManifestErrorCode, detail: string) {
    super(`Source manifest rejection (${code}): ${detail}`)
    this.name = 'SourceManifestError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Evidence entry types
// ---------------------------------------------------------------------------

/** Per-topic evidence: canonical field digest of the projected record. */
export interface TopicEvidence {
  readonly digest: string
  /** Independent digest of the overflow object alone (dimension ⑩). */
  readonly overflowDigest: string
}

/** Per-message evidence: ownership + order + canonical field digest. */
export interface MessageEvidence {
  readonly topicId: string
  readonly sortOrder: number
  readonly digest: string
  /** Independent digest of the overflow object alone (dimension ⑩). */
  readonly overflowDigest: string
  /** Digest of the structured `overflow.model` slot, or null (dimension ⑨). */
  readonly structuredModelDigest: string | null
}

/** Per-block evidence: ownership + order + canonical field digest. */
export interface BlockEvidence {
  readonly messageId: string
  readonly sortOrder: number
  readonly digest: string
  /** Independent digest of the overflow object alone (dimension ⑩). */
  readonly overflowDigest: string
  /** Digest of the structured `overflow.content` slot, or null (dimension ⑨). */
  readonly structuredContentDigest: string | null
}

/** Per-file-reference evidence (derived from projected blocks, LOCK-D5). */
export interface FileReferenceEvidence {
  readonly blockId: string
  readonly digest: string
  /** Independent digest of the overflow object alone (dimension ⑩). */
  readonly overflowDigest: string
}

/** Per-segment evidence: ownership + canonical field digest. */
export interface SegmentEvidence {
  readonly topicId: string
  readonly digest: string
  /** Independent digest of the overflow object alone (dimension ⑩). */
  readonly overflowDigest: string
}

/** One manifest entity section: complete ID set with per-ID evidence. */
export interface ManifestEntitySection<E> {
  readonly count: number
  readonly entries: Readonly<Record<string, E>>
}

/**
 * Finalized source verification manifest (LOCK-4301). Deep-frozen;
 * covers every committed page and nothing else.
 */
export interface SourceVerificationManifest {
  readonly topics: ManifestEntitySection<TopicEvidence>
  readonly messages: ManifestEntitySection<MessageEvidence>
  readonly blocks: ManifestEntitySection<BlockEvidence>
  readonly fileReferences: ManifestEntitySection<FileReferenceEvidence>
  readonly segments: ManifestEntitySection<SegmentEvidence>
  /** Segment memberships: ordered message ID arrays per segment (LOCK-D6). */
  readonly memberships: {
    readonly rowCount: number
    readonly bySegment: Readonly<Record<string, readonly string[]>>
  }
  /** Source `files` pages are count-diagnostic ONLY (LOCK-D7). */
  readonly sourceFiles: { readonly recordCount: number }
  /** Number of successfully committed pages contributing evidence. */
  readonly committedPageCount: number
}

// ---------------------------------------------------------------------------
// Staged input / delta
// ---------------------------------------------------------------------------

/**
 * Target-equivalent projections of one validated page, as staged by the
 * Phase 4.2 data plane BEFORE its DB transaction (LOCK-4301).
 */
export interface StagedPageEvidence {
  readonly entity: ImportEntityName
  readonly topics: readonly TopicData[]
  readonly messages: readonly MessageData[]
  readonly blocks: readonly MessageBlockData[]
  readonly fileReferences: readonly FileReferenceData[]
  readonly segments: readonly TopicSegmentData[]
  readonly memberships: ReadonlyArray<{ readonly segmentId: string; readonly messageIds: readonly string[] }>
  /** Raw source rows in the page (used for `files` diagnostics only). */
  readonly sourceRowCount: number
}

/**
 * Precomputed evidence for one page. Opaque to callers: hold it across the
 * DB transaction and pass to `commitPageDelta()` on success, or drop it.
 */
export interface SourceManifestPageDelta {
  readonly entity: ImportEntityName
  readonly topics: ReadonlyArray<readonly [string, TopicEvidence]>
  readonly messages: ReadonlyArray<readonly [string, MessageEvidence]>
  readonly blocks: ReadonlyArray<readonly [string, BlockEvidence]>
  readonly fileReferences: ReadonlyArray<readonly [string, FileReferenceEvidence]>
  readonly segments: ReadonlyArray<readonly [string, SegmentEvidence]>
  readonly memberships: ReadonlyArray<readonly [string, readonly string[]]>
  readonly sourceFileRecordCount: number
}

// ---------------------------------------------------------------------------
// Evidence construction (LOCK-4302)
//
// All record framing lives in the shared `entityFraming` module (used by
// this builder AND the candidate verifier). Records are framed explicitly
// so every canonical column is PRESENT (null when null); only overflow
// keys can be absent, preserving the absent-vs-null distinction.
// ---------------------------------------------------------------------------

function topicEvidence(t: TopicData): TopicEvidence {
  const d = digestTopic(t)
  return { digest: d.record, overflowDigest: d.overflow }
}

function messageEvidence(m: MessageData): MessageEvidence {
  const d = digestMessage(m)
  return {
    topicId: m.topicId,
    sortOrder: m.sortOrder,
    digest: d.record,
    overflowDigest: d.overflow,
    structuredModelDigest: d.structuredModel
  }
}

function blockEvidence(b: MessageBlockData): BlockEvidence {
  const d = digestBlock(b)
  return {
    messageId: b.messageId,
    sortOrder: b.sortOrder,
    digest: d.record,
    overflowDigest: d.overflow,
    structuredContentDigest: d.structuredContent
  }
}

function fileReferenceEvidence(r: FileReferenceData): FileReferenceEvidence {
  const d = digestFileReference(r)
  return { blockId: r.blockId, digest: d.record, overflowDigest: d.overflow }
}

function segmentEvidence(s: TopicSegmentData): SegmentEvidence {
  const d = digestSegment(s)
  return { topicId: s.topicId, digest: d.record, overflowDigest: d.overflow }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Streaming manifest builder. One instance per import session, owned by
 * the data plane. Stage before the page transaction, commit after it.
 */
export class SourceVerificationManifestBuilder {
  private readonly topics = new Map<string, TopicEvidence>()
  private readonly messages = new Map<string, MessageEvidence>()
  private readonly blocks = new Map<string, BlockEvidence>()
  private readonly fileReferences = new Map<string, FileReferenceEvidence>()
  private readonly segments = new Map<string, SegmentEvidence>()
  private readonly membershipsBySegment = new Map<string, readonly string[]>()
  private membershipRowCount = 0
  private sourceFileRecordCount = 0
  private committedPageCount = 0
  private finalized = false

  /**
   * Compute the evidence delta for one staged page. Pure — does not touch
   * builder state, so a failed DB transaction simply drops the delta.
   *
   * @throws {CanonicalizationError} if a projected record is not JSON-safe.
   */
  stagePageDelta(staged: StagedPageEvidence): SourceManifestPageDelta {
    return {
      entity: staged.entity,
      topics: staged.topics.map((t) => [t.id, topicEvidence(t)] as const),
      messages: staged.messages.map((m) => [m.id, messageEvidence(m)] as const),
      blocks: staged.blocks.map((b) => [b.id, blockEvidence(b)] as const),
      fileReferences: staged.fileReferences.map((r) => [r.id, fileReferenceEvidence(r)] as const),
      segments: staged.segments.map((s) => [s.id, segmentEvidence(s)] as const),
      memberships: staged.memberships.map((m) => [m.segmentId, [...m.messageIds]] as const),
      sourceFileRecordCount: staged.entity === 'files' ? staged.sourceRowCount : 0
    }
  }

  /**
   * Merge a staged delta into the manifest. Call ONLY after the page's DB
   * transaction committed (LOCK-4301).
   *
   * @throws {SourceManifestError} after finalize, or on duplicate evidence
   *         (defensive — the data plane already guarantees uniqueness).
   */
  commitPageDelta(delta: SourceManifestPageDelta): void {
    if (this.finalized) {
      throw new SourceManifestError('FINALIZED', 'commitPageDelta called after finalize()')
    }
    this.mergeUnique(this.topics, delta.topics, 'topics')
    this.mergeUnique(this.messages, delta.messages, 'messages')
    this.mergeUnique(this.blocks, delta.blocks, 'blocks')
    this.mergeUnique(this.fileReferences, delta.fileReferences, 'file_references')
    this.mergeUnique(this.segments, delta.segments, 'segments')
    this.mergeUnique(this.membershipsBySegment, delta.memberships, 'memberships')
    for (const [, messageIds] of delta.memberships) {
      this.membershipRowCount += messageIds.length
    }
    this.sourceFileRecordCount += delta.sourceFileRecordCount
    this.committedPageCount += 1
  }

  /**
   * Produce the deep-frozen manifest. Exact-once: a second call throws,
   * and no further deltas can be committed afterwards.
   */
  finalize(): SourceVerificationManifest {
    if (this.finalized) {
      throw new SourceManifestError('FINALIZED', 'finalize() called more than once')
    }
    this.finalized = true

    const manifest: SourceVerificationManifest = {
      topics: freezeSection(this.topics),
      messages: freezeSection(this.messages),
      blocks: freezeSection(this.blocks),
      fileReferences: freezeSection(this.fileReferences),
      segments: freezeSection(this.segments),
      memberships: Object.freeze({
        rowCount: this.membershipRowCount,
        bySegment: freezeRecord(this.membershipsBySegment, (ids) => Object.freeze([...ids]))
      }),
      sourceFiles: Object.freeze({ recordCount: this.sourceFileRecordCount }),
      committedPageCount: this.committedPageCount
    }
    return Object.freeze(manifest)
  }

  private mergeUnique<V>(target: Map<string, V>, entries: ReadonlyArray<readonly [string, V]>, entity: string): void {
    for (const [id, evidence] of entries) {
      if (target.has(id)) {
        throw new SourceManifestError('DUPLICATE_EVIDENCE', `duplicate ${entity} evidence for id '${id}'`)
      }
      target.set(id, evidence)
    }
  }
}

// ---------------------------------------------------------------------------
// Freezing helpers
// ---------------------------------------------------------------------------

function freezeSection<E>(source: Map<string, E>): ManifestEntitySection<E> {
  return Object.freeze({
    count: source.size,
    entries: freezeRecord(source, (evidence) => Object.freeze({ ...evidence }))
  })
}

function freezeRecord<V, F>(source: Map<string, V>, freezeValue: (value: V) => F): Readonly<Record<string, F>> {
  const record: Record<string, F> = Object.create(null)
  for (const [id, value] of source) {
    record[id] = freezeValue(value)
  }
  return Object.freeze(record)
}
