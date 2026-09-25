/**
 * deleteMessagesWithDependentsThunk / deleteSingleMessageThunk — unified
 * plural semantic delete.
 *
 * The renderer supplies ONLY stable root IDs. Main expands user dependents +
 * captures the authority undo snapshot in one transaction. Redux/segments/
 * anchor converge from the response deltas only after DB success; DB failure
 * leaves Redux/anchor untouched and yields no undo parts.
 */

import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesWithDependents: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    removeMessages: vi.fn((p: unknown) => ({ type: 'removeMessages', p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', p })),
    replaceSegmentsForTopic: vi.fn((p: unknown) => ({ type: 'replaceSegmentsForTopic', p })),
    transferAnchorsWithAuthorityGroupKeys: vi.fn(),
    transferAnchorsAfterDeletion: vi.fn(),
    buildGroupList: vi.fn(() => []),
    selectLoadedMessagesForTopic: vi.fn(),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', p }))
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
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents,
    deleteMessagesWithSegments: vi.fn(),
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    updateMessage: vi.fn(),
    fetchMessages: vi.fn(),
    listBlocksByFile: vi.fn(),
    deleteBlocks: vi.fn()
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult,
  restoreOrdinaryTopic: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn()
}))

vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: mocks.buildGroupList,
  transferAnchorsAfterDeletion: mocks.transferAnchorsAfterDeletion,
  transferAnchorsWithAuthorityGroupKeys: mocks.transferAnchorsWithAuthorityGroupKeys
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn()
}))

vi.mock('@renderer/store/topicSegment', () => ({
  replaceSegmentsForTopic: mocks.replaceSegmentsForTopic
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
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

// --- Helpers --------------------------------------------------------------

const createMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'msg-1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: ['block-1', 'block-2'],
    askId: undefined,
    ...overrides
  }) as unknown as Message

const createAssistantMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'asst-1',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks: ['block-3'],
    askId: 'msg-1',
    ...overrides
  }) as unknown as Message

const semanticResponse = {
  affectedFileIds: [],
  remainingReferenceCounts: {},
  deletedMessageIds: ['msg-1', 'asst-1'],
  deletedBlockIds: ['block-1', 'block-2', 'block-3'],
  previousUserMessageIds: ['msg-1'],
  remainingUserMessageIds: [],
  segments: [],
  restoreGroups: [
    {
      entries: [
        { message: { id: 'msg-1', blocks: ['block-1', 'block-2'] }, blocks: [{ id: 'block-1' }, { id: 'block-2' }] },
        { message: { id: 'asst-1', blocks: ['block-3'] }, blocks: [{ id: 'block-3' }] }
      ],
      positionIndex: 0,
      anchorMessageId: null
    }
  ],
  segmentSnapshots: []
}

// --- Store mock setup ----------------------------------------------------

interface StoreState {
  messages: {
    entities: Record<string, Message>
    messageIdsByTopic: Record<string, string[]>
  }
}

let storeState: StoreState

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    removeMessages: mocks.removeMessages
  },
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: mocks.removeManyBlocks,
  updateOneBlock: vi.fn(),
  upsertManyBlocks: vi.fn(),
  upsertOneBlock: vi.fn()
}))

// --- Tests ----------------------------------------------------------------

