/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
/**
 * Unified data access layer for messages
 * Provides a consistent API for accessing messages from the SQLite chat DB
 * (via IPC to Main-side ChatDbAggregateService).
 */

// Export main service
export { DbService, dbService } from './DbService'

// Export types
export type { ChatDbApi } from './SqliteMessageDataSource'
export { ChatDbResultError, SqliteMessageDataSource } from './SqliteMessageDataSource'
export type { MessageDataSource, MessageExchange } from './types'
