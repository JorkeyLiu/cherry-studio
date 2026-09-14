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
  BranchMessagesToTopicRequest,
  BulkAddBlocksRequest,
  ChatDbChannel,
  CloneMessagesToTopicRequest,
  CountFileRefsByFileRequest,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithDependentsRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteSegmentRequest,
  EmptyTrashTopicsRequest,
  EnsureTopicRequest,
  FetchAnswerGroupRequest,
  FetchContextClosureRequest,
  FetchMessagesRequest,
  FetchMessagesWindowRequest,
  FetchTopicActivityRequest,
  FetchTopicNamingContextRequest,
  FetchWholeTopicSnapshotRequest,
  GetRawTopicRequest,
  HardDeleteTopicRequest,
  InsertMessageGroupIntent,
  InsertMessageGroupsRequest,
  InsertMessagesAfterAnchorRequest,
  ListBlocksByFileRequest,
  ListFileRefsByFileRequest,
  ListSegmentsRequest,
  ListTrashTopicsRequest,
  PasteMessagesToTopicRequest,
  PurgeExpiredTopicsRequest,
  RegenerateAssistantMessageRequest,
  ReorderAnswerGroupRequest,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  ResendUserMessagesRequest,
  ResetAssistantTopicsRequest,
  ResetMessagesForResendRequest,
  RestoreTopicRequest,
  SearchMessagesRequest,
  SelectAnswerMessageRequest,
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
  BLOCK_JSON_PROFILE,
  validateIdField,
  validateIndex,
  validateIso8601Timestamp,
  validateJsonObject,
  validateJsonObjectArray,
  validateJsonObjectArrayBlock,
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
    // LOCK-LB-5: the success value is validated per-array below — message
    // objects retain the generic caps, while the `blocks` array is validated
    // with the named block-specific profile (per-string 8 MiB, per-row
    // 16 MiB, 64 MiB per result). The envelope-level generic walk is skipped
    // so its 1 MiB string cap cannot reject legitimate large blocks.
    validateResultEnvelope(result, 'chatdb:fetch-messages', { skipValueValidation: true })
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-messages] Expected object with "messages" and "blocks"'
        )
      }
      // LOCK-LB-8: the success value must be a PLAIN object — Object.prototype
      // or null prototype — never a class instance.
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', '[chatdb:fetch-messages] Success value must be a plain object')
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
      // Message objects stay on the generic 1 MiB caps (LOCK-LB-5).
      validateJsonObjectArray(v.messages, 'result.value.messages')
      // Blocks use the block-specific profile with a shared 64 MiB result
      // aggregate budget (LOCK-LB-1/4/5).
      validateJsonObjectArrayBlock(v.blocks, 'result.value.blocks', BLOCK_JSON_PROFILE)
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
  allowedKeys: keySet('topicId', 'assistantId', 'name'),
  validate(value: unknown): void {
    validateRequest(value, ensureTopicContract.allowedKeys)
    const req = value as EnsureTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (req.assistantId !== undefined) {
      validateNonEmptyString(req.assistantId, 'request.assistantId')
    }
    if (req.name !== undefined && req.name !== null && typeof req.name !== 'string') {
      throw new ValidationError('request.name', `Expected string|null, got ${typeof req.name}`)
    }
  },
  validateResult: voidResult('chatdb:ensure-topic')
}

const appendMessageContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'message', 'blocks', 'insertIndex', 'diagnostics', 'resendAttemptId'),
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
    validateResendAttemptId(req.resendAttemptId)
    // LOCK-004: optional diagnostic-only correlation metadata. JSON-safety is
    // already enforced by validateRequest; only shape/type bounds are needed
    // here. Never validated against message content.
    if (req.diagnostics !== undefined) {
      const diag = req.diagnostics
      if (diag === null || typeof diag !== 'object' || Array.isArray(diag)) {
        throw new ValidationError('request.diagnostics', 'Expected an object')
      }
      for (const key of Object.keys(diag)) {
        if (key !== 'correlationId' && key !== 'ordinal') {
          throw new ValidationError(`request.diagnostics.${key}`, `Unknown property '${key}'`)
        }
      }
      if (diag.correlationId !== undefined) {
        if (
          typeof diag.correlationId !== 'string' ||
          diag.correlationId.length === 0 ||
          diag.correlationId.length > 64
        ) {
          throw new ValidationError(
            'request.diagnostics.correlationId',
            'Expected a non-empty string up to 64 characters'
          )
        }
      }
      if (diag.ordinal !== undefined) {
        if (
          typeof diag.ordinal !== 'number' ||
          !Number.isInteger(diag.ordinal) ||
          diag.ordinal < 1 ||
          diag.ordinal > 100
        ) {
          throw new ValidationError('request.diagnostics.ordinal', 'Expected a positive integer up to 100')
        }
      }
    }
  },
  validateResult: voidResult('chatdb:append-message')
}

const updateMessageContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageId', 'updates', 'resendAttemptId'),
  validate(value: unknown): void {
    validateRequest(value, updateMessageContract.allowedKeys)
    const req = value as UpdateMessageRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.messageId, 'request.messageId')
    validateResendAttemptId(req.resendAttemptId)
    validateJsonObject(req.updates, 'request.updates')
    // Reject identity/reparenting fields at the shared request boundary
    validateNoIdentityFields(req.updates, new Set(['id', 'topicId', 'sortOrder']), 'request.updates')
  },
  validateResult: voidResult('chatdb:update-message')
}

/**
 * Cross-process authority answer selection.
 *
 * Request is selected-ID only (Main resolves the full group):
 * - `topicId` and `selectedMessageId` are non-empty strings.
 * - No extra fields (unknown keys fail closed).
 *
 * Result is the Main-resolved full group:
 * `{topicId, askId, selectedMessageId, messageIds}` with messageIds
 * non-empty, unique, containing selected exactly once.
 */
const SELECT_ANSWER_VALUE_KEYS = new Set(['topicId', 'askId', 'selectedMessageId', 'messageIds'])

const selectAnswerMessageContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'selectedMessageId'),
  validate(value: unknown): void {
    validateRequest(value, selectAnswerMessageContract.allowedKeys)
    const req = value as SelectAnswerMessageRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.selectedMessageId, 'request.selectedMessageId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:select-answer-message')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:select-answer-message] Expected SelectAnswerMessageResponse object'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', '[chatdb:select-answer-message] Success value must be a plain object')
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!SELECT_ANSWER_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:select-answer-message] Unknown key in success value: "${key}"`
          )
        }
      }
      validateNonEmptyString(v.topicId, 'result.value.topicId')
      validateNonEmptyString(v.askId, 'result.value.askId')
      validateNonEmptyString(v.selectedMessageId, 'result.value.selectedMessageId')
      if (!Array.isArray(v.messageIds)) {
        throw new ValidationError(
          'result.value.messageIds',
          '[chatdb:select-answer-message] Expected array of messageIds'
        )
      }
      if ((v.messageIds as unknown[]).length === 0) {
        throw new ValidationError(
          'result.value.messageIds',
          '[chatdb:select-answer-message] messageIds must not be empty'
        )
      }
      const seen = new Set<string>()
      let selectedCount = 0
      for (let i = 0; i < (v.messageIds as unknown[]).length; i++) {
        const id = (v.messageIds as unknown[])[i]
        if (typeof id !== 'string' || id.length === 0) {
          throw new ValidationError(`result.value.messageIds[${i}]`, 'Expected a non-empty string')
        }
        if (seen.has(id)) {
          throw new ValidationError(
            `result.value.messageIds[${i}]`,
            '[chatdb:select-answer-message] Duplicate messageId'
          )
        }
        seen.add(id)
        if (id === v.selectedMessageId) selectedCount += 1
      }
      if (selectedCount !== 1) {
        throw new ValidationError(
          'result.value.selectedMessageId',
          '[chatdb:select-answer-message] selectedMessageId must appear in messageIds exactly once'
        )
      }
    }
  }
}

const updateMessageAndBlocksContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageUpdates', 'blocksToUpdate', 'blockIdsToDelete', 'resendAttemptId'),
  validate(value: unknown): void {
    validateRequest(value, updateMessageAndBlocksContract.allowedKeys)
    const req = value as UpdateMessageAndBlocksRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateResendAttemptId(req.resendAttemptId)
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

/**
 * Optional Main-internal resend attempt carrier (SYNC-DATA-055 issuer slice).
 *
 * Absent = legacy/ordinary path (unchanged). When present it must be the
 * Main-authoritative colon-free attempt id (1..256 chars, no ':', no lone
 * surrogates) — never askId, Message.extra/overflow, or diagnostics
 * correlationId. Unknown request keys still fail closed via validateRequest.
 */
function validateResendAttemptId(value: unknown, at = 'request.resendAttemptId'): void {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new ValidationError(at, 'Expected a non-empty string up to 256 characters')
  }
  if (value.includes(':')) {
    throw new ValidationError(at, 'Attempt id must not contain ":"')
  }
  if (/[\uD800-\uDFFF]/.test(value)) {
    throw new ValidationError(at, 'Attempt id must not contain lone surrogates')
  }
}

/**
 * Shared validation for optional measurement-only correlation metadata
 * (PERF-STREAM-ATTR-001, LOCK-STREAM-ATTR-001). Mirrors the append-message
 * `diagnostics` validation (LOCK-004): JSON-safety is already enforced by
 * `validateRequest`; only shape/type bounds are checked here. Never validated
 * against message content. Rejects unknown properties, so a future field
 * never silently passes an old validator.
 */
function validateStreamWriteDiagnostics(diagnostics: unknown, at = 'request.diagnostics'): void {
  if (diagnostics === undefined) return
  if (diagnostics === null || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
    throw new ValidationError(at, 'Expected an object')
  }
  const diag = diagnostics as Record<string, unknown>
  for (const key of Object.keys(diag)) {
    if (key !== 'correlationId' && key !== 'ordinal') {
      throw new ValidationError(`${at}.${key}`, `Unknown property '${key}'`)
    }
  }
  if (diag.correlationId !== undefined) {
    if (typeof diag.correlationId !== 'string' || diag.correlationId.length === 0 || diag.correlationId.length > 64) {
      throw new ValidationError(`${at}.correlationId`, 'Expected a non-empty string up to 64 characters')
    }
  }
  if (diag.ordinal !== undefined) {
    if (typeof diag.ordinal !== 'number' || !Number.isInteger(diag.ordinal) || diag.ordinal < 1 || diag.ordinal > 100) {
      throw new ValidationError(`${at}.ordinal`, 'Expected a positive integer up to 100')
    }
  }
}

const updateBlocksContract: ChatDbContract = {
  allowedKeys: keySet('blocks', 'diagnostics', 'resendAttemptId'),
  validate(value: unknown): void {
    validateRequest(value, updateBlocksContract.allowedKeys)
    const req = value as UpdateBlocksRequest
    validateResendAttemptId(req.resendAttemptId)
    validateStreamWriteDiagnostics(req.diagnostics)
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
  allowedKeys: keySet('blockId', 'updates', 'diagnostics', 'resendAttemptId'),
  validate(value: unknown): void {
    validateRequest(value, updateSingleBlockContract.allowedKeys)
    const req = value as UpdateSingleBlockRequest
    validateNonEmptyString(req.blockId, 'request.blockId')
    validateResendAttemptId(req.resendAttemptId)
    validateStreamWriteDiagnostics(req.diagnostics)
    // updates is a partial patch, not a full block — no messageId required
    validateJsonObject(req.updates, 'request.updates')
    // Reject identity/reparenting fields at the shared request boundary
    validateNoIdentityFields(req.updates, new Set(['id', 'messageId', 'sortOrder']), 'request.updates')
  },
  validateResult: voidResult('chatdb:update-single-block')
}

const bulkAddBlocksContract: ChatDbContract = {
  allowedKeys: keySet('blocks', 'resendAttemptId'),
  validate(value: unknown): void {
    validateRequest(value, bulkAddBlocksContract.allowedKeys)
    const req = value as BulkAddBlocksRequest
    validateResendAttemptId(req.resendAttemptId)
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
// Answer-group authority reorder contract (additive semantic command)
// ---------------------------------------------------------------------------

const REORDER_ANSWER_GROUP_VALUE_KEYS = new Set(['topicId', 'askId', 'anchorMessageId', 'orderedMessageIds'])

const reorderAnswerGroupContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'anchorMessageId', 'orderedMessageIds'),
  validate(value: unknown): void {
    validateRequest(value, reorderAnswerGroupContract.allowedKeys)
    const req = value as ReorderAnswerGroupRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.anchorMessageId, 'request.anchorMessageId')
    if (!Array.isArray(req.orderedMessageIds)) {
      throw new ValidationError('request.orderedMessageIds', 'Expected an array of message IDs')
    }
    if (req.orderedMessageIds.length === 0) {
      throw new ValidationError('request.orderedMessageIds', 'orderedMessageIds must not be empty')
    }
    const seen = new Set<string>()
    for (let i = 0; i < req.orderedMessageIds.length; i++) {
      const id = req.orderedMessageIds[i]
      if (typeof id !== 'string' || id.length === 0) {
        throw new ValidationError(`request.orderedMessageIds[${i}]`, 'Expected a non-empty string')
      }
      if (seen.has(id)) {
        throw new ValidationError(
          `request.orderedMessageIds[${i}]`,
          '[chatdb:reorder-answer-group] Duplicate messageId'
        )
      }
      seen.add(id)
    }
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:reorder-answer-group')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:reorder-answer-group] Expected ReorderAnswerGroupResponse object'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', '[chatdb:reorder-answer-group] Success value must be a plain object')
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!REORDER_ANSWER_GROUP_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:reorder-answer-group] Unknown key in success value: "${key}"`
          )
        }
      }
      validateNonEmptyString(v.topicId, 'result.value.topicId')
      validateNonEmptyString(v.askId, 'result.value.askId')
      validateNonEmptyString(v.anchorMessageId, 'result.value.anchorMessageId')
      if (!Array.isArray(v.orderedMessageIds)) {
        throw new ValidationError(
          'result.value.orderedMessageIds',
          '[chatdb:reorder-answer-group] Expected array of orderedMessageIds'
        )
      }
      if ((v.orderedMessageIds as unknown[]).length === 0) {
        throw new ValidationError(
          'result.value.orderedMessageIds',
          '[chatdb:reorder-answer-group] orderedMessageIds must not be empty'
        )
      }
      const seen = new Set<string>()
      let anchorCount = 0
      for (let i = 0; i < (v.orderedMessageIds as unknown[]).length; i++) {
        const id = (v.orderedMessageIds as unknown[])[i]
        if (typeof id !== 'string' || id.length === 0) {
          throw new ValidationError(`result.value.orderedMessageIds[${i}]`, 'Expected a non-empty string')
        }
        if (seen.has(id)) {
          throw new ValidationError(
            `result.value.orderedMessageIds[${i}]`,
            '[chatdb:reorder-answer-group] Duplicate messageId'
          )
        }
        seen.add(id)
        if (id === v.anchorMessageId) anchorCount += 1
      }
      if (anchorCount !== 1) {
        throw new ValidationError(
          'result.value.anchorMessageId',
          '[chatdb:reorder-answer-group] anchorMessageId must appear in orderedMessageIds exactly once'
        )
      }
    }
  }
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
  allowedKeys: keySet('topicId', 'name'),
  validate(value: unknown): void {
    validateRequest(value, softDeleteTopicContract.allowedKeys)
    const req = value as SoftDeleteTopicRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (req.name !== undefined && req.name !== null && typeof req.name !== 'string') {
      throw new ValidationError('request.name', `Expected string|null, got ${typeof req.name}`)
    }
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

/** Result validator for deletion responses that include exact deletedTopicIds. */
function deletionCleanupResultValidator(channel: string): (result: unknown) => void {
  return (result: unknown): void => {
    validateResultEnvelope(result, channel)
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      if (obj.value === null || typeof obj.value !== 'object' || Array.isArray(obj.value)) {
        throw new ValidationError(
          'result.value',
          `[${channel}] Expected FileCleanupResult with deletedTopicIds, got ${obj.value === null ? 'null' : typeof obj.value}`
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
      // Exact authoritative deleted IDs — string array, may be empty, never null/undefined, unknown keys rejected at envelope level already
      validateStringArray(v.deletedTopicIds, `result.value.deletedTopicIds`)
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
  validateResult: deletionCleanupResultValidator('chatdb:hard-delete-topic')
}

const purgeExpiredTopicsContract: ChatDbContract = {
  allowedKeys: keySet('cutoffTimestamp'),
  validate(value: unknown): void {
    validateRequest(value, purgeExpiredTopicsContract.allowedKeys)
    const req = value as PurgeExpiredTopicsRequest
    validateIso8601Timestamp(req.cutoffTimestamp, 'request.cutoffTimestamp')
  },
  validateResult: deletionCleanupResultValidator('chatdb:purge-expired-topics')
}

const emptyTrashTopicsContract: ChatDbContract = {
  allowedKeys: keySet('assistantId'),
  validate(value: unknown): void {
    validateRequest(value, emptyTrashTopicsContract.allowedKeys)
    const req = value as EmptyTrashTopicsRequest
    validateNonEmptyString(req.assistantId, 'request.assistantId')
  },
  // LOCK-531: one aggregate FileCleanupResult for the whole transaction.
  validateResult: deletionCleanupResultValidator('chatdb:empty-trash-topics')
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
    // Exact authoritative deleted IDs — empty allowed, never undefined
    validateStringArray(result.deletedTopicIds, 'result.value.deletedTopicIds')
    // replacement topic must never be invalidated — enforce at the shared
    // contract boundary so a malformed envelope is fail-closed
    const replacementId = (replacement as Record<string, unknown>).id as string
    if ((result.deletedTopicIds as string[]).includes(replacementId)) {
      throw new ValidationError(
        'result.value.deletedTopicIds',
        '[chatdb:reset-assistant-topics] deletedTopicIds must not contain replacementTopic.id'
      )
    }
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

const branchMessagesToTopicContract: ChatDbContract = {
  allowedKeys: keySet('sourceTopicId', 'targetTopicId', 'anchorMessageId', 'assistantId'),
  validate(value: unknown): void {
    validateRequest(value, branchMessagesToTopicContract.allowedKeys)
    const req = value as BranchMessagesToTopicRequest
    validateNonEmptyString(req.sourceTopicId, 'request.sourceTopicId')
    validateNonEmptyString(req.targetTopicId, 'request.targetTopicId')
    validateNonEmptyString(req.anchorMessageId, 'request.anchorMessageId')
    if (req.assistantId !== undefined) {
      validateNonEmptyString(req.assistantId, 'request.assistantId')
    }
  },
  validateResult(result: unknown): void {
    // Mirrors fetch-messages success shape: { messages: JsonObject[], blocks: JsonObject[] }
    validateResultEnvelope(result, 'chatdb:branch-messages-to-topic', { skipValueValidation: true })
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:branch-messages-to-topic] Expected object with "messages" and "blocks"'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError(
          'result.value',
          '[chatdb:branch-messages-to-topic] Success value must be a plain object'
        )
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_MESSAGES_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:branch-messages-to-topic] Unknown key in success value: "${key}"`
          )
        }
      }
      validateJsonObjectArray(v.messages, 'result.value.messages')
      validateJsonObjectArrayBlock(v.blocks, 'result.value.blocks', BLOCK_JSON_PROFILE)
    }
  }
}

const RESET_RESEND_VALUE_KEYS = new Set(['affectedFileIds', 'remainingReferenceCounts', 'attempts'])
const RESET_RESEND_ATTEMPT_KEYS = new Set(['messageId', 'attemptId'])

const SEMANTIC_RESEND_VALUE_KEYS = new Set([
  'affectedFileIds',
  'remainingReferenceCounts',
  'topicId',
  'askId',
  'userMessage',
  'userBlocks',
  'executionMessages',
  'removedBlockIds',
  'createdMessageIds',
  'attempts'
])

function validateSemanticModelSnapshot(value: unknown, path: string): void {
  validateJsonObject(value, path)
  const rec = value as Record<string, unknown>
  validateNonEmptyString(rec.id, `${path}.id`)
  validateNonEmptyString(rec.provider, `${path}.provider`)
  validateNonEmptyString(rec.name, `${path}.name`)
  validateNonEmptyString(rec.group, `${path}.group`)
}

function validateSemanticResendResult(channel: string): (result: unknown) => void {
  return (result: unknown): void => {
    validateResultEnvelope(result, channel)
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError('result.value', `[${channel}] Expected SemanticResendResponse object`)
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', `[${channel}] Success value must be a plain object`)
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!SEMANTIC_RESEND_VALUE_KEYS.has(key)) {
          throw new ValidationError(`result.value.${key}`, `[${channel}] Unknown key in success value: "${key}"`)
        }
      }
      validateStringArray(v.affectedFileIds, 'result.value.affectedFileIds')
      validateJsonObject(v.remainingReferenceCounts, 'result.value.remainingReferenceCounts')
      const counts = v.remainingReferenceCounts as Record<string, unknown>
      for (const key of Object.keys(counts)) {
        if (key.length === 0) {
          throw new ValidationError(
            'result.value.remainingReferenceCounts',
            `[${channel}] remainingReferenceCounts key must be a non-empty string`
          )
        }
        validateNonNegativeInteger(counts[key], `result.value.remainingReferenceCounts.${key}`)
      }
      validateNonEmptyString(v.topicId, 'result.value.topicId')
      validateNonEmptyString(v.askId, 'result.value.askId')
      validateJsonObject(v.userMessage, 'result.value.userMessage')
      validateIdField(v.userMessage as any, 'result.value.userMessage')
      validateJsonObjectArray(v.userBlocks, 'result.value.userBlocks')
      for (let i = 0; i < (v.userBlocks as unknown[]).length; i++) {
        const b = (v.userBlocks as Record<string, unknown>[])[i]
        validateIdField(b as any, `result.value.userBlocks[${i}]`)
        validateMessageIdField(b as any, `result.value.userBlocks[${i}]`)
      }
      if (!Array.isArray(v.executionMessages) || (v.executionMessages as unknown[]).length === 0) {
        throw new ValidationError('result.value.executionMessages', `[${channel}] Expected non-empty executionMessages`)
      }
      validateEntries(v.executionMessages, 'result.value.executionMessages')
      validateStringArray(v.removedBlockIds, 'result.value.removedBlockIds')
      validateStringArray(v.createdMessageIds, 'result.value.createdMessageIds')
      const created = new Set(v.createdMessageIds as string[])
      if (created.size !== (v.createdMessageIds as string[]).length) {
        throw new ValidationError('result.value.createdMessageIds', `[${channel}] Duplicate createdMessageId`)
      }
      const execIds = (v.executionMessages as Array<{ message: Record<string, unknown> }>).map(
        (e) => e.message?.id as string
      )
      for (const cid of created) {
        if (!execIds.includes(cid)) {
          throw new ValidationError('result.value.createdMessageIds', `[${channel}] createdMessageId not in execution`)
        }
      }
      if (!Array.isArray(v.attempts)) {
        throw new ValidationError('result.value.attempts', `[${channel}] Expected attempts array`)
      }
      const seen = new Set<string>()
      for (let i = 0; i < (v.attempts as unknown[]).length; i++) {
        const entry = (v.attempts as unknown[])[i]
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new ValidationError(`result.value.attempts[${i}]`, `[${channel}] Expected attempt mapping object`)
        }
        const rec = entry as Record<string, unknown>
        for (const key of Object.keys(rec)) {
          if (!RESET_RESEND_ATTEMPT_KEYS.has(key)) {
            throw new ValidationError(
              `result.value.attempts[${i}].${key}`,
              `[${channel}] Unknown key in attempt mapping: "${key}"`
            )
          }
        }
        validateNonEmptyString(rec.messageId, `result.value.attempts[${i}].messageId`)
        const attemptId = rec.attemptId
        if (typeof attemptId !== 'string' || attemptId.length < 1 || attemptId.length > 256) {
          throw new ValidationError(
            `result.value.attempts[${i}].attemptId`,
            `[${channel}] Expected a non-empty string up to 256 characters`
          )
        }
        if (attemptId.includes(':')) {
          throw new ValidationError(
            `result.value.attempts[${i}].attemptId`,
            `[${channel}] Attempt id must not contain ":"`
          )
        }
        if (/[\uD800-\uDFFF]/.test(attemptId)) {
          throw new ValidationError(
            `result.value.attempts[${i}].attemptId`,
            `[${channel}] Attempt id must not contain lone surrogates`
          )
        }
        const mid = rec.messageId as string
        if (seen.has(mid)) {
          throw new ValidationError(`result.value.attempts[${i}].messageId`, `[${channel}] Duplicate attempt messageId`)
        }
        seen.add(mid)
      }
      if (seen.size !== execIds.length || !execIds.every((id) => seen.has(id))) {
        throw new ValidationError('result.value.attempts', `[${channel}] attempts must map executionMessages 1:1`)
      }
    }
  }
}

const resendUserMessagesContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'userMessageId', 'assistantId', 'currentModel'),
  validate(value: unknown): void {
    validateRequest(value, resendUserMessagesContract.allowedKeys)
    const req = value as ResendUserMessagesRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.userMessageId, 'request.userMessageId')
    validateNonEmptyString(req.assistantId, 'request.assistantId')
    validateSemanticModelSnapshot(req.currentModel, 'request.currentModel')
  },
  validateResult: validateSemanticResendResult('chatdb:resend-user-messages')
}

const regenerateAssistantMessageContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'assistantMessageId', 'assistantId', 'currentModel'),
  validate(value: unknown): void {
    validateRequest(value, regenerateAssistantMessageContract.allowedKeys)
    const req = value as RegenerateAssistantMessageRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.assistantMessageId, 'request.assistantMessageId')
    validateNonEmptyString(req.assistantId, 'request.assistantId')
    // Optional absence is legal (self-modelId path); when present it must be
    // a strict snapshot. Resend keeps currentModel required.
    if (req.currentModel !== undefined) {
      validateSemanticModelSnapshot(req.currentModel, 'request.currentModel')
    }
  },
  validateResult: validateSemanticResendResult('chatdb:regenerate-assistant-message')
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
  validateResult(result: unknown): void {
    // File-cleanup facts plus the strictly-closed per-message attempt mapping
    // (SYNC-DATA-055 issuer slice). Unknown value keys fail closed; each
    // mapping entry carries only messageId + attemptId.
    validateResultEnvelope(result, 'chatdb:reset-messages-for-resend')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:reset-messages-for-resend] Expected ResetMessagesForResendResponse object'
        )
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!RESET_RESEND_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:reset-messages-for-resend] Unknown key in success value: "${key}"`
          )
        }
      }
      validateStringArray(v.affectedFileIds, 'result.value.affectedFileIds')
      validateJsonObject(v.remainingReferenceCounts, 'result.value.remainingReferenceCounts')
      const counts = v.remainingReferenceCounts as Record<string, unknown>
      for (const key of Object.keys(counts)) {
        if (key.length === 0) {
          throw new ValidationError(
            'result.value.remainingReferenceCounts',
            '[chatdb:reset-messages-for-resend] remainingReferenceCounts key must be a non-empty string'
          )
        }
        validateNonNegativeInteger(counts[key], `result.value.remainingReferenceCounts.${key}`)
      }
      if (!Array.isArray(v.attempts)) {
        throw new ValidationError('result.value.attempts', '[chatdb:reset-messages-for-resend] Expected attempts array')
      }
      const seen = new Set<string>()
      for (let i = 0; i < (v.attempts as unknown[]).length; i++) {
        const entry = (v.attempts as unknown[])[i]
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new ValidationError(
            `result.value.attempts[${i}]`,
            '[chatdb:reset-messages-for-resend] Expected attempt mapping object'
          )
        }
        const rec = entry as Record<string, unknown>
        for (const key of Object.keys(rec)) {
          if (!RESET_RESEND_ATTEMPT_KEYS.has(key)) {
            throw new ValidationError(
              `result.value.attempts[${i}].${key}`,
              `[chatdb:reset-messages-for-resend] Unknown key in attempt mapping: "${key}"`
            )
          }
        }
        validateNonEmptyString(rec.messageId, `result.value.attempts[${i}].messageId`)
        const attemptId = rec.attemptId
        if (typeof attemptId !== 'string' || attemptId.length < 1 || attemptId.length > 256) {
          throw new ValidationError(
            `result.value.attempts[${i}].attemptId`,
            '[chatdb:reset-messages-for-resend] Expected a non-empty string up to 256 characters'
          )
        }
        if (attemptId.includes(':')) {
          throw new ValidationError(
            `result.value.attempts[${i}].attemptId`,
            '[chatdb:reset-messages-for-resend] Attempt id must not contain ":"'
          )
        }
        if (/[\uD800-\uDFFF]/.test(attemptId)) {
          throw new ValidationError(
            `result.value.attempts[${i}].attemptId`,
            '[chatdb:reset-messages-for-resend] Attempt id must not contain lone surrogates'
          )
        }
        const mid = rec.messageId as string
        if (seen.has(mid)) {
          throw new ValidationError(
            `result.value.attempts[${i}].messageId`,
            '[chatdb:reset-messages-for-resend] Duplicate attempt messageId'
          )
        }
        seen.add(mid)
      }
    }
  }
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

