/**
 * Standalone topic JSON data exchange — export builder, import validation,
 * and import planning for ONE ENTIRE logical topic.
 *
 * Scope:
 * - Export builds a versioned payload from Main SQLite domain rows (main
 *   route plus ALL branches) using the existing domain serializers, so wire
 *   values never contradict stored rows. Identity/scope columns (topic id,
 *   assistant bindings, deletedAt) are stripped; attachment payloads, the
 *   Dexie file catalog, and credentials are never included.
 * - Import deep-validates the untrusted payload (format marker, schema
 *   version, unique IDs, referential links, branch parent cycles, anchor
 *   owner relationships) BEFORE any write, allocates fresh IDs for the new
 *   topic/messages/blocks/branches/segments/file references, and remaps
 *   every internal reference (askId, anchorMessageId, branch parents,
 *   segment membership, block parents) while preserving attachment
 *   identities (fileId), order, timestamps, and opaque overflow data.
 * - A dangling branch anchor preserves the existing valid missing-anchor
 *   state (BRANCH-5 fail-closed resolution); it is never auto-repaired.
 *   Every other dangling reference fails validation with zero writes.
 *
 * No schema migration, no new subsystem: writes go through the existing
 * import seam (ChatImportWriter) plus one direct branch-row insert.
 */

import { randomUUID } from 'node:crypto'

import type {
  FileReferenceWire,
  JsonObject,
  SegmentWire,
  TopicDataExportBlock,
  TopicDataExportBranch,
  TopicDataExportFileReference,
  TopicDataExportMessage,
  TopicDataExportPayload,
  TopicDataExportSegment,
  TopicDataExportTopic
} from '@shared/chatDb'

import type {
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicBranchData,
  TopicData,
  TopicSegmentData
} from './domain/types'
import { ChatDbValidationError } from './errors'
import { L2_TRASH_RETENTION_MARKER } from './trashRetention'
import { blockToWire, fileReferenceToWire, messageToWire, segmentToWire, topicToWireFull } from './wireAdapters'

/** Format marker for standalone topic JSON files. Never renamed. */
export const TOPIC_DATA_FORMAT = 'cherry-chat-topic-data' as const

/** Schema version for standalone topic JSON files. Unsupported versions fail before writes. */
export const TOPIC_DATA_VERSION = 1 as const

const TOPIC_DATA_PAYLOAD_KEYS = new Set([
  'format',
  'version',
  'exportedAt',
  'topic',
  'messages',
  'blocks',
  'branches',
  'segments',
  'fileReferences'
])

// ---------------------------------------------------------------------------
// Export builder (Main domain rows → versioned payload)
// ---------------------------------------------------------------------------

export interface TopicDataExportInput {
  topic: TopicData
  /** ALL owned messages across main + every branch (authority order). */
  messages: MessageData[]
  /** Blocks keyed by owning message id (authority order per message). */
  blocksByMessage: Map<string, MessageBlockData[]>
  /** ALL branch nodes of the logical topic. */
  branches: TopicBranchData[]
  /** Segments with their ordered membership message ids. */
  segments: Array<{ segment: TopicSegmentData; messageIds: string[] }>
  /** File-reference rows for the exported blocks. */
  fileReferences: FileReferenceData[]
  exportedAt: string
}

function stripKeys(wire: JsonObject, keys: ReadonlySet<string>): JsonObject {
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(wire)) {
    if (!keys.has(key)) out[key] = value
  }
  return out
}

const TOPIC_STRIP_KEYS = new Set(['id', 'assistantId', 'deletedAt'])
const MESSAGE_STRIP_KEYS = new Set(['topicId', 'assistantId'])
const SEGMENT_STRIP_KEYS = new Set(['topicId', 'firstMessageId', 'lastMessageId', 'messageCount'])

/**
 * Build the versioned export payload from authoritative domain rows.
 * Pure construction (no I/O); the caller owns the read transaction.
 */
