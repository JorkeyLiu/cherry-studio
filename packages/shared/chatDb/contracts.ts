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
  CountFileRefsByFileRequest,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteSegmentRequest,
  EnsureTopicRequest,
  FetchMessagesRequest,
  GetRawTopicRequest,
  ListBlocksByFileRequest,
  ListFileRefsByFileRequest,
  ListSegmentsRequest,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  TopicExistsRequest,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSegmentMetadataRequest,
  UpdateSingleBlockRequest,
  UpsertSegmentRequest
} from './types'
import {
  validateIdField,
  validateIndex,
  validateJsonObject,
  validateJsonObjectArray,
  validateMessageIdField,
  validateNoIdentityFields,
  validateNonEmptyString,
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
  allowedKeys: keySet('topicId', 'messageUpdates', 'blocksToUpdate'),
  validate(value: unknown): void {
    validateRequest(value, updateMessageAndBlocksContract.allowedKeys)
    const req = value as UpdateMessageAndBlocksRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
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
  validateResult: voidResult('chatdb:update-message-and-blocks')
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
  validateResult: voidResult('chatdb:delete-blocks')
}

const clearMessagesContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, clearMessagesContract.allowedKeys)
    const req = value as ClearMessagesRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult: voidResult('chatdb:clear-messages')
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
  'chatdb:list-blocks-by-file': listBlocksByFileContract
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
