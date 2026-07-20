/**
 * Repository factory — binds all five repositories to a Drizzle database
 * or transaction executor.
 *
 * Design:
 * - For aggregate compound commands, create repositories from tx inside
 *   root db.transaction(...). No await inside transaction callbacks.
 * - Existing nested repository transactions use Drizzle savepoints.
 * - The factory accepts any BetterSQLite3Database (root or transaction)
 *   so repositories can be bound to either context.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { BlocksRepository } from './BlocksRepository'
import { FileReferencesRepository } from './FileReferencesRepository'
import { MessagesRepository } from './MessagesRepository'
import { TopicSegmentsRepository } from './TopicSegmentsRepository'
import { TopicsRepository } from './TopicsRepository'

/**
 * Aggregate of all five chat DB repositories bound to a single
 * Drizzle database or transaction executor.
 */
export interface ChatDbRepositories {
  topics: TopicsRepository
  messages: MessagesRepository
  blocks: BlocksRepository
  segments: TopicSegmentsRepository
  fileRefs: FileReferencesRepository
}

/**
 * Create all five repositories bound to the given Drizzle database.
 *
 * @param db  Drizzle database instance (root or transaction-scoped).
 * @returns   Aggregate of all five repositories.
 */
export function createRepositories(db: BetterSQLite3Database<any>): ChatDbRepositories {
  return {
    topics: new TopicsRepository(db),
    messages: new MessagesRepository(db),
    blocks: new BlocksRepository(db),
    segments: new TopicSegmentsRepository(db),
    fileRefs: new FileReferencesRepository(db)
  }
}
