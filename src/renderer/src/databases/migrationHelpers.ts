/**
 * Side-effect-free migration helpers for historical Dexie schema upgrades.
 *
 * These helpers mirror the exact block creation shapes of
 * `src/renderer/src/utils/messageUtils/create.ts` (ids, statuses, types,
 * timestamps, content, error/citation/file/tool/translation shapes) WITHOUT
 * any of its runtime dependencies (LoggerService, `@renderer/types` value
 * exports, `uuid`, ...). They exist so the v7 upgrade can run inside the
 * isolated chatImport renderer without evaluating the main renderer bundle.
 *
 * The module has NO runtime imports at all: the leaf enums
 * `MessageBlockStatus` / `MessageBlockType` from `@renderer/types/newMessage`
 * are referenced only as type-only imports, and their runtime values are
 * migration-local `as const` literal objects (exact enum string values with a
 * narrow per-member type assertion at this interface boundary — the nominal
 * string enum typing of the block interfaces is satisfied without evaluating
 * any main-renderer module). No i18n, no LoggerService, no `uuid`, no
 * window/api bridge is evaluated.
 *
 * The only difference from `messageUtils/create.ts` is the block id source:
 * `generateId()` prefers the native `crypto.randomUUID` (available in the
 * Electron/Chromium renderer and in Node ≥ 19, which is what Vitest runs
 * under) and falls back to a shape-preserving RFC 4122 v4 generator — never a
 * module with window/api side effects.
 */
import type { FileMetadata } from '@renderer/types'
import type { SerializedError } from '@renderer/types/error'
import type {
  BaseMessageBlock,
  CitationMessageBlock,
  ErrorMessageBlock,
  FileMessageBlock,
  ImageMessageBlock,
  MainTextMessageBlock,
  MessageBlockStatus,
  MessageBlockType,
  ThinkingMessageBlock,
  ToolMessageBlock,
  TranslationMessageBlock
} from '@renderer/types/newMessage'

/**
 * Migration-local block status constants — exact string values of the
 * `MessageBlockStatus` enum in `@renderer/types/newMessage`, declared as
 * `as const` literals. The per-member type assertion is the narrow interface
 * boundary that satisfies the nominal string enum typing (string literals are
 * not assignable to string enums) without a runtime enum import; the cast is
 * erased at build time.
 */
const BLOCK_STATUS = {
  PENDING: 'pending' as MessageBlockStatus.PENDING,
  PROCESSING: 'processing' as MessageBlockStatus.PROCESSING,
  STREAMING: 'streaming' as MessageBlockStatus.STREAMING,
  SUCCESS: 'success' as MessageBlockStatus.SUCCESS,
  ERROR: 'error' as MessageBlockStatus.ERROR,
  PAUSED: 'paused' as MessageBlockStatus.PAUSED
} as const

/**
 * Migration-local block type constants — exact string values of the
 * `MessageBlockType` enum in `@renderer/types/newMessage`, declared as
 * `as const` literals (narrow per-member type assertion at the interface
 * boundary; see `BLOCK_STATUS`).
 */
const BLOCK_TYPE = {
  UNKNOWN: 'unknown' as MessageBlockType.UNKNOWN,
  MAIN_TEXT: 'main_text' as MessageBlockType.MAIN_TEXT,
  THINKING: 'thinking' as MessageBlockType.THINKING,
  TRANSLATION: 'translation' as MessageBlockType.TRANSLATION,
  IMAGE: 'image' as MessageBlockType.IMAGE,
  CODE: 'code' as MessageBlockType.CODE,
  TOOL: 'tool' as MessageBlockType.TOOL,
  FILE: 'file' as MessageBlockType.FILE,
  ERROR: 'error' as MessageBlockType.ERROR,
  CITATION: 'citation' as MessageBlockType.CITATION,
  VIDEO: 'video' as MessageBlockType.VIDEO
} as const

/**
 * Generate a random block id with RFC 4122 v4 shape.
 *
 * Prefers the native `crypto.randomUUID()` (present in the Electron/Chromium
 * renderer and Node ≥ 19 / Vitest) and falls back to a pure, import-free v4
 * generator for any environment where the global is missing. The fallback is
 * intentionally dependency-free so this module can never pull the `uuid`
 * package or any main-renderer module into the isolated import pipeline.
 */