const DELETE_WITH_DEPENDENTS_VALUE_KEYS = new Set([
  'affectedFileIds',
  'remainingReferenceCounts',
  'deletedMessageIds',
  'deletedBlockIds',
  'previousUserMessageIds',
  'remainingUserMessageIds',
  'segments',
  'restoreGroups',
  'segmentSnapshots'
])
const DELETE_WITH_DEPENDENTS_SEGMENT_KEYS = new Set([
  'id',
  'topicId',
  'name',
  'messageIds',
  'color',
  'createdAt',
  'updatedAt'
])
const DELETE_WITH_DEPENDENTS_RESTORE_GROUP_KEYS = new Set(['entries', 'positionIndex', 'anchorMessageId'])
const DELETE_WITH_DEPENDENTS_RESTORE_ENTRY_KEYS = new Set(['message', 'blocks'])

const DELETE_WITH_DEPENDENTS_CHANNEL = 'chatdb:delete-messages-with-dependents'

/**
 * Strict SegmentWire validator shared by the post-delete catalog and the
 * pre-delete affected snapshots (same shape, same unknown-key fail-closed).
 */
function validateDependentsSegmentWire(seg: unknown, path: string): string {
  if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) {
    throw new ValidationError(path, `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Expected segment object`)
  }
  const rec = seg as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    if (!DELETE_WITH_DEPENDENTS_SEGMENT_KEYS.has(key)) {
      throw new ValidationError(
        `${path}.${key}`,
        `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Unknown key in segment: "${key}"`
      )
    }
  }
  validateNonEmptyString(rec.id, `${path}.id`)
  validateNonEmptyString(rec.topicId, `${path}.topicId`)
  if (rec.name !== null && rec.name !== undefined && typeof rec.name !== 'string') {
    throw new ValidationError(`${path}.name`, `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Expected string|null for name`)
  }
  if (!Array.isArray(rec.messageIds)) {
    throw new ValidationError(`${path}.messageIds`, `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Expected messageIds array`)
  }
  {
    const seenMsg = new Set<string>()
    const mids = rec.messageIds as unknown[]
    for (let j = 0; j < mids.length; j++) {
      const mid = mids[j]
      if (typeof mid !== 'string' || mid.length === 0) {
        throw new ValidationError(`${path}.messageIds[${j}]`, 'Expected a non-empty string')
      }
      if (seenMsg.has(mid)) {
        throw new ValidationError(
          `${path}.messageIds[${j}]`,
          `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Duplicate segment messageId`
        )
      }
      seenMsg.add(mid)
    }
  }
  if (rec.color !== undefined && rec.color !== null && typeof rec.color !== 'string') {
    throw new ValidationError(`${path}.color`, `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Expected string|null for color`)
  }
  if (rec.createdAt !== null && rec.createdAt !== undefined && typeof rec.createdAt !== 'string') {
    throw new ValidationError(
      `${path}.createdAt`,
      `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Expected string|null for createdAt`
    )
  }
  if (rec.updatedAt !== null && rec.updatedAt !== undefined && typeof rec.updatedAt !== 'string') {
    throw new ValidationError(
      `${path}.updatedAt`,
      `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Expected string|null for updatedAt`
    )
  }
  return rec.id as string
}

const deleteMessagesWithDependentsContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'messageIds'),
  validate(value: unknown): void {
    validateRequest(value, deleteMessagesWithDependentsContract.allowedKeys)
    const req = value as DeleteMessagesWithDependentsRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (!Array.isArray(req.messageIds) || req.messageIds.length === 0) {
      throw new ValidationError('request.messageIds', 'Expected a non-empty array of stable root message IDs')
    }
    const seen = new Set<string>()
    for (let i = 0; i < req.messageIds.length; i++) {
      const id = req.messageIds[i]
      if (typeof id !== 'string' || id.length === 0) {
        throw new ValidationError(`request.messageIds[${i}]`, 'Expected a non-empty string')
      }
      if (seen.has(id)) {
        throw new ValidationError(
          `request.messageIds[${i}]`,
          `[${DELETE_WITH_DEPENDENTS_CHANNEL}] Duplicate root message ID at index ${i}`
        )
      }
      seen.add(id)
    }
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, DELETE_WITH_DEPENDENTS_CHANNEL)
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:delete-messages-with-dependents] Expected DeleteMessagesWithDependentsResponse object'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError(
          'result.value',
          '[chatdb:delete-messages-with-dependents] Success value must be a plain object'
        )
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!DELETE_WITH_DEPENDENTS_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:delete-messages-with-dependents] Unknown key in success value: "${key}"`
          )
        }
      }
      validateStringArray(v.affectedFileIds, 'result.value.affectedFileIds')
      validateJsonObject(v.remainingReferenceCounts, 'result.value.remainingReferenceCounts')
      const counts = v.remainingReferenceCounts as Record<string, unknown>
      for (const key of Object.keys(counts)) {
        if (key.length === 0) {
          throw new ValidationError(
            'result.value.remainingReferenceCounts',
            '[chatdb:delete-messages-with-dependents] remainingReferenceCounts key must be a non-empty string'
          )
        }
        validateNonNegativeInteger(counts[key], `result.value.remainingReferenceCounts.${key}`)
      }
      // deletedMessageIds: non-empty unique IDs (semantic delete always deletes at least one root).
      if (!Array.isArray(v.deletedMessageIds) || (v.deletedMessageIds as unknown[]).length === 0) {
        throw new ValidationError(
          'result.value.deletedMessageIds',
          '[chatdb:delete-messages-with-dependents] deletedMessageIds must be a non-empty array'
        )
      }
      const deletedSet = new Set<string>()
      {
        const arr = v.deletedMessageIds as unknown[]
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i]
          if (typeof id !== 'string' || id.length === 0) {
            throw new ValidationError(`result.value.deletedMessageIds[${i}]`, 'Expected a non-empty string')
          }
          if (deletedSet.has(id)) {
            throw new ValidationError(
              `result.value.deletedMessageIds[${i}]`,
              '[chatdb:delete-messages-with-dependents] Duplicate deletedMessageId'
            )
          }
          deletedSet.add(id)
        }
      }
      // deletedBlockIds: array (may be empty), unique non-empty strings.
      if (!Array.isArray(v.deletedBlockIds)) {
        throw new ValidationError(
          'result.value.deletedBlockIds',
          '[chatdb:delete-messages-with-dependents] Expected deletedBlockIds array'
        )
      }
      {
        const seen = new Set<string>()
        const arr = v.deletedBlockIds as unknown[]
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i]
          if (typeof id !== 'string' || id.length === 0) {
            throw new ValidationError(`result.value.deletedBlockIds[${i}]`, 'Expected a non-empty string')
          }
          if (seen.has(id)) {
            throw new ValidationError(
              `result.value.deletedBlockIds[${i}]`,
              '[chatdb:delete-messages-with-dependents] Duplicate deletedBlockId'
            )
          }
          seen.add(id)
        }
      }
      // previous/remaining user IDs: arrays (remaining may be empty), unique shape only.
      for (const key of ['previousUserMessageIds', 'remainingUserMessageIds'] as const) {
        if (!Array.isArray(v[key])) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:delete-messages-with-dependents] Expected ${key} array`
          )
        }
        const seen = new Set<string>()
        const arr = v[key] as unknown[]
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i]
          if (typeof id !== 'string' || id.length === 0) {
            throw new ValidationError(`result.value.${key}[${i}]`, 'Expected a non-empty string')
          }
          if (seen.has(id)) {
            throw new ValidationError(
              `result.value.${key}[${i}]`,
              `[chatdb:delete-messages-with-dependents] Duplicate ${key} entry`
            )
          }
          seen.add(id)
        }
      }
      // segments: complete post-delete catalog array (may be empty), strict SegmentWire shapes.
      if (!Array.isArray(v.segments)) {
        throw new ValidationError(
          'result.value.segments',
          '[chatdb:delete-messages-with-dependents] Expected segments array'
        )
      }
      {
        const seenSeg = new Set<string>()
        const segs = v.segments as unknown[]
        for (let i = 0; i < segs.length; i++) {
          const sid = validateDependentsSegmentWire(segs[i], `result.value.segments[${i}]`)
          if (seenSeg.has(sid)) {
            throw new ValidationError(
              `result.value.segments[${i}].id`,
              '[chatdb:delete-messages-with-dependents] Duplicate segment id'
            )
          }
          seenSeg.add(sid)
        }
      }
      // segmentSnapshots: pre-delete full snapshots of affected segments (may be empty).
      if (!Array.isArray(v.segmentSnapshots)) {
        throw new ValidationError(
          'result.value.segmentSnapshots',
          '[chatdb:delete-messages-with-dependents] Expected segmentSnapshots array'
        )
      }
      {
        const seenSnap = new Set<string>()
        const snaps = v.segmentSnapshots as unknown[]
        for (let i = 0; i < snaps.length; i++) {
          const sid = validateDependentsSegmentWire(snaps[i], `result.value.segmentSnapshots[${i}]`)
          if (seenSnap.has(sid)) {
            throw new ValidationError(
              `result.value.segmentSnapshots[${i}].id`,
              '[chatdb:delete-messages-with-dependents] Duplicate segment snapshot id'
            )
          }
          seenSnap.add(sid)
        }
      }
      // restoreGroups: non-empty ordered contiguous restore groups covering exactly the deleted set.
      if (!Array.isArray(v.restoreGroups) || (v.restoreGroups as unknown[]).length === 0) {
        throw new ValidationError(
          'result.value.restoreGroups',
          '[chatdb:delete-messages-with-dependents] restoreGroups must be a non-empty array'
        )
      }
      {
        const covered = new Set<string>()
        const groups = v.restoreGroups as unknown[]
        for (let i = 0; i < groups.length; i++) {
          const gpath = `result.value.restoreGroups[${i}]`
          const group = groups[i] as Record<string, unknown>
          if (group === null || typeof group !== 'object' || Array.isArray(group)) {
            throw new ValidationError(gpath, '[chatdb:delete-messages-with-dependents] Expected restore group object')
          }
          for (const key of Object.keys(group)) {
            if (!DELETE_WITH_DEPENDENTS_RESTORE_GROUP_KEYS.has(key)) {
              throw new ValidationError(
                `${gpath}.${key}`,
                `[chatdb:delete-messages-with-dependents] Unknown key in restore group: "${key}"`
              )
            }
          }
          if (!Array.isArray(group.entries) || (group.entries as unknown[]).length === 0) {
            throw new ValidationError(
              `${gpath}.entries`,
              '[chatdb:delete-messages-with-dependents] Restore group entries must be a non-empty array'
            )
          }
          validateNonNegativeInteger(group.positionIndex, `${gpath}.positionIndex`)
          if (group.anchorMessageId !== null) {
            if (typeof group.anchorMessageId !== 'string' || group.anchorMessageId.length === 0) {
              throw new ValidationError(
                `${gpath}.anchorMessageId`,
                '[chatdb:delete-messages-with-dependents] Expected a non-empty string or null for anchorMessageId'
              )
            }
            if (deletedSet.has(group.anchorMessageId)) {
              throw new ValidationError(
                `${gpath}.anchorMessageId`,
                '[chatdb:delete-messages-with-dependents] Anchor must be a surviving message'
              )
            }
          }
          const entries = group.entries as unknown[]
          for (let j = 0; j < entries.length; j++) {
            const epath = `${gpath}.entries[${j}]`
            const entry = entries[j] as Record<string, unknown>
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
              throw new ValidationError(epath, '[chatdb:delete-messages-with-dependents] Expected restore entry object')
            }
            for (const key of Object.keys(entry)) {
              if (!DELETE_WITH_DEPENDENTS_RESTORE_ENTRY_KEYS.has(key)) {
                throw new ValidationError(
                  `${epath}.${key}`,
                  `[chatdb:delete-messages-with-dependents] Unknown key in restore entry: "${key}"`
                )
              }
            }
            validateJsonObject(entry.message, `${epath}.message`)
            if (!Array.isArray(entry.blocks)) {
              throw new ValidationError(
                `${epath}.blocks`,
                '[chatdb:delete-messages-with-dependents] Expected blocks array in restore entry'
              )
            }
            validateJsonObjectArray(entry.blocks, `${epath}.blocks`)
            const mid = (entry.message as Record<string, unknown>).id
            if (typeof mid !== 'string' || mid.length === 0) {
              throw new ValidationError(
                `${epath}.message.id`,
                '[chatdb:delete-messages-with-dependents] Restore entry message must carry a non-empty id'
              )
            }
            if (!deletedSet.has(mid)) {
              throw new ValidationError(
                `${epath}.message.id`,
                '[chatdb:delete-messages-with-dependents] Restore entry message is not in deletedMessageIds'
              )
            }
            if (covered.has(mid)) {
              throw new ValidationError(
                `${epath}.message.id`,
                '[chatdb:delete-messages-with-dependents] Duplicate restore entry message id'
              )
            }
            covered.add(mid)
          }
        }
        if (covered.size !== deletedSet.size) {
          throw new ValidationError(
            'result.value.restoreGroups',
            '[chatdb:delete-messages-with-dependents] Restore groups must cover exactly the deletedMessageIds set'
          )
        }
      }
    }
  }
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
// S6.1: Windowed read contract — R-02 latest / R-03 around (typed window)
// ---------------------------------------------------------------------------

