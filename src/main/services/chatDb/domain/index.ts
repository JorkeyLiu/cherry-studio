/**
 * Barrel export for chat database domain layer.
 */

export type { MergeOverflowOptions } from './codec'
export {
  decodeJson,
  encodeJson,
  mergeOverflow,
  OVERFLOW_CLEAR,
  OVERFLOW_REMOVE,
  reconstruct,
  reconstructBlock
} from './codec'
export type {
  ClearOptions,
  CursorKind,
  EntityPatch,
  PageCursor,
  PageResult
} from './cursor'
export {
  decodeCursor,
  decodeNumericOrderCursor,
  decodeTopicTimestampCursor,
  encodeCursor,
  encodeNumericOrderCursor,
  encodeTopicTimestampCursor,
  validateLimit
} from './cursor'
export type { RowPatchResult } from './mappers'
export {
  fileReferenceFromRow,
  fileReferenceToRow,
  fileReferenceToRowPatch,
  messageBlockFromRow,
  messageBlockToRow,
  messageBlockToRowPatch,
  messageFromRow,
  messageToRow,
  messageToRowPatch,
  topicFromRow,
  topicSegmentFromRow,
  topicSegmentMessageFromRow,
  topicSegmentMessageToRow,
  topicSegmentToRow,
  topicSegmentToRowPatch,
  topicToRow,
  topicToRowPatch
} from './mappers'
export type {
  EntityPatchInput,
  FileReferenceData,
  FileReferenceRow,
  MessageBlockData,
  MessageBlockRow,
  MessageData,
  MessageRow,
  OverflowPatchValue,
  TopicData,
  TopicRow,
  TopicSegmentData,
  TopicSegmentMessageData,
  TopicSegmentMessageRow,
  TopicSegmentRow
} from './types'
