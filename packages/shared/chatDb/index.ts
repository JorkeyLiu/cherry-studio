/**
 * ChatDB shared domain — barrel export.
 *
 * This package contains the wire DTO types, result envelope, runtime
 * validators, and command contracts for the ChatDB IPC layer.
 *
 * Dependencies: none (self-contained, JSON-only).
 * Does NOT import Electron, Node, Drizzle, SQLite, or Renderer types.
 */

// Types — wire DTOs, result envelope, command map
export type {
  AppendMessageRequest,
  BulkAddBlocksRequest,
  ChatDbChannel,
  ChatDbCommandMap,
  ChatDbCommands,
  ChatDbError,
  ChatDbFailure,
  ChatDbRequest,
  ChatDbResponse,
  ChatDbResult,
  ChatDbSuccess,
  ClearMessagesRequest,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  EnsureTopicRequest,
  FetchMessagesRequest,
  FetchMessagesResponse,
  GetRawTopicRequest,
  GetRawTopicResponse,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  TopicExistsRequest,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSingleBlockRequest
} from './types'

// Result envelope constructors and type guards
export {
  ERR_FOREIGN_KEY,
  ERR_IDENTITY_VIOLATION,
  ERR_INVALID_STATE,
  ERR_NOT_FOUND,
  ERR_STORAGE,
  ERR_VALIDATION,
  fail,
  isFailure,
  isSuccess,
  ok
} from './result'

// Runtime validation
export {
  MAX_ARRAY_LENGTH,
  MAX_DEPTH,
  MAX_STRING_LENGTH,
  validateIdField,
  validateIndex,
  validateJsonObject,
  validateJsonObjectArray,
  validateJsonValue,
  validateMessageIdField,
  validateNonEmptyString,
  validateRequest,
  validateResultEnvelope,
  validateStringArray,
  ValidationError
} from './validation'

// Command contracts
export type { ChatDbContract } from './contracts'
export { chatDbContracts, getContract, validateChatDbRequest, validateChatDbResult } from './contracts'
