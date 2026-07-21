/**
 * ChatImport shared domain — barrel export.
 *
 * Re-uses the result envelope from chatDb (ok/fail/isSuccess/isFailure).
 * Does NOT duplicate the validation machinery; imports from chatDb.
 */

// Types — wire DTOs and envelope
export type {
  ChatImportEnvelope,
  DiscoveryResult,
  ImportErrorPayload,
  ReadPageRequest,
  ReadPageResponse,
  SourceStats
} from './types'

// Re-export result envelope from chatDb (no duplication)
export { ERR_VALIDATION, fail, isFailure, isSuccess, ok } from '../chatDb/result'
export type {
  ChatDbError as ImportError,
  ChatDbFailure as ImportFailure,
  ChatDbResult as ImportResult,
  ChatDbSuccess as ImportSuccess
} from '../chatDb/types'

// Re-export validation helpers from chatDb (no duplication)
export {
  validateJsonObject,
  validateJsonObjectArray,
  validateJsonValue,
  validateNonEmptyString,
  validateRequest,
  ValidationError
} from '../chatDb/validation'