function validateBoundedCount(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new ValidationError(path, 'Expected an integer between 1 and 100')
  }
}

const FETCH_MESSAGES_WINDOW_VALUE_KEYS = new Set(['messages', 'blocks', 'window'])
const FETCH_MESSAGES_WINDOW_META_KEYS = new Set([
  'kind',
  'completeness',
  'topicId',
  'anchorMessageId',
  'requested',
  'firstMessageId',
  'lastMessageId',
  'returnedCount',
  'hasMoreBefore',
  'hasMoreAfter'
])
const FETCH_MESSAGES_WINDOW_REQUESTED_KEYS = new Set(['limit', 'before', 'after'])

const fetchMessagesWindowContract: ChatDbContract = {
  allowedKeys: keySet('kind', 'topicId', 'limit', 'anchorMessageId', 'before', 'after'),
  validate(value: unknown): void {
    validateRequest(value, fetchMessagesWindowContract.allowedKeys)
    const req = value as FetchMessagesWindowRequest & Record<string, unknown>
    if (req.kind !== 'latest' && req.kind !== 'around') {
      throw new ValidationError('request.kind', 'Expected "latest" or "around"')
    }
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (req.kind === 'latest') {
      if ('anchorMessageId' in req || 'before' in req || 'after' in req) {
        throw new ValidationError('request', 'Latest window must not contain anchorMessageId, before, or after')
      }
      if (req.limit === undefined) {
        throw new ValidationError('request.limit', 'Expected an integer between 1 and 100')
      }
      validateBoundedCount(req.limit, 'request.limit')
    } else {
      // around
      if ('limit' in req) {
        throw new ValidationError('request', 'Around window must not contain limit')
      }
      validateNonEmptyString(req.anchorMessageId as unknown as string, 'request.anchorMessageId')
      if (req.before === undefined) {
        throw new ValidationError('request.before', 'Expected an integer between 1 and 100')
      }
      if (req.after === undefined) {
        throw new ValidationError('request.after', 'Expected an integer between 1 and 100')
      }
      validateBoundedCount(req.before, 'request.before')
      validateBoundedCount(req.after, 'request.after')
    }
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:fetch-messages-window', { skipValueValidation: true })
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-messages-window] Expected object with messages, blocks, window'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', '[chatdb:fetch-messages-window] Success value must be a plain object')
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_MESSAGES_WINDOW_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:fetch-messages-window] Unknown key in success value: "${key}"`
          )
        }
      }
      // messages / blocks
      validateJsonObjectArray(v.messages, 'result.value.messages')
      validateJsonObjectArrayBlock(v.blocks, 'result.value.blocks', BLOCK_JSON_PROFILE)
      // window meta
      if (v.window === null || typeof v.window !== 'object' || Array.isArray(v.window)) {
        throw new ValidationError('result.value.window', '[chatdb:fetch-messages-window] Expected window object')
      }
      const w = v.window as Record<string, unknown>
      for (const key of Object.keys(w)) {
        if (!FETCH_MESSAGES_WINDOW_META_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.window.${key}`,
            `[chatdb:fetch-messages-window] Unknown key in window: "${key}"`
          )
        }
      }
      if (w.kind !== 'latest' && w.kind !== 'around') {
        throw new ValidationError(
          'result.value.window.kind',
          '[chatdb:fetch-messages-window] Expected "latest" or "around"'
        )
      }
      if (w.completeness !== 'window') {
        throw new ValidationError(
          'result.value.window.completeness',
          '[chatdb:fetch-messages-window] Expected completeness "window"'
        )
      }
      validateNonEmptyString(w.topicId, 'result.value.window.topicId')
      if (w.anchorMessageId !== undefined && w.anchorMessageId !== null) {
        validateNonEmptyString(w.anchorMessageId, 'result.value.window.anchorMessageId')
      }
      if (w.requested === null || typeof w.requested !== 'object' || Array.isArray(w.requested)) {
        throw new ValidationError(
          'result.value.window.requested',
          '[chatdb:fetch-messages-window] Expected requested object'
        )
      }
      const rq = w.requested as Record<string, unknown>
      for (const key of Object.keys(rq)) {
        if (!FETCH_MESSAGES_WINDOW_REQUESTED_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.window.requested.${key}`,
            `[chatdb:fetch-messages-window] Unknown key in requested: "${key}"`
          )
        }
      }
      // LOCK-S6.1-003/004: strict per-kind requested validation — reject
      // kind/requested mismatch, empty requested, or missing required bounds.
      if (w.kind === 'latest') {
        if (!('limit' in rq)) {
          throw new ValidationError(
            'result.value.window.requested.limit',
            '[chatdb:fetch-messages-window] Latest window must have requested.limit'
          )
        }
        if ('before' in rq || 'after' in rq) {
          throw new ValidationError(
            'result.value.window.requested',
            '[chatdb:fetch-messages-window] Latest window must not have before/after'
          )
        }
        validateBoundedCount(rq.limit, 'result.value.window.requested.limit')
        if (Object.keys(rq).length !== 1) {
          throw new ValidationError(
            'result.value.window.requested',
            '[chatdb:fetch-messages-window] Latest window requested must have exactly limit'
          )
        }
      } else {
        // around
        if (!('before' in rq) || !('after' in rq)) {
          throw new ValidationError(
            'result.value.window.requested',
            '[chatdb:fetch-messages-window] Around window must have requested.before and requested.after'
          )
        }
        if ('limit' in rq) {
          throw new ValidationError(
            'result.value.window.requested',
            '[chatdb:fetch-messages-window] Around window must not have limit'
          )
        }
        validateBoundedCount(rq.before, 'result.value.window.requested.before')
        validateBoundedCount(rq.after, 'result.value.window.requested.after')
        if (Object.keys(rq).length !== 2) {
          throw new ValidationError(
            'result.value.window.requested',
            '[chatdb:fetch-messages-window] Around window requested must have exactly before and after'
          )
        }
      }
      if (w.firstMessageId !== null) {
        validateNonEmptyString(w.firstMessageId, 'result.value.window.firstMessageId')
      }
      if (w.lastMessageId !== null) {
        validateNonEmptyString(w.lastMessageId, 'result.value.window.lastMessageId')
      }
      if (
        typeof w.returnedCount !== 'number' ||
        !Number.isFinite(w.returnedCount) ||
        !Number.isInteger(w.returnedCount) ||
        w.returnedCount < 0
      ) {
        throw new ValidationError(
          'result.value.window.returnedCount',
          '[chatdb:fetch-messages-window] Expected non-negative integer returnedCount'
        )
      }
      if (typeof w.hasMoreBefore !== 'boolean') {
        throw new ValidationError(
          'result.value.window.hasMoreBefore',
          '[chatdb:fetch-messages-window] Expected boolean hasMoreBefore'
        )
      }
      if (typeof w.hasMoreAfter !== 'boolean') {
        throw new ValidationError(
          'result.value.window.hasMoreAfter',
          '[chatdb:fetch-messages-window] Expected boolean hasMoreAfter'
        )
      }
      // Consistency: empty implies null bounds
      if (w.returnedCount === 0) {
        if (w.firstMessageId !== null || w.lastMessageId !== null) {
          throw new ValidationError(
            'result.value.window',
            '[chatdb:fetch-messages-window] Empty window must have null first/lastMessageId'
          )
        }
      } else {
        if (w.firstMessageId === null || w.lastMessageId === null) {
          throw new ValidationError(
            'result.value.window',
            '[chatdb:fetch-messages-window] Non-empty window must have first/lastMessageId'
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// S6.2b R-05: Answer-group READ contract — authoritative fetch-answer-group
// ---------------------------------------------------------------------------

const FETCH_ANSWER_GROUP_VALUE_KEYS = new Set(['completeness', 'topicId', 'anchorMessageId', 'askId', 'messageIds'])

const fetchAnswerGroupContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'anchorMessageId'),
  validate(value: unknown): void {
    validateRequest(value, fetchAnswerGroupContract.allowedKeys)
    const req = value as FetchAnswerGroupRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.anchorMessageId, 'request.anchorMessageId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:fetch-answer-group')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-answer-group] Expected object with completeness, topicId, anchorMessageId, askId, messageIds'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', '[chatdb:fetch-answer-group] Success value must be a plain object')
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_ANSWER_GROUP_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:fetch-answer-group] Unknown key in success value: "${key}"`
          )
        }
      }
      if (v.completeness !== 'answer-group') {
        throw new ValidationError(
          'result.value.completeness',
          '[chatdb:fetch-answer-group] Expected completeness "answer-group"'
        )
      }
      validateNonEmptyString(v.topicId, 'result.value.topicId')
      validateNonEmptyString(v.anchorMessageId, 'result.value.anchorMessageId')
      validateNonEmptyString(v.askId, 'result.value.askId')
      if (!Array.isArray(v.messageIds)) {
        throw new ValidationError('result.value.messageIds', '[chatdb:fetch-answer-group] Expected array of messageIds')
      }
      if (v.messageIds.length === 0) {
        throw new ValidationError('result.value.messageIds', '[chatdb:fetch-answer-group] messageIds must not be empty')
      }
      const seen = new Set<string>()
      let anchorFound = false
      for (let i = 0; i < (v.messageIds as unknown[]).length; i++) {
        const id = (v.messageIds as unknown[])[i]
        if (typeof id !== 'string' || id.length === 0) {
          throw new ValidationError(`result.value.messageIds[${i}]`, 'Expected a non-empty string')
        }
        if (seen.has(id)) {
          throw new ValidationError(
            `result.value.messageIds[${i}]`,
            `[chatdb:fetch-answer-group] Duplicate messageId at index ${i}`
          )
        }
        seen.add(id)
        if (id === v.anchorMessageId) anchorFound = true
      }
      if (!anchorFound) {
        throw new ValidationError(
          'result.value.messageIds',
          '[chatdb:fetch-answer-group] messageIds must include anchorMessageId'
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// S6.3 R-06: Context closure READ — anchor through newest (distinct completeness)
// ---------------------------------------------------------------------------

const FETCH_CONTEXT_CLOSURE_VALUE_KEYS = new Set(['messages', 'blocks', 'closure'])
const FETCH_CONTEXT_CLOSURE_CLOSURE_KEYS = new Set([
  'completeness',
  'topicId',
  'anchorGroupKey',
  'firstMessageId',
  'lastMessageId',
  'returnedCount',
  'totalTurnCount',
  'selectedTurnCount',
  'boundaryMessageId'
])

const fetchContextClosureContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'anchorGroupKey'),
  validate(value: unknown): void {
    validateRequest(value, fetchContextClosureContract.allowedKeys)
    const req = value as FetchContextClosureRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.anchorGroupKey, 'request.anchorGroupKey')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:fetch-context-closure', { skipValueValidation: true })
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-context-closure] Expected object with messages, blocks, closure'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', '[chatdb:fetch-context-closure] Success value must be a plain object')
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_CONTEXT_CLOSURE_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:fetch-context-closure] Unknown key in success value: "${key}"`
          )
        }
      }
      validateJsonObjectArray(v.messages, 'result.value.messages')
      validateJsonObjectArrayBlock(v.blocks, 'result.value.blocks', BLOCK_JSON_PROFILE)
      if (v.closure === null || typeof v.closure !== 'object' || Array.isArray(v.closure)) {
        throw new ValidationError('result.value.closure', '[chatdb:fetch-context-closure] Expected closure object')
      }
      const cProto = Object.getPrototypeOf(v.closure)
      if (cProto !== Object.prototype && cProto !== null) {
        throw new ValidationError(
          'result.value.closure',
          '[chatdb:fetch-context-closure] Success closure must be a plain object'
        )
      }
      const c = v.closure as Record<string, unknown>
      for (const key of Object.keys(c)) {
        if (!FETCH_CONTEXT_CLOSURE_CLOSURE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.closure.${key}`,
            `[chatdb:fetch-context-closure] Unknown key in closure: "${key}"`
          )
        }
      }
      if (c.completeness !== 'context-closure') {
        throw new ValidationError(
          'result.value.closure.completeness',
          '[chatdb:fetch-context-closure] Expected completeness "context-closure"'
        )
      }
      validateNonEmptyString(c.topicId, 'result.value.closure.topicId')
      validateNonEmptyString(c.anchorGroupKey, 'result.value.closure.anchorGroupKey')
      if (c.firstMessageId !== null) {
        validateNonEmptyString(c.firstMessageId, 'result.value.closure.firstMessageId')
      }
      if (c.lastMessageId !== null) {
        validateNonEmptyString(c.lastMessageId, 'result.value.closure.lastMessageId')
      }
      if (
        typeof c.returnedCount !== 'number' ||
        !Number.isFinite(c.returnedCount) ||
        !Number.isInteger(c.returnedCount) ||
        c.returnedCount < 0
      ) {
        throw new ValidationError(
          'result.value.closure.returnedCount',
          '[chatdb:fetch-context-closure] Expected non-negative integer returnedCount'
        )
      }
      const msgs = v.messages as unknown[]
      if (c.returnedCount !== msgs.length) {
        throw new ValidationError(
          'result.value.closure.returnedCount',
          '[chatdb:fetch-context-closure] returnedCount must equal messages length'
        )
      }
      // S6.3 audit: a valid anchor-based closure must never be an empty success.
      // Missing topic or unresolved anchor is typed NOT_FOUND; an empty success
      // with supplied anchorGroupKey / null bounds is always a contract violation.
      if (c.returnedCount === 0) {
        throw new ValidationError(
          'result.value.closure.returnedCount',
          '[chatdb:fetch-context-closure] Empty closure with supplied anchorGroupKey is not a valid success; use NOT_FOUND'
        )
      }
      if (c.firstMessageId === null || c.lastMessageId === null) {
        throw new ValidationError(
          'result.value.closure',
          '[chatdb:fetch-context-closure] Non-empty closure must have first/lastMessageId'
        )
      }
      {
        const firstId = (msgs[0] as Record<string, unknown>).id
        const lastId = (msgs[msgs.length - 1] as Record<string, unknown>).id
        if (c.firstMessageId !== firstId) {
          throw new ValidationError(
            'result.value.closure.firstMessageId',
            '[chatdb:fetch-context-closure] firstMessageId must match first message id'
          )
        }
        if (c.lastMessageId !== lastId) {
          throw new ValidationError(
            'result.value.closure.lastMessageId',
            '[chatdb:fetch-context-closure] lastMessageId must match last message id'
          )
        }
      }
      // LOCK-001: authoritative counts and boundary — integer >=1, selected<=total, boundary null iff selected===total else non-empty and exactly firstMessageId
      if (
        typeof c.totalTurnCount !== 'number' ||
        !Number.isFinite(c.totalTurnCount) ||
        !Number.isInteger(c.totalTurnCount) ||
        c.totalTurnCount < 1
      ) {
        throw new ValidationError(
          'result.value.closure.totalTurnCount',
          '[chatdb:fetch-context-closure] Expected integer totalTurnCount >=1'
        )
      }
      if (
        typeof c.selectedTurnCount !== 'number' ||
        !Number.isFinite(c.selectedTurnCount) ||
        !Number.isInteger(c.selectedTurnCount) ||
        c.selectedTurnCount < 1
      ) {
        throw new ValidationError(
          'result.value.closure.selectedTurnCount',
          '[chatdb:fetch-context-closure] Expected integer selectedTurnCount >=1'
        )
      }
      if (c.selectedTurnCount > c.totalTurnCount) {
        throw new ValidationError(
          'result.value.closure.selectedTurnCount',
          '[chatdb:fetch-context-closure] selectedTurnCount must be <= totalTurnCount'
        )
      }
      if (c.selectedTurnCount === c.totalTurnCount) {
        if (c.boundaryMessageId !== null) {
          throw new ValidationError(
            'result.value.closure.boundaryMessageId',
            '[chatdb:fetch-context-closure] boundaryMessageId must be null when selected===total (whole-topic)'
          )
        }
      } else {
        if (typeof c.boundaryMessageId !== 'string' || c.boundaryMessageId.length === 0) {
          throw new ValidationError(
            'result.value.closure.boundaryMessageId',
            '[chatdb:fetch-context-closure] boundaryMessageId must be non-empty string when selected<total (partial)'
          )
        }
        if (c.boundaryMessageId !== c.firstMessageId) {
          throw new ValidationError(
            'result.value.closure.boundaryMessageId',
            '[chatdb:fetch-context-closure] boundaryMessageId must equal firstMessageId when partial'
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-topic snapshot READ — one-shot export/knowledge snapshot (distinct completeness)
// ---------------------------------------------------------------------------

const FETCH_WHOLE_TOPIC_SNAPSHOT_VALUE_KEYS = new Set(['messages', 'blocks', 'snapshot'])
const FETCH_WHOLE_TOPIC_SNAPSHOT_META_KEYS = new Set([
  'completeness',
  'topicId',
  'firstMessageId',
  'lastMessageId',
  'returnedCount'
])

const fetchWholeTopicSnapshotContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, fetchWholeTopicSnapshotContract.allowedKeys)
    const req = value as FetchWholeTopicSnapshotRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:fetch-whole-topic-snapshot', { skipValueValidation: true })
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-whole-topic-snapshot] Expected object with messages, blocks, snapshot'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-whole-topic-snapshot] Success value must be a plain object'
        )
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_WHOLE_TOPIC_SNAPSHOT_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:fetch-whole-topic-snapshot] Unknown key in success value: "${key}"`
          )
        }
      }
      validateJsonObjectArray(v.messages, 'result.value.messages')
      validateJsonObjectArrayBlock(v.blocks, 'result.value.blocks', BLOCK_JSON_PROFILE)
      if (v.snapshot === null || typeof v.snapshot !== 'object' || Array.isArray(v.snapshot)) {
        throw new ValidationError(
          'result.value.snapshot',
          '[chatdb:fetch-whole-topic-snapshot] Expected snapshot object'
        )
      }
      const sProto = Object.getPrototypeOf(v.snapshot)
      if (sProto !== Object.prototype && sProto !== null) {
        throw new ValidationError(
          'result.value.snapshot',
          '[chatdb:fetch-whole-topic-snapshot] Success snapshot must be a plain object'
        )
      }
      const s = v.snapshot as Record<string, unknown>
      for (const key of Object.keys(s)) {
        if (!FETCH_WHOLE_TOPIC_SNAPSHOT_META_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.snapshot.${key}`,
            `[chatdb:fetch-whole-topic-snapshot] Unknown key in snapshot: "${key}"`
          )
        }
      }
      if (s.completeness !== 'whole-topic') {
        throw new ValidationError(
          'result.value.snapshot.completeness',
          '[chatdb:fetch-whole-topic-snapshot] Expected completeness "whole-topic"'
        )
      }
      validateNonEmptyString(s.topicId, 'result.value.snapshot.topicId')
      if (s.firstMessageId !== null) {
        validateNonEmptyString(s.firstMessageId, 'result.value.snapshot.firstMessageId')
      }
      if (s.lastMessageId !== null) {
        validateNonEmptyString(s.lastMessageId, 'result.value.snapshot.lastMessageId')
      }
      if (
        typeof s.returnedCount !== 'number' ||
        !Number.isFinite(s.returnedCount) ||
        !Number.isInteger(s.returnedCount) ||
        s.returnedCount < 0
      ) {
        throw new ValidationError(
          'result.value.snapshot.returnedCount',
          '[chatdb:fetch-whole-topic-snapshot] Expected non-negative integer returnedCount'
        )
      }
      const msgs = v.messages as unknown[]
      if (s.returnedCount !== msgs.length) {
        throw new ValidationError(
          'result.value.snapshot.returnedCount',
          '[chatdb:fetch-whole-topic-snapshot] returnedCount must equal messages length'
        )
      }
      if (s.returnedCount === 0) {
        if (s.firstMessageId !== null || s.lastMessageId !== null) {
          throw new ValidationError(
            'result.value.snapshot',
            '[chatdb:fetch-whole-topic-snapshot] Empty snapshot must have null first/lastMessageId'
          )
        }
      } else {
        if (s.firstMessageId === null || s.lastMessageId === null) {
          throw new ValidationError(
            'result.value.snapshot',
            '[chatdb:fetch-whole-topic-snapshot] Non-empty snapshot must have first/lastMessageId'
          )
        }
        const firstId = (msgs[0] as Record<string, unknown>).id
        const lastId = (msgs[msgs.length - 1] as Record<string, unknown>).id
        if (s.firstMessageId !== firstId) {
          throw new ValidationError(
            'result.value.snapshot.firstMessageId',
            '[chatdb:fetch-whole-topic-snapshot] firstMessageId must match first message id'
          )
        }
        if (s.lastMessageId !== lastId) {
          throw new ValidationError(
            'result.value.snapshot.lastMessageId',
            '[chatdb:fetch-whole-topic-snapshot] lastMessageId must match last message id'
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded naming/activity authority reads — never whole-topic
// ---------------------------------------------------------------------------

const FETCH_TOPIC_NAMING_CONTEXT_VALUE_KEYS = new Set([
  'topic',
  'messageCount',
  'firstMessage',
  'latestMessages',
  'blocks',
  'naming'
])
const FETCH_TOPIC_NAMING_CONTEXT_TOPIC_KEYS = new Set(['id', 'name', 'isNameManuallyEdited'])
const FETCH_TOPIC_NAMING_CONTEXT_META_KEYS = new Set([
  'completeness',
  'topicId',
  'firstMessageId',
  'lastMessageId',
  'returnedLatestCount'
])

const fetchTopicNamingContextContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, fetchTopicNamingContextContract.allowedKeys)
    const req = value as FetchTopicNamingContextRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:fetch-topic-naming-context', { skipValueValidation: true })
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-topic-naming-context] Expected object with topic, messageCount, firstMessage, latestMessages, blocks, naming'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-topic-naming-context] Success value must be a plain object'
        )
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_TOPIC_NAMING_CONTEXT_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:fetch-topic-naming-context] Unknown key in success value: "${key}"`
          )
        }
      }
      // Authority topic naming metadata (id + name + manual-edit flag only).
      if (v.topic === null || typeof v.topic !== 'object' || Array.isArray(v.topic)) {
        throw new ValidationError('result.value.topic', '[chatdb:fetch-topic-naming-context] Expected topic object')
      }
      const tProto = Object.getPrototypeOf(v.topic)
      if (tProto !== Object.prototype && tProto !== null) {
        throw new ValidationError(
          'result.value.topic',
          '[chatdb:fetch-topic-naming-context] Success topic must be a plain object'
        )
      }
      const t = v.topic as Record<string, unknown>
      for (const key of Object.keys(t)) {
        if (!FETCH_TOPIC_NAMING_CONTEXT_TOPIC_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.topic.${key}`,
            `[chatdb:fetch-topic-naming-context] Unknown key in topic: "${key}"`
          )
        }
      }
      validateNonEmptyString(t.id, 'result.value.topic.id')
      if (t.name !== null && typeof t.name !== 'string') {
        throw new ValidationError(
          'result.value.topic.name',
          '[chatdb:fetch-topic-naming-context] Expected string|null for name'
        )
      }
      if (t.isNameManuallyEdited !== null && typeof t.isNameManuallyEdited !== 'boolean') {
        throw new ValidationError(
          'result.value.topic.isNameManuallyEdited',
          '[chatdb:fetch-topic-naming-context] Expected boolean|null for isNameManuallyEdited'
        )
      }
      if (
        typeof v.messageCount !== 'number' ||
        !Number.isFinite(v.messageCount) ||
        !Number.isInteger(v.messageCount) ||
        v.messageCount < 0
      ) {
        throw new ValidationError(
          'result.value.messageCount',
          '[chatdb:fetch-topic-naming-context] Expected non-negative integer messageCount'
        )
      }
      if (v.firstMessage !== null) {
        validateJsonObject(v.firstMessage, 'result.value.firstMessage')
      }
      const latest = validateJsonObjectArray(v.latestMessages, 'result.value.latestMessages')
      if (latest.length > 5) {
        throw new ValidationError(
          'result.value.latestMessages',
          '[chatdb:fetch-topic-naming-context] latestMessages must contain at most 5 messages'
        )
      }
      validateJsonObjectArrayBlock(v.blocks, 'result.value.blocks', BLOCK_JSON_PROFILE)
      if (v.naming === null || typeof v.naming !== 'object' || Array.isArray(v.naming)) {
        throw new ValidationError('result.value.naming', '[chatdb:fetch-topic-naming-context] Expected naming object')
      }
      const nProto = Object.getPrototypeOf(v.naming)
      if (nProto !== Object.prototype && nProto !== null) {
        throw new ValidationError(
          'result.value.naming',
          '[chatdb:fetch-topic-naming-context] Success naming must be a plain object'
        )
      }
      const n = v.naming as Record<string, unknown>
      for (const key of Object.keys(n)) {
        if (!FETCH_TOPIC_NAMING_CONTEXT_META_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.naming.${key}`,
            `[chatdb:fetch-topic-naming-context] Unknown key in naming: "${key}"`
          )
        }
      }
      if (n.completeness !== 'naming-context') {
        throw new ValidationError(
          'result.value.naming.completeness',
          '[chatdb:fetch-topic-naming-context] Expected completeness "naming-context"'
        )
      }
      validateNonEmptyString(n.topicId, 'result.value.naming.topicId')
      if (n.firstMessageId !== null) {
        validateNonEmptyString(n.firstMessageId, 'result.value.naming.firstMessageId')
      }
      if (n.lastMessageId !== null) {
        validateNonEmptyString(n.lastMessageId, 'result.value.naming.lastMessageId')
      }
      if (
        typeof n.returnedLatestCount !== 'number' ||
        !Number.isFinite(n.returnedLatestCount) ||
        !Number.isInteger(n.returnedLatestCount) ||
        n.returnedLatestCount < 0 ||
        n.returnedLatestCount > 5
      ) {
        throw new ValidationError(
          'result.value.naming.returnedLatestCount',
          '[chatdb:fetch-topic-naming-context] Expected integer returnedLatestCount in [0, 5]'
        )
      }
      const msgs = v.latestMessages as unknown[]
      if (n.returnedLatestCount !== msgs.length) {
        throw new ValidationError(
          'result.value.naming.returnedLatestCount',
          '[chatdb:fetch-topic-naming-context] returnedLatestCount must equal latestMessages length'
        )
      }
      const messageCount = v.messageCount
      if (n.returnedLatestCount > messageCount) {
        throw new ValidationError(
          'result.value.naming.returnedLatestCount',
          '[chatdb:fetch-topic-naming-context] returnedLatestCount must not exceed messageCount'
        )
      }
      if (messageCount === 0) {
        if (v.firstMessage !== null || msgs.length !== 0) {
          throw new ValidationError(
            'result.value',
            '[chatdb:fetch-topic-naming-context] Empty topic must have null firstMessage and empty latestMessages'
          )
        }
        if (n.firstMessageId !== null || n.lastMessageId !== null) {
          throw new ValidationError(
            'result.value.naming',
            '[chatdb:fetch-topic-naming-context] Empty topic must have null first/lastMessageId'
          )
        }
      } else {
        if (v.firstMessage === null || msgs.length === 0) {
          throw new ValidationError(
            'result.value',
            '[chatdb:fetch-topic-naming-context] Non-empty topic must have firstMessage and latestMessages'
          )
        }
        if (n.firstMessageId === null || n.lastMessageId === null) {
          throw new ValidationError(
            'result.value.naming',
            '[chatdb:fetch-topic-naming-context] Non-empty naming must have first/lastMessageId'
          )
        }
        const firstId = (v.firstMessage as Record<string, unknown>).id
        const lastId = (msgs[msgs.length - 1] as Record<string, unknown>).id
        if (n.firstMessageId !== firstId) {
          throw new ValidationError(
            'result.value.naming.firstMessageId',
            '[chatdb:fetch-topic-naming-context] firstMessageId must match firstMessage id'
          )
        }
        if (n.lastMessageId !== lastId) {
          throw new ValidationError(
            'result.value.naming.lastMessageId',
            '[chatdb:fetch-topic-naming-context] lastMessageId must match last latest message id'
          )
        }
      }
    }
  }
}

const FETCH_TOPIC_ACTIVITY_VALUE_KEYS = new Set([
  'messageCount',
  'latestMessageId',
  'latestMessageCreatedAt',
  'activity'
])
const FETCH_TOPIC_ACTIVITY_META_KEYS = new Set(['completeness', 'topicId'])

const fetchTopicActivityContract: ChatDbContract = {
  allowedKeys: keySet('topicId'),
  validate(value: unknown): void {
    validateRequest(value, fetchTopicActivityContract.allowedKeys)
    const req = value as FetchTopicActivityRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
  },
  validateResult(result: unknown): void {
    validateResultEnvelope(result, 'chatdb:fetch-topic-activity')
    const obj = result as Record<string, unknown>
    if (obj.ok === true) {
      const value = obj.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          'result.value',
          '[chatdb:fetch-topic-activity] Expected object with messageCount, latestMessageId, latestMessageCreatedAt, activity'
        )
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new ValidationError('result.value', '[chatdb:fetch-topic-activity] Success value must be a plain object')
      }
      const v = value as Record<string, unknown>
      for (const key of Object.keys(v)) {
        if (!FETCH_TOPIC_ACTIVITY_VALUE_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.${key}`,
            `[chatdb:fetch-topic-activity] Unknown key in success value: "${key}"`
          )
        }
      }
      if (
        typeof v.messageCount !== 'number' ||
        !Number.isFinite(v.messageCount) ||
        !Number.isInteger(v.messageCount) ||
        v.messageCount < 0
      ) {
        throw new ValidationError(
          'result.value.messageCount',
          '[chatdb:fetch-topic-activity] Expected non-negative integer messageCount'
        )
      }
      if (v.latestMessageId !== null) {
        validateNonEmptyString(v.latestMessageId, 'result.value.latestMessageId')
      }
      if (v.latestMessageCreatedAt !== null) {
        validateNonEmptyString(v.latestMessageCreatedAt, 'result.value.latestMessageCreatedAt')
      }
      if (v.activity === null || typeof v.activity !== 'object' || Array.isArray(v.activity)) {
        throw new ValidationError('result.value.activity', '[chatdb:fetch-topic-activity] Expected activity object')
      }
      const aProto = Object.getPrototypeOf(v.activity)
      if (aProto !== Object.prototype && aProto !== null) {
        throw new ValidationError(
          'result.value.activity',
          '[chatdb:fetch-topic-activity] Success activity must be a plain object'
        )
      }
      const a = v.activity as Record<string, unknown>
      for (const key of Object.keys(a)) {
        if (!FETCH_TOPIC_ACTIVITY_META_KEYS.has(key)) {
          throw new ValidationError(
            `result.value.activity.${key}`,
            `[chatdb:fetch-topic-activity] Unknown key in activity: "${key}"`
          )
        }
      }
      if (a.completeness !== 'topic-activity') {
        throw new ValidationError(
          'result.value.activity.completeness',
          '[chatdb:fetch-topic-activity] Expected completeness "topic-activity"'
        )
      }
      validateNonEmptyString(a.topicId, 'result.value.activity.topicId')
      const messageCount = v.messageCount
      if (messageCount === 0) {
        if (v.latestMessageId !== null || v.latestMessageCreatedAt !== null) {
          throw new ValidationError(
            'result.value',
            '[chatdb:fetch-topic-activity] Empty topic must have null latestMessageId/createdAt'
          )
        }
      } else if (v.latestMessageId === null) {
        throw new ValidationError(
          'result.value.latestMessageId',
          '[chatdb:fetch-topic-activity] Non-empty topic must have latestMessageId'
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Insert message groups contract — stable intents, Main-authoritative
// ---------------------------------------------------------------------------

const INSERT_MESSAGE_GROUPS_CHANNEL = 'chatdb:insert-message-groups'
const INSERT_MESSAGE_GROUP_KEYS = new Set(['entries', 'intent'])
const INSERT_MESSAGE_GROUP_INTENT_KEYS = new Set(['kind', 'messageId'])

function validateInsertMessageGroupIntent(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(path, `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Expected intent object`)
  }
  const rec = value as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    if (!INSERT_MESSAGE_GROUP_INTENT_KEYS.has(key)) {
      throw new ValidationError(`${path}.${key}`, `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Unknown key in intent: "${key}"`)
    }
  }
  const kind = rec.kind
  if (kind !== 'after-group-tail' && kind !== 'before-message' && kind !== 'topic-tail') {
    throw new ValidationError(
      `${path}.kind`,
      `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Expected kind "after-group-tail", "before-message" or "topic-tail"`
    )
  }
  if (kind === 'topic-tail') {
    if ('messageId' in rec) {
      throw new ValidationError(
        `${path}.messageId`,
        `[${INSERT_MESSAGE_GROUPS_CHANNEL}] topic-tail must not carry messageId`
      )
    }
    return
  }
  if (!('messageId' in rec)) {
    throw new ValidationError(
      `${path}.messageId`,
      `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Missing required field "messageId"`
    )
  }
  validateNonEmptyString(rec.messageId, `${path}.messageId`)
}

const insertMessageGroupsContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'groups'),
  validate(value: unknown): void {
    validateRequest(value, insertMessageGroupsContract.allowedKeys)
    const req = value as InsertMessageGroupsRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    if (!Array.isArray(req.groups) || req.groups.length === 0) {
      throw new ValidationError('request.groups', `[${INSERT_MESSAGE_GROUPS_CHANNEL}] groups must be a non-empty array`)
    }
    const seenMessageIds = new Set<string>()
    for (let gi = 0; gi < req.groups.length; gi++) {
      const gpath = `request.groups[${gi}]`
      const group = (req.groups as unknown[])[gi] as Record<string, unknown>
      if (group === null || typeof group !== 'object' || Array.isArray(group)) {
        throw new ValidationError(gpath, `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Expected group object`)
      }
      for (const key of Object.keys(group)) {
        if (!INSERT_MESSAGE_GROUP_KEYS.has(key)) {
          throw new ValidationError(
            `${gpath}.${key}`,
            `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Unknown key in group: "${key}"`
          )
        }
      }
      if (!('entries' in group) || !('intent' in group)) {
        throw new ValidationError(
          gpath,
          `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Group must carry entries and exactly one intent`
        )
      }
      validateEntries(group.entries, `${gpath}.entries`)
      if (!Array.isArray(group.entries) || (group.entries as unknown[]).length === 0) {
        throw new ValidationError(`${gpath}.entries`, `[${INSERT_MESSAGE_GROUPS_CHANNEL}] entries must not be empty`)
      }
      validateInsertMessageGroupIntent(group.intent as InsertMessageGroupIntent, `${gpath}.intent`)
      const entries = group.entries as Array<{ message: Record<string, unknown> }>
      for (let ei = 0; ei < entries.length; ei++) {
        const mid = entries[ei]?.message?.id
        if (typeof mid !== 'string' || mid.length === 0) {
          throw new ValidationError(
            `${gpath}.entries[${ei}].message.id`,
            `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Entry message must carry a non-empty id`
          )
        }
        if (seenMessageIds.has(mid)) {
          throw new ValidationError(
            `${gpath}.entries[${ei}].message.id`,
            `[${INSERT_MESSAGE_GROUPS_CHANNEL}] Duplicate new message ID "${mid}" across groups`
          )
        }
        seenMessageIds.add(mid)
      }
    }
  },
  validateResult: fileCleanupResultValidator('chatdb:insert-message-groups')
}

