import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessageGroups: vi.fn(),
    upsertSegment: vi.fn(),
    listSegments: vi.fn(),
    updateFileCount: vi.fn(),
    deleteMessagesFromDB: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectMessagesForTopic: vi.fn(),
    messagesReceived: vi.fn((p: { topicId: string; messages: Message[] }) => ({
      type: 'newMessages/messagesReceived',
      payload: p
    })),
    removeMessages: vi.fn((p: unknown) => ({ type: 'newMessages/removeMessages', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/removeManyBlocks', payload: p })),
    addSegment: vi.fn((p: unknown) => ({ type: 'topicSegment/addSegment', payload: p })),
    replaceSegmentsForTopic: vi.fn((p: unknown) => ({ type: 'topicSegment/replaceSegmentsForTopic', payload: p })),
    pushUndoAction: vi.fn((p: unknown) => ({ type: 'undoStack/pushUndoAction', payload: p })),
    clearClipboard: vi.fn(() => ({ type: 'clipboard/clearClipboard' })),
    collectSegmentSnapshots: vi.fn(() => []),
    syncSegmentsAfterMessageDeletion: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    insertMessageGroups: mocks.insertMessageGroups,
    upsertSegment: mocks.upsertSegment,
    listSegments: mocks.listSegments,
    updateFileCount: mocks.updateFileCount
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/clipboard', () => ({
  clearClipboard: mocks.clearClipboard,
  setClipboard: () => ({ type: 'clipboard/setClipboard' })
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: { messagesReceived: mocks.messagesReceived, removeMessages: mocks.removeMessages },
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: mocks.upsertManyBlocks,
  removeManyBlocks: mocks.removeManyBlocks
}))

vi.mock('@renderer/store/undoStack', () => ({
  pushUndoAction: mocks.pushUndoAction
}))

vi.mock('@renderer/store/topicSegment', () => ({
  addSegment: mocks.addSegment,
  replaceSegmentsForTopic: mocks.replaceSegmentsForTopic
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  collectSegmentSnapshots: mocks.collectSegmentSnapshots,
  collectWholeSelectedSegmentsForClipboard: vi.fn(() => []),
  syncSegmentsAfterMessageDeletion: mocks.syncSegmentsAfterMessageDeletion
}))

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

function makeMsg(id: string): Message {
  return {
    id,
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: []
  } as unknown as Message
}

function baseState(items: any[], segmentSnapshots: any[]) {
  const target = ['m0', 'm1', 'm2', 'm3'].map(makeMsg)
  return {
    clipboard: { mode: 'copy', items, sourceTopicId: null, segmentSnapshots },
    messages: {
      entities: Object.fromEntries(target.map((m) => [m.id, m])),
      messageIdsByTopic: { 'topic-1': target.map((m) => m.id) },
      currentTopicId: 'topic-1'
    },
    messageBlocks: { entities: {} }
  }
}

function mockTargetMessages(state: any) {
  mocks.selectMessagesForTopic.mockImplementation((_s: unknown, topicId: string) => {
    const ids = state.messages.messageIdsByTopic[topicId] ?? []
    return ids.map((id: string) => state.messages.entities[id]).filter(Boolean)
  })
}

function wire(id: string, topicId: string, sortOrder: number, messageIds: string[], name = id) {
  return {
    id,
    topicId,
    name,
    messageIds: [...messageIds],
    color: `color-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length
  }
}

describe('ClipboardService segment batch convergence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.insertMessageGroups.mockResolvedValue(emptyCleanup)
  })

  it('multi-segment rebuild converges with exactly one list+replace, no per-item stale adds', async () => {
    const origA = makeMsg('orig-a')
    const origB = makeMsg('orig-b')
    const state = baseState(
      [{ originalAskId: 'orig-a', messages: [origA, origB], blocks: [] as MessageBlock[], positionIndex: 0 }],
      [
        { originalSegmentId: 'seg-orig-a', name: 'SegA', color: 'color-a', originalMessageIds: ['orig-a'] },
        { originalSegmentId: 'seg-orig-b', name: 'SegB', color: 'color-b', originalMessageIds: ['orig-b'] }
      ]
    )
    mockTargetMessages(state)
    mocks.upsertSegment.mockImplementation((id: string, topicId: string, name: string, messageIds: string[]) =>
      Promise.resolve(wire(id, topicId, 0, messageIds, name))
    )
    mocks.listSegments.mockImplementation((topicId: string) =>
      Promise.resolve([
        wire('seg-new-a', topicId, 0, ['new-a'], 'SegA'),
        wire('seg-new-b', topicId, 1, ['new-b'], 'SegB')
      ])
    )

    const { pasteMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()
    await pasteMessages(dispatch, () => state as any, 'topic-1', 'm1')

    expect(mocks.upsertSegment).toHaveBeenCalledTimes(2)
    expect(mocks.listSegments).toHaveBeenCalledTimes(1)
    expect(mocks.listSegments).toHaveBeenCalledWith('topic-1')
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === 'topicSegment/replaceSegmentsForTopic')
    expect(replaces).toHaveLength(1)
    expect(replaces[0][0].payload.topicId).toBe('topic-1')
    // No per-item stale catalog adds on the success path.
    const adds = dispatch.mock.calls.filter((c) => c[0]?.type === 'topicSegment/addSegment')
    expect(adds).toHaveLength(0)
  })

  it('no created segments performs no catalog read', async () => {
    const orig = makeMsg('orig-a')
    const state = baseState(
      [{ originalAskId: 'orig-a', messages: [orig], blocks: [] as MessageBlock[], positionIndex: 0 }],
      []
    )
    mockTargetMessages(state)

    const { pasteMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()
    await pasteMessages(dispatch, () => state as any, 'topic-1', 'm1')

    expect(mocks.upsertSegment).not.toHaveBeenCalled()
    expect(mocks.listSegments).not.toHaveBeenCalled()
  })

  it('list failure fallback keeps per-wire adds so pasted segments stay visible', async () => {
    const origA = makeMsg('orig-a')
    const state = baseState(
      [{ originalAskId: 'orig-a', messages: [origA], blocks: [] as MessageBlock[], positionIndex: 0 }],
      [{ originalSegmentId: 'seg-orig-a', name: 'SegA', color: 'color-a', originalMessageIds: ['orig-a'] }]
    )
    mockTargetMessages(state)
    mocks.upsertSegment.mockImplementation((id: string, topicId: string, name: string, messageIds: string[]) =>
      Promise.resolve(wire(id, topicId, 0, messageIds, name))
    )
    mocks.listSegments.mockRejectedValue(new Error('list failed'))

    const { pasteMessages } = await import('../ClipboardService')
    const dispatch = vi.fn()
    await pasteMessages(dispatch, () => state as any, 'topic-1', 'm1')

    expect(mocks.upsertSegment).toHaveBeenCalledTimes(1)
    expect(mocks.listSegments).toHaveBeenCalledTimes(1)
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === 'topicSegment/replaceSegmentsForTopic')
    expect(replaces).toHaveLength(0)
    const adds = dispatch.mock.calls.filter((c) => c[0]?.type === 'topicSegment/addSegment')
    expect(adds).toHaveLength(1)
    expect(adds[0][0].payload.messageIds).toHaveLength(1)
  })
})
