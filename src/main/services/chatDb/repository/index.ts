/**
 * Repository layer for the chat database.
 *
 * Each repository wraps Drizzle ORM queries for a single table,
 * providing a domain-specific API (CRUD + queries).
 */

export { BlocksRepository } from './BlocksRepository'
export { FileReferencesRepository } from './FileReferencesRepository'
export type { AffectedCount, GetResult } from './helpers'
export { MessagesRepository } from './MessagesRepository'
export { TopicSegmentsRepository } from './TopicSegmentsRepository'
export { TopicsRepository } from './TopicsRepository'
