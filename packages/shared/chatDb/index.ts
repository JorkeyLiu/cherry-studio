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
  ClearMessagesResponse,
  ClearTopicWithSegmentsRequest,
  ClearTopicWithSegmentsResponse,
  CloneMessagesToTopicRequest,
  CloneMessagesToTopicResponse,
  CountFileRefsByFileRequest,
  CountFileRefsByFileResponse,
  DeleteBlocksRequest,
  DeleteBlocksResponse,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteMessagesWithSegmentsResponse,
  DeleteSegmentRequest,
  EmptyTrashTopicsRequest,
  EmptyTrashTopicsResponse,
  EnsureTopicRequest,
  FetchMessagesRequest,
  FetchMessagesResponse,
  FileCleanupResult,
  FileReferenceWire,
  GetRawTopicRequest,
  GetRawTopicResponse,
  HardDeleteTopicRequest,
  HardDeleteTopicResponse,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ListBlocksByFileRequest,
  ListBlocksByFileResponse,
  ListFileRefsByFileRequest,
  ListFileRefsByFileResponse,
  ListSegmentsRequest,
  ListSegmentsResponse,
  ListTrashTopicsRequest,
  ListTrashTopicsResponse,
  MessageBlockEntry,
  PasteMessagesToTopicRequest,
  PasteMessagesToTopicResponse,
  PurgeExpiredTopicsRequest,
  PurgeExpiredTopicsResponse,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  ReplaceSegmentMembershipResponse,
  ResetAssistantTopicsRequest,
  ResetAssistantTopicsResponse,
  ResetMessagesForResendRequest,
  ResetMessagesForResendResponse,
  RestoreTopicRequest,
  RestoreTopicResponse,
  SearchMessagesRequest,
  SearchMessagesResponse,
  SearchResultItem,
  SegmentWire,
  SoftDeleteTopicRequest,
  TopicExistsRequest,
  TopicWire,
  TransferTopicOwnershipRequest,
  TransferTopicOwnershipResponse,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSegmentMetadataRequest,
  UpdateSegmentMetadataResponse,
  UpdateSingleBlockRequest,
  UpdateTopicMetadataRequest,
  UpdateTopicMetadataResponse,
  UpsertSegmentRequest,
  UpsertSegmentResponse
} from './types'

// Result envelope constructors and type guards
export {
  ERR_BUSY,
  ERR_CONFLICT,
  ERR_FOREIGN_KEY,
  ERR_IDENTITY_VIOLATION,
  ERR_INVALID_STATE,
  ERR_NOT_FOUND,
  ERR_STORAGE,
  ERR_UNAVAILABLE,
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
  validateIso8601Timestamp,
  validateJsonObject,
  validateJsonObjectArray,
  validateJsonValue,
  validateMessageIdField,
  validateNoIdentityFields,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateRequest,
  validateResultEnvelope,
  validateStringArray,
  ValidationError
} from './validation'

// Command contracts
export type { ChatDbContract } from './contracts'
export { chatDbContracts, getContract, validateChatDbRequest, validateChatDbResult } from './contracts'
