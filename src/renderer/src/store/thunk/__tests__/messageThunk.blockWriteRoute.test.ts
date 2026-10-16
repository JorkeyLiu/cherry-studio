/**
 * Block-only write route threading (cross-topic reference boundary).
 *
 * Block-only writes (`updateBlocks` / `updateSingleBlock` / `bulkAddBlocks` /
 * `deleteBlocks`) carry no inherent route. When the UI/store knows the addressed
 * route it must ride with the write so Main can verify each block's parent
 * against the addressed tuple and reject a foreign cross-topic prefix write.
 *
 * Two invariants are locked here:
 * 1. The thunk adapters forward the addressed route tuple they are given
 *    (translation carries the active-topic target route).
 * 2. A source background stream (SSE execution / throttled streaming) carries
 *    its PINNED execution route, never the active route re-resolved at write
 *    time; an explicitly pinned main route (null) is preserved.
 *
 * The route stays optional so existing callers that omit it are unchanged
 * (canonical parent resolution in Main).
 */

import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resetMessagesForResend: vi.fn(),
    resendUserMessages: vi.fn(),
    regenerateAssistantMessage: vi.fn(),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    bulkAddBlocks: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectLoadedMessagesForTopic: vi.fn(),
    transformMessagesAndFetch: vi.fn(),
    autoRenameTopic: vi.fn(),
    computeContextInfo: vi.fn(),
    getAssistantSettings: vi.fn()
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

vi.mock('@renderer/services/db', () => ({
  dbService: {
    resetMessagesForResend: mocks.resetMessagesForResend,
    resendUserMessages: mocks.resendUserMessages,
    regenerateAssistantMessage: mocks.regenerateAssistantMessage,
    appendMessage: mocks.appendMessage,
    updateMessage: mocks.updateMessage,
    updateMessageAndBlocks: mocks.updateMessageAndBlocks,
    updateBlocks: mocks.updateBlocks,
    updateSingleBlock: mocks.updateSingleBlock,
    bulkAddBlocks: mocks.bulkAddBlocks
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn()
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: (task: () => Promise<unknown>) => task() }),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  addAbortController: vi.fn()
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

vi.mock('@renderer/services/ApiService', () => ({
  transformMessagesAndFetch: mocks.transformMessagesAndFetch
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  autoRenameTopic: mocks.autoRenameTopic
}))

vi.mock('@renderer/services/contextInfoService', () => ({
  computeContextInfo: mocks.computeContextInfo
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: mocks.getAssistantSettings
}))

interface StoreState {
  messages: {
    entities: Record<string, any>
    messageIdsByTopic: Record<string, string[]>
    mutableMessageIdsByTopic?: Record<string, string[]>
    mutableRouteByTopic?: Record<string, string | null>
  }
  messageBlocks: { entities: Record<string, any> }
  assistants: { assistants: Array<{ id: string }> }
  topicBranch: { activeBranchIdByTopic: Record<string, string | null> }
}

let storeState: StoreState

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  }
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    addMessage: vi.fn((p: unknown) => ({ type: 'addMessage', p })),
    updateMessage: vi.fn((p: unknown) => ({ type: 'updateMessage', p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'setTopicLoading', p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'setTopicFulfilled', p })),
    upsertBlockReference: vi.fn((p: unknown) => ({ type: 'upsertBlockReference', p }))
  },
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', p })),
  updateOneBlock: vi.fn((p: unknown) => ({ type: 'updateOneBlock', p })),
  upsertManyBlocks: vi.fn(),
  upsertOneBlock: vi.fn((p: unknown) => ({ type: 'upsertOneBlock', p })),
  messageBlocksSelectors: {
    selectById: (state: any, id: string) => state?.messageBlocks?.entities?.[id]
  }
}))

const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r))

const block = (id: string, messageId = 'm-1') => ({ id, messageId }) as unknown as MessageBlock

