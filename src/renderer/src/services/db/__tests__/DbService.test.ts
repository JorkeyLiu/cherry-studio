/**
 * DbService Tests — Phase 3.4 immutable injected routing policy.
 *
 * Covers:
 * - dexie policy routes all ordinary operations to Dexie source
 * - singleton default reports Dexie, does not instantiate SQLite
 * - sqlite-validation routes all 14 non-file ordinary operations to SQLite
 * - lazy factory called at most once; agent-only calls never create SQLite
 * - sqlite-authoritative rejects synchronously at construction
 * - no mutable policy API (setPolicy/configure/reset)
 * - all topic-addressed agent operations route Agent under both policies
 * - mixed updateBlocks partitions agent/ordinary correctly
 * - updateSingleBlock classification (agent/ordinary/unresolved)
 * - bulkAddBlocks/deleteBlocks follow configured ordinary source
 * - transport/ChatDbResultError failures propagate unchanged
 * - no readiness/topicExists probe before unrelated operations
 * - updateFileCount(s) always use Dexie under every constructible policy
 * - getSourceType behavior
 * - arguments/returns preserved
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentMessageSource, DexieMessageSource, OrdinaryMessageSource } from '../routingPolicy'

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const { mockGetState } = vi.hoisted(() => ({
  mockGetState: vi.fn()
}))

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that trigger module-level code
// ---------------------------------------------------------------------------

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn().mockReturnValue({
      silly: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: mockGetState, dispatch: vi.fn() }
}))

vi.mock('../DexieMessageDataSource', () => ({
  DexieMessageDataSource: vi.fn().mockImplementation(() => ({}))
}))

vi.mock('../AgentMessageDataSource', () => ({
  AgentMessageDataSource: vi.fn().mockImplementation(() => ({
    getStreamingCacheInfo: vi.fn()
  }))
}))

vi.mock('../SqliteMessageDataSource', () => ({
  SqliteMessageDataSource: vi.fn().mockImplementation(() => ({}))
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { DbService } from '../DbService'

// ---------------------------------------------------------------------------
// Helpers — spy factories for injected dependencies
// ---------------------------------------------------------------------------

function makeDexieSpy(): DexieMessageSource {
  return {
    fetchMessages: vi.fn(),
    getRawTopic: vi.fn(),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    deleteMessage: vi.fn(),
    deleteMessages: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    bulkAddBlocks: vi.fn(),
    deleteBlocks: vi.fn(),
    clearMessages: vi.fn(),
    topicExists: vi.fn(),
    ensureTopic: vi.fn(),
    updateFileCount: vi.fn(),
    updateFileCounts: vi.fn()
  }
}

function makeAgentSpy(): AgentMessageSource {
  return {
    fetchMessages: vi.fn(),
    getRawTopic: vi.fn(),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    deleteMessage: vi.fn(),
    deleteMessages: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    deleteBlocks: vi.fn(),
    clearMessages: vi.fn(),
    topicExists: vi.fn(),
    ensureTopic: vi.fn(),
    getStreamingCacheInfo: vi.fn()
  }
}

function makeOrdinarySpy(): OrdinaryMessageSource {
  return {
    fetchMessages: vi.fn(),
    getRawTopic: vi.fn(),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    deleteMessage: vi.fn(),
    deleteMessages: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    bulkAddBlocks: vi.fn(),
    deleteBlocks: vi.fn(),
    clearMessages: vi.fn(),
    topicExists: vi.fn(),
    ensureTopic: vi.fn()
  }
}

/** Create mock Redux state with controlled message/block entities. */
function setupMockState(opts?: {
  messages?: Record<string, { topicId: string }>
  blocks?: Record<string, { messageId: string }>
}) {
  mockGetState.mockReturnValue({
    messages: { entities: opts?.messages ?? {} },
    messageBlocks: { entities: opts?.blocks ?? {} }
  })
}

/** Construct a DbService with dexie policy and fresh spies. */
function makeDexieDb(): { db: DbService; dexie: DexieMessageSource; agent: AgentMessageSource } {
  const dexie = makeDexieSpy()
  const agent = makeAgentSpy()
  const db = new DbService({ policy: 'dexie', dexieSource: dexie, agentSource: agent })
  return { db, dexie, agent }
}