describe('deleteSingleMessageThunk (thin plural wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: {
        entities: {},
        messageIdsByTopic: {}
      }
    }
  })

  describe('semantic delete (DB-first, authority deltas)', () => {
    it('calls the plural semantic command with one stable root and converges from response deltas', async () => {
      const userMsg = createMessage()
      const asstMsg = createAssistantMessage()

      storeState.messages.entities = {
        'msg-1': userMsg,
        'asst-1': asstMsg
      }
      storeState.messages.messageIdsByTopic = {
        'topic-1': ['msg-1', 'asst-1']
      }
      mocks.deleteMessagesWithDependents.mockResolvedValue(semanticResponse)

      const { deleteSingleMessageThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await deleteSingleMessageThunk('topic-1', 'msg-1')(dispatch, () => storeState as any)

      expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith('topic-1', ['msg-1'], null)
      expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(semanticResponse)
      expect(mocks.replaceSegmentsForTopic).toHaveBeenCalledTimes(1)
      expect(mocks.transferAnchorsWithAuthorityGroupKeys).toHaveBeenCalledWith(
        dispatch,
        expect.any(Function),
        'topic-1',
        ['msg-1'],
        [],
        null
      )
    })

    it('Redux mutations happen AFTER successful DB commit', async () => {
      const userMsg = createMessage()
      storeState.messages.entities = { 'msg-1': userMsg }
      storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }

      const dbCalled = vi.fn()
      const cleanupCalled = vi.fn()
      const reduxCalled = vi.fn()
      mocks.deleteMessagesWithDependents.mockImplementation(async () => {
        dbCalled()
        return semanticResponse
      })
      mocks.consumeFileCleanupResult.mockImplementation(async () => {
        cleanupCalled()
      })

      const { deleteSingleMessageThunk } = await import('../messageThunk')
      const dispatch = vi.fn().mockImplementation(() => {
        reduxCalled()
      })

      await deleteSingleMessageThunk('topic-1', 'msg-1')(dispatch, () => storeState as any)

      expect(dbCalled).toHaveBeenCalled()
      expect(cleanupCalled).toHaveBeenCalled()
      expect(reduxCalled).toHaveBeenCalled()
      expect(dbCalled.mock.invocationCallOrder[0]).toBeLessThan(cleanupCalled.mock.invocationCallOrder[0])
      expect(cleanupCalled.mock.invocationCallOrder[0]).toBeLessThan(reduxCalled.mock.invocationCallOrder[0])
    })

    it('DB failure leaves Redux and anchors unchanged', async () => {
      const userMsg = createMessage()
      storeState.messages.entities = { 'msg-1': userMsg }
      storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
      mocks.deleteMessagesWithDependents.mockRejectedValue(new Error('SQLITE_FAILURE'))

      const { deleteSingleMessageThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await deleteSingleMessageThunk('topic-1', 'msg-1')(dispatch, () => storeState as any)

      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
      expect(mocks.transferAnchorsWithAuthorityGroupKeys).not.toHaveBeenCalled()
      expect(mocks.replaceSegmentsForTopic).not.toHaveBeenCalled()
    })
  })
})

describe('deleteMessagesWithDependentsThunk (plural roots)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: {
        entities: {},
        messageIdsByTopic: {}
      }
    }
  })

  it('passes stable root IDs without reading the loaded cascade and returns undo parts', async () => {
    mocks.deleteMessagesWithDependents.mockResolvedValue(semanticResponse)
    storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1', 'asst-1'] }

    const { deleteMessagesWithDependentsThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as any

    const result = await deleteMessagesWithDependentsThunk('topic-1', ['msg-1', 'other-root'])(dispatch, getState)

    // Roots pass through untouched — no loaded expansion, no cascade derivation.
    // Main route resolves to the null route owner.
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith('topic-1', ['msg-1', 'other-root'], null)
    expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(mocks.buildGroupList).not.toHaveBeenCalled()
    // Authority convergence.
    expect(mocks.removeMessages).toHaveBeenCalledWith({
      topicId: 'topic-1',
      messageIds: ['msg-1', 'asst-1']
    })
    expect(mocks.replaceSegmentsForTopic).toHaveBeenCalledTimes(1)
    expect(mocks.transferAnchorsWithAuthorityGroupKeys).toHaveBeenCalledWith(
      dispatch,
      expect.any(Function),
      'topic-1',
      ['msg-1'],
      [],
      null
    )
    // Normalized undo snapshot for the caller.
    expect(result.response).toBe(semanticResponse)
    expect(result.undoParts.groupAnchors).toHaveLength(1)
    expect(result.undoParts.groupAnchors[0].anchorMessageId).toBeNull()
    expect(result.undoParts.groupAnchors[0].messages.map((m) => m.id)).toEqual(['msg-1', 'asst-1'])
    // Loaded intersection captured before persistence bounds the Redux projection.
    expect(result.undoParts.groupAnchors[0].loadedMessageIds).toEqual(['msg-1', 'asst-1'])
    expect(result.undoParts.segmentSnapshots).toEqual([])
  })

  it('captures the pre-delete loaded set so partly-loaded groups record only the loaded intersection', async () => {
    mocks.deleteMessagesWithDependents.mockResolvedValue(semanticResponse)
    // asst-1 was outside the loaded projection before delete.
    storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }

    const { deleteMessagesWithDependentsThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const result = await deleteMessagesWithDependentsThunk('topic-1', ['msg-1'])(dispatch, () => storeState as any)

    // Full authority messages/blocks are kept for Main restore.
    expect(result.undoParts.groupAnchors[0].messages.map((m) => m.id)).toEqual(['msg-1', 'asst-1'])
    expect(result.undoParts.groupAnchors[0].loadedMessageIds).toEqual(['msg-1'])
  })

  it('DB failure propagates with no dispatch and no undo parts', async () => {
    mocks.deleteMessagesWithDependents.mockRejectedValue(new Error('SQLITE_FAILURE'))

    const { deleteMessagesWithDependentsThunk } = await import('../messageThunk')
    const dispatch = vi.fn()

    await expect(
      deleteMessagesWithDependentsThunk('topic-1', ['msg-1'])(dispatch, () => storeState as any)
    ).rejects.toThrow('SQLITE_FAILURE')
    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
  })
})