export function buildTopicDataExport(input: TopicDataExportInput): TopicDataExportPayload {
  const topicWire = stripKeys(topicToWireFull(input.topic), TOPIC_STRIP_KEYS) as TopicDataExportTopic

  const messages = input.messages.map(
    (message) => stripKeys(messageToWire(message), MESSAGE_STRIP_KEYS) as TopicDataExportMessage
  )

  const blocks: TopicDataExportBlock[] = []
  for (const message of input.messages) {
    for (const block of input.blocksByMessage.get(message.id) ?? []) {
      blocks.push(blockToWire(block) as TopicDataExportBlock)
    }
  }

  const branches = input.branches.map((branch) => {
    const wire = {
      ...branch.overflow,
      id: branch.id,
      parentBranchId: branch.parentBranchId,
      anchorMessageId: branch.anchorMessageId,
      name: branch.name,
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt
    } as TopicDataExportBranch
    return wire
  })

  const segments = input.segments.map(({ segment, messageIds }) => {
    const wire = segmentToWire(segment, messageIds) as SegmentWire & JsonObject
    return {
      ...segment.overflow,
      ...stripKeys(wire, SEGMENT_STRIP_KEYS)
    } as TopicDataExportSegment
  })

  const fileReferences = input.fileReferences.map((ref) => {
    const wire = fileReferenceToWire(ref) as FileReferenceWire & JsonObject
    return { ...ref.overflow, ...wire } as TopicDataExportFileReference
  })

  return {
    format: TOPIC_DATA_FORMAT,
    version: TOPIC_DATA_VERSION,
    exportedAt: input.exportedAt,
    topic: topicWire,
    messages,
    blocks,
    branches,
    segments,
    fileReferences
  }
}

// ---------------------------------------------------------------------------
// Import validation (untrusted payload → normalized records)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function fail(path: string, reason: string): never {
  throw new ChatDbValidationError(`Invalid topic data at ${path}: ${reason}`)
}

function reqObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, 'expected a plain object')
  return value
}

function reqArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  return value as unknown[]
}

function reqNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string')
  return value
}

function reqNullOrString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') fail(path, 'expected a string or null')
  return value
}

function reqNullOrNonEmptyString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null
  return reqNonEmptyString(value, path)
}

function reqSortOrder(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(path, 'expected a non-negative integer sortOrder')
  }
  return value
}

function reqNullOrNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number or null')
  return value
}

/**
 * Split a validated entity record into known columns plus opaque overflow.
 * A present `overflow` key must be a plain object (merged in) or the
 * record is rejected; every other unknown key is preserved verbatim.
 */
function splitOverflow(
  record: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  path: string
): Record<string, unknown> {
  const overflow: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (knownKeys.has(key)) continue
    if (key === 'overflow') {
      if (!isPlainObject(value)) fail(path, 'expected "overflow" to be a plain object')
      Object.assign(overflow, value)
      continue
    }
    overflow[key] = value
  }
  return overflow
}

const TOPIC_KNOWN_KEYS = new Set(['name', 'createdAt', 'updatedAt'])
const MESSAGE_KNOWN_KEYS = new Set([
  'id',
  'branchId',
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'createdAt',
  'updatedAt',
  'sortOrder'
])
const BLOCK_KNOWN_KEYS = new Set([
  'id',
  'messageId',
  'type',
  'content',
  'status',
  'createdAt',
  'updatedAt',
  'sortOrder'
])
const BRANCH_KNOWN_KEYS = new Set(['id', 'parentBranchId', 'anchorMessageId', 'name', 'createdAt', 'updatedAt'])
const SEGMENT_KNOWN_KEYS = new Set(['id', 'name', 'messageIds', 'createdAt', 'updatedAt', 'sortOrder'])
const FILE_REF_KNOWN_KEYS = new Set(['id', 'blockId', 'fileId', 'fileName', 'filePath', 'fileType', 'count'])

export interface ValidatedTopicDataImport {
  topic: { name: string | null; createdAt: string | null; updatedAt: string | null; overflow: Record<string, unknown> }
  messages: Array<Record<string, unknown> & { id: string }>
  blocks: Array<Record<string, unknown> & { id: string }>
  branches: Array<Record<string, unknown> & { id: string }>
  segments: Array<Record<string, unknown> & { id: string }>
  fileReferences: Array<Record<string, unknown> & { id: string }>
}

/**
 * Deep-validate the untrusted standalone payload. Throws
 * ChatDbValidationError on the first defect; writes never start.
 */