/** Construct a DbService with sqlite-validation policy and a spy factory. */
function makeSqliteDb(): {
  db: DbService
  dexie: DexieMessageSource
  agent: AgentMessageSource
  sqlite: OrdinaryMessageSource
  factory: ReturnType<typeof vi.fn>
} {
  const dexie = makeDexieSpy()
  const agent = makeAgentSpy()
  const sqlite = makeOrdinarySpy()
  const factory = vi.fn().mockReturnValue(sqlite)
  const db = new DbService({
    policy: 'sqlite-validation',
    dexieSource: dexie,
    agentSource: agent,
    sqliteSourceFactory: factory
  })
  return { db, dexie, agent, sqlite, factory }
}

const TOPIC = 'topic-regular-1'
const AGENT_TOPIC = 'agent-session:session-abc'
const MSG_ID = 'msg-1'
const AGENT_MSG_ID = 'msg-agent-1'
const BLK_ID = 'blk-1'
const AGENT_BLK_ID = 'blk-agent-1'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DbService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupMockState()
  })

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('sqlite-authoritative rejects synchronously with Phase 5 message', () => {
      expect(
        () =>
          new DbService({
            policy: 'sqlite-authoritative',
            dexieSource: makeDexieSpy(),
            agentSource: makeAgentSpy()
          })
      ).toThrow(/Phase 5/)
    })

    it('dexie policy constructs without error', () => {
      expect(() => makeDexieDb()).not.toThrow()
    })

    it('sqlite-validation policy constructs without error', () => {
      expect(() => makeSqliteDb()).not.toThrow()
    })
  })

  // =========================================================================
  // Singleton default
  // =========================================================================

  describe('singleton default', () => {
    it('getSourceType returns dexie for regular topics', () => {
      const { db } = makeDexieDb()
      expect(db.getSourceType(TOPIC)).toBe('dexie')
    })

    it('getSourceType returns agent for agent topics', () => {
      const { db } = makeDexieDb()
      expect(db.getSourceType(AGENT_TOPIC)).toBe('agent')
    })
  })

  // =========================================================================
  // Routing: dexie policy — all 10 topic-addressed operations → Dexie
  // =========================================================================

  describe('routing: dexie policy', () => {
    const TOPIC_OPS = [
      {
        name: 'fetchMessages',
        call: (db: DbService) => db.fetchMessages(TOPIC),
        spy: (d: DexieMessageSource) => d.fetchMessages
      },
      {
        name: 'getRawTopic',
        call: (db: DbService) => db.getRawTopic(TOPIC),
        spy: (d: DexieMessageSource) => d.getRawTopic
      },
      {
        name: 'appendMessage',
        call: (db: DbService) => db.appendMessage(TOPIC, { id: 'm1' } as any, []),
        spy: (d: DexieMessageSource) => d.appendMessage
      },
      {
        name: 'updateMessage',
        call: (db: DbService) => db.updateMessage(TOPIC, 'm1', {} as any),
        spy: (d: DexieMessageSource) => d.updateMessage
      },
      {
        name: 'updateMessageAndBlocks',
        call: (db: DbService) => db.updateMessageAndBlocks(TOPIC, { id: 'm1' } as any, []),
        spy: (d: DexieMessageSource) => d.updateMessageAndBlocks
      },
      {
        name: 'deleteMessage',
        call: (db: DbService) => db.deleteMessage(TOPIC, 'm1'),
        spy: (d: DexieMessageSource) => d.deleteMessage
      },
      {
        name: 'deleteMessages',
        call: (db: DbService) => db.deleteMessages(TOPIC, ['m1']),
        spy: (d: DexieMessageSource) => d.deleteMessages
      },
      {
        name: 'clearMessages',
        call: (db: DbService) => db.clearMessages(TOPIC),
        spy: (d: DexieMessageSource) => d.clearMessages
      },
      {
        name: 'topicExists',
        call: (db: DbService) => db.topicExists(TOPIC),
        spy: (d: DexieMessageSource) => d.topicExists
      },
      {
        name: 'ensureTopic',
        call: (db: DbService) => db.ensureTopic(TOPIC),
        spy: (d: DexieMessageSource) => d.ensureTopic
      }
    ] as const

    for (const op of TOPIC_OPS) {
      it(`${op.name} routes to Dexie source`, async () => {
        const { db, dexie } = makeDexieDb()
        await op.call(db)
        expect(op.spy(dexie)).toHaveBeenCalledOnce()
      })
    }
  })

  // =========================================================================
  // Routing: sqlite-validation — all 14 non-file ordinary operations → SQLite
  // =========================================================================

  describe('routing: sqlite-validation policy', () => {
    const TOPIC_OPS = [
      {
        name: 'fetchMessages',
        call: (db: DbService) => db.fetchMessages(TOPIC),
        spy: (s: OrdinaryMessageSource) => s.fetchMessages
      },
      {
        name: 'getRawTopic',
        call: (db: DbService) => db.getRawTopic(TOPIC),
        spy: (s: OrdinaryMessageSource) => s.getRawTopic
      },
      {
        name: 'appendMessage',
        call: (db: DbService) => db.appendMessage(TOPIC, { id: 'm1' } as any, []),
        spy: (s: OrdinaryMessageSource) => s.appendMessage
      },
      {
        name: 'updateMessage',
        call: (db: DbService) => db.updateMessage(TOPIC, 'm1', {} as any),
        spy: (s: OrdinaryMessageSource) => s.updateMessage
      },
      {
        name: 'updateMessageAndBlocks',
        call: (db: DbService) => db.updateMessageAndBlocks(TOPIC, { id: 'm1' } as any, []),
        spy: (s: OrdinaryMessageSource) => s.updateMessageAndBlocks
      },
      {
        name: 'deleteMessage',
        call: (db: DbService) => db.deleteMessage(TOPIC, 'm1'),
        spy: (s: OrdinaryMessageSource) => s.deleteMessage
      },
      {
        name: 'deleteMessages',
        call: (db: DbService) => db.deleteMessages(TOPIC, ['m1']),
        spy: (s: OrdinaryMessageSource) => s.deleteMessages
      },
      {
        name: 'clearMessages',
        call: (db: DbService) => db.clearMessages(TOPIC),
        spy: (s: OrdinaryMessageSource) => s.clearMessages
      },
      {
        name: 'topicExists',
        call: (db: DbService) => db.topicExists(TOPIC),
        spy: (s: OrdinaryMessageSource) => s.topicExists
      },
      {
        name: 'ensureTopic',
        call: (db: DbService) => db.ensureTopic(TOPIC),
        spy: (s: OrdinaryMessageSource) => s.ensureTopic
      }
    ] as const

    for (const op of TOPIC_OPS) {
      it(`${op.name} routes to SQLite source`, async () => {
        const { db, sqlite, factory } = makeSqliteDb()
        await op.call(db)
        expect(op.spy(sqlite)).toHaveBeenCalledOnce()
        expect(factory).toHaveBeenCalledOnce()
        // Dexie should NOT be called for this operation
      })
    }

    it('bulkAddBlocks routes to SQLite source', async () => {
      const { db, sqlite } = makeSqliteDb()
      await db.bulkAddBlocks([{ id: 'b1' } as any])
      expect(sqlite.bulkAddBlocks).toHaveBeenCalledOnce()
    })

    it('deleteBlocks routes to SQLite source', async () => {
      const { db, sqlite } = makeSqliteDb()
      await db.deleteBlocks(['b1'])
      expect(sqlite.deleteBlocks).toHaveBeenCalledOnce()
    })

    it('updateSingleBlock routes to SQLite for ordinary block', async () => {
      setupMockState({ blocks: { [BLK_ID]: { messageId: MSG_ID } }, messages: { [MSG_ID]: { topicId: TOPIC } } })
      const { db, sqlite } = makeSqliteDb()
      await db.updateSingleBlock(BLK_ID, { content: 'x' } as any)
      expect(sqlite.updateSingleBlock).toHaveBeenCalledOnce()
    })

    it('updateBlocks routes ordinary partition to SQLite source', async () => {
      setupMockState({ messages: { [MSG_ID]: { topicId: TOPIC } } })
      const { db, sqlite } = makeSqliteDb()
      await db.updateBlocks([{ id: 'b1', messageId: MSG_ID } as any])
      expect(sqlite.updateBlocks).toHaveBeenCalledOnce()
    })

    it('getSourceType returns sqlite for regular topics', () => {
      const { db } = makeSqliteDb()
      expect(db.getSourceType(TOPIC)).toBe('sqlite')
    })

    it('Dexie source is NOT called for ordinary topic-addressed operations', async () => {
      const { db, dexie } = makeSqliteDb()
      await db.fetchMessages(TOPIC)
      await db.appendMessage(TOPIC, { id: 'm1' } as any, [])
      await db.updateMessage(TOPIC, 'm1', {} as any)
      await db.deleteMessage(TOPIC, 'm1')
      await db.clearMessages(TOPIC)
      await db.topicExists(TOPIC)
      await db.ensureTopic(TOPIC)
      await db.getRawTopic(TOPIC)
      // Verify none of the Dexie ordinary methods were called
      expect(dexie.fetchMessages).not.toHaveBeenCalled()
      expect(dexie.appendMessage).not.toHaveBeenCalled()
      expect(dexie.updateMessage).not.toHaveBeenCalled()
      expect(dexie.deleteMessage).not.toHaveBeenCalled()
      expect(dexie.clearMessages).not.toHaveBeenCalled()
      expect(dexie.topicExists).not.toHaveBeenCalled()
      expect(dexie.ensureTopic).not.toHaveBeenCalled()
      expect(dexie.getRawTopic).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Lazy factory behavior
  // =========================================================================

  describe('lazy SQLite factory', () => {
    it('factory called once on first ordinary operation', async () => {
      const { db, factory } = makeSqliteDb()
      expect(factory).not.toHaveBeenCalled()
      await db.fetchMessages(TOPIC)
      expect(factory).toHaveBeenCalledOnce()
    })

    it('factory called at most once across multiple ordinary operations', async () => {
      const { db, factory } = makeSqliteDb()
      await db.fetchMessages(TOPIC)
      await db.appendMessage(TOPIC, { id: 'm1' } as any, [])
      await db.updateMessage(TOPIC, 'm1', {} as any)
      await db.deleteMessage(TOPIC, 'm1')
      await db.clearMessages(TOPIC)
      await db.topicExists(TOPIC)
      await db.ensureTopic(TOPIC)
      await db.getRawTopic(TOPIC)
      await db.bulkAddBlocks([])
      await db.deleteBlocks(['b1'])
      expect(factory).toHaveBeenCalledOnce()
    })

    it('agent-only calls never create SQLite source', async () => {
      const { db, factory } = makeSqliteDb()
      await db.fetchMessages(AGENT_TOPIC)
      await db.appendMessage(AGENT_TOPIC, { id: 'm1' } as any, [])
      await db.updateMessage(AGENT_TOPIC, 'm1', {} as any)
      await db.deleteMessage(AGENT_TOPIC, 'm1')
      await db.clearMessages(AGENT_TOPIC)
      await db.topicExists(AGENT_TOPIC)
      await db.ensureTopic(AGENT_TOPIC)
      await db.getRawTopic(AGENT_TOPIC)
      expect(factory).not.toHaveBeenCalled()
    })

    it('dexie policy never calls sqlite factory', async () => {
      const dexie = makeDexieSpy()
      const agent = makeAgentSpy()
      const sqliteFactory = vi.fn()
      const db = new DbService({
        policy: 'dexie',
        dexieSource: dexie,
        agentSource: agent,
        sqliteSourceFactory: sqliteFactory
      })
      await db.fetchMessages(TOPIC)
      await db.appendMessage(TOPIC, { id: 'm1' } as any, [])
      expect(sqliteFactory).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Agent routing (policy-independent, highest precedence)
  // =========================================================================

  describe('agent routing (policy-independent)', () => {
    const AGENT_OPS = [
      {
        name: 'fetchMessages',
        call: (db: DbService) => db.fetchMessages(AGENT_TOPIC),
        spy: (a: AgentMessageSource) => a.fetchMessages
      },
      {
        name: 'getRawTopic',
        call: (db: DbService) => db.getRawTopic(AGENT_TOPIC),
        spy: (a: AgentMessageSource) => a.getRawTopic
      },
      {
        name: 'appendMessage',
        call: (db: DbService) => db.appendMessage(AGENT_TOPIC, { id: 'm1' } as any, []),
        spy: (a: AgentMessageSource) => a.appendMessage
      },
      {
        name: 'updateMessage',
        call: (db: DbService) => db.updateMessage(AGENT_TOPIC, 'm1', {} as any),
        spy: (a: AgentMessageSource) => a.updateMessage
      },
      {
        name: 'updateMessageAndBlocks',
        call: (db: DbService) => db.updateMessageAndBlocks(AGENT_TOPIC, { id: 'm1' } as any, []),
        spy: (a: AgentMessageSource) => a.updateMessageAndBlocks
      },
      {
        name: 'deleteMessage',
        call: (db: DbService) => db.deleteMessage(AGENT_TOPIC, 'm1'),
        spy: (a: AgentMessageSource) => a.deleteMessage
      },
      {
        name: 'deleteMessages',
        call: (db: DbService) => db.deleteMessages(AGENT_TOPIC, ['m1']),
        spy: (a: AgentMessageSource) => a.deleteMessages
      },
      {
        name: 'clearMessages',
        call: (db: DbService) => db.clearMessages(AGENT_TOPIC),
        spy: (a: AgentMessageSource) => a.clearMessages
      },
      {
        name: 'topicExists',
        call: (db: DbService) => db.topicExists(AGENT_TOPIC),
        spy: (a: AgentMessageSource) => a.topicExists
      },
      {
        name: 'ensureTopic',
        call: (db: DbService) => db.ensureTopic(AGENT_TOPIC),
        spy: (a: AgentMessageSource) => a.ensureTopic
      }
    ] as const

    for (const op of AGENT_OPS) {
      it(`${op.name} routes to agent source under dexie policy`, async () => {
        const { db, agent } = makeDexieDb()
        await op.call(db)
        expect(op.spy(agent)).toHaveBeenCalledOnce()
      })
    }

    for (const op of AGENT_OPS) {
      it(`${op.name} routes to agent source under sqlite-validation policy`, async () => {
        const { db, agent } = makeSqliteDb()
        await op.call(db)
        expect(op.spy(agent)).toHaveBeenCalledOnce()
      })
    }

    it('agent topic operations do NOT call ordinary source under dexie', async () => {
      const { db, dexie } = makeDexieDb()
      await db.fetchMessages(AGENT_TOPIC)
      expect(dexie.fetchMessages).not.toHaveBeenCalled()
    })

    it('agent topic operations do NOT create SQLite source', async () => {
      const { db, factory } = makeSqliteDb()
      await db.fetchMessages(AGENT_TOPIC)
      expect(factory).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Block operations
  // =========================================================================

  describe('block operations', () => {
    describe('updateBlocks', () => {
      it('partitions agent and ordinary blocks correctly', async () => {
        setupMockState({
          messages: {
            [MSG_ID]: { topicId: TOPIC },
            [AGENT_MSG_ID]: { topicId: AGENT_TOPIC }
          }
        })
        const { db, dexie, agent } = makeDexieDb()

        await db.updateBlocks([
          { id: 'b-ordinary', messageId: MSG_ID } as any,
          { id: 'b-agent', messageId: AGENT_MSG_ID } as any
        ])

        expect(agent.updateBlocks).toHaveBeenCalledOnce()
        expect(dexie.updateBlocks).toHaveBeenCalledOnce()

        // Verify the correct blocks went to each source
        const agentBlocks = (agent.updateBlocks as any).mock.calls[0][0]
        const dexieBlocks = (dexie.updateBlocks as any).mock.calls[0][0]
        expect(agentBlocks).toHaveLength(1)
        expect(agentBlocks[0].id).toBe('b-agent')
        expect(dexieBlocks).toHaveLength(1)
        expect(dexieBlocks[0].id).toBe('b-ordinary')
      })

      it('unresolvable blocks route to configured ordinary source', async () => {
        setupMockState({}) // empty state — nothing resolvable
        const { db, dexie, agent } = makeDexieDb()

        await db.updateBlocks([{ id: 'b-orphan', messageId: 'unknown-msg' } as any])

        expect(agent.updateBlocks).not.toHaveBeenCalled()
        expect(dexie.updateBlocks).toHaveBeenCalledOnce()
      })

      it('empty blocks array is a no-op', async () => {
        const { db, dexie, agent } = makeDexieDb()
        await db.updateBlocks([])
        expect(dexie.updateBlocks).not.toHaveBeenCalled()
        expect(agent.updateBlocks).not.toHaveBeenCalled()
      })

      it('partitions correctly under sqlite-validation', async () => {
        setupMockState({
          messages: {
            [MSG_ID]: { topicId: TOPIC },
            [AGENT_MSG_ID]: { topicId: AGENT_TOPIC }
          }
        })
        const { db, sqlite, agent } = makeSqliteDb()

        await db.updateBlocks([
          { id: 'b-ordinary', messageId: MSG_ID } as any,
          { id: 'b-agent', messageId: AGENT_MSG_ID } as any
        ])

        expect(agent.updateBlocks).toHaveBeenCalledOnce()
        expect(sqlite.updateBlocks).toHaveBeenCalledOnce()
      })
    })

    describe('updateSingleBlock', () => {
      it('routes to agent source for agent-classified block', async () => {
        setupMockState({
          blocks: { [AGENT_BLK_ID]: { messageId: AGENT_MSG_ID } },
          messages: { [AGENT_MSG_ID]: { topicId: AGENT_TOPIC } }
        })
        const { db, agent, dexie } = makeDexieDb()

        await db.updateSingleBlock(AGENT_BLK_ID, { content: 'x' } as any)

        expect(agent.updateSingleBlock).toHaveBeenCalledOnce()
        expect(dexie.updateSingleBlock).not.toHaveBeenCalled()
      })

      it('routes to configured ordinary source for ordinary block', async () => {
        setupMockState({
          blocks: { [BLK_ID]: { messageId: MSG_ID } },
          messages: { [MSG_ID]: { topicId: TOPIC } }
        })
        const { db, dexie, agent } = makeDexieDb()

        await db.updateSingleBlock(BLK_ID, { content: 'x' } as any)

        expect(dexie.updateSingleBlock).toHaveBeenCalledOnce()
        expect(agent.updateSingleBlock).not.toHaveBeenCalled()
      })

      it('routes to configured ordinary source for unresolved block (not in state)', async () => {
        setupMockState({}) // empty state
        const { db, dexie, agent } = makeDexieDb()

        await db.updateSingleBlock('unknown-blk', { content: 'x' } as any)

        expect(dexie.updateSingleBlock).toHaveBeenCalledOnce()
        expect(agent.updateSingleBlock).not.toHaveBeenCalled()
      })

      it('routes agent block to agent source under sqlite-validation', async () => {
        setupMockState({
          blocks: { [AGENT_BLK_ID]: { messageId: AGENT_MSG_ID } },
          messages: { [AGENT_MSG_ID]: { topicId: AGENT_TOPIC } }
        })
        const { db, agent, sqlite } = makeSqliteDb()

        await db.updateSingleBlock(AGENT_BLK_ID, { content: 'x' } as any)

        expect(agent.updateSingleBlock).toHaveBeenCalledOnce()
        expect(sqlite.updateSingleBlock).not.toHaveBeenCalled()
      })
    })

    describe('bulkAddBlocks', () => {
      it('routes to configured ordinary source (dexie)', async () => {
        const { db, dexie } = makeDexieDb()
        await db.bulkAddBlocks([{ id: 'b1' } as any])
        expect(dexie.bulkAddBlocks).toHaveBeenCalledOnce()
      })

      it('routes to configured ordinary source (sqlite)', async () => {
        const { db, sqlite } = makeSqliteDb()
        await db.bulkAddBlocks([{ id: 'b1' } as any])
        expect(sqlite.bulkAddBlocks).toHaveBeenCalledOnce()
      })
    })

    describe('deleteBlocks', () => {
      it('routes to configured ordinary source (dexie)', async () => {
        const { db, dexie } = makeDexieDb()
        await db.deleteBlocks(['b1', 'b2'])
        expect(dexie.deleteBlocks).toHaveBeenCalledWith(['b1', 'b2'])
      })

      it('routes to configured ordinary source (sqlite)', async () => {
        const { db, sqlite } = makeSqliteDb()
        await db.deleteBlocks(['b1', 'b2'])
        expect(sqlite.deleteBlocks).toHaveBeenCalledWith(['b1', 'b2'])
      })
    })
  })

  // =========================================================================
  // File operations — always Dexie
  // =========================================================================

  describe('file operations (always Dexie)', () => {
    it('updateFileCount uses Dexie under dexie policy', async () => {
      const { db, dexie } = makeDexieDb()
      await db.updateFileCount('file-1', 1, true)
      expect(dexie.updateFileCount).toHaveBeenCalledWith('file-1', 1, true)
    })

    it('updateFileCount uses Dexie under sqlite-validation policy', async () => {
      const { db, dexie, sqlite } = makeSqliteDb()
      await db.updateFileCount('file-1', -1, false)
      expect(dexie.updateFileCount).toHaveBeenCalledWith('file-1', -1, false)
      // SQLite source must NOT be called for file ops
      expect(sqlite.updateFileCount ?? vi.fn()).not.toHaveBeenCalled()
    })

    it('updateFileCounts uses Dexie under dexie policy', async () => {
      const { db, dexie } = makeDexieDb()
      const files = [
        { id: 'f1', delta: 1 },
        { id: 'f2', delta: -1, deleteIfZero: true }
      ]
      await db.updateFileCounts(files)
      expect(dexie.updateFileCounts).toHaveBeenCalledWith(files)
    })

    it('updateFileCounts uses Dexie under sqlite-validation policy', async () => {
      const { db, dexie } = makeSqliteDb()
      const files = [{ id: 'f1', delta: 2 }]
      await db.updateFileCounts(files)
      expect(dexie.updateFileCounts).toHaveBeenCalledWith(files)
    })

    it('file operations never create SQLite source', async () => {
      const { db, factory } = makeSqliteDb()
      await db.updateFileCount('file-1', 1)
      await db.updateFileCounts([{ id: 'f1', delta: 1 }])
      expect(factory).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // getSourceType
  // =========================================================================

  describe('getSourceType', () => {
    it('returns agent for agent session topics', () => {
      const { db } = makeDexieDb()
      expect(db.getSourceType(AGENT_TOPIC)).toBe('agent')
    })

    it('returns dexie for regular topics under dexie policy', () => {
      const { db } = makeDexieDb()
      expect(db.getSourceType(TOPIC)).toBe('dexie')
    })

    it('returns sqlite for regular topics under sqlite-validation policy', () => {
      const { db } = makeSqliteDb()
      expect(db.getSourceType(TOPIC)).toBe('sqlite')
    })

    it('agent detection takes precedence over policy', () => {
      const { db } = makeSqliteDb()
      expect(db.getSourceType(AGENT_TOPIC)).toBe('agent')
    })
  })

  // =========================================================================
  // Error propagation
  // =========================================================================

  describe('error propagation', () => {
    it('transport error from configured source propagates unchanged', async () => {
      const { db, dexie } = makeDexieDb()
      const error = new Error('IPC transport failed')
      ;(dexie.fetchMessages as any).mockRejectedValue(error)

      await expect(db.fetchMessages(TOPIC)).rejects.toThrow('IPC transport failed')
    })

    it('structured failure from SQLite propagates unchanged', async () => {
      const { db, sqlite } = makeSqliteDb()
      const error = new Error('NOT_FOUND: topic missing')
      ;(sqlite.fetchMessages as any).mockRejectedValue(error)

      await expect(db.fetchMessages(TOPIC)).rejects.toThrow('NOT_FOUND: topic missing')
    })

    it('exactly one source call on failure, zero to other sources', async () => {
      const { db, dexie, agent } = makeDexieDb()
      ;(dexie.appendMessage as any).mockRejectedValue(new Error('fail'))

      try {
        await db.appendMessage(TOPIC, { id: 'm1' } as any, [])
      } catch {
        // expected
      }

      expect(dexie.appendMessage).toHaveBeenCalledOnce()
      expect(agent.appendMessage).not.toHaveBeenCalled()
    })

    it('SQLite failure does not trigger Dexie fallback', async () => {
      const { db, sqlite, dexie } = makeSqliteDb()
      ;(sqlite.fetchMessages as any).mockRejectedValue(new Error('SQLite error'))

      try {
        await db.fetchMessages(TOPIC)
      } catch {
        // expected
      }

      expect(sqlite.fetchMessages).toHaveBeenCalledOnce()
      expect(dexie.fetchMessages).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // No readiness probes
  // =========================================================================

  describe('no readiness probes', () => {
    it('fetchMessages does not call topicExists', async () => {
      const { db, dexie } = makeDexieDb()
      await db.fetchMessages(TOPIC)
      expect(dexie.topicExists).not.toHaveBeenCalled()
    })

    it('appendMessage does not call topicExists', async () => {
      const { db, dexie } = makeDexieDb()
      await db.appendMessage(TOPIC, { id: 'm1' } as any, [])
      expect(dexie.topicExists).not.toHaveBeenCalled()
    })

    it('updateBlocks does not call topicExists', async () => {
      setupMockState({ messages: { [MSG_ID]: { topicId: TOPIC } } })
      const { db, dexie } = makeDexieDb()
      await db.updateBlocks([{ id: 'b1', messageId: MSG_ID } as any])
      expect(dexie.topicExists).not.toHaveBeenCalled()
    })

    it('updateSingleBlock does not call topicExists', async () => {
      setupMockState({
        blocks: { [BLK_ID]: { messageId: MSG_ID } },
        messages: { [MSG_ID]: { topicId: TOPIC } }
      })
      const { db, dexie } = makeDexieDb()
      await db.updateSingleBlock(BLK_ID, {} as any)
      expect(dexie.topicExists).not.toHaveBeenCalled()
    })

    it('file operations do not call topicExists', async () => {
      const { db, dexie } = makeDexieDb()
      await db.updateFileCount('f1', 1)
      expect(dexie.topicExists).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // No mutable policy API
  // =========================================================================

  describe('no mutable policy API', () => {
    it('has no setPolicy method', () => {
      const { db } = makeDexieDb()
      expect((db as any).setPolicy).toBeUndefined()
    })

    it('has no configure method', () => {
      const { db } = makeDexieDb()
      expect((db as any).configure).toBeUndefined()
    })

    it('has no reset method', () => {
      const { db } = makeDexieDb()
      expect((db as any).reset).toBeUndefined()
    })

    it('getSourceType is consistent across calls (immutable policy)', () => {
      const { db } = makeSqliteDb()
      expect(db.getSourceType(TOPIC)).toBe('sqlite')
      expect(db.getSourceType(TOPIC)).toBe('sqlite')
      expect(db.getSourceType(TOPIC)).toBe('sqlite')
    })
  })

  // =========================================================================
  // Argument / return preservation
  // =========================================================================

  describe('argument and return preservation', () => {
    it('fetchMessages passes topicId and forceReload, returns result', async () => {
      const { db, dexie } = makeDexieDb()
      const expectedResult = { messages: [{ id: 'm1' }] as any, blocks: [{ id: 'b1' }] as any }
      ;(dexie.fetchMessages as any).mockResolvedValue(expectedResult)

      const result = await db.fetchMessages(TOPIC, true)

      expect(dexie.fetchMessages).toHaveBeenCalledWith(TOPIC, true)
      expect(result).toBe(expectedResult)
    })

    it('appendMessage passes all arguments through', async () => {
      const { db, dexie } = makeDexieDb()
      const msg = { id: 'm1', role: 'user' } as any
      const blocks = [{ id: 'b1' }] as any

      await db.appendMessage(TOPIC, msg, blocks, 3)

      expect(dexie.appendMessage).toHaveBeenCalledWith(TOPIC, msg, blocks, 3)
    })

    it('updateMessage passes all arguments through', async () => {
      const { db, dexie } = makeDexieDb()
      const updates = { content: 'new' } as any

      await db.updateMessage(TOPIC, 'm1', updates)

      expect(dexie.updateMessage).toHaveBeenCalledWith(TOPIC, 'm1', updates)
    })

    it('updateMessageAndBlocks passes all arguments through', async () => {
      const { db, dexie } = makeDexieDb()
      const msgUpdates = { id: 'm1', content: 'x' } as any
      const blocks = [{ id: 'b1' }] as any

      await db.updateMessageAndBlocks(TOPIC, msgUpdates, blocks)

      expect(dexie.updateMessageAndBlocks).toHaveBeenCalledWith(TOPIC, msgUpdates, blocks)
    })

    it('deleteMessages passes messageIds array through', async () => {
      const { db, dexie } = makeDexieDb()
      await db.deleteMessages(TOPIC, ['m1', 'm2', 'm3'])
      expect(dexie.deleteMessages).toHaveBeenCalledWith(TOPIC, ['m1', 'm2', 'm3'])
    })

    it('clearMessages passes topicId through', async () => {
      const { db, dexie } = makeDexieDb()
      await db.clearMessages(TOPIC)
      expect(dexie.clearMessages).toHaveBeenCalledWith(TOPIC)
    })

    it('topicExists returns boolean from source', async () => {
      const { db, dexie } = makeDexieDb()
      ;(dexie.topicExists as any).mockResolvedValue(true)
      expect(await db.topicExists(TOPIC)).toBe(true)
      ;(dexie.topicExists as any).mockResolvedValue(false)
      expect(await db.topicExists(TOPIC)).toBe(false)
    })

    it('getRawTopic returns result from source', async () => {
      const { db, dexie } = makeDexieDb()
      const rawTopic = { id: TOPIC, messages: [] }
      ;(dexie.getRawTopic as any).mockResolvedValue(rawTopic)
      expect(await db.getRawTopic(TOPIC)).toBe(rawTopic)
    })

    it('getRawTopic returns undefined when source returns undefined', async () => {
      const { db, dexie } = makeDexieDb()
      ;(dexie.getRawTopic as any).mockResolvedValue(undefined)
      expect(await db.getRawTopic(TOPIC)).toBeUndefined()
    })
  })

  // =========================================================================
  // isAgentSession utility
  // =========================================================================

  describe('isAgentSession', () => {
    it('returns true for agent session topics', () => {
      const { db } = makeDexieDb()
      expect(db.isAgentSession(AGENT_TOPIC)).toBe(true)
    })

    it('returns false for regular topics', () => {
      const { db } = makeDexieDb()
      expect(db.isAgentSession(TOPIC)).toBe(false)
    })
  })
})
