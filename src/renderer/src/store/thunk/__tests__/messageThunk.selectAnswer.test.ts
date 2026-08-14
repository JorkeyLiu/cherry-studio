/**
 * selectAnswerMessageThunk — PERF-100 one-logical-selection contract.
 *
 * Verifies:
 *  1. DB-first: ONE `dbService.selectAnswerMessage` atomic Main command runs
 *     BEFORE any Redux commit.
 *  2. Exactly ONE plural `updateManyMessages` Redux dispatch for the whole
 *     logical selection (never one dispatch per group member).
 *  3. The Redux commit carries every foldSelected patch: selected=true,
 *     every other supplied ID=false.
 *  4. DB failure propagates and NO Redux commit happens (no divergent state).
 *  5. The thunk does NOT dispatch updateTopicUpdatedAt itself — the data
 *     source dispatches it exactly once (the thunk must not duplicate it).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    dbSelectAnswerMessage: vi.fn().mockResolvedValue(undefined),
    dispatch: vi.fn(),
    updateManyMessagesAction: vi.fn((p: unknown) => ({ type: 'updateManyMessages', payload: p })),
    updateTopicUpdatedAtAction: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p }))
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => ({})
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    updateManyMessages: mocks.updateManyMessagesAction,
    updateMessage: vi.fn()
  },
  selectMessagesForTopic: vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAtAction,
  default: {}
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: vi.fn(),
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    selectAnswerMessage: mocks.dbSelectAnswerMessage,
    updateMessageAndBlocks: vi.fn(),
    updateMessage: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    appendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    resetMessagesForResend: vi.fn(),
    fetchMessages: vi.fn().mockResolvedValue({ messages: [], blocks: [] }),
    deleteMessagesWithSegments: vi.fn(),
    deleteBlocks: vi.fn(),
    listBlocksByFile: vi.fn()
  }
}))

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({
      selectAnswerMessage: vi.fn()
    })
  }
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: vi.fn(() => ({ add: vi.fn() })),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: vi.fn(),
  findMainTextBlocks: vi.fn(),
  findAllBlocks: vi.fn(),
  findTranslationBlocks: vi.fn(),
  findTranslationBlocksById: vi.fn(),
  isAssistantInterruptedThinkingOnlyMessage: vi.fn()
}))

vi.mock('lru-cache', () => ({
  LRUCache: vi.fn().mockImplementation(() => ({
    has: vi.fn(() => false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }))
}))

vi.mock('swr', () => ({
  mutate: vi.fn()
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

vi.mock('@renderer/store/topicSegment', () => ({
  clearSegmentsForTopic: vi.fn()
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  clearTopicSegmentsFromDB: vi.fn(),
  loadTopicSegmentsThunk: vi.fn(),
  removeMessageFromSegmentsThunk: vi.fn()
}))

// Import AFTER mocks
import { selectAnswerMessageThunk } from '@renderer/store/thunk/messageThunk'

// --- Test data ------------------------------------------------------------

const topicId = 'topic-123'
const selectedMessageId = 'a-2'
const messageIds = ['a-1', 'a-2', 'a-3']

// --- Tests ----------------------------------------------------------------

describe('selectAnswerMessageThunk — PERF-100 one logical selection', () => {
  const dispatch = mocks.dispatch

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dbSelectAnswerMessage.mockResolvedValue(undefined)
  })

  it('runs ONE atomic DB command BEFORE any Redux commit', async () => {
    const callOrder: string[] = []
    mocks.dbSelectAnswerMessage.mockImplementation(async () => {
      callOrder.push('db-atomic')
    })
    dispatch.mockImplementation((action: unknown) => {
      callOrder.push(`redux-${(action as any).type}`)
      return action
    })

    await selectAnswerMessageThunk(topicId, selectedMessageId, messageIds)(dispatch)

    expect(mocks.dbSelectAnswerMessage).toHaveBeenCalledTimes(1)
    expect(mocks.dbSelectAnswerMessage).toHaveBeenCalledWith(topicId, selectedMessageId, messageIds)

    const dbIdx = callOrder.findIndex((c) => c.startsWith('db-'))
    const reduxIdx = callOrder.findIndex((c) => c.startsWith('redux-'))
    expect(dbIdx).toBeGreaterThanOrEqual(0)
    expect(reduxIdx).toBeGreaterThanOrEqual(0)
    expect(dbIdx).toBeLessThan(reduxIdx)
  })

  it('performs EXACTLY ONE plural Redux dispatch for the whole selection', async () => {
    await selectAnswerMessageThunk(topicId, selectedMessageId, messageIds)(dispatch)

    // Exactly one Redux action total — the plural commit.
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.updateManyMessagesAction).toHaveBeenCalledTimes(1)
    // Never one dispatch per group member.
    expect(dispatch).not.toHaveBeenCalledTimes(messageIds.length)
  })

  it('commits every foldSelected patch in one updateManyMessages action', async () => {
    await selectAnswerMessageThunk(topicId, selectedMessageId, messageIds)(dispatch)

    const payload = mocks.updateManyMessagesAction.mock.calls[0][0] as any
    expect(payload.topicId).toBe(topicId)
    expect(payload.updates).toEqual([
      { messageId: 'a-1', updates: { foldSelected: false } },
      { messageId: 'a-2', updates: { foldSelected: true } },
      { messageId: 'a-3', updates: { foldSelected: false } }
    ])
    // Exactly one selected among the supplied group.
    const selectedPatches = payload.updates.filter((u: any) => u.updates.foldSelected === true)
    expect(selectedPatches).toHaveLength(1)
    expect(selectedPatches[0].messageId).toBe(selectedMessageId)
  })

  it('does NOT touch Redux when the DB command fails (no divergent state)', async () => {
    mocks.dbSelectAnswerMessage.mockRejectedValue(new Error('SQLite not found'))

    await expect(selectAnswerMessageThunk(topicId, selectedMessageId, messageIds)(dispatch)).rejects.toThrow(
      'SQLite not found'
    )

    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.updateManyMessagesAction).not.toHaveBeenCalled()
  })

  it('does NOT dispatch updateTopicUpdatedAt itself (data source owns the single timestamp dispatch)', async () => {
    await selectAnswerMessageThunk(topicId, selectedMessageId, messageIds)(dispatch)

    // The thunk's only dispatch is the plural commit; the data source
    // dispatches updateTopicUpdatedAt exactly once outside the thunk.
    expect(mocks.updateTopicUpdatedAtAction).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
