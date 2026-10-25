/**
 * Undo/redo catalog-convergence: genuine list failure AFTER a Main commit is
 * a projection failure, never an authority rollback.
 *
 * Real rootReducer store + real UndoService + real segment helpers; Main IPC
 * mocked only. Asserts Main phases + stack position + projection validity
 * flags, not just helper args.
 *
 * Guarantees:
 * - undoDelete message restore + catalog list failure => IDs restored once,
 *   history advanced (no CONFLICT retry), projection invalidated fenced, no
 *   fabricated catalog.
 * - undoCutPaste source catalog list failure => target cleanup still runs,
 *   source restored and copies gone, history advanced.
 * - undoPaste cleanup catalog list failure => deleted copies remain deleted,
 *   history advanced.
 * - redoPaste catalog list failure => copies re-inserted, history advanced.
 * - precommit insert rejection retains history (generic stays fail-closed).
 */
import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessageGroups: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    upsertSegment: vi.fn(),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: vi.fn(),
    listSegments: vi.fn(),
    updateFileCount: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    transferAnchors: vi.fn()
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
    deleteMessagesWithSegments: mocks.deleteMessagesWithSegments,
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents,
    upsertSegment: mocks.upsertSegment,
    replaceSegmentMembership: mocks.replaceSegmentMembership,
    deleteSegment: mocks.deleteSegment,
    listSegments: mocks.listSegments,
    updateFileCount: mocks.updateFileCount
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/services/anchorService', () => ({
  transferAnchorsWithAuthorityGroupKeys: mocks.transferAnchors,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { pushUndoAction } from '@renderer/store/undoStack'
import type { Message } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import { isSegmentCatalogConvergenceError, resetCatalogRequestSeqForTests } from '@renderer/utils/topicSegmentCatalog'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'

function windowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({
      id,
      topicId,
      role: 'user',
      blocks: []
    })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    mutableMessageIds: [...ids],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 20 },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

function establish(store: ReturnType<typeof configureStore>, topicId: string, ids: string[]) {
  store.dispatch(bumpGeneration(topicId))
  const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
  store.dispatch(
    publishResidentComplete({ topicId, generation: gen, windowResponse: windowResponse(topicId, ids), segments: [] })
  )
  store.dispatch(newMessagesActions.mergeRouteMutability({ topicId, route: null, mutableMessageIds: [...ids] }) as any)
}

function ackFor(
  topicId: string,
  groups: Array<{ entries: Array<{ message: { id: string } }> }>,
  branchId: string | null = null
) {
  const flat = groups.flatMap((g) => g.entries.map((e) => e.message.id))
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    topicId,
    branchId,
    insertedMessages: flat.map((id) => ({ id, topicId, role: 'user', blocks: [] })),
    insertedBlocks: [],
    insertedMessageIds: flat,
    mutableMessageIds: [...flat],
    groups: groups.map((g) => ({
      insertedMessageIds: g.entries.map((e) => e.message.id),
      beforeMessageId: null,
      nextMessageId: null
    }))
  }
}

