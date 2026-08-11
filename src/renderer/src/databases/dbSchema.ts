/**
 * Canonical Dexie schema module for the `CherryStudio` IndexedDB database.
 *
 * This module is deliberately side-effect-minimal:
 * - Its ONLY runtime dependency is the `dexie` package (the single ordinary
 *   renderer singleton semantics are preserved — `import '@renderer/databases'`
 *   and `import db from '@renderer/databases'` initialize exactly this instance).
 * - All type imports are `import type` and are erased at build time, so this
 *   module never evaluates the `@renderer/types` barrel, i18n, LoggerService,
 *   messageUtils, or any other main-renderer module.
 * - The v5/v7/v8 upgrade callbacks use a lazy `await import('./upgrades')`, so
 *   the migration code is only fetched and evaluated when a source database
 *   actually needs one of those upgrades. A database already at v11 never loads
 *   the upgrades chunk.
 *
 * The isolated chatImport renderer dynamic-imports THIS module directly (see
 * `src/renderer/src/windows/chatImport/entryPoint.ts`) so it can open the
 * source database and execute historical v5/v7/v8 upgrades without evaluating
 * the main renderer bundle or any window.api/window.electron side effects.
 */
import type {
  CustomTranslateLanguage,
  FileMetadata,
  KnowledgeNoteItem,
  QuickPhrase,
  TopicSegment,
  TranslateHistory
} from '@renderer/types'
// Import necessary types for blocks and new message structure
import type { Message as NewMessage, MessageBlock } from '@renderer/types/newMessage'
import { Dexie, type EntityTable } from 'dexie'

// Database declaration (canonical singleton for both the ordinary renderer and
// the chatImport hidden renderer)
export const db = new Dexie('CherryStudio', {
  chromeTransactionDurability: 'strict'
}) as Dexie & {
  files: EntityTable<FileMetadata, 'id'>
  topics: EntityTable<{ id: string; messages: NewMessage[]; deletedAt?: string }, 'id'> // Correct type for topics
  settings: EntityTable<{ id: string; value: any }, 'id'>
  knowledge_notes: EntityTable<KnowledgeNoteItem, 'id'>
  translate_history: EntityTable<TranslateHistory, 'id'>
  quick_phrases: EntityTable<QuickPhrase, 'id'>
  message_blocks: EntityTable<MessageBlock, 'id'> // Correct type for message_blocks
  translate_languages: EntityTable<CustomTranslateLanguage, 'id'>
  topic_segments: EntityTable<TopicSegment, 'id'>
}

db.version(1).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count'
})

db.version(2).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value'
})

db.version(3).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at'
})

db.version(4).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt'
})

db.version(5)
  .stores({
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id, messages',
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt'
  })
  .upgrade(async (tx) => {
    const { upgradeToV5 } = await import('./upgrades')
    return upgradeToV5(tx)
  })

db.version(6).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
  quick_phrases: 'id'
})

// --- NEW VERSION 7 ---
db.version(7)
  .stores({
    // Redeclare all tables for the new version
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id', // Correct index for topics
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
    quick_phrases: 'id',
    message_blocks: 'id, messageId, file.id' // Correct syntax with comma separator
  })
  .upgrade(async (tx) => {
    const { upgradeToV7 } = await import('./upgrades')
    return upgradeToV7(tx)
  })

db.version(8)
  .stores({
    // Redeclare all tables for the new version
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id', // Correct index for topics
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
    quick_phrases: 'id',
    message_blocks: 'id, messageId, file.id' // Correct syntax with comma separator
  })
  .upgrade(async (tx) => {
    const { upgradeToV8 } = await import('./upgrades')
    return upgradeToV8(tx)
  })

db.version(9).stores({
  // Redeclare all tables for the new version
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id', // Correct index for topics
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
  translate_languages: '&id, langCode',
  quick_phrases: 'id',
  message_blocks: 'id, messageId, file.id' // Correct syntax with comma separator
})

db.version(10).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
  translate_languages: '&id, langCode',
  quick_phrases: 'id',
  message_blocks: 'id, messageId, file.id'
})

db.version(11).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
  translate_languages: '&id, langCode',
  quick_phrases: 'id',
  message_blocks: 'id, messageId, file.id',
  topic_segments: 'id, topicId'
})

export default db