export function validateTopicDataImport(payload: unknown): ValidatedTopicDataImport {
  const root = reqObject(payload, 'payload')
  for (const key of Object.keys(root)) {
    if (!TOPIC_DATA_PAYLOAD_KEYS.has(key)) fail('payload', `unknown key "${key}"`)
  }
  if (root.format !== TOPIC_DATA_FORMAT) fail('payload.format', `expected format "${TOPIC_DATA_FORMAT}"`)
  if (root.version !== TOPIC_DATA_VERSION) {
    throw new ChatDbValidationError(
      `Unsupported topic data version: expected ${TOPIC_DATA_VERSION}, received ${String(root.version)}`
    )
  }

  const topicRecord = reqObject(root.topic, 'payload.topic')
  const topic = {
    name: reqNullOrString(topicRecord.name, 'payload.topic.name'),
    createdAt: reqNullOrString(topicRecord.createdAt, 'payload.topic.createdAt'),
    updatedAt: reqNullOrString(topicRecord.updatedAt, 'payload.topic.updatedAt'),
    overflow: splitOverflow(topicRecord, TOPIC_KNOWN_KEYS, 'payload.topic')
  }

  const rawMessages = reqArray(root.messages, 'payload.messages')
  const rawBlocks = reqArray(root.blocks, 'payload.blocks')
  const rawBranches = reqArray(root.branches, 'payload.branches')
  const rawSegments = reqArray(root.segments, 'payload.segments')
  const rawFileRefs = reqArray(root.fileReferences, 'payload.fileReferences')

  const messages = rawMessages.map((entry, index) => {
    const record = reqObject(entry, `payload.messages[${index}]`)
    const id = reqNonEmptyString(record.id, `payload.messages[${index}].id`)
    const branchId = reqNullOrNonEmptyString(record.branchId, `payload.messages[${index}].branchId`)
    reqNullOrString(record.role, `payload.messages[${index}].role`)
    reqNullOrString(record.content, `payload.messages[${index}].content`)
    reqNullOrString(record.status, `payload.messages[${index}].status`)
    reqNullOrString(record.askId, `payload.messages[${index}].askId`)
    reqNullOrString(record.modelId, `payload.messages[${index}].modelId`)
    reqNullOrString(record.createdAt, `payload.messages[${index}].createdAt`)
    reqNullOrString(record.updatedAt, `payload.messages[${index}].updatedAt`)
    reqSortOrder(record.sortOrder, `payload.messages[${index}].sortOrder`)
    // `model` may be a scalar or a structured object (overflow round-trip).
    const model = record.model
    if (model !== null && model !== undefined && typeof model !== 'string' && !isPlainObject(model)) {
      fail(`payload.messages[${index}].model`, 'expected a string, structured object, or null')
    }
    return { ...record, id, branchId } as Record<string, unknown> & { id: string }
  })

  const blocks = rawBlocks.map((entry, index) => {
    const record = reqObject(entry, `payload.blocks[${index}]`)
    const id = reqNonEmptyString(record.id, `payload.blocks[${index}].id`)
    reqNonEmptyString(record.messageId, `payload.blocks[${index}].messageId`)
    reqNullOrString(record.type, `payload.blocks[${index}].type`)
    reqNullOrString(record.status, `payload.blocks[${index}].status`)
    reqNullOrString(record.createdAt, `payload.blocks[${index}].createdAt`)
    reqNullOrString(record.updatedAt, `payload.blocks[${index}].updatedAt`)
    reqSortOrder(record.sortOrder, `payload.blocks[${index}].sortOrder`)
    // `content` may be scalar or structured (e.g. tool results live in overflow).
    const content = record.content
    if (content !== null && content !== undefined && typeof content !== 'string' && !isPlainObject(content)) {
      if (!Array.isArray(content)) fail(`payload.blocks[${index}].content`, 'expected scalar, object, or null content')
    }
    return { ...record, id } as Record<string, unknown> & { id: string }
  })

  const branches = rawBranches.map((entry, index) => {
    const record = reqObject(entry, `payload.branches[${index}]`)
    const id = reqNonEmptyString(record.id, `payload.branches[${index}].id`)
    const parentBranchId = reqNullOrNonEmptyString(record.parentBranchId, `payload.branches[${index}].parentBranchId`)
    reqNonEmptyString(record.anchorMessageId, `payload.branches[${index}].anchorMessageId`)
    reqNullOrString(record.name, `payload.branches[${index}].name`)
    reqNullOrString(record.createdAt, `payload.branches[${index}].createdAt`)
    reqNullOrString(record.updatedAt, `payload.branches[${index}].updatedAt`)
    return { ...record, id, parentBranchId } as Record<string, unknown> & { id: string }
  })

  const segments = rawSegments.map((entry, index) => {
    const record = reqObject(entry, `payload.segments[${index}]`)
    const id = reqNonEmptyString(record.id, `payload.segments[${index}].id`)
    reqNullOrString(record.name, `payload.segments[${index}].name`)
    reqNullOrString(record.createdAt, `payload.segments[${index}].createdAt`)
    reqNullOrString(record.updatedAt, `payload.segments[${index}].updatedAt`)
    reqSortOrder(record.sortOrder, `payload.segments[${index}].sortOrder`)
    const messageIds = reqArray(record.messageIds, `payload.segments[${index}].messageIds`)
    messageIds.forEach((messageId, memberIndex) =>
      reqNonEmptyString(messageId, `payload.segments[${index}].messageIds[${memberIndex}]`)
    )
    return { ...record, id } as Record<string, unknown> & { id: string }
  })

  const fileReferences = rawFileRefs.map((entry, index) => {
    const record = reqObject(entry, `payload.fileReferences[${index}]`)
    const id = reqNonEmptyString(record.id, `payload.fileReferences[${index}].id`)
    reqNonEmptyString(record.blockId, `payload.fileReferences[${index}].blockId`)
    reqNonEmptyString(record.fileId, `payload.fileReferences[${index}].fileId`)
    reqNullOrString(record.fileName, `payload.fileReferences[${index}].fileName`)
    reqNullOrString(record.filePath, `payload.fileReferences[${index}].filePath`)
    reqNullOrString(record.fileType, `payload.fileReferences[${index}].fileType`)
    reqNullOrNumber(record.count, `payload.fileReferences[${index}].count`)
    return { ...record, id } as Record<string, unknown> & { id: string }
  })

  // Unique entity IDs per collection.
  const requireUnique = (items: Array<{ id: string }>, path: string): void => {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.id)) fail(path, `duplicate id "${item.id}"`)
      seen.add(item.id)
    }
  }
  requireUnique(messages, 'payload.messages')
  requireUnique(blocks, 'payload.blocks')
  requireUnique(branches, 'payload.branches')
  requireUnique(segments, 'payload.segments')
  requireUnique(fileReferences, 'payload.fileReferences')

  const messageIds = new Set(messages.map((message) => message.id))
  const messageOwner = new Map<string, string | null>(
    messages.map((message) => [message.id, (message.branchId as string | null) ?? null])
  )
  const blockIds = new Set(blocks.map((block) => block.id))
  const branchIds = new Set(branches.map((branch) => branch.id))

  // F2: the Main-only L2 trash-retention marker never crosses the export
  // wire (export strips it) and must never be accepted back from untrusted
  // import overflow — rejection, never silent stripping, so a hostile file
  // cannot extend trash retention.
  if (L2_TRASH_RETENTION_MARKER in topic.overflow) {
    fail('payload.topic', `Main-only "${L2_TRASH_RETENTION_MARKER}" must not be present`)
  }

  // F3: narrow typed-overflow guards for the only overflow keys with a
  // shared typed wire contract. Topic `pinned`/`isNameManuallyEdited` are
  // boolean|null and `prompt` is string|null (update-topic-metadata /
  // TopicWire); segment `color` is string|null (SegmentWire). Every other
  // overflow key — including local-only `foldSelected`/`useful` which have
  // no shared wire validation — stays opaque and is preserved verbatim.
  const topicOverflow = topic.overflow
  if ('pinned' in topicOverflow) {
    const value = topicOverflow.pinned
    if (value !== null && value !== undefined && typeof value !== 'boolean') {
      fail('payload.topic', 'expected boolean|null for "pinned"')
    }
  }
  if ('isNameManuallyEdited' in topicOverflow) {
    const value = topicOverflow.isNameManuallyEdited
    if (value !== null && value !== undefined && typeof value !== 'boolean') {
      fail('payload.topic', 'expected boolean|null for "isNameManuallyEdited"')
    }
  }
  if ('prompt' in topicOverflow) {
    const value = topicOverflow.prompt
    if (value !== null && value !== undefined && typeof value !== 'string') {
      fail('payload.topic', 'expected string|null for "prompt"')
    }
  }
  for (const [index, segment] of segments.entries()) {
    const overflow = splitOverflow(segment as Record<string, unknown>, SEGMENT_KNOWN_KEYS, `payload.segments[${index}]`)
    if ('color' in overflow) {
      const value = overflow.color
      if (value !== null && value !== undefined && typeof value !== 'string') {
        fail(`payload.segments[${index}]`, 'expected string|null for "color"')
      }
    }
  }

  // F1: every non-null message owner must resolve to an exported branch.
  // Without this, `branchIdMap.get(unknown)` yields undefined and the plan
  // silently coerces it to main-route NULL.
  for (const [index, message] of messages.entries()) {
    const branchId = (message.branchId as string | null) ?? null
    if (branchId !== null && !branchIds.has(branchId)) {
      fail(`payload.messages[${index}].branchId`, `unknown branch "${branchId}"`)
    }
  }

  // F4: duplicate ordering keys within one ordering scope would tie-break
  // by fresh random UUID on import (sort_order ASC, id ASC) and silently
  // reorder. Sparse gaps are legal and preserved verbatim; only duplicates
  // fail. Scopes match the repositories: messages per route owner
  // (topic + branch), blocks per parent message, segments per topic.
  // Segment memberships keep payload array order (writer assigns index) and
  // file references carry no ordering key (schema orders by id), so neither
  // is reordered here.
  {
    const seenByOwner = new Map<string, Set<number>>()
    for (const [index, message] of messages.entries()) {
      const owner = (message.branchId as string | null) ?? null
      const ownerKey = owner === null ? 'main' : owner
      const order = message.sortOrder as number
      let seen = seenByOwner.get(ownerKey)
      if (!seen) {
        seen = new Set<number>()
        seenByOwner.set(ownerKey, seen)
      }
      if (seen.has(order)) {
        fail(`payload.messages[${index}].sortOrder`, `duplicate sortOrder ${String(order)} in the same route`)
      }
      seen.add(order)
    }
  }
  {
    const seenByMessage = new Map<string, Set<number>>()
    for (const [index, block] of blocks.entries()) {
      const parent = block.messageId as string
      const order = block.sortOrder as number
      let seen = seenByMessage.get(parent)
      if (!seen) {
        seen = new Set<number>()
        seenByMessage.set(parent, seen)
      }
      if (seen.has(order)) {
        fail(`payload.blocks[${index}].sortOrder`, `duplicate sortOrder ${String(order)} in message "${parent}"`)
      }
      seen.add(order)
    }
  }
  {
    const seenSegmentOrders = new Set<number>()
    for (const [index, segment] of segments.entries()) {
      const order = segment.sortOrder as number
      if (seenSegmentOrders.has(order)) {
        fail(`payload.segments[${index}].sortOrder`, `duplicate sortOrder ${String(order)} in the same topic`)
      }
      seenSegmentOrders.add(order)
    }
  }

  // Referential links: blocks, segments, and file references must resolve.
  // Branch anchors may dangle (preserved missing-anchor state, BRANCH-5).
  for (const [index, block] of blocks.entries()) {
    if (!messageIds.has(block.messageId as string)) {
      fail(`payload.blocks[${index}].messageId`, `unknown message "${String(block.messageId)}"`)
    }
  }
  for (const branch of branches) {
    const parentBranchId = branch.parentBranchId as string | null
    if (parentBranchId !== null && !branchIds.has(parentBranchId)) {
      fail('payload.branches', `branch "${branch.id}" references unknown parent "${parentBranchId}"`)
    }
  }
  // Branch parent cycles fail closed.
  for (const branch of branches) {
    const seen = new Set<string>([branch.id])
    let current = branch.parentBranchId as string | null
    while (current !== null) {
      if (seen.has(current)) fail('payload.branches', `parent cycle through branch "${current}"`)
      seen.add(current)
      const parent = branches.find((candidate) => candidate.id === current)
      current = (parent?.parentBranchId as string | null) ?? null
    }
  }
  // Anchor owner relationships per existing invariants (BRANCH-7 owner-only
  // anchors): a resolvable anchor must be owned by the parent route
  // (main parent = main-owned anchor). Missing anchors are preserved as-is.
  for (const branch of branches) {
    const anchorId = branch.anchorMessageId as string
    if (!messageIds.has(anchorId)) continue
    const parentBranchId = branch.parentBranchId as string | null
    const anchorOwner = messageOwner.get(anchorId) ?? null
    if (anchorOwner !== parentBranchId) {
      fail('payload.branches', `branch "${branch.id}" anchor "${anchorId}" is not owned by the parent route (BRANCH-7)`)
    }
  }
  for (const [index, segment] of segments.entries()) {
    const memberIds = segment.messageIds as string[]
    const seen = new Set<string>()
    for (const [memberIndex, messageId] of memberIds.entries()) {
      if (!messageIds.has(messageId)) {
        fail(`payload.segments[${index}].messageIds[${memberIndex}]`, `unknown message "${messageId}"`)
      }
      if (seen.has(messageId)) {
        fail(`payload.segments[${index}].messageIds[${memberIndex}]`, `duplicate message "${messageId}"`)
      }
      seen.add(messageId)
    }
  }
  for (const [index, ref] of fileReferences.entries()) {
    if (!blockIds.has(ref.blockId as string)) {
      fail(`payload.fileReferences[${index}].blockId`, `unknown block "${String(ref.blockId)}"`)
    }
  }

  return { topic, messages, blocks, branches, segments, fileReferences }
}