function segWire(id: string, topicId: string, mids: string[]) {
  return {
    id,
    topicId,
    name: id,
    messageIds: [...mids],
    color: `color-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder: 0,
    firstMessageId: mids[0] ?? null,
    lastMessageId: mids[mids.length - 1] ?? null,
    messageCount: mids.length
  }
}

function msg(id: string, topicId: string): Message {
  return {
    id,
    topicId,
    role: 'user',
    assistantId: 'assistant-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: []
  }
}

describe('UndoService catalog convergence (real store, real helpers)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCatalogRequestSeqForTests()
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined as any)
    mocks.deleteMessagesWithSegments.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} } as any)
    mocks.updateFileCount.mockResolvedValue(undefined as any)
  })

  it('undoDelete message restore + catalog list failure => IDs restored once, history advanced, projection invalidated', async () => {
    const topicId = 't-undo-delete-conv'
    const store = configureStore({ reducer: rootReducer })
    establish(store, topicId, [])
    const genBefore = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number

    mocks.insertMessageGroups.mockImplementation(async (tid: string, groups: any[], branchId?: string | null) =>
      ackFor(tid, groups, branchId ?? null)
    )
    // Segment restore Main write succeeds, catalog list fails genuinely.
    mocks.upsertSegment.mockImplementation(async (id: string, tid: string, _n: string, mids: string[]) =>
      segWire(id, tid, mids)
    )
    mocks.listSegments.mockRejectedValue(new Error('list failed'))

    const u1 = msg('u1', topicId)
    const a1 = { ...msg('a1', topicId), role: 'assistant' as const, askId: 'u1' }
    store.dispatch(
      pushUndoAction({
        id: 'undo-delete-conv-1',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: topicId,
        rootMessageIds: ['u1'],
        insertedMessageIds: ['u1', 'a1'],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        groupAnchors: [
          {
            messages: [u1, a1],
            blocks: [],
            positionIndex: 0,
            anchorMessageId: null,
            loadedMessageIds: ['u1', 'a1']
          }
        ],
        segmentSnapshots: [
          {
            id: 'seg-1',
            topicId,
            name: 'S',
            messageIds: ['u1'],
            color: 'color-seg-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any
        ]
      }) as any
    )

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)

    // Authority success: history stays advanced (never rolled back to CONFLICT).
    expect(undone?.type).toBe('delete')
    expect((store.getState() as any).undoStack.undoStack.length).toBe(0)
    expect((store.getState() as any).undoStack.redoStack.length).toBe(1)
    // Main phases ran exactly once: message restore + segment Main write + list.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.upsertSegment).toHaveBeenCalledTimes(1)
    expect(mocks.listSegments).toHaveBeenCalledWith(topicId)
    // IDs restored once in projection.
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['u1', 'a1'])
    // Projection invalidated fenced (bumped, never marked complete), no fabricated catalog.
    const entry = (store.getState() as any).residentRegistry.entries[topicId]
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBeGreaterThan(genBefore)
  })

  it('undoCutPaste source catalog list failure => target cleanup still runs, source restored and copies gone, history advanced', async () => {
    const topicId = 't-undo-cutpaste-conv'
    const store = configureStore({ reducer: rootReducer })
    establish(store, topicId, ['copy-1'])
    const srcU = msg('src-u', topicId)
    const copy1 = msg('copy-1', topicId)
    // Loaded projection holds the copy so block collection sees it.
    store.dispatch(
      newMessagesActions.applyInsertedMessageGroups({
        topicId,
        route: null,
        messages: [copy1],
        insertedMessageIds: ['copy-1'],
        mutableMessageIds: ['copy-1'],
        groups: [
          { insertedMessageIds: ['copy-1'], beforeMessageId: null, nextMessageId: null, visibleMessageIds: ['copy-1'] }
        ]
      }) as any
    )

    mocks.insertMessageGroups.mockImplementation(async (tid: string, groups: any[], branchId?: string | null) =>
      ackFor(tid, groups, branchId ?? null)
    )
    mocks.upsertSegment.mockImplementation(async (id: string, tid: string, _n: string, mids: string[]) =>
      segWire(id, tid, mids)
    )
    mocks.replaceSegmentMembership.mockImplementation(async (id: string, mids: string[]) => segWire(id, topicId, mids))
    mocks.deleteSegment.mockResolvedValue(undefined as any)
    // Every catalog list fails: both source restore and target cleanup converge
    // as typed projection failures after their Main writes committed.
    mocks.listSegments.mockRejectedValue(new Error('list failed'))

    store.dispatch(
      pushUndoAction({
        id: 'undo-cutpaste-conv-1',
        type: 'cut_paste',
        timestamp: Date.now(),
        targetTopicId: topicId,
        insertedMessageIds: ['copy-1'],
        pastedMessagesSnapshot: [copy1],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        sourceTopicId: topicId,
        sourceRootIds: ['src-u'],
        sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: ['src-u'] },
        sourceGroupAnchors: [
          { messages: [srcU], blocks: [], positionIndex: 0, anchorMessageId: null, loadedMessageIds: ['src-u'] }
        ],
        sourceSegmentSnapshots: [
          {
            id: 'seg-src',
            topicId,
            name: 'Src',
            messageIds: ['src-u'],
            color: 'c',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any
        ],
        targetSegmentSnapshots: [
          {
            id: 'seg-tgt',
            topicId,
            name: 'Tgt',
            messageIds: ['copy-1'],
            color: 'c',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any
        ],
        targetAnchorMessageId: null,
        targetInsertPositionIndex: 0
      }) as any
    )

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)

    expect(undone?.type).toBe('cut_paste')
    expect((store.getState() as any).undoStack.undoStack.length).toBe(0)
    expect((store.getState() as any).undoStack.redoStack.length).toBe(1)
    // REQUIRED Main phases both ran: source restore insert + target copy delete.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMessagesWithSegments).toHaveBeenCalledTimes(1)
    // Source restored and copies gone in projection.
    const ids = (store.getState() as any).messages.messageIdsByTopic[topicId] as string[]
    expect(ids).toContain('src-u')
    expect(ids).not.toContain('copy-1')
    // Projection invalidated (never complete on failed read).
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(false)
  })

  it('undoPaste cleanup catalog list failure => deleted copies remain deleted, history advanced', async () => {
    const topicId = 't-undo-paste-conv'
    const store = configureStore({ reducer: rootReducer })
    establish(store, topicId, ['copy-1', 'copy-2'])
    const copy1 = msg('copy-1', topicId)
    const copy2 = msg('copy-2', topicId)
    store.dispatch(
      newMessagesActions.applyInsertedMessageGroups({
        topicId,
        route: null,
        messages: [copy1, copy2],
        insertedMessageIds: ['copy-1', 'copy-2'],
        mutableMessageIds: ['copy-1', 'copy-2'],
        groups: [
          {
            insertedMessageIds: ['copy-1', 'copy-2'],
            beforeMessageId: null,
            nextMessageId: null,
            visibleMessageIds: ['copy-1', 'copy-2']
          }
        ]
      }) as any
    )

    mocks.deleteSegment.mockResolvedValue(undefined as any)
    mocks.listSegments.mockRejectedValue(new Error('list failed'))

    store.dispatch(
      pushUndoAction({
        id: 'undo-paste-conv-1',
        type: 'paste',
        timestamp: Date.now(),
        targetTopicId: topicId,
        insertedMessageIds: ['copy-1', 'copy-2'],
        targetInsertPositionIndex: 0,
        targetAnchorMessageId: null,
        targetInsertIntent: { kind: 'topic-tail' },
        targetSegmentSnapshots: [
          {
            id: 'seg-tgt',
            topicId,
            name: 'Tgt',
            messageIds: ['copy-1'],
            color: 'c',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any
        ],
        pastedMessagesSnapshot: [copy1, copy2],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: []
      }) as any
    )

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)

    expect(undone?.type).toBe('paste')
    expect((store.getState() as any).undoStack.undoStack.length).toBe(0)
    expect((store.getState() as any).undoStack.redoStack.length).toBe(1)
    expect(mocks.deleteMessagesWithSegments).toHaveBeenCalledTimes(1)
    // Deleted copies remain deleted (no resurrection on projection failure).
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual([])
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(false)
  })

  it('redoPaste catalog list failure => copies re-inserted, history advanced', async () => {
    const topicId = 't-redo-paste-conv'
    const store = configureStore({ reducer: rootReducer })
    establish(store, topicId, [])
    const pasted = msg('pasted-1', topicId)

    mocks.insertMessageGroups.mockImplementation(async (tid: string, groups: any[], branchId?: string | null) =>
      ackFor(tid, groups, branchId ?? null)
    )
    mocks.upsertSegment.mockImplementation(async (id: string, tid: string, _n: string, mids: string[]) =>
      segWire(id, tid, mids)
    )
    mocks.listSegments.mockRejectedValue(new Error('list failed'))

    store.dispatch(
      pushUndoAction({
        id: 'redo-paste-conv-1',
        type: 'paste',
        timestamp: Date.now(),
        targetTopicId: topicId,
        insertedMessageIds: ['pasted-1'],
        targetInsertPositionIndex: 0,
        targetAnchorMessageId: null,
        targetInsertIntent: { kind: 'topic-tail' },
        targetSegmentSnapshots: [
          {
            id: 'seg-tgt',
            topicId,
            name: 'Tgt',
            messageIds: ['pasted-1'],
            color: 'c',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as any
        ],
        pastedMessagesSnapshot: [pasted],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: []
      }) as any
    )
    // Move to redo stack (undo -> redo) to set up the redo precondition.
    store.dispatch({ type: 'undoStack/prepareUndo' } as any)
    expect((store.getState() as any).undoStack.undoStack.length).toBe(0)
    expect((store.getState() as any).undoStack.redoStack.length).toBe(1)

    const { executeRedo } = await import('../UndoService')
    const redone = await executeRedo(store.dispatch as any, store.getState as any)

    expect(redone?.type).toBe('paste')
    expect((store.getState() as any).undoStack.redoStack.length).toBe(0)
    expect((store.getState() as any).undoStack.undoStack.length).toBe(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['pasted-1'])
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(false)
  })

  it('precommit insert rejection retains history (generic stays fail-closed)', async () => {
    const topicId = 't-undo-precommit'
    const store = configureStore({ reducer: rootReducer })
    establish(store, topicId, [])
    mocks.insertMessageGroups.mockRejectedValue(new Error('SQLITE_CONSTRAINT'))
    mocks.listSegments.mockResolvedValue([])

    const u1 = msg('u1', topicId)
    store.dispatch(
      pushUndoAction({
        id: 'undo-precommit-1',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: topicId,
        rootMessageIds: ['u1'],
        insertedMessageIds: ['u1'],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        groupAnchors: [
          { messages: [u1], blocks: [], positionIndex: 0, anchorMessageId: null, loadedMessageIds: ['u1'] }
        ],
        segmentSnapshots: []
      }) as any
    )

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)

    expect(undone).toBeNull()
    // History rolled back for precommit failure (safe to retry, no commit).
    expect((store.getState() as any).undoStack.undoStack.length).toBe(1)
    expect((store.getState() as any).undoStack.redoStack.length).toBe(0)
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual([])
  })

  it('genuine list failure throws typed catalog-convergence (stale stays silent discard)', async () => {
    const topicId = 't-conv-typed'
    const store = configureStore({ reducer: rootReducer })
    establish(store, topicId, ['m1'])
    mocks.listSegments.mockRejectedValue(new Error('list failed'))

    const { convergeTopicSegmentCatalog } = await import('@renderer/utils/topicSegmentCatalog')
    await expect(convergeTopicSegmentCatalog(store.dispatch as any, topicId, store.getState as any)).rejects.toThrow(
      'list failed'
    )
    try {
      await convergeTopicSegmentCatalog(store.dispatch as any, topicId, store.getState as any)
    } catch (error) {
      expect(isSegmentCatalogConvergenceError(error)).toBe(true)
      expect((error as any).topicId).toBe(topicId)
      expect((error as any).committed).toBe(true)
    }
    // Fenced invalidation happened (bumped), never a fabricated complete.
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(false)
  })
})