describe('block-only write route threading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} },
      assistants: { assistants: [] },
      topicBranch: { activeBranchIdByTopic: {} }
    }
    mocks.updateBlocks.mockResolvedValue(undefined)
    mocks.updateSingleBlock.mockResolvedValue(undefined)
    mocks.bulkAddBlocks.mockResolvedValue(undefined)
    // Deterministic RAF so the throttler's DB write is observable without a
    // real animation frame.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  it('forwards the addressed route tuple through every block-only wrapper', async () => {
    const { updateBlocks, updateSingleBlock, bulkAddBlocks } = await import('../messageThunk')
    const route = { topicId: 'topic-1', branchId: 'br-1' }

    await updateBlocks([block('b1')], undefined, 'attempt-1', route)
    expect(mocks.updateBlocks).toHaveBeenCalledWith([block('b1')], undefined, 'attempt-1', route)

    await updateSingleBlock('b1', { content: 'x' } as never, undefined, 'attempt-1', route)
    expect(mocks.updateSingleBlock).toHaveBeenCalledWith('b1', { content: 'x' }, undefined, 'attempt-1', route)

    await bulkAddBlocks([block('b2')], 'attempt-1', route)
    expect(mocks.bulkAddBlocks).toHaveBeenCalledWith([block('b2')], 'attempt-1', route)
  })

  it('keeps the route optional for existing callers (canonical parent resolution)', async () => {
    const { updateBlocks } = await import('../messageThunk')
    await updateBlocks([block('b-legacy')])
    expect(mocks.updateBlocks).toHaveBeenCalledWith([block('b-legacy')], undefined, undefined, undefined)
  })

  it('translation update thunk carries the addressed target route', async () => {
    const { updateTranslationBlockThunk } = await import('../messageThunk')
    const route = { topicId: 'topic-1', branchId: 'br-target' }
    await updateTranslationBlockThunk('b-tr', 'hello', false, route)(vi.fn() as never)

    expect(mocks.updateSingleBlock).toHaveBeenCalledWith(
      'b-tr',
      { content: 'hello', status: MessageBlockStatus.STREAMING },
      undefined,
      undefined,
      route
    )
  })

  it('throttled streaming write carries the execution context route', async () => {
    const { throttledBlockUpdate, flushThrottledBlockUpdate } = await import('../messageThunk')
    throttledBlockUpdate('b-throttle-1', { content: 'chunk' }, { topicId: 'topic-1', branchId: 'br-src' })
    flushThrottledBlockUpdate('b-throttle-1')
    await flushMicrotasks()

    expect(mocks.updateSingleBlock).toHaveBeenCalledWith('b-throttle-1', { content: 'chunk' }, undefined, undefined, {
      topicId: 'topic-1',
      branchId: 'br-src'
    })
  })

  it('source stream message+block save carries the PINNED route, never the active route', async () => {
    const { saveUpdatesToDB } = await import('../messageThunk')
    // The user has since switched to a different branch on the same topic.
    storeState.topicBranch.activeBranchIdByTopic['topic-1'] = 'br-active'

    await saveUpdatesToDB('m-1', 'topic-1', {}, [block('b1')], undefined, 'br-src')

    expect(mocks.updateBlocks).toHaveBeenCalledWith([block('b1')], undefined, undefined, {
      topicId: 'topic-1',
      branchId: 'br-src'
    })
  })

  it('source stream single-block save preserves an explicitly pinned main route (null)', async () => {
    const { saveUpdatedBlockToDB } = await import('../messageThunk')
    storeState.messageBlocks.entities['b-x'] = block('b-x')
    // Active route is a branch, but the pinned execution route is main-route null.
    storeState.topicBranch.activeBranchIdByTopic['topic-1'] = 'br-active'

    await saveUpdatedBlockToDB('b-x', 'm-1', 'topic-1', (() => storeState) as never, 'attempt-1', undefined, null)

    expect(mocks.updateBlocks).toHaveBeenCalledWith([block('b-x')], undefined, 'attempt-1', {
      topicId: 'topic-1',
      branchId: null
    })
  })
})
