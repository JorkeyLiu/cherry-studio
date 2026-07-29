/**
 * Command contract definitions for ChatDb IPC.
 *
 * Maps each IPC channel to:
 * - Allowed request keys (rejects unknown properties).
 * - Runtime validation function for the request payload.
 * - Runtime validation function for the result envelope (ok/fail, command-specific value shape).
 *
 * Design:
 * - Each contract entry is a frozen object with `allowedKeys`, `validate`, and `validateResult`.
 * - Validators call the shared validation functions, enforcing JSON safety,
 *   required fields, type constraints, and result envelope structure.
 * - No Electron, Node, Drizzle, or SQLite imports.
 */

import type {
  AppendMessageRequest,
  BulkAddBlocksRequest,
  ChatDbChannel,
  ClearMessagesRequest,
  ClearTopicWithSegmentsRequest,
  CloneMessagesToTopicRequest,
  CountFileRefsByFileRequest,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteSegmentRequest,
  EmptyTrashTopicsRequest,
  EnsureTopicRequest,
  FetchMessagesRequest,
  GetRawTopicRequest,
  HardDeleteTopicRequest,
  ListBlocksByFileRequest,
  ListFileRefsByFileRequest,
  ListSegmentsRequest,
  ListTrashTopicsRequest,
  PasteMessagesToTopicRequest,
  PurgeExpiredTopicsRequest,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  ResetAssistantTopicsRequest,
  ResetMessagesForResendRequest,
  RestoreTopicRequest,
  SearchMessagesRequest,
  SoftDeleteTopicRequest,
  TopicExistsRequest,
  TransferTopicOwnershipRequest,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSegmentMetadataRequest,
  UpdateSingleBlockRequest,
  UpdateTopicMetadataRequest,
  UpsertSegmentRequest
} from './types'
import {
  validateIdField,
  validateIndex,
  validateIso8601Timestamp,
  validateJsonObject,
  validateJsonObjectArray,
  validateMessageIdField,
  validateNoIdentityFields,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateRequest,
  validateResultEnvelope,
  validateStringArray,
  ValidationError
} from './validation'

// ---------------------------------------------------------------------------
// Contract type
// ---------------------------------------------------------------------------

export interface ChatDbContract {
  /** Allowed top-level request keys. Rejects unknown properties. */
  readonly allowedKeys: ReadonlySet<string>
  /** Runtime validation function for request payloads. Throws ValidationError on failure. */
  readonly validate: (value: unknown) => void
  /** Runtime validation function for result envelopes. Throws ValidationError on failure. */
  readonly validateResult: (value: unknown) => void
}

// ---------------------------------------------------------------------------
// Helper: create a ReadonlySet cheaply
// ---------------------------------------------------------------------------

function keySet(...keys: string[]): ReadonlySet<string> {
  return new Set(keys)
}

// ---------------------------------------------------------------------------
// Result validation helpers
// ---------------------------------------------------------------------------

/**
 * Create a result validator that enforces a null success value (void commands).
 */
function voidResult(channel: string): (result: unknown) => void {
  return (result: unknown): void => {
    validateResultEnvelope(result, channel)
    const obj = result as Record<string, unknown>
    if (obj.ok === true && obj.value !== null) {
      throw new ValidationError('result.value', `[${channel}] Void command result value must be null`)
    }
  }
}

/**
 * Create a result validator that enforces a boolean success value.
 */
function booleanResult(channel: string): (result: unknown) => void {
  return (result: unknown): void => {
    validateResultEnvelope(result, channel)
    const obj = result as Record<string, unknown>
    if (obj.ok === true && typeof obj.value !== 'boolean') {
      throw new ValidationError('result.value', `[${channel}] Expected boolean value, got ${typeof obj.value}`)
    }
  }
}

/**
 * Allowed keys for FetchMessagesResponse success value.
 */
const FETCH_MESSAGES_VALUE_KEYS = new Set(['messages', 'blocks'])

/**
 * Allowed keys for GetRawTopicResponse success value (non-null case).
 */
const GET_RAW_TOPIC_VALUE_KEYS = new Set(['id', 'messages'])

// ---------------------------------------------------------------------------
// Contract definitions — one per ChatDb channel
// ---------------------------------------------------------------------------

const fetchMessagesContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, fetchMessagesContract.allowedKeys)
    const req = value as FetchMessagesRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:fetch-messages')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-messages] Expected object with "messages" and "blocks"'
        )
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_MESSAGES_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:fetch-messages] Unknown key in success value: "${key}"`
          )
        }
      }
      validateJsonObjectArray(v.messages, 'result.value.messages')
      validateJsonObjectArray(v.blocks, 'result.value.blocks')
    }
  }
}

const getRawTopicContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, getRawTopicContract.allowedKeys)
    const req = value as GetRawTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:get-raw-topic')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value !== null) {
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new ValidationError(
            'result.value',
            '[chatdb:get-raw-topic] Expected null or object with "id" and "messages"'
          )
        }
        const v = value as Record<string, unknown>
        for (const key of Object.keys(v)) {
          if (!GET_RAW_TOPIC_VALUE_KEYS.has(key)) {
            throw new ValidationError(
              `result.value.${key}`,
              `[chatdb:get-raw-topic] Unknown key in success value: "${key}"`
            )
          }
        }
        validateNonEmptyString(v.id, 'result.value.id')
        validateJsonObjectArray(v.messages, 'result.value.messages')
      }
    }
  }
}

const topicExistsContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, topicExistsContract.allowedKeys)
    const req = value as TopicExistsRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult: booleanResult('chatdb:topic-exists')
}

const ensureTopicContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'assistantId'),
  validate(value: unknown): void {
    validateRequest(value, ensureTopicContract.allowedKeys)
    const req = value as EnsureTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (req.assistantId !== undefined) {
      validateNonEmptyString(req.assistantId, 'request.assistantId')
    }
  },
  validateResult: voidResult('chatdb:ensure-topic')
}

const appendMessageContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'message', 'blocks', 'insertIndex'),
  validate(value: unknown): void {
    validateRequest(value, appendMessageContract.allowedKeys)
    const req = value as AppendMessageRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateJsonObject(req.message, 'request.message')
    validateIdField(req.message, 'request.message')
    // Validate blocks is a proper array before iteration (prevents TypeError on malformed payloads)
    const blocks = validateJsonObjectArray(req.blocks, 'request.blocks')
    // Validate each block: require id + messageId, check ownership consistency
    for (let i = 0; i < blocks.length; i++) {
      validateIdField(blocks[i], `request.blocks[${i}]`)
      validateMessageIdField(blocks[i], `request.blocks[${i}]`)
      // Ownership consistency: block.messageId must match message.id
      if (req.message.id !== undefined && blocks[i].messageId !== req.message.id) {
        throw new ValidationError(
          `request.blocks[${i}].messageId`,
          `Block messageId "${blocks[i].messageId}" does not match message id "${req.message.id}"`
        )
      }
    }
    if (req.insertIndex !== undefined) {
      validateIndex(req.insertIndex, 'request.insertIndex')
    }
  },
  validateResult: voidResult('chatdb:append-message')
}

const updateMessageContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageId', 'updates'),
  validate(value: unknown): void {
    validateRequest(value, updateMessageContract.allowedKeys)
    const req = value as UpdateMessageRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.messageId, 'request.messageId')
    validateJsonObject(req.updates, 'request.updates')
    // Reject identity/reparenting fields at the shared request boundary
    validateNoIdentityFields(req.updates, new Set(['id', 'topicId', 'sortOrder']), 'request.updates')
  },
  validateResult: voidResult('chatdb:update-message')
}

const updateMessageAndBlocksContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageUpdates', 'blocksToUpdate', 'blockIdsToDelete'),
  validate(value: unknown): void {
    validateRequest(value, updateMessageAndBlocksContract.allowedKeys)
    const req = value as UpdateMessageAndBlocksRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (req.blockIdsToDelete !== undefined) validateStringArray(req.blockIdsToDelete, 'request.blockIdsToDelete')
    validateJsonObject(req.messageUpdates, 'request.messageUpdates')
    validateIdField(req.messageUpdates, 'request.messageUpdates')
    // Reject identity/reparenting fields at the shared request boundary
    validateNoIdentityFields(req.messageUpdates, new Set(['topicId']), 'request.messageUpdates')
    // Validate blocksToUpdate is a proper array before iteration
    const blocks = validateJsonObjectArray(req.blocksToUpdate, 'request.blocksToUpdate')
    for (let i = 0; i < blocks.length; i++) {
      validateIdField(blocks[i], `request.blocksToUpdate[${i}]`)
      validateMessageIdField(blocks[i], `request.blocksToUpdate[${i}]`)
      // Ownership consistency: block.messageId must match messageUpdates.id
      if (blocks[i].messageId !== req.messageUpdates.id) {
        throw new ValidationError(
          `request.blocksToUpdate[${i}].messageId`,
          `Block messageId "${blocks[i].messageId}" does not match message id "${req.messageUpdates.id}"`
        )
      }
    }
  },
  validateResult: fileCleanupResultValidator('chatdb:update-message-and-blocks')
}

const deleteMessageContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageId'),
  validate(value: unknown): void {
    validateRequest(value, deleteMessageContract.allowedKeys)
    const req = value as DeleteMessageRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.messageId, 'request.messageId')
  },
  validateResult: voidResult('chatdb:delete-message')
}

const deleteMessagesContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageIds'),
  validate(value: unknown): void {
    validateRequest(value, deleteMessagesContract.allowedKeys)
    const req = value as DeleteMessagesRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateStringArray(req.messageIds, 'request.messageIds')
  },
  validateResult: voidResult('chatdb:delete-messages')
}

const updateBlocksContract: ChatDbContract = {
  allowedKeys: keySet('blocks'),
  validate(value: unknown): void {
    validateRequest(value, updateBlocksContract.allowedKeys)
    const req = value as UpdateBlocksRequest
    // Validate blocks is a proper array before iteration
    const blocks = validateJsonObjectArray(req.blocks, 'request.blocks')
    // Blocks are full entities: require both id and messageId, reject reparenting
    for (let i = 0; i < blocks.length; i++) {
      validateIdField(blocks[i], `request.blocks[${i}]`)
      validateMessageIdField(blocks[i], `request.blocks[${i}]`)
    }
  },
  validateResult: voidResult('chatdb:update-blocks')
}

const updateSingleBlockContract: ChatDbContract = {
  allowedKeys: keySet('blockId', 'updates'),
  validate(value: unknown): void {
    validateRequest(value, updateSingleBlockContract.allowedKeys)
    const req = value as UpdateSingleBlockRequest
    validateNonEmptyString(req.blockId, 'request.blockId')
    // updates is a partial patch, not a full block — no messageId required
    validateJsonObject(req.updates, 'request.updates')
    // Reject identity/reparenting fields at the shared request boundary
    validateNoIdentityFields(req.updates, new Set(['id', 'messageId', 'sortOrder']), 'request.updates')
  },
  validateResult: voidResult('chatdb:update-single-block')
}

const bulkAddBlocksContract: ChatDbContract = {
  allowedKeys: keySet('blocks'),
  validate(value: unknown): void {
    validateRequest(value, bulkAddBlocksContract.allowedKeys)
    const req = value as BulkAddBlocksRequest
    // Validate blocks is a proper array before iteration
    const blocks = validateJsonObjectArray(req.blocks, 'request.blocks')
    // Blocks are full entities: require both id and messageId
    for (let i = 0; i < blocks.length; i++) {
      validateIdField(blocks[i], `request.blocks[${i}]`)
      validateMessageIdField(blocks[i], `request.blocks[${i}]`)
    }
  },
  validateResult: voidResult('chatdb:bulk-add-blocks')
}

const deleteBlocksContract: ChatDbContract = {
  allowedKeys: keySet('blockIds'),
  validate(value: unknown): void {
    validateRequest(value, deleteBlocksContract.allowedKeys)
    const req = value as DeleteBlocksRequest
    validateStringArray(req.blockIds, 'request.blockIds')
  },
  validateResult: fileCleanupResultValidator('chatdb:delete-blocks')
}

const clearMessagesContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, clearMessagesContract.allowedKeys)
    const req = value as ClearMessagesRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult: fileCleanupResultValidator('chatdb:clear-messages')
}

// ---------------------------------------------------------------------------
// Phase 5.1A: Segment contracts
// ---------------------------------------------------------------------------

const listSegmentsContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, listSegmentsContract.allowedKeys)
    const req = value as ListSegmentsRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:list-segments')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      if (!Array.isArray(obj.value)) {
        throw new ValidationError('result.value', '[chatdb:list-segments] Expected array of segments')
      }
    }
  }
}

const SEGMENT_VALUE_KEYS = new Set(['id', 'topicId', 'name', 'messageIds', 'color', 'createdAt', 'updatedAt'])

function validateSegmentResult(channel: string): (result: unknown) => void {
  return (result: unknown): void => {
    validateResultEnvelope(result, channel)
    const obj = result as Record<string, unknown>
    if (obj.ok === true && obj.value !== null && typeof obj.value === 'object' && !Array.isArray(obj.value)) {
      const v = obj.value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!SEGMENT_VALUE_KEYS.has(key)) {
          throw new ValidationError(`result.value.${key}`, `[${channel}] Unknown key in segment value: "${key}"`)
        }
      }
      validateNonEmptyString(v.id, 'result.value.id')
      validateNonEmptyString(v.topicId, 'result.value.topicId')
      if (!Array.isArray(v.messageIds)) {
        throw new ValidationError('result.value.messageIds', `[${channel}] Expected array of message IDs`)
      }
    }
  }
}

const upsertSegmentContract: ChatDbContract = {
  allowedKeys: keySet('segmentId', 'topicId', 'name', 'messageIds', 'color'),
  validate(value: unknown): void {
    validateRequest(value, upsertSegmentContract.allowedKeys)
    const req = value as UpsertSegmentRequest
    validateNonEmptyString(req.segmentId, 'request.segmentId')
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (req.name !== undefined && req.name !== null) {
      validateNonEmptyString(req.name, 'request.name')
    }
    if (!Array.isArray(req.messageIds)) {
      throw new ValidationError('request.messageIds', 'Expected an array of message IDs')
    }
    for (let i = 0; i < req.messageIds.length; i++) {
      if (typeof req.messageIds[i] !== 'string' || req.messageIds[i].length === 0) {
        throw new ValidationError(`request.messageIds[${i}]`, 'Expected a non-empty string')
      }
    }
  },
  validateResult: validateSegmentResult('chatdb:upsert-segment')
}

const updateSegmentMetadataContract: ChatDbContract = {
  allowedKeys: keySet('segmentId', 'name', 'color'),
  validate(value: unknown): void {
    validateRequest(value, updateSegmentMetadataContract.allowedKeys)
    const req = value as UpdateSegmentMetadataRequest
    validateNonEmptyString(req.segmentId, 'request.segmentId')
  },
  validateResult: validateSegmentResult('chatdb:update-segment-metadata')
}

const deleteSegmentContract: ChatDbContract = {
  allowedKeys: keySet('segmentId'),
  validate(value: unknown): void {
    validateRequest(value, deleteSegmentContract.allowedKeys)
    const req = value as DeleteSegmentRequest
    validateNonEmptyString(req.segmentId, 'request.segmentId')
  },
  validateResult: voidResult('chatdb:delete-segment')
}

const replaceSegmentMembershipContract: ChatDbContract = {
  allowedKeys: keySet('segmentId', 'messageIds'),
  validate(value: unknown): void {
    validateRequest(value, replaceSegmentMembershipContract.allowedKeys)
    const req = value as ReplaceSegmentMembershipRequest
    validateNonEmptyString(req.segmentId, 'request.segmentId')
    if (!Array.isArray(req.messageIds)) {
      throw new ValidationError('request.messageIds', 'Expected an array of message IDs')
    }
    for (let i = 0; i < req.messageIds.length; i++) {
      if (typeof req.messageIds[i] !== 'string' || req.messageIds[i].length === 0) {
        throw new ValidationError(`request.messageIds[${i}]`, 'Expected a non-empty string')
      }
    }
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:replace-segment-membership')
    const obj = result as Record<string, unknown>
    if (obj.ok === true && obj.value !== null) {
      validateSegmentResult('chatdb:replace-segment-membership')(result)
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5.1A: Message reorder contract
// ---------------------------------------------------------------------------

const reorderMessagesContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageIds'),
  validate(value: unknown): void {
    validateRequest(value, reorderMessagesContract.allowedKeys)
    const req = value as ReorderMessagesRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (!Array.isArray(req.messageIds)) {
      throw new ValidationError('request.messageIds', 'Expected an array of message IDs')
    }
    for (let i = 0; i < req.messageIds.length; i++) {
      if (typeof req.messageIds[i] !== 'string' || req.messageIds[i].length === 0) {
        throw new ValidationError(`request.messageIds[${i}]`, 'Expected a non-empty string')
      }
    }
  },
  validateResult: voidResult('chatdb:reorder-messages')
}

// ---------------------------------------------------------------------------
// Phase 5.1A: File reference query contracts (read-only)
// ---------------------------------------------------------------------------

const listFileRefsByFileContract: ChatDbContract = {
  allowedKeys: keySet('fileId'),
  validate(value: unknown): void {
    validateRequest(value, listFileRefsByFileContract.allowedKeys)
    const req = value as ListFileRefsByFileRequest
    validateNonEmptyString(req.fileId, 'request.fileId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:list-file-refs-by-file')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      if (!Array.isArray(obj.value)) {
        throw new ValidationError('result.value', '[chatdb:list-file-refs-by-file] Expected array of file references')
      }
    }
  }
}

const countFileRefsByFileContract: ChatDbContract = {
  allowedKeys: keySet('fileId'),
  validate(value: unknown): void {
    validateRequest(value, countFileRefsByFileContract.allowedKeys)
    const req = value as CountFileRefsByFileRequest
    validateNonEmptyString(req.fileId, 'request.fileId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:count-file-refs-by-file')
    const obj = result as Record<string, unknown>
    if (obj.ok === true && typeof obj.value !== 'number') {
      throw new ValidationError('result.value', '[chatdb:count-file-refs-by-file] Expected number value')
    }
  }
}

const listBlocksByFileContract: ChatDbContract = {
  allowedKeys: keySet('fileId'),
  validate(value: unknown): void {
    validateRequest(value, listBlocksByFileContract.allowedKeys)
    const req = value as ListBlocksByFileRequest
    validateNonEmptyString(req.fileId, 'request.fileId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:list-blocks-by-file')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      if (!Array.isArray(obj.value)) {
        throw new ValidationError('result.value', '[chatdb:list-blocks-by-file] Expected array of blocks')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5.1B: Topic lifecycle contracts
// ---------------------------------------------------------------------------

const updateTopicMetadataContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'name', 'pinned', 'prompt', 'isNameManuallyEdited'),
  validate(value: unknown): void {
    validateRequest(value, updateTopicMetadataContract.allowedKeys)
    const req = value as UpdateTopicMetadataRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    // Reject identity fields in the patch
    if ('id' in req || 'assistantId' in req || 'createdAt' in req || 'deletedAt' in req) {
      throw new ValidationError(
        'request',
        'Identity fields (id, assistantId, createdAt, deletedAt) must not be present'
      )
    }
    // Validate field types: name must be string|null, prompt must be string|null
    if (req.name !== undefined && req.name !== null && typeof req.name !== 'string') {
      throw new ValidationError('request.name', `Expected string|null, got ${typeof req.name}`)
    }
    if (req.prompt !== undefined && req.prompt !== null && typeof req.prompt !== 'string') {
      throw new ValidationError('request.prompt', `Expected string|null, got ${typeof req.prompt}`)
    }
    // Validate field types: pinned must be boolean|null, isNameManuallyEdited must be boolean|null
    if (req.pinned !== undefined && req.pinned !== null && typeof req.pinned !== 'boolean') {
      throw new ValidationError('request.pinned', `Expected boolean|null, got ${typeof req.pinned}`)
    }
    if (
      req.isNameManuallyEdited !== undefined &&
      req.isNameManuallyEdited !== null &&
      typeof req.isNameManuallyEdited !== 'boolean'
    ) {
      throw new ValidationError(
        'request.isNameManuallyEdited',
        `Expected boolean|null, got ${typeof req.isNameManuallyEdited}`
      )
    }
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:update-topic-metadata')
    const obj = result as Record<string, unknown>
    if (obj.ok === true && obj.value !== null && typeof obj.value === 'object' && !Array.isArray(obj.value)) {
      const v = obj.value as Record<string, unknown>
      if (typeof v.id !== 'string' || v.id.length === 0) {
        throw new ValidationError('result.value.id', '[chatdb:update-topic-metadata] Expected non-empty string id')
      }
      // Validate TopicWire result field types
      if (v.name !== undefined && v.name !== null && typeof v.name !== 'string') {
        throw new ValidationError('result.value.name', '[chatdb:update-topic-metadata] Expected string|null for name')
      }
      if (v.pinned !== undefined && v.pinned !== null && typeof v.pinned !== 'boolean') {
        throw new ValidationError(
          'result.value.pinned',
          '[chatdb:update-topic-metadata] Expected boolean|null for pinned'
        )
      }
      if (v.prompt !== undefined && v.prompt !== null && typeof v.prompt !== 'string') {
        throw new ValidationError(
          'result.value.prompt',
          '[chatdb:update-topic-metadata] Expected string|null for prompt'
        )
      }
      if (
        v.isNameManuallyEdited !== undefined &&
        v.isNameManuallyEdited !== null &&
        typeof v.isNameManuallyEdited !== 'boolean'
      ) {
        throw new ValidationError(
          'result.value.isNameManuallyEdited',
          '[chatdb:update-topic-metadata] Expected boolean|null for isNameManuallyEdited'
        )
      }
    }
  }
}

const softDeleteTopicContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, softDeleteTopicContract.allowedKeys)
    const req = value as SoftDeleteTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult: voidResult('chatdb:soft-delete-topic')
}

/**
 * Validate the four mutable TopicWire metadata field types plus id on a
 * result value object. Shared by TopicWire-shaped result validators.
 */
function validateTopicWireValueFields(v: Record<string, unknown>, channel: string): void {
  if (typeof v.id !== 'string' || v.id.length === 0) {
    throw new ValidationError('result.value.id', `[${channel}] Expected non-empty string id`)
  }
  if (v.name !== undefined && v.name !== null && typeof v.name !== 'string') {
    throw new ValidationError('result.value.name', `[${channel}] Expected string|null for name`)
  }
  if (v.pinned !== undefined && v.pinned !== null && typeof v.pinned !== 'boolean') {
    throw new ValidationError('result.value.pinned', `[${channel}] Expected boolean|null for pinned`)
  }
  if (v.prompt !== undefined && v.prompt !== null && typeof v.prompt !== 'string') {
    throw new ValidationError('result.value.prompt', `[${channel}] Expected string|null for prompt`)
  }
  if (
    v.isNameManuallyEdited !== undefined &&
    v.isNameManuallyEdited !== null &&
    typeof v.isNameManuallyEdited !== 'boolean'
  ) {
    throw new ValidationError(
      'result.value.isNameManuallyEdited',
      `[${channel}] Expected boolean|null for isNameManuallyEdited`
    )
  }
}

const restoreTopicContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, restoreTopicContract.allowedKeys)
    const req = value as RestoreTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  // LOCK-532: restore returns the atomically restored TopicWire, or null
  // when no soft-deleted row was restored.
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:restore-topic')
    const obj = result as Record<string, unknown>
    if (obj.ok === true && obj.value !== null) {
      if (typeof obj.value !== 'object' || Array.isArray(obj.value)) {
        throw new ValidationError('result.value', '[chatdb:restore-topic] Expected TopicWire object or null')
      }
      validateTopicWireValueFields(obj.value as Record<string, unknown>, 'chatdb:restore-topic')
    }
  }
}

const listTrashTopicsContract: ChatDbContract = {
  allowedKeys: keySet('assistantId', 'limit', 'cursor'),
  validate(value: unknown): void {
    validateRequest(value, listTrashTopicsContract.allowedKeys)
    const req = value as ListTrashTopicsRequest
    if (req.assistantId !== undefined && req.assistantId !== null) {
      validateNonEmptyString(req.assistantId, 'request.assistantId')
    }
    if (req.limit !== undefined && req.limit !== null) {
      if (
        typeof req.limit !== 'number' ||
        !Number.isFinite(req.limit) ||
        !Number.isInteger(req.limit) ||
        req.limit < 1
      ) {
        throw new ValidationError('request.limit', 'Expected a positive integer')
      }
    }
    if (req.cursor !== undefined && req.cursor !== null) {
      validateNonEmptyString(req.cursor, 'request.cursor')
    }
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:list-trash-topics')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const v = obj.value as Record<string, unknown>
      if (!Array.isArray(v.items)) {
        throw new ValidationError('result.value.items', '[chatdb:list-trash-topics] Expected items array')
      }
      if (typeof v.hasMore !== 'boolean') {
        throw new ValidationError('result.value.hasMore', '[chatdb:list-trash-topics] Expected boolean hasMore')
      }
      // Validate TopicWire fields in each item
      for (let i = 0; i < v.items.length; i++) {
        const item = v.items[i] as Record<string, unknown>
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          throw new ValidationError(`result.value.items[${i}]`, '[chatdb:list-trash-topics] Expected TopicWire object')
        }
        if (typeof item.id !== 'string' || item.id.length === 0) {
          throw new ValidationError(
            `result.value.items[${i}].id`,
            '[chatdb:list-trash-topics] Expected non-empty string id'
          )
        }
        if (item.name !== undefined && item.name !== null && typeof item.name !== 'string') {
          throw new ValidationError(
            `result.value.items[${i}].name`,
            '[chatdb:list-trash-topics] Expected string|null for name'
          )
        }
        if (item.pinned !== undefined && item.pinned !== null && typeof item.pinned !== 'boolean') {
          throw new ValidationError(
            `result.value.items[${i}].pinned`,
            '[chatdb:list-trash-topics] Expected boolean|null for pinned'
          )
        }
        if (item.prompt !== undefined && item.prompt !== null && typeof item.prompt !== 'string') {
          throw new ValidationError(
            `result.value.items[${i}].prompt`,
            '[chatdb:list-trash-topics] Expected string|null for prompt'
          )
        }
        if (
          item.isNameManuallyEdited !== undefined &&
          item.isNameManuallyEdited !== null &&
          typeof item.isNameManuallyEdited !== 'boolean'
        ) {
          throw new ValidationError(
            `result.value.items[${i}].isNameManuallyEdited`,
            '[chatdb:list-trash-topics] Expected boolean|null for isNameManuallyEdited'
          )
        }
      }
    }
  }
}

/** Result validator for FileCleanupResult-shaped responses. */
function fileCleanupResultValidator(channel: string): (result: unknown) => void {
  return (result: unknown): void => {
    validateResultEnvelope(result, channel)
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      if (obj.value === null || typeof obj.value !== 'object' || Array.isArray(obj.value)) {
        throw new ValidationError(
          'result.value',
          `[${channel}] Expected FileCleanupResult object, got ${obj.value === null ? 'null' : typeof obj.value}`
        )
      }
      const v = obj.value as Record<string, unknown>
      validateStringArray(v.affectedFileIds, `result.value.affectedFileIds`)
      validateJsonObject(v.remainingReferenceCounts, `result.value.remainingReferenceCounts`)
      const counts = v.remainingReferenceCounts as Record<string, unknown>
      for (const key of Object.keys(counts)) {
        if (key.length === 0) {
          throw new ValidationError(
            `result.value.remainingReferenceCounts`,
            `[${channel}] remainingReferenceCounts key must be a non-empty string`
          )
        }
        validateNonNegativeInteger(counts[key], `result.value.remainingReferenceCounts.${key}`)
      }
    }
  }
}

const hardDeleteTopicContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, hardDeleteTopicContract.allowedKeys)
    const req = value as HardDeleteTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult: fileCleanupResultValidator('chatdb:hard-delete-topic')
}

const purgeExpiredTopicsContract: ChatDbContract = {
  allowedKeys: keySet('cutoffTimestamp'),
  validate(value: unknown): void {
    validateRequest(value, purgeExpiredTopicsContract.allowedKeys)
    const req = value as PurgeExpiredTopicsRequest
    validateIso8601Timestamp(req.cutoffTimestamp, 'request.cutoffTimestamp')
  },
  validateResult: fileCleanupResultValidator('chatdb:purge-expired-topics')
}

const emptyTrashTopicsContract: ChatDbContract = {
  allowedKeys: keySet('assistantId'),
  validate(value: unknown): void {
    validateRequest(value, emptyTrashTopicsContract.allowedKeys)
    const req = value as EmptyTrashTopicsRequest
    validateNonEmptyString(req.assistantId, 'request.assistantId')
  },
  // LOCK-531: one aggregate FileCleanupResult for the whole transaction.
  validateResult: fileCleanupResultValidator('chatdb:empty-trash-topics')
}

const transferTopicOwnershipContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'assistantId'),
  validate(value: unknown): void {
    validateRequest(value, transferTopicOwnershipContract.allowedKeys)
    const req = value as TransferTopicOwnershipRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.assistantId, 'request.assistantId')
  },
  validateResult: voidResult('chatdb:transfer-topic-ownership')
}

const resetAssistantTopicsContract: ChatDbContract = {
  allowedKeys: keySet('assistantId', 'replacementTopicId'),
  validate(value: unknown): void {
    validateRequest(value, resetAssistantTopicsContract.allowedKeys)
    const req = value as ResetAssistantTopicsRequest
    validateNonEmptyString(req.assistantId, 'request.assistantId')
    validateNonEmptyString(req.replacementTopicId, 'request.replacementTopicId')
  },
  validateResult(value: unknown): void {
    validateResultEnvelope(value, 'chatdb:reset-assistant-topics')
    const envelope = value as Record<string, unknown>
    if (
      envelope.ok !== true ||
      envelope.value === null ||
      typeof envelope.value !== 'object' ||
      Array.isArray(envelope.value)
    ) {
      return
    }
    const result = envelope.value as Record<string, unknown>
    const cleanup = result.cleanup
    if (cleanup === null || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
      throw new ValidationError('result.value.cleanup', '[chatdb:reset-assistant-topics] Expected cleanup object')
    }
    fileCleanupResultValidator('chatdb:reset-assistant-topics')({ ok: true, value: cleanup })
    const replacement = result.replacementTopic
    if (replacement === null || typeof replacement !== 'object' || Array.isArray(replacement)) {
      throw new ValidationError('result.replacementTopic', '[chatdb:reset-assistant-topics] Expected TopicWire object')
    }
    validateTopicWireValueFields(replacement as Record<string, unknown>, 'chatdb:reset-assistant-topics')
  }
}

// ---------------------------------------------------------------------------
// Phase 5.1B: Compound mutation contracts
// ---------------------------------------------------------------------------

/** Validate a MessageBlockEntry array in a compound request. */
function validateEntries(entries: unknown, path: string): void {
  if (!Array.isArray(entries)) {
    throw new ValidationError(path, 'Expected an array')
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Record<string, unknown>
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`${path}[${i}]`, 'Expected an object with message and blocks')
    }
    validateJsonObject(entry.message, `${path}[${i}].message`)
    validateIdField(entry.message as any, `${path}[${i}].message`)
    const blocks = validateJsonObjectArray(entry.blocks, `${path}[${i}].blocks`)
    for (let j = 0; j < blocks.length; j++) {
      validateIdField(blocks[j], `${path}[${i}].blocks[${j}]`)
      validateMessageIdField(blocks[j], `${path}[${i}].blocks[${j}]`)
    }
  }
}

const cloneMessagesToTopicContract: ChatDbContract = {
  allowedKeys: keySet('targetTopicId', 'assistantId', 'entries'),
  validate(value: unknown): void {
    validateRequest(value, cloneMessagesToTopicContract.allowedKeys)
    const req = value as CloneMessagesToTopicRequest
    validateNonEmptyString(req.targetTopicId, 'request.targetTopicId')
    if (req.assistantId !== undefined) {
      validateNonEmptyString(req.assistantId, 'request.assistantId')
    }
    validateEntries(req.entries, 'request.entries')
  },
  validateResult: voidResult('chatdb:clone-messages-to-topic')
}

const resetMessagesForResendContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messages', 'blockIdsToDelete'),
  validate(value: unknown): void {
    validateRequest(value, resetMessagesForResendContract.allowedKeys)
    const req = value as ResetMessagesForResendRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateEntries(req.messages, 'request.messages')
    validateStringArray(req.blockIdsToDelete, 'request.blockIdsToDelete')
  },
  validateResult: fileCleanupResultValidator('chatdb:reset-messages-for-resend')
}

const deleteMessagesWithSegmentsContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageIds'),
  validate(value: unknown): void {
    validateRequest(value, deleteMessagesWithSegmentsContract.allowedKeys)
    const req = value as DeleteMessagesWithSegmentsRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateStringArray(req.messageIds, 'request.messageIds')
  },
  validateResult: fileCleanupResultValidator('chatdb:delete-messages-with-segments')
}

const pasteMessagesToTopicContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'entries', 'insertIndex'),
  validate(value: unknown): void {
    validateRequest(value, pasteMessagesToTopicContract.allowedKeys)
    const req = value as PasteMessagesToTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateEntries(req.entries, 'request.entries')
    if (req.insertIndex !== undefined) {
      validateIndex(req.insertIndex, 'request.insertIndex')
    }
  },
  validateResult: fileCleanupResultValidator('chatdb:paste-messages-to-topic')
}

const clearTopicWithSegmentsContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, clearTopicWithSegmentsContract.allowedKeys)
    const req = value as ClearTopicWithSegmentsRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult: fileCleanupResultValidator('chatdb:clear-topic-with-segments')
}

// ---------------------------------------------------------------------------
// Phase 5.1B-2: Search contract
// ---------------------------------------------------------------------------

/** Allowed keys for SearchMessagesResponse success value. */
const SEARCH_RESPONSE_VALUE_KEYS = new Set(['items', 'nextCursor', 'hasMore', 'totalCount'])

/** Allowed keys for each SearchResultItem. */
const SEARCH_RESULT_ITEM_KEYS = new Set([
  'blockId',
  'messageId',
  'topicId',
  'topicName',
  'rawContent',
  'messageCreatedAt'
])

const searchMessagesContract: ChatDbContract = {
  allowedKeys: keySet('keywords', 'matchMode', 'sortOrder', 'pageSize', 'cursor'),
  validate(value: unknown): void {
    validateRequest(value, searchMessagesContract.allowedKeys)
    const req = value as SearchMessagesRequest
    // keywords: must be a string (can be empty for no-op, but must be string)
    if (typeof req.keywords !== 'string') {
      throw new ValidationError('request.keywords', 'Expected string')
    }
    if (req.keywords.length > 1000) {
      throw new ValidationError('request.keywords', 'Keywords too long (max 1000 chars)')
    }
    // matchMode: must be one of the allowed values
    if (req.matchMode !== 'whole-word' && req.matchMode !== 'substring') {
      throw new ValidationError('request.matchMode', 'Expected "whole-word" or "substring"')
    }
    // sortOrder: must be one of the allowed values
    if (req.sortOrder !== 'newest' && req.sortOrder !== 'oldest') {
      throw new ValidationError('request.sortOrder', 'Expected "newest" or "oldest"')
    }
    // pageSize: optional, must be positive integer if provided
    if (req.pageSize !== undefined && req.pageSize !== null) {
      if (
        typeof req.pageSize !== 'number' ||
        !Number.isFinite(req.pageSize) ||
        !Number.isInteger(req.pageSize) ||
        req.pageSize < 1
      ) {
        throw new ValidationError('request.pageSize', 'Expected a positive integer')
      }
      if (req.pageSize > 100) {
        throw new ValidationError('request.pageSize', 'Page size must be at most 100')
      }
    }
    // cursor: optional non-empty base64url string (canonical opaque format).
    // Malformed cursors are rejected here; deeper decode validation happens
    // in the repository and also fails with a validation error (never resets).
    if (req.cursor !== undefined && req.cursor !== null) {
      if (typeof req.cursor !== 'string' || req.cursor.length === 0) {
        throw new ValidationError('request.cursor', 'Expected non-empty string cursor')
      }
      if (!/^[A-Za-z0-9_-]+$/.test(req.cursor)) {
        throw new ValidationError('request.cursor', 'Cursor must be canonical base64url format')
      }
    }
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:search-messages')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError('result.value', '[chatdb:search-messages] Expected response object')
      }
      const v = value as Record<string, unknown>
      // Reject unknown keys in the response value
      for (const key of Object.keys(v)) {
        if (!SEARCH_RESPONSE_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:search-messages] Unknown key in response value: "${key}"`
          )
        }
      }
      if (!Array.isArray(v.items)) {
        throw new ValidationError('result.value.items', '[chatdb:search-messages] Expected items array')
      }
      if (typeof v.hasMore !== 'boolean') {
        throw new ValidationError('result.value.hasMore', '[chatdb:search-messages] Expected boolean hasMore')
      }
      // totalCount: finite non-negative integer
      if (
        typeof v.totalCount !== 'number' ||
        !Number.isFinite(v.totalCount) ||
        !Number.isInteger(v.totalCount) ||
        v.totalCount < 0
      ) {
        throw new ValidationError(
          'result.value.totalCount',
          '[chatdb:search-messages] Expected finite non-negative integer totalCount'
        )
      }
      // nextCursor: optional canonical opaque cursor (non-empty base64url string)
      if (v.nextCursor !== undefined) {
        if (typeof v.nextCursor !== 'string' || v.nextCursor.length === 0 || !/^[A-Za-z0-9_-]+$/.test(v.nextCursor)) {
          throw new ValidationError(
            'result.value.nextCursor',
            '[chatdb:search-messages] Expected canonical non-empty base64url nextCursor'
          )
        }
      }
      // Validate each SearchResultItem (full shape, unknown keys rejected)
      for (let i = 0; i < v.items.length; i++) {
        const item = v.items[i] as Record<string, unknown>
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          throw new ValidationError(
            `result.value.items[${i}]`,
            '[chatdb:search-messages] Expected SearchResultItem object'
          )
        }
        for (const key of Object.keys(item)) {
          if (!SEARCH_RESULT_ITEM_KEYS.has(key)) {
            throw new ValidationError(
              `result.value.items[${i}].${key}`,
              `[chatdb:search-messages] Unknown key in SearchResultItem: "${key}"`
            )
          }
        }
        if (typeof item.blockId !== 'string' || item.blockId.length === 0) {
          throw new ValidationError(
            `result.value.items[${i}].blockId`,
            '[chatdb:search-messages] Expected non-empty string blockId'
          )
        }
        if (typeof item.messageId !== 'string' || item.messageId.length === 0) {
          throw new ValidationError(
            `result.value.items[${i}].messageId`,
            '[chatdb:search-messages] Expected non-empty string messageId'
          )
        }
        if (typeof item.topicId !== 'string' || item.topicId.length === 0) {
          throw new ValidationError(
            `result.value.items[${i}].topicId`,
            '[chatdb:search-messages] Expected non-empty string topicId'
          )
        }
        // topicName: string | null
        if (item.topicName !== null && typeof item.topicName !== 'string') {
          throw new ValidationError(
            `result.value.items[${i}].topicName`,
            '[chatdb:search-messages] Expected string|null topicName'
          )
        }
        // rawContent: string
        if (typeof item.rawContent !== 'string') {
          throw new ValidationError(
            `result.value.items[${i}].rawContent`,
            '[chatdb:search-messages] Expected string rawContent'
          )
        }
        // messageCreatedAt: string | null
        if (item.messageCreatedAt !== null && typeof item.messageCreatedAt !== 'string') {
          throw new ValidationError(
            `result.value.items[${i}].messageCreatedAt`,
            '[chatdb:search-messages] Expected string|null messageCreatedAt'
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Contract registry — exact channel → contract mapping
// ---------------------------------------------------------------------------

/**
 * Immutable registry of all ChatDb command contracts.
 * Keys match ChatDbChannel / IpcChannel enum values exactly.
 */
export const chatDbContracts: Readonly<Record<ChatDbChannel, ChatDbContract>> = Object.freeze({
  // Original 14 commands
  'chatdb:fetch-messages': fetchMessagesContract,
  'chatdb:get-raw-topic': getRawTopicContract,
  'chatdb:topic-exists': topicExistsContract,
  'chatdb:ensure-topic': ensureTopicContract,
  'chatdb:append-message': appendMessageContract,
  'chatdb:update-message': updateMessageContract,
  'chatdb:update-message-and-blocks': updateMessageAndBlocksContract,
  'chatdb:delete-message': deleteMessageContract,
  'chatdb:delete-messages': deleteMessagesContract,
  'chatdb:update-blocks': updateBlocksContract,
  'chatdb:update-single-block': updateSingleBlockContract,
  'chatdb:bulk-add-blocks': bulkAddBlocksContract,
  'chatdb:delete-blocks': deleteBlocksContract,
  'chatdb:clear-messages': clearMessagesContract,
  // Phase 5.1A: segment commands
  'chatdb:list-segments': listSegmentsContract,
  'chatdb:upsert-segment': upsertSegmentContract,
  'chatdb:update-segment-metadata': updateSegmentMetadataContract,
  'chatdb:delete-segment': deleteSegmentContract,
  'chatdb:replace-segment-membership': replaceSegmentMembershipContract,
  // Phase 5.1A: message reorder
  'chatdb:reorder-messages': reorderMessagesContract,
  // Phase 5.1A: file reference queries (read-only)
  'chatdb:list-file-refs-by-file': listFileRefsByFileContract,
  'chatdb:count-file-refs-by-file': countFileRefsByFileContract,
  'chatdb:list-blocks-by-file': listBlocksByFileContract,
  // Phase 5.1B: topic lifecycle
  'chatdb:update-topic-metadata': updateTopicMetadataContract,
  'chatdb:soft-delete-topic': softDeleteTopicContract,
  'chatdb:restore-topic': restoreTopicContract,
  'chatdb:list-trash-topics': listTrashTopicsContract,
  'chatdb:hard-delete-topic': hardDeleteTopicContract,
  'chatdb:purge-expired-topics': purgeExpiredTopicsContract,
  // Phase 5.2B: atomic assistant empty-trash
  'chatdb:empty-trash-topics': emptyTrashTopicsContract,
  'chatdb:transfer-topic-ownership': transferTopicOwnershipContract,
  'chatdb:reset-assistant-topics': resetAssistantTopicsContract,
  // Phase 5.1B: compound mutations
  'chatdb:clone-messages-to-topic': cloneMessagesToTopicContract,
  'chatdb:reset-messages-for-resend': resetMessagesForResendContract,
  'chatdb:delete-messages-with-segments': deleteMessagesWithSegmentsContract,
  'chatdb:paste-messages-to-topic': pasteMessagesToTopicContract,
  'chatdb:clear-topic-with-segments': clearTopicWithSegmentsContract,
  // Phase 5.1B-2: search
  'chatdb:search-messages': searchMessagesContract
})

/**
 * Get the contract for a given ChatDb channel.
 * Throws if the channel is not a valid ChatDb command.
 */
export function getContract(channel: ChatDbChannel): ChatDbContract {
  const contract = chatDbContracts[channel]
  if (!contract) {
    throw new Error(`No contract registered for ChatDb channel: ${channel}`)
  }
  return contract
}

/**
 * Validate a request payload for a given ChatDb channel.
 * Convenience wrapper around getContract(channel).validate(request).
 *
 * @param channel  The ChatDb channel string.
 * @param request  The request payload to validate.
 * @throws {ValidationError} If validation fails.
 */
export function validateChatDbRequest(channel: ChatDbChannel, request: unknown): void {
  getContract(channel).validate(request)
}

/**
 * Validate a result envelope for a given ChatDb channel.
 * Convenience wrapper around getContract(channel).validateResult(result).
 *
 * Enforces envelope structure (ok/fail discrimination, error fields,
 * unknown-key rejection) plus command-specific success value shape.
 *
 * @param channel  The ChatDb channel string.
 * @param result   The result payload to validate.
 * @throws {ValidationError} If validation fails.
 */
export function validateChatDbResult(channel: ChatDbChannel, result: unknown): void {
  getContract(channel).validateResult(result)
}
