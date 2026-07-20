/**
 * Wire ↔ Domain adapters for ChatDb IPC.
 *
 * Converts between JsonObject wire DTOs and Main persistence domain types.
 *
 * Design rules:
 * - JsonObject maps known fields to domain DTO, unknown keys → overflow.
 * - Domain → JsonObject: overflow keys spread as base, columns overlay.
 * - Nullable semantics preserved: null → null, undefined → omitted.
 * - Renderer Message.blocks (ID array) is reconstructed from DB sort_order.
 * - Tool blocks: object content lives in overflow.content (column content is null).
 * - File reference projection: replaces stale references for file/image blocks.
 * - Unknown JSON extension keys round-trip through overflow.
 */

import type { JsonObject } from '@shared/chatDb'

import { reconstruct, reconstructBlock } from './domain/codec'
import type { FileReferenceData, MessageBlockData, MessageData, TopicData } from './domain/types'

// ---------------------------------------------------------------------------
// Known field sets for mapping
// ---------------------------------------------------------------------------

const TOPIC_FIELDS = new Set(['id', 'assistantId', 'name', 'createdAt', 'updatedAt', 'deletedAt'])
const MESSAGE_FIELDS = new Set([
  'id',
  'topicId',
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt',
  'sortOrder'
])
const BLOCK_FIELDS = new Set(['id', 'messageId', 'type', 'content', 'status', 'createdAt', 'updatedAt', 'sortOrder'])

// ---------------------------------------------------------------------------
// JsonObject → Domain DTO
// ---------------------------------------------------------------------------

/**
 * Convert a JsonObject wire entity to a TopicData domain DTO.
 * Unknown keys are preserved in overflow.
 */
export function wireToTopic(json: JsonObject): TopicData {
  const overflow: Record<string, unknown> = {}
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(json)) {
    if (TOPIC_FIELDS.has(key)) {
      result[key] = value
    } else {
      overflow[key] = value
    }
  }

  return {
    id: result.id as string,
    assistantId: (result.assistantId as string | null) ?? null,
    name: (result.name as string | null) ?? null,
    createdAt: (result.createdAt as string | null) ?? null,
    updatedAt: (result.updatedAt as string | null) ?? null,
    deletedAt: (result.deletedAt as string | null) ?? null,
    overflow
  }
}

/**
 * Convert a JsonObject wire entity to a MessageData domain DTO.
 * Unknown keys are preserved in overflow.
 */
export function wireToMessage(json: JsonObject): MessageData {
  const overflow: Record<string, unknown> = {}
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(json)) {
    if (MESSAGE_FIELDS.has(key)) {
      result[key] = value
    } else {
      overflow[key] = value
    }
  }

  return {
    id: result.id as string,
    topicId: (result.topicId as string) ?? '',
    role: (result.role as string | null) ?? null,
    content: (result.content as string | null) ?? null,
    status: (result.status as string | null) ?? null,
    askId: (result.askId as string | null) ?? null,
    model: (result.model as string | null) ?? null,
    modelId: (result.modelId as string | null) ?? null,
    assistantId: (result.assistantId as string | null) ?? null,
    createdAt: (result.createdAt as string | null) ?? null,
    updatedAt: (result.updatedAt as string | null) ?? null,
    sortOrder: (result.sortOrder as number) ?? 0,
    overflow
  }
}

/**
 * Convert a JsonObject wire entity to a MessageBlockData domain DTO.
 * Unknown keys are preserved in overflow.
 *
 * For tool blocks where the Renderer stores structured object content,
 * the wire `content` field may be an object (not a string). This adapter
 * moves object content to overflow.content and sets column content to null,
 * matching the Main persistence contract.
 */
