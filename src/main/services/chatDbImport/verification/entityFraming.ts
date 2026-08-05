/**
 * Shared canonical entity digest framing (LOCK-4302).
 *
 * The single source of truth for how a projected/reconstructed domain
 * record is framed before hashing. Both the source manifest builder
 * (Phase 4.3.1) and the candidate verifier (Phase 4.3.2) call these
 * functions, so the field lists exist exactly once and source/target
 * digests are comparable by construction. Never duplicate these framings.
 *
 * Framing rules:
 * - Every canonical column is explicitly PRESENT (null when null); only
 *   overflow keys can be absent, preserving absent-vs-null end to end.
 * - The projected `overflow` object rides inside the whole-record digest
 *   AND is digested alone so the overflow dimension has independent
 *   evidence (LOCK-4304 dimension ⑩).
 * - Structured JSON slots — message `overflow.model` (structured Model)
 *   and block `overflow.content` (structured tool content) — are digested
 *   independently so structured model/tool integrity has evidence separate
 *   from the whole-record digest (LOCK-4304 dimension ⑨).
 *
 * Hash only explicitly constructed projected records — never raw Dexie
 * objects or raw SQL JSON strings (LOCK-4302).
 *
 * Main-only. Never expose over IPC/preload/renderer.
 */

import { stripBlockAttachmentUnavailableMarker } from '@main/services/chatDb/attachmentAvailability'
import type {
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicData,
  TopicSegmentData
} from '@main/services/chatDb/domain/types'

import { canonicalDigest } from './canonicalJson'

// ---------------------------------------------------------------------------
// Digest evidence fragments
// ---------------------------------------------------------------------------

/** Whole-record + overflow digests shared by every entity. */
export interface EntityDigests {
  /** Canonical digest of the fully framed record (columns + overflow). */
  readonly record: string
  /** Canonical digest of the overflow object alone (dimension ⑩). */
  readonly overflow: string
}

/** Message digests: adds the structured model slot (dimension ⑨). */
export interface MessageDigests extends EntityDigests {
  /** Digest of `overflow.model` when present, else null. */
  readonly structuredModel: string | null
}

/** Block digests: adds the structured tool-content slot (dimension ⑨). */
export interface BlockDigests extends EntityDigests {
  /** Digest of `overflow.content` when present, else null. */
  readonly structuredContent: string | null
}

// ---------------------------------------------------------------------------
// Record framing — every canonical column explicit (LOCK-4302)
// ---------------------------------------------------------------------------

/** Frame a topic record: every canonical column present, null when null. */
export function frameTopicRecord(t: TopicData): Record<string, unknown> {
  return {
    id: t.id,
    assistantId: t.assistantId,
    name: t.name,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    deletedAt: t.deletedAt,
    overflow: t.overflow
  }
}

/** Frame a message record: every canonical column present, null when null. */
export function frameMessageRecord(m: MessageData): Record<string, unknown> {
  return {
    id: m.id,
    topicId: m.topicId,
    role: m.role,
    content: m.content,
    status: m.status,
    askId: m.askId,
    model: m.model,
    modelId: m.modelId,
    assistantId: m.assistantId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    sortOrder: m.sortOrder,
    overflow: m.overflow
  }
}

/**
 * Frame a block record: every canonical column present, null when null.
 *
 * LOCK-UI-6: the importer-owned attachment-unavailable marker (applied to
 * the candidate AFTER the source manifest is built) is deterministically
 * EXCLUDED from the framed overflow — it is not source evidence, so the
 * manifest-side and candidate-side record digests stay comparable.
 */
export function frameBlockRecord(b: MessageBlockData): Record<string, unknown> {
  return {
    id: b.id,
    messageId: b.messageId,
    type: b.type,
    content: b.content,
    status: b.status,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    sortOrder: b.sortOrder,
    overflow: stripBlockAttachmentUnavailableMarker(b.overflow)
  }
}

/** Frame a file-reference record: every canonical column present. */
export function frameFileReferenceRecord(r: FileReferenceData): Record<string, unknown> {
  return {
    id: r.id,
    blockId: r.blockId,
    fileId: r.fileId,
    fileName: r.fileName,
    filePath: r.filePath,
    fileType: r.fileType,
    count: r.count,
    overflow: r.overflow
  }
}

/** Frame a segment record: every canonical column present, null when null. */
export function frameSegmentRecord(s: TopicSegmentData): Record<string, unknown> {
  return {
    id: s.id,
    topicId: s.topicId,
    name: s.name,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    sortOrder: s.sortOrder,
    overflow: s.overflow
  }
}

// ---------------------------------------------------------------------------
// Digest computation — used by manifest builder AND candidate verifier
// ---------------------------------------------------------------------------

/** Compute topic digests (record + overflow). */
export function digestTopic(t: TopicData): EntityDigests {
  return {
    record: canonicalDigest(frameTopicRecord(t)),
    overflow: canonicalDigest(t.overflow)
  }
}

/** Compute message digests (record + overflow + structured model slot). */
export function digestMessage(m: MessageData): MessageDigests {
  return {
    record: canonicalDigest(frameMessageRecord(m)),
    overflow: canonicalDigest(m.overflow),
    structuredModel: 'model' in m.overflow ? canonicalDigest(m.overflow.model) : null
  }
}

/**
 * Compute block digests (record + overflow + structured content slot).
 * LOCK-UI-6: the importer-owned unavailable marker is stripped from both
 * the record and overflow digests (see {@link frameBlockRecord}).
 */
export function digestBlock(b: MessageBlockData): BlockDigests {
  const overflow = stripBlockAttachmentUnavailableMarker(b.overflow)
  return {
    record: canonicalDigest(frameBlockRecord(b)),
    overflow: canonicalDigest(overflow),
    structuredContent: 'content' in b.overflow ? canonicalDigest(b.overflow.content) : null
  }
}

/** Compute file-reference digests (record + overflow). */
export function digestFileReference(r: FileReferenceData): EntityDigests {
  return {
    record: canonicalDigest(frameFileReferenceRecord(r)),
    overflow: canonicalDigest(r.overflow)
  }
}

/** Compute segment digests (record + overflow). */
export function digestSegment(s: TopicSegmentData): EntityDigests {
  return {
    record: canonicalDigest(frameSegmentRecord(s)),
    overflow: canonicalDigest(s.overflow)
  }
}
