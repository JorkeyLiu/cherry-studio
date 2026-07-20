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
import { loggerService } from '@logger'
import store from '@renderer/store'
import type { Message, MessageBlock } from '@renderer/types/newMessage'

import { AgentMessageDataSource } from './AgentMessageDataSource'
import { DexieMessageDataSource } from './DexieMessageDataSource'
import type {
  AgentMessageSource,
  DbRoutingPolicy,
  DbServiceDeps,
  DexieMessageSource,
  OrdinaryMessageSource
} from './routingPolicy'
import { SqliteMessageDataSource } from './SqliteMessageDataSource'
import type { MessageDataSource } from './types'
import { buildAgentSessionTopicId, isAgentSessionTopicId } from './types'

const logger = loggerService.withContext('DbService')

/**
 * Source type reported by getSourceType().
 */
export type DbSourceType = 'dexie' | 'sqlite' | 'agent'

/**
 * Facade service that routes data operations to the appropriate data source
 * based on topic ID type (agent session) and injected routing policy.
 *
 * Phase 3.4: Immutable injected routing policy.
 * - Production singleton (getInstance()) permanently defaults to 'dexie'.
 * - 'sqlite-validation' only via explicit constructor for test/dev instances.
 * - 'sqlite-authoritative' throws synchronously (Phase 5 reserved).
 * - Agent session routing is policy-independent and highest precedence.
 * - updateFileCount(s) always use Dexie, independent of policy.
 * - No readiness/database/migration detection, fallback, retry-to-Dexie,
 *   shadow reads, or dual writes.
 */
class DbService implements MessageDataSource {
  private static instance: DbService

  private readonly policy: DbRoutingPolicy
  private readonly dexieSource: DexieMessageSource
  private readonly agentSource: AgentMessageSource
  private readonly sqliteSourceFactory: (() => OrdinaryMessageSource) | undefined

  // Lazy SQLite source — created at most once for sqlite-validation policy
  private _ordinarySource: OrdinaryMessageSource | undefined
  private _ordinarySourceResolved = false

  /**
   * Construct DbService with explicit dependencies.
   *
   * @throws {Error} if policy is 'sqlite-authoritative' (Phase 5 reserved).
   */
  constructor(deps: DbServiceDeps) {
    if (deps.policy === 'sqlite-authoritative') {
      throw new Error(
        'sqlite-authoritative policy is reserved for Phase 5 and cannot be used. ' +
          'Use dexie or sqlite-validation policy.'
      )
    }

    this.policy = deps.policy
    this.dexieSource = deps.dexieSource
    this.agentSource = deps.agentSource

    // For sqlite-validation, prepare the lazy factory (defaults to renderer context)
    if (deps.policy === 'sqlite-validation') {
      this.sqliteSourceFactory =
        deps.sqliteSourceFactory ?? (() => new SqliteMessageDataSource() as unknown as OrdinaryMessageSource)
    }
  }

  /**
   * Get singleton instance. Permanently defaults to 'dexie' policy.
   * Never instantiates SQLite or touches window.api.chatDb.
   */
  static getInstance(): DbService {
    if (!DbService.instance) {
      DbService.instance = new DbService({
        policy: 'dexie',
        dexieSource: new DexieMessageDataSource(),
        agentSource: new AgentMessageDataSource()
      })
    }
    return DbService.instance
  }

  // ============ Source Resolution ============

  /**
   * Get the configured ordinary (non-agent) source.
   * For 'dexie' policy: returns Dexie source directly.
   * For 'sqlite-validation': lazily creates SQLite source on first call.
   */
  private getOrdinarySource(): OrdinaryMessageSource {
    switch (this.policy) {
      case 'dexie':
        return this.dexieSource
      case 'sqlite-validation':
        if (!this._ordinarySourceResolved) {
          this._ordinarySourceResolved = true
          this._ordinarySource = this.sqliteSourceFactory!()
          logger.info('SQLite source lazily created for sqlite-validation policy')
        }
        return this._ordinarySource!
      default:
        // sqlite-authoritative rejected at construction time
        throw new Error(`Unsupported routing policy: ${this.policy}`)
    }
  }

  /**
   * Determine which data source to use for a topic-addressed operation.
   * Agent session routing is always highest precedence and policy-independent.
   */
  private getDataSource(topicId: string): MessageDataSource {
    if (isAgentSessionTopicId(topicId)) {
      logger.silly(`Using AgentMessageDataSource for topic ${topicId}`)
      return this.agentSource
    }

    const source = this.getOrdinarySource()
    logger.silly(
      `Using ${this.policy === 'dexie' ? 'DexieMessageDataSource' : 'SqliteMessageDataSource'} for topic ${topicId}`
    )
    return source
  }

  /**
   * Resolve topicId for a message via Redux state or agent streaming cache.
   */
  private resolveMessageTopicId(messageId: string): string | undefined {
    const state = store.getState()

    const parentMessage = state.messages.entities[messageId]
    if (parentMessage) {
      return parentMessage.topicId
    }

    const agentInfo = this.agentSource.getStreamingCacheInfo(messageId)
    if (agentInfo) {
      return buildAgentSessionTopicId(agentInfo.sessionId)
    }

    return undefined
  }

  // ============ Read Operations ============