export function wireToBlock(json: JsonObject): MessageBlockData {
  const overflow: Record<string, unknown> = {}
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(json)) {
    if (BLOCK_FIELDS.has(key)) {
      result[key] = value
    } else {
      overflow[key] = value
    }
  }

  // Handle tool block object content: move to overflow if content is not a string
  let content: string | null = (result.content as string | null) ?? null
  const rawContent = result.content
  if (rawContent !== null && rawContent !== undefined && typeof rawContent !== 'string') {
    // Object/array content → overflow.content, column content → null
    overflow.content = rawContent
    content = null
  }

  return {
    id: result.id as string,
    messageId: (result.messageId as string) ?? '',
    type: (result.type as string | null) ?? null,
    content,
    status: (result.status as string | null) ?? null,
    createdAt: (result.createdAt as string | null) ?? null,
    updatedAt: (result.updatedAt as string | null) ?? null,
    sortOrder: (result.sortOrder as number) ?? 0,
    overflow
  }
}

// ---------------------------------------------------------------------------
// Domain DTO → JsonObject
// ---------------------------------------------------------------------------

/**
 * Convert a TopicData domain DTO to a JsonObject for the wire.
 * Overflow keys are spread as the base, then column values overlay.
 * The `overflow` key itself is excluded from the output.
 */
export function topicToWire(topic: TopicData): JsonObject {
  return reconstruct(topic) as JsonObject
}

/**
 * Convert a MessageData domain DTO to a JsonObject for the wire.
 * Overflow keys are spread as the base, then column values overlay.
 * The `overflow` key itself is excluded from the output.
 */
export function messageToWire(message: MessageData): JsonObject {
  return reconstruct(message) as JsonObject
}

/**
 * Convert a MessageBlockData domain DTO to a JsonObject for the wire.
 * Uses reconstructBlock to handle tool blocks with object content
 * in overflow.content.
 */
export function blockToWire(block: MessageBlockData): JsonObject {
  return reconstructBlock(block) as JsonObject
}

// ---------------------------------------------------------------------------
// Relational message.blocks reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct each message's `blocks` array (ordered block IDs) from the
 * block list. Blocks are grouped by messageId and ordered by sortOrder.
 *
 * This rebuilds the relational `blocks: string[]` field that the Renderer
 * stores on each Message but which is implicit in the DB (sort_order on
 * message_blocks table).
 *
 * @param messages  Messages in sort_order order.
 * @param blocks    All blocks for these messages, in sort_order order.
 * @returns         Messages with `blocks` field set to ordered block ID arrays.
 */
export function reconstructMessageBlockRelations(messages: JsonObject[], blocks: JsonObject[]): JsonObject[] {
  // Group blocks by messageId
  const blocksByMessage = new Map<string, string[]>()
  for (const block of blocks) {
    const messageId = block.messageId as string
    if (!messageId) continue
    if (!blocksByMessage.has(messageId)) {
      blocksByMessage.set(messageId, [])
    }
    blocksByMessage.get(messageId)!.push(block.id as string)
  }

  // Attach blocks array to each message
  return messages.map((msg) => ({
    ...msg,
    blocks: blocksByMessage.get(msg.id as string) ?? []
  }))
}

// ---------------------------------------------------------------------------
// File reference projection
// ---------------------------------------------------------------------------

/** Block types that carry file metadata */
const FILE_BLOCK_TYPES = new Set(['file', 'image'])

/**
 * Project file references from a block's metadata.
 *
 * For file/image blocks, extracts file metadata (id, name, path, type)
 * and returns a FileReferenceData snapshot. For non-file blocks,
 * returns an empty array (no references).
 *
 * Does NOT create canonical files — only block-linked reference snapshots.
 *
 * @param block   The block domain DTO.
 * @returns       Array of FileReferenceData for this block (0 or 1 entries).
 */
export function projectFileReferences(block: MessageBlockData): FileReferenceData[] {
  const blockType = block.type
  if (!blockType || !FILE_BLOCK_TYPES.has(blockType)) {
    return []
  }

  // Extract file metadata from overflow or content
  const fileMeta = extractFileMetadata(block)
  if (!fileMeta) {
    return []
  }

  return [
    {
      id: `fr-${block.id}-${fileMeta.fileId}`,
      blockId: block.id,
      fileId: fileMeta.fileId,
      fileName: fileMeta.fileName ?? null,
      filePath: fileMeta.filePath ?? null,
      fileType: fileMeta.fileType ?? null,
      count: 1,
      overflow: {}
    }
  ]
}