export function generateId(): string {
  const cryptoObj = globalThis.crypto
  if (typeof cryptoObj !== 'undefined' && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  // RFC 4122 v4 fallback (format-compatible with uuid.v4()).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Creates a base message block with common properties — same shape as
 * `createBaseMessageBlock` in `utils/messageUtils/create.ts`.
 */
export function createBaseMessageBlock<T extends MessageBlockType>(
  messageId: string,
  type: T,
  overrides: Partial<Omit<BaseMessageBlock, 'id' | 'messageId' | 'type'>> = {}
): BaseMessageBlock & { type: T } {
  const now = new Date().toISOString()
  return {
    id: generateId(),
    messageId,
    type,
    createdAt: now,
    status: BLOCK_STATUS.PROCESSING,
    error: undefined,
    ...overrides
  }
}

/**
 * Creates a Main Text Message Block — same shape as `createMainTextBlock`.
 */
export function createMainTextBlock(
  messageId: string,
  content: string,
  overrides: Partial<Omit<MainTextMessageBlock, 'id' | 'messageId' | 'type' | 'content'>> = {}
): MainTextMessageBlock {
  const baseBlock = createBaseMessageBlock(messageId, BLOCK_TYPE.MAIN_TEXT, overrides)
  return {
    ...baseBlock,
    content,
    knowledgeBaseIds: overrides.knowledgeBaseIds
  }
}

/**
 * Creates a Thinking Message Block — same shape as `createThinkingBlock`.
 */
export function createThinkingBlock(
  messageId: string,
  content: string = '',
  overrides: Partial<Omit<ThinkingMessageBlock, 'id' | 'messageId' | 'type' | 'content'>> = {}
): ThinkingMessageBlock {
  const baseOverrides: Partial<Omit<BaseMessageBlock, 'id' | 'messageId' | 'type'>> = {
    status: BLOCK_STATUS.PROCESSING,
    ...overrides
  }
  const baseBlock = createBaseMessageBlock(messageId, BLOCK_TYPE.THINKING, baseOverrides)
  return {
    ...baseBlock,
    content,
    thinking_millsec: overrides.thinking_millsec || 0
  }
}

/**
 * Creates a Translation Message Block — same shape as `createTranslationBlock`.
 */
export function createTranslationBlock(
  messageId: string,
  content: string,
  targetLanguage: string,
  overrides: Partial<Omit<TranslationMessageBlock, 'id' | 'messageId' | 'type' | 'content' | 'targetLanguage'>> = {}
): TranslationMessageBlock {
  const { sourceBlockId, sourceLanguage, ...baseOverrides } = overrides
  const baseBlock = createBaseMessageBlock(messageId, BLOCK_TYPE.TRANSLATION, {
    status: BLOCK_STATUS.SUCCESS,
    ...baseOverrides
  })
  return {
    ...baseBlock,
    content,
    targetLanguage,
    sourceBlockId: sourceBlockId,
    sourceLanguage: sourceLanguage
  }
}

/**
 * Creates an Image Message Block — same shape as `createImageBlock` (without
 * the LoggerService image-type warning).
 */
export function createImageBlock(
  messageId: string,
  overrides: Partial<Omit<ImageMessageBlock, 'id' | 'messageId' | 'type'>> = {}
): ImageMessageBlock {
  const { file, url, metadata, ...baseOverrides } = overrides
  const baseBlock = createBaseMessageBlock(messageId, BLOCK_TYPE.IMAGE, baseOverrides)
  return {
    ...baseBlock,
    url: url,
    file: file,
    metadata: metadata
  }
}

/**
 * Creates a File Message Block — same shape as `createFileBlock` (without the
 * LoggerService image-type warning).
 */
export function createFileBlock(
  messageId: string,
  file: FileMetadata,
  overrides: Partial<Omit<FileMessageBlock, 'id' | 'messageId' | 'type' | 'file'>> = {}
): FileMessageBlock {
  return {
    ...createBaseMessageBlock(messageId, BLOCK_TYPE.FILE, overrides),
    file
  }
}

/**
 * Creates an Error Message Block — same shape as `createErrorBlock`.
 */
export function createErrorBlock(
  messageId: string,
  errorData: SerializedError,
  overrides: Partial<Omit<ErrorMessageBlock, 'id' | 'messageId' | 'type' | 'error'>> = {}
): ErrorMessageBlock {
  const baseBlock = createBaseMessageBlock(messageId, BLOCK_TYPE.ERROR, {
    status: BLOCK_STATUS.ERROR,
    error: errorData,
    ...overrides
  })
  return baseBlock as ErrorMessageBlock
}

/**
 * Creates a Tool Block — same shape as `createToolBlock` (without the
 * LoggerService debug logging).
 */
export function createToolBlock(
  messageId: string,
  toolId: string,
  overrides: Partial<Omit<ToolMessageBlock, 'id' | 'messageId' | 'type' | 'toolId'>> = {}
): ToolMessageBlock {
  let initialStatus: MessageBlockStatus = BLOCK_STATUS.PROCESSING
  if (overrides.content !== undefined || overrides.error !== undefined) {
    initialStatus = overrides.error ? BLOCK_STATUS.ERROR : BLOCK_STATUS.SUCCESS
  } else if (overrides.toolName || overrides.arguments) {
    initialStatus = BLOCK_STATUS.PROCESSING
  }

  const { toolName, arguments: args, content, error, metadata, ...baseOnlyOverrides } = overrides
  const baseOverrides: Partial<Omit<BaseMessageBlock, 'id' | 'messageId' | 'type'>> = {
    status: initialStatus,
    error: error,
    metadata: metadata,
    ...baseOnlyOverrides
  }
  const baseBlock = createBaseMessageBlock(messageId, BLOCK_TYPE.TOOL, baseOverrides)
  return {
    ...baseBlock,
    toolId,
    toolName,
    arguments: args,
    content
  }
}

/**
 * Creates a Citation Block — same shape as `createCitationBlock`.
 */
export function createCitationBlock(
  messageId: string,
  citationData: Omit<CitationMessageBlock, keyof BaseMessageBlock | 'type'>,
  overrides: Partial<Omit<CitationMessageBlock, 'id' | 'messageId' | 'type' | keyof typeof citationData>> = {}
): CitationMessageBlock {
  const { response, knowledge, memories, ...baseOverrides } = {
    ...citationData,
    ...overrides
  }

  const baseBlock = createBaseMessageBlock(messageId, BLOCK_TYPE.CITATION, {
    status: BLOCK_STATUS.SUCCESS,
    ...baseOverrides
  })

  return {
    ...baseBlock,
    response,
    knowledge,
    memories
  }
}