  async fetchMessages(
    topicId: string,
    forceReload?: boolean
  ): Promise<{
    messages: Message[]
    blocks: MessageBlock[]
  }> {
    const source = this.getDataSource(topicId)
    return source.fetchMessages(topicId, forceReload)
  }

  // ============ Write Operations ============

  async appendMessage(topicId: string, message: Message, blocks: MessageBlock[], insertIndex?: number): Promise<void> {
    const source = this.getDataSource(topicId)
    return source.appendMessage(topicId, message, blocks, insertIndex)
  }

  async updateMessage(topicId: string, messageId: string, updates: Partial<Message>): Promise<void> {
    const source = this.getDataSource(topicId)
    return source.updateMessage(topicId, messageId, updates)
  }

  async updateMessageAndBlocks(
    topicId: string,
    messageUpdates: Partial<Message> & Pick<Message, 'id'>,
    blocksToUpdate: MessageBlock[]
  ): Promise<void> {
    const source = this.getDataSource(topicId)
    return source.updateMessageAndBlocks(topicId, messageUpdates, blocksToUpdate)
  }

  async deleteMessage(topicId: string, messageId: string): Promise<void> {
    const source = this.getDataSource(topicId)
    return source.deleteMessage(topicId, messageId)
  }

  async deleteMessages(topicId: string, messageIds: string[]): Promise<void> {
    const source = this.getDataSource(topicId)
    return source.deleteMessages(topicId, messageIds)
  }

  // ============ Block Operations ============

  async updateBlocks(blocks: MessageBlock[]): Promise<void> {
    if (blocks.length === 0) {
      return
    }

    const agentBlocks: MessageBlock[] = []
    const ordinaryBlocks: MessageBlock[] = []

    for (const block of blocks) {
      const topicId = this.resolveMessageTopicId(block.messageId)

      if (topicId && isAgentSessionTopicId(topicId)) {
        agentBlocks.push(block)
      } else {
        if (!topicId) {
          logger.warn(`Unable to resolve topicId for block ${block.id}, routing to configured ordinary source`)
        }
        ordinaryBlocks.push(block)
      }
    }

    if (agentBlocks.length > 0) {
      await this.agentSource.updateBlocks(agentBlocks)
    }

    if (ordinaryBlocks.length > 0) {
      await this.getOrdinarySource().updateBlocks(ordinaryBlocks)
    }
  }

  async deleteBlocks(blockIds: string[]): Promise<void> {
    // Route to configured ordinary source; agent blocks cannot be deleted individually
    return this.getOrdinarySource().deleteBlocks(blockIds)
  }

  // ============ Batch Operations ============

  async clearMessages(topicId: string): Promise<void> {
    const source = this.getDataSource(topicId)
    return source.clearMessages(topicId)
  }

  async topicExists(topicId: string): Promise<boolean> {
    const source = this.getDataSource(topicId)
    return source.topicExists(topicId)
  }

  async ensureTopic(topicId: string): Promise<void> {
    const source = this.getDataSource(topicId)
    return source.ensureTopic(topicId)
  }

  // ============ Optional Methods ============

  async getRawTopic(topicId: string): Promise<{ id: string; messages: Message[] } | undefined> {
    const source = this.getDataSource(topicId)
    return source.getRawTopic(topicId)
  }

  async updateSingleBlock(blockId: string, updates: Partial<MessageBlock>): Promise<void> {
    const state = store.getState()
    const existingBlock = state.messageBlocks.entities[blockId]

    if (existingBlock) {
      const topicId = this.resolveMessageTopicId(existingBlock.messageId)

      if (topicId && isAgentSessionTopicId(topicId)) {
        return this.agentSource.updateSingleBlock(blockId, updates)
      }
    } else {
      logger.warn(`Block ${blockId} not found in state, routing to configured ordinary source`)
    }

    // Route to configured ordinary source for regular or unresolved blocks
    return this.getOrdinarySource().updateSingleBlock(blockId, updates)
  }

  async bulkAddBlocks(blocks: MessageBlock[]): Promise<void> {
    // Route to configured ordinary source; agent blocks use persistExchange
    return this.getOrdinarySource().bulkAddBlocks(blocks)
  }

  async updateFileCount(fileId: string, delta: number, deleteIfZero: boolean = false): Promise<void> {
    // File operations always use Dexie, independent of routing policy
    return this.dexieSource.updateFileCount(fileId, delta, deleteIfZero)
  }

  async updateFileCounts(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void> {
    // File operations always use Dexie, independent of routing policy
    return this.dexieSource.updateFileCounts(files)
  }

  // ============ Utility Methods ============

  /**
   * Check if a topic is an agent session.
   */
  isAgentSession(topicId: string): boolean {
    return isAgentSessionTopicId(topicId)
  }

  /**
   * Get the data source type for a topic.
   * Reports agent first (policy-independent), otherwise the configured ordinary source.
   */
  getSourceType(topicId: string): DbSourceType {
    if (isAgentSessionTopicId(topicId)) {
      return 'agent'
    }
    return this.policy === 'sqlite-validation' ? 'sqlite' : 'dexie'
  }
}

// Export singleton instance
export const dbService = DbService.getInstance()

// Also export class for testing purposes
export { DbService }