interface FileMetadata {
  fileId: string
  fileName: string | null
  filePath: string | null
  fileType: string | null
}

/**
 * Extract file metadata from a block.
 * Checks overflow.file (Renderer FileMetadata object), overflow fields,
 * and content parsing.
 */
function extractFileMetadata(block: MessageBlockData): FileMetadata | null {
  // Check overflow for file metadata object (Renderer stores FileMetadata in overflow.file)
  const overflowFile = block.overflow.file
  if (overflowFile && typeof overflowFile === 'object' && !Array.isArray(overflowFile)) {
    const file = overflowFile as Record<string, unknown>
    const fileId = file.id ?? file.fileId
    if (typeof fileId === 'string' && fileId.length > 0) {
      return {
        fileId,
        fileName: (file.name as string) ?? (file.fileName as string) ?? null,
        filePath: (file.path as string) ?? (file.filePath as string) ?? null,
        fileType: (file.type as string) ?? (file.fileType as string) ?? null
      }
    }
  }

  // Check overflow for direct file fields
  const fileId = block.overflow.fileId ?? block.overflow.file_id
  if (typeof fileId === 'string' && fileId.length > 0) {
    return {
      fileId,
      fileName: (block.overflow.fileName as string) ?? (block.overflow.file_name as string) ?? null,
      filePath: (block.overflow.filePath as string) ?? (block.overflow.file_path as string) ?? null,
      fileType: (block.overflow.fileType as string) ?? (block.overflow.file_type as string) ?? null
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Batch adapters
// ---------------------------------------------------------------------------

/**
 * Convert an array of JsonObject wire entities to MessageBlockData[].
 */
export function wireToBlocks(jsonArray: JsonObject[]): MessageBlockData[] {
  return jsonArray.map(wireToBlock)
}

/**
 * Convert an array of MessageBlockData to JsonObject[] for the wire.
 */
export function blocksToWire(blocks: MessageBlockData[]): JsonObject[] {
  return blocks.map(blockToWire)
}

/**
 * Convert an array of MessageData to JsonObject[] for the wire.
 */
export function messagesToWire(messages: MessageData[]): JsonObject[] {
  return messages.map(messageToWire)
}

/**
 * Build a partial domain patch from a JsonObject wire patch.
 * Only includes fields present in the input; unknown keys go to overflow.
 * Returns a partial MessageData suitable for repository update methods.
 */
export function wireToMessagePatch(json: JsonObject): Partial<MessageData> & { overflow?: Record<string, unknown> } {
  const patch: Record<string, unknown> = {}
  const overflow: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(json)) {
    if (MESSAGE_FIELDS.has(key)) {
      patch[key] = value
    } else {
      overflow[key] = value
    }
  }

  if (Object.keys(overflow).length > 0) {
    patch.overflow = overflow
  }

  return patch as Partial<MessageData> & { overflow?: Record<string, unknown> }
}

/**
 * Build a partial domain patch from a JsonObject wire patch for blocks.
 * Only includes fields present in the input; unknown keys go to overflow.
 * Handles tool block object content.
 */
export function wireToBlockPatch(json: JsonObject): Partial<MessageBlockData> & { overflow?: Record<string, unknown> } {
  const patch: Record<string, unknown> = {}
  const overflow: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(json)) {
    if (BLOCK_FIELDS.has(key)) {
      patch[key] = value
    } else {
      overflow[key] = value
    }
  }

  // Handle tool block object content
  if (
    'content' in patch &&
    patch.content !== null &&
    patch.content !== undefined &&
    typeof patch.content !== 'string'
  ) {
    overflow.content = patch.content
    patch.content = null
  }

  if (Object.keys(overflow).length > 0) {
    patch.overflow = overflow
  }

  return patch as Partial<MessageBlockData> & { overflow?: Record<string, unknown> }
}
