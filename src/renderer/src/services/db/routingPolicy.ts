/**
 * Routing policy types and dependency interfaces for DbService.
 *
 * Phase 3.4: Immutable injected routing policy.
 * - Production singleton defaults permanently to 'dexie'.
 * - 'sqlite-validation' only via explicitly constructed test/development instance.
 * - 'sqlite-authoritative' type-reserved; synchronously throws Phase-5-only error.
 * - No env var, Redux, localStorage, mutable setter, or global configure/reset API.
 */

import type { Message, MessageBlock } from '@renderer/types/newMessage'

import type { MessageDataSource } from './types'

// ---------------------------------------------------------------------------
// Policy type
// ---------------------------------------------------------------------------

/**
 * Routing policy for DbService ordinary (non-agent) operations.
 *
 * - `'dexie'` — Route all ordinary operations to Dexie (IndexedDB).
 *   Production default; always safe.
 * - `'sqlite-validation'` — Route ordinary operations to SQLite via IPC.
 *   For development/testing validation; requires explicit construction.
 * - `'sqlite-authoritative'` — Reserved for Phase 5.
 *   Synchronously throws at construction time.
 */
export type DbRoutingPolicy = 'dexie' | 'sqlite-validation' | 'sqlite-authoritative'

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Ordinary message source with block-level write methods guaranteed present.
 * Both DexieMessageDataSource and SqliteMessageDataSource satisfy this.
 */
export interface OrdinaryMessageSource extends MessageDataSource {
  updateSingleBlock(blockId: string, updates: Partial<MessageBlock>): Promise<void>
  bulkAddBlocks(blocks: MessageBlock[]): Promise<void>
}

/**
 * Dexie-specific source: ordinary operations plus file reference count management.
 */
export interface DexieMessageSource extends OrdinaryMessageSource {
  updateFileCount(fileId: string, delta: number, deleteIfZero?: boolean): Promise<void>
  updateFileCounts(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void>
}

/**
 * Agent message source: standard operations plus streaming cache access
 * needed for block-to-topic resolution in mixed updateBlocks,
 * and updateSingleBlock for agent-classified block updates.
 */
export interface AgentMessageSource extends MessageDataSource {
  getStreamingCacheInfo(messageId: string): { sessionId: string; message?: Message } | undefined
  updateSingleBlock(blockId: string, updates: Partial<MessageBlock>): Promise<void>
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Immutable constructor dependencies for DbService.
 *
 * All data sources are injected. No hidden detection, no global state,
 * no env vars, no Redux reads for routing decisions.
 */
export interface DbServiceDeps {
  /** Routing policy for this instance. Immutable after construction. */
  readonly policy: DbRoutingPolicy

  /** Dexie-backed data source. Always available; used for file operations regardless of policy. */
  readonly dexieSource: DexieMessageSource

  /** Agent-backed data source for agent session topics. */
  readonly agentSource: AgentMessageSource

  /**
   * Lazy factory for creating the SQLite ordinary source.
   *
   * - Only invoked for 'sqlite-validation' policy, on first ordinary operation.
   * - Called at most once per DbService instance.
   * - If omitted for 'sqlite-validation', defaults to constructing
   *   SqliteMessageDataSource from renderer context (window.api.chatDb).
   * - Not used for 'dexie' policy.
   *
   * Tests should inject a factory returning a spy/fake.
   */
  readonly sqliteSourceFactory?: () => OrdinaryMessageSource
}