// ---------------------------------------------------------------------------
// S6.2c-2: Insert after stable anchor contract — Main-authoritative
// ---------------------------------------------------------------------------

const insertMessagesAfterAnchorContract: ChatDbContract = {
  allowedKeys: keySet('topicId', 'afterMessageId', 'entries'),
  validate(value: unknown): void {
    validateRequest(value, insertMessagesAfterAnchorContract.allowedKeys)
    const req = value as InsertMessagesAfterAnchorRequest
    validateNonEmptyString(req.topicId, 'request.topicId')
    validateNonEmptyString(req.afterMessageId, 'request.afterMessageId')
    validateEntries(req.entries, 'request.entries')
    if (req.entries.length === 0) {
      throw new ValidationError('request.entries', 'entries must not be empty')
    }
  },
  validateResult: fileCleanupResultValidator('chatdb:insert-messages-after-anchor')
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
  // PERF-100: one atomic multi-model answer selection (foldSelected group switch)
  'chatdb:select-answer-message': selectAnswerMessageContract,
  'chatdb:delete-message': deleteMessageContract,
  'chatdb:delete-messages': deleteMessagesContract,
  'chatdb:update-blocks': updateBlocksContract,
  'chatdb:update-single-block': updateSingleBlockContract,
  'chatdb:bulk-add-blocks': bulkAddBlocksContract,
  'chatdb:delete-blocks': deleteBlocksContract,
  // Phase 5.1A: segment commands
  'chatdb:list-segments': listSegmentsContract,
  'chatdb:upsert-segment': upsertSegmentContract,
  'chatdb:update-segment-metadata': updateSegmentMetadataContract,
  'chatdb:delete-segment': deleteSegmentContract,
  'chatdb:replace-segment-membership': replaceSegmentMembershipContract,
  // Phase 5.1A: message reorder
  'chatdb:reorder-messages': reorderMessagesContract,
  // Answer-group authority reorder (additive semantic command)
  'chatdb:reorder-answer-group': reorderAnswerGroupContract,
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
  // S6.2c-1: branch by stable anchor (additive, keeps old clone path intact)
  'chatdb:branch-messages-to-topic': branchMessagesToTopicContract,
  // Phase 5.1B: compound mutations
  'chatdb:clone-messages-to-topic': cloneMessagesToTopicContract,
  'chatdb:reset-messages-for-resend': resetMessagesForResendContract,
  'chatdb:resend-user-messages': resendUserMessagesContract,
  'chatdb:regenerate-assistant-message': regenerateAssistantMessageContract,
  'chatdb:delete-messages-with-segments': deleteMessagesWithSegmentsContract,
  'chatdb:delete-messages-with-dependents': deleteMessagesWithDependentsContract,
  'chatdb:paste-messages-to-topic': pasteMessagesToTopicContract,
  // Phase 5.1B-2: search
  'chatdb:search-messages': searchMessagesContract,
  // S6.1: windowed reads
  'chatdb:fetch-messages-window': fetchMessagesWindowContract,
  // S6.2b R-05: authoritative answer-group READ
  'chatdb:fetch-answer-group': fetchAnswerGroupContract,
  // S6.3 R-06: authoritative context closure READ (anchor through newest)
  'chatdb:fetch-context-closure': fetchContextClosureContract,
  // One-shot whole-topic snapshot READ (topic exports / knowledge)
  'chatdb:fetch-whole-topic-snapshot': fetchWholeTopicSnapshotContract,
  // Bounded naming/activity authority reads (naming + rate-limit; never whole-topic)
  'chatdb:fetch-topic-naming-context': fetchTopicNamingContextContract,
  'chatdb:fetch-topic-activity': fetchTopicActivityContract,
  // S6.2c-2: Main-authoritative insert after stable anchor
  'chatdb:insert-messages-after-anchor': insertMessagesAfterAnchorContract,
  'chatdb:insert-message-groups': insertMessageGroupsContract
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