describe('buildDeleteDependentsUndoParts (response adapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('derives file deltas from authority FILE blocks for undo restoration', async () => {
    const { buildDeleteDependentsUndoParts } = await import('../messageThunk')
    const response = {
      ...semanticResponse,
      restoreGroups: [
        {
          entries: [
            {
              message: { id: 'msg-1' },
              blocks: [{ id: 'block-f', type: MessageBlockType.FILE, file: { id: 'file-1' } }]
            }
          ],
          positionIndex: 2,
          anchorMessageId: 'next-1'
        }
      ]
    }
    const parts = buildDeleteDependentsUndoParts(response as any, ['msg-1'])
    expect(parts.groupAnchors).toHaveLength(1)
    expect(parts.groupAnchors[0].positionIndex).toBe(2)
    expect(parts.groupAnchors[0].anchorMessageId).toBe('next-1')
    expect(parts.groupAnchors[0].loadedMessageIds).toEqual(['msg-1'])
    expect(parts.fileReferenceDeltas).toEqual([{ fileId: 'file-1', delta: -1 }])
  })

  it('intersects authority restore groups with the pre-delete loaded set (ordered)', async () => {
    const { buildDeleteDependentsUndoParts } = await import('../messageThunk')
    const response = {
      ...semanticResponse,
      restoreGroups: [
        {
          entries: [
            { message: { id: 'm1' }, blocks: [{ id: 'b1', messageId: 'm1' }] },
            { message: { id: 'm2' }, blocks: [{ id: 'b2', messageId: 'm2' }] },
            { message: { id: 'm3' }, blocks: [{ id: 'b3', messageId: 'm3' }] }
          ],
          positionIndex: 0,
          anchorMessageId: null
        }
      ]
    }
    const parts = buildDeleteDependentsUndoParts(response as any, ['m1', 'm3'])
    // Full authority payload kept for Main.
    expect(parts.groupAnchors[0].messages.map((m) => (m as unknown as { id: string }).id)).toEqual(['m1', 'm2', 'm3'])
    expect(parts.groupAnchors[0].blocks).toHaveLength(3)
    // Redux projection subset only.
    expect(parts.groupAnchors[0].loadedMessageIds).toEqual(['m1', 'm3'])
  })

  it('missing pre-delete set fails closed with an empty intersection', async () => {
    const { buildDeleteDependentsUndoParts } = await import('../messageThunk')
    const parts = buildDeleteDependentsUndoParts(semanticResponse as any)
    expect(parts.groupAnchors[0].messages.map((m) => (m as unknown as { id: string }).id)).toEqual(['msg-1', 'asst-1'])
    expect(parts.groupAnchors[0].loadedMessageIds).toEqual([])
  })

  it('adapts pre-delete segment snapshots to TopicSegment shapes', async () => {
    const { buildDeleteDependentsUndoParts } = await import('../messageThunk')
    const response = {
      ...semanticResponse,
      segmentSnapshots: [
        {
          id: 's1',
          topicId: 'topic-1',
          name: 'seg',
          messageIds: ['msg-1'],
          createdAt: null,
          updatedAt: null,
          sortOrder: 0,
          firstMessageId: 'msg-1',
          lastMessageId: 'msg-1',
          messageCount: 1
        }
      ]
    }
    const parts = buildDeleteDependentsUndoParts(response as any)
    expect(parts.segmentSnapshots).toHaveLength(1)
    expect(parts.segmentSnapshots[0].id).toBe('s1')
    expect(parts.segmentSnapshots[0].messageIds).toEqual(['msg-1'])
    expect(parts.segmentSnapshots[0].sortOrder).toBe(0)
    expect(parts.segmentSnapshots[0].firstMessageId).toBe('msg-1')
    expect(parts.segmentSnapshots[0].lastMessageId).toBe('msg-1')
    expect(parts.segmentSnapshots[0].messageCount).toBe(1)
  })
})