// ---------------------------------------------------------------------------
// Import planning (validated records → fresh domain rows with remapped refs)
// ---------------------------------------------------------------------------

export interface PlannedTopicDataImport {
  topic: TopicData
  messages: MessageData[]
  blocks: MessageBlockData[]
  branches: TopicBranchData[]
  segments: TopicSegmentData[]
  /** Complete ordered membership per (fresh) segment id. */
  memberships: Array<{ segmentId: string; messageIds: string[] }>
  fileReferences: FileReferenceData[]
}

/**
 * Allocate fresh IDs and remap every internal reference. Pure planning
 * (no I/O); the caller inserts the plan in one transaction.
 *
 * - Topic + necessary message assistant bindings go to `targetAssistantId`;
 *   the source assistant is never required.
 * - `askId` values that reference an imported message are remapped;
 *   opaque/orphan keys are preserved verbatim.
 * - Dangling branch anchors keep their source id verbatim (missing-anchor
 *   state is preserved, never repaired).
 * - Attachment identities (`fileId`) and index metadata are preserved
 *   verbatim; order, timestamps, and overflow survive unchanged.
 */
export function planTopicDataImport(
  validated: ValidatedTopicDataImport,
  targetAssistantId: string,
  nowIso: string
): PlannedTopicDataImport {
  const newTopicId = randomUUID()

  const messageIdMap = new Map<string, string>()
  for (const message of validated.messages) messageIdMap.set(message.id, randomUUID())
  const blockIdMap = new Map<string, string>()
  for (const block of validated.blocks) blockIdMap.set(block.id, randomUUID())
  const branchIdMap = new Map<string, string>()
  for (const branch of validated.branches) branchIdMap.set(branch.id, randomUUID())
  const segmentIdMap = new Map<string, string>()
  for (const segment of validated.segments) segmentIdMap.set(segment.id, randomUUID())

  const topic: TopicData = {
    id: newTopicId,
    assistantId: targetAssistantId,
    name: validated.topic.name,
    createdAt: validated.topic.createdAt ?? nowIso,
    updatedAt: validated.topic.updatedAt ?? nowIso,
    deletedAt: null,
    overflow: { ...validated.topic.overflow }
  }

  const messages: MessageData[] = validated.messages.map((record) => {
    const oldBranchId = (record.branchId as string | null) ?? null
    const oldAskId = (record.askId as string | null) ?? null
    // Structured model objects round-trip through overflow (wireToMessage
    // semantics): a non-string model is preserved opaquely with a null column.
    const rawModel = record.model
    const structuredModel = rawModel !== null && rawModel !== undefined && typeof rawModel !== 'string'
    return {
      id: messageIdMap.get(record.id)!,
      topicId: newTopicId,
      branchId: oldBranchId === null ? null : branchIdMap.get(oldBranchId)!,
      role: (record.role as string | null) ?? null,
      content: (record.content as string | null) ?? null,
      status: (record.status as string | null) ?? null,
      askId: oldAskId !== null && messageIdMap.has(oldAskId) ? messageIdMap.get(oldAskId)! : oldAskId,
      model: structuredModel ? null : ((rawModel as string | null) ?? null),
      modelId: (record.modelId as string | null) ?? null,
      assistantId: targetAssistantId,
      createdAt: (record.createdAt as string | null) ?? null,
      updatedAt: (record.updatedAt as string | null) ?? null,
      sortOrder: record.sortOrder as number,
      overflow: {
        ...splitOverflow(record, MESSAGE_KNOWN_KEYS, 'payload.messages'),
        ...(structuredModel ? { model: rawModel } : {})
      }
    }
  })

  const blocks: MessageBlockData[] = validated.blocks.map((record) => {
    const content = record.content
    const structured = content !== null && content !== undefined && typeof content !== 'string'
    return {
      id: blockIdMap.get(record.id)!,
      messageId: messageIdMap.get(record.messageId as string)!,
      type: (record.type as string | null) ?? null,
      content: structured ? null : ((content as string | null) ?? null),
      status: (record.status as string | null) ?? null,
      createdAt: (record.createdAt as string | null) ?? null,
      updatedAt: (record.updatedAt as string | null) ?? null,
      sortOrder: record.sortOrder as number,
      overflow: {
        ...splitOverflow(record, BLOCK_KNOWN_KEYS, 'payload.blocks'),
        ...(structured ? { content } : {})
      }
    }
  })

  const branches: TopicBranchData[] = validated.branches.map((record) => {
    const oldAnchor = record.anchorMessageId as string
    return {
      id: branchIdMap.get(record.id)!,
      topicId: newTopicId,
      parentBranchId:
        (record.parentBranchId as string | null) === null ? null : branchIdMap.get(record.parentBranchId as string)!,
      anchorMessageId: messageIdMap.has(oldAnchor) ? messageIdMap.get(oldAnchor)! : oldAnchor,
      name: (record.name as string | null) ?? null,
      createdAt: (record.createdAt as string | null) ?? null,
      updatedAt: (record.updatedAt as string | null) ?? null,
      overflow: splitOverflow(record, BRANCH_KNOWN_KEYS, 'payload.branches')
    }
  })

  const segments: TopicSegmentData[] = []
  const memberships: Array<{ segmentId: string; messageIds: string[] }> = []
  for (const record of validated.segments) {
    const freshId = segmentIdMap.get(record.id)!
    segments.push({
      id: freshId,
      topicId: newTopicId,
      name: (record.name as string | null) ?? null,
      createdAt: (record.createdAt as string | null) ?? null,
      updatedAt: (record.updatedAt as string | null) ?? null,
      sortOrder: record.sortOrder as number,
      overflow: splitOverflow(record, SEGMENT_KNOWN_KEYS, 'payload.segments')
    })
    memberships.push({
      segmentId: freshId,
      messageIds: (record.messageIds as string[]).map((messageId) => messageIdMap.get(messageId)!)
    })
  }

  const fileReferences: FileReferenceData[] = validated.fileReferences.map((record) => ({
    id: randomUUID(),
    blockId: blockIdMap.get(record.blockId as string)!,
    fileId: record.fileId as string,
    fileName: (record.fileName as string | null) ?? null,
    filePath: (record.filePath as string | null) ?? null,
    fileType: (record.fileType as string | null) ?? null,
    count: (record.count as number | null) ?? null,
    overflow: splitOverflow(record, FILE_REF_KNOWN_KEYS, 'payload.fileReferences')
  }))

  return { topic, messages, blocks, branches, segments, memberships, fileReferences }
}
