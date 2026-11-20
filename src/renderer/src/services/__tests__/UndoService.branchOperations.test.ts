/**
 * UndoService — branch-operation history and route pinning.
 *
 * Branch create/rename/move/delete are replayed through one Main authority
 * command with the snapshot the original mutation returned; the renderer keeps
 * only the in-memory session history. History advances only after the authority
 * mutation succeeded, a rejected replay stays retryable and reports an explicit
 * failure, and every paste action addresses the route it recorded instead of
 * whatever route is active when the user hits undo/redo.
 */
import type { AppDispatch, RootState } from '@renderer/store'
import type * as UndoStackModule from '@renderer/store/undoStack'
import type { UndoAction } from '@renderer/types/editMode'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    replayBranchOperation: vi.fn(),
    insertMessageGroups: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    deleteMessagesFromDB: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    publishInsertMessageGroupsAck: vi.fn(),
    removeManyBlocks: vi.fn(),
    fetchTopicBranches: vi.fn(),
    loadRouteMessages: vi.fn(),
    deleteSegmentsBySnapshots: vi.fn(),
    restoreSegmentsAfterUndo: vi.fn(),
    restoreTargetSegments: vi.fn(),
    syncSegmentsAfterMessageDeletion: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    replayBranchOperation: mocks.replayBranchOperation,
    insertMessageGroups: mocks.insertMessageGroups,
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/services/insertGroupsAck', () => ({
  publishInsertMessageGroupsAck: mocks.publishInsertMessageGroupsAck
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB,
  executeDeleteMessagesWithDependents: vi.fn(),
  executeStagedCutSourceDelete: vi.fn(),
  fetchTopicBranchesThunk: mocks.fetchTopicBranches,
  loadRouteMessagesThunk: mocks.loadRouteMessages,
  publishDeleteAuthorityCatalog: vi.fn()
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  deleteSegmentsBySnapshots: mocks.deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo: mocks.restoreSegmentsAfterUndo,
  restoreTargetSegments: mocks.restoreTargetSegments,
  syncSegmentsAfterMessageDeletion: mocks.syncSegmentsAfterMessageDeletion
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: mocks.removeManyBlocks
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    removeMessages: (payload: unknown) => ({ type: 'messages/removeMessages', payload }),
    invalidateRouteMutability: (payload: unknown) => ({ type: 'messages/invalidateRouteMutability', payload })
  },
  selectLoadedMessagesForTopic: () => []
}))

vi.mock('@renderer/store/routeAnswerGroup', () => ({
  requireMutableForActiveRoute: vi.fn()
}))

vi.mock('@renderer/store/topicBranch', () => ({
  activeBranchReset: (payload: unknown) => ({ type: 'topicBranch/activeBranchReset', payload }),
  activeBranchSet: (payload: unknown) => ({ type: 'topicBranch/activeBranchSet', payload }),
  selectActiveBranchId: (state: RootState, topicId: string) =>
    (state as unknown as { topicBranch: { activeBranchIdByTopic: Record<string, string> } }).topicBranch
      .activeBranchIdByTopic[topicId] ?? null,
  selectTopicBranches: (state: RootState, topicId: string) =>
    (state as unknown as { topicBranch: { branchesByTopic: Record<string, unknown[]> } }).topicBranch.branchesByTopic[
      topicId
    ] ?? []
}))

vi.mock('@renderer/store/undoStack', async (importOriginal) => {
  const actual = await importOriginal<typeof UndoStackModule>()
  // Keep the real history gate / push helpers so the replay-window behavior is
  // exercised; only the cursor actions are reduced by this test's dispatcher.
  return {
    ...actual,
    commitUndoAction: (id: string) => ({ type: 'undoStack/commitUndoAction', payload: id }),
    commitRedoAction: (id: string) => ({ type: 'undoStack/commitRedoAction', payload: id })
  }
})

let storeState: RootState
let dispatch: AppDispatch
const dispatched: Array<{ type: string; payload?: unknown }> = []

function makeState(): RootState {
  return {
    undoStack: { undoStack: [], redoStack: [] },
    messages: { entities: {}, messageIdsByTopic: {}, mutableMessageIdsByTopic: {}, mutableRouteByTopic: {} },
    messageBlocks: { entities: {} },
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: {},
      routeGenerationByTopic: {}
    }
  } as unknown as RootState
}

function makeMessage(id: string): Message {
  return {
    id,
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks: []
  } as unknown as Message
}

function pasteAction(overrides?: Partial<Record<string, unknown>>): UndoAction {
  return {
    id: 'paste-1',
    type: 'paste',
    timestamp: Date.now(),
    targetTopicId: 'topic-1',
    insertedMessageIds: ['p1'],
    pastedMessagesSnapshot: [makeMessage('p1')],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: [],
    targetAnchorMessageId: null,
    targetInsertPositionIndex: 0,
    targetSegmentSnapshots: [],
    ...overrides
  } as unknown as UndoAction
}

const moveSnapshot = {
  kind: 'move' as const,
  branch: {
    id: 'branch-new',
    parentBranchId: null,
    anchorMessageId: 'aA',
    name: 'Moved',
    createdAt: null,
    updatedAt: null,
    overflow: {}
  },
  sourceBranchId: null,
  movedMessageIds: ['uB', 'aB'],
  sourceOrderBefore: ['uA', 'aA', 'uB', 'aB'],
  reparented: []
}

function moveAction(): UndoAction {
  return {
    id: 'move-1',
    type: 'branch_move',
    timestamp: Date.now(),
    targetTopicId: 'topic-1',
    snapshot: moveSnapshot
  } as unknown as UndoAction
}

function stackState(): { undoStack: UndoAction[]; redoStack: UndoAction[] } {
  return (storeState as unknown as { undoStack: { undoStack: UndoAction[]; redoStack: UndoAction[] } }).undoStack
}

describe('UndoService branch operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dispatched.length = 0
    storeState = makeState()
    dispatch = ((action: { type: string; payload?: unknown } | ((...args: unknown[]) => unknown)) => {
      if (typeof action === 'function') return action()
      if (action.type === 'undoStack/commitUndoAction') {
        const stack = stackState()
        const index = stack.undoStack.findIndex((entry) => entry.id === action.payload)
        if (index !== -1) stack.redoStack.push(...stack.undoStack.splice(index, 1))
      } else if (action.type === 'undoStack/commitRedoAction') {
        const stack = stackState()
        const index = stack.redoStack.findIndex((entry) => entry.id === action.payload)
        if (index !== -1) stack.undoStack.push(...stack.redoStack.splice(index, 1))
      } else if (action.type === 'topicBranch/activeBranchSet') {
        const payload = action.payload as { topicId: string; branchId: string }
        ;(storeState as any).topicBranch.activeBranchIdByTopic[payload.topicId] = payload.branchId
      } else if (action.type === 'topicBranch/activeBranchReset') {
        const payload = action.payload as { topicId: string }
        delete (storeState as any).topicBranch.activeBranchIdByTopic[payload.topicId]
      } else if (action.type === 'undoStack/pushUndoAction') {
        // Real reducer semantics: append and drop the redo chain.
        const stack = stackState()
        stack.undoStack.push(action.payload as UndoAction)
        stack.redoStack.length = 0
      }
      dispatched.push(action as { type: string; payload?: unknown })
      return action
    }) as unknown as AppDispatch

    mocks.replayBranchOperation.mockResolvedValue({
      topicId: 'topic-1',
      kind: 'move',
      direction: 'undo',
      branchIds: [],
      messageIds: []
    })
    mocks.deleteMessagesFromDB.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} })
    mocks.insertMessageGroups.mockResolvedValue({ insertedMessageIds: ['p1'], messages: [], blocks: [] })
    mocks.fetchTopicBranches.mockReturnValue({ type: 'thunk/fetchTopicBranches' })
    mocks.loadRouteMessages.mockReturnValue({ type: 'thunk/loadRouteMessages' })
    mocks.deleteSegmentsBySnapshots.mockResolvedValue(undefined)
    mocks.syncSegmentsAfterMessageDeletion.mockResolvedValue(undefined)
    mocks.restoreSegmentsAfterUndo.mockResolvedValue(undefined)
    mocks.restoreTargetSegments.mockResolvedValue(undefined)
  })

  it('replays one branch move through Main and advances the cursor only on success', async () => {
    const action = moveAction()
    stackState().undoStack.push(action)
    const { executeUndo } = await import('../UndoService')

    const outcome = await executeUndo(dispatch, () => storeState)

    expect(outcome.status).toBe('success')
    expect(mocks.replayBranchOperation).toHaveBeenCalledExactlyOnceWith('topic-1', 'undo', moveSnapshot)
    expect(dispatched).toContainEqual({ type: 'undoStack/commitUndoAction', payload: action.id })
    expect(stackState().undoStack).toEqual([])
    expect(stackState().redoStack.map((entry) => entry.id)).toEqual([action.id])
    // Projection converged for the addressed topic.
    expect(dispatched).toContainEqual({ type: 'thunk/fetchTopicBranches' })
    expect(mocks.loadRouteMessages).toHaveBeenCalledWith('topic-1', null, { kind: 'latest' })
  })

  it('maps every branch action kind onto its Main replay snapshot', async () => {
    const create = {
      id: 'create-1',
      type: 'branch_create',
      timestamp: 1,
      targetTopicId: 'topic-1',
      branch: {
        id: 'branch-1',
        parentBranchId: null,
        anchorMessageId: 'aA',
        name: null,
        createdAt: null,
        updatedAt: null,
        overflow: {}
      }
    } as unknown as UndoAction
    const rename = {
      id: 'rename-1',
      type: 'branch_rename',
      timestamp: 2,
      targetTopicId: 'topic-1',
      branchId: 'branch-1',
      beforeName: 'Before',
      afterName: 'After'
    } as unknown as UndoAction
    const remove = {
      id: 'delete-1',
      type: 'branch_delete',
      timestamp: 3,
      targetTopicId: 'topic-1',
      rootBranchId: 'branch-1',
      snapshot: {
        kind: 'delete',
        rootBranchId: 'branch-1',
        branches: [],
        messages: [],
        blocks: [],
        fileReferences: [],
        segments: [],
        segmentOrder: [],
        boundaries: []
      }
    } as unknown as UndoAction
    const { executeUndo } = await import('../UndoService')

    for (const action of [create, rename, remove]) {
      mocks.replayBranchOperation.mockClear()
      stackState().undoStack.push(action)
      const outcome = await executeUndo(dispatch, () => storeState)
      expect(outcome.status).toBe('success')
      expect(mocks.replayBranchOperation).toHaveBeenCalledTimes(1)
      const payload = mocks.replayBranchOperation.mock.calls[0][2] as { kind: string }
      expect(payload.kind).toBe(
        action.type === 'branch_create' ? 'create' : action.type === 'branch_rename' ? 'rename' : 'delete'
      )
      expect(stackState().undoStack).toEqual([])
      // Clean redo stack for the next iteration.
      stackState().redoStack.length = 0
    }
  })

  it('keeps a rejected replay retryable and reports an explicit failure', async () => {
    const action = moveAction()
    stackState().undoStack.push(action)
    mocks.replayBranchOperation.mockRejectedValue(new Error('BRANCH_REPLAY_GUARD'))
    const { executeUndo } = await import('../UndoService')

    const outcome = await executeUndo(dispatch, () => storeState)

    expect(outcome.status).toBe('failed')
    expect(mocks.replayBranchOperation).toHaveBeenCalledTimes(1)
    expect(dispatched.some((entry) => entry.type === 'undoStack/commitUndoAction')).toBe(false)
    expect(stackState().undoStack.map((entry) => entry.id)).toEqual([action.id])
    expect(stackState().redoStack).toEqual([])

    // A retry after the guard clears succeeds and advances exactly once.
    mocks.replayBranchOperation.mockResolvedValue({
      topicId: 'topic-1',
      kind: 'move',
      direction: 'undo',
      branchIds: [],
      messageIds: []
    })
    const retry = await executeUndo(dispatch, () => storeState)
    expect(retry.status).toBe('success')
    expect(stackState().undoStack).toEqual([])
  })

  it('redoes the newest undone branch action and restores the cursor on failure', async () => {
    const action = moveAction()
    stackState().redoStack.push(action)
    const { executeRedo } = await import('../UndoService')

    const outcome = await executeRedo(dispatch, () => storeState)
    expect(outcome.status).toBe('success')
    expect(mocks.replayBranchOperation).toHaveBeenCalledExactlyOnceWith('topic-1', 'redo', moveSnapshot)
    expect(dispatched).toContainEqual({ type: 'undoStack/commitRedoAction', payload: action.id })
    expect(stackState().undoStack.map((entry) => entry.id)).toEqual([action.id])

    stackState().redoStack.length = 0
    stackState().undoStack.length = 0
    stackState().redoStack.push(action)
    mocks.replayBranchOperation.mockRejectedValue(new Error('guard'))
    const failed = await executeRedo(dispatch, () => storeState)
    expect(failed.status).toBe('failed')
    expect(stackState().redoStack.map((entry) => entry.id)).toEqual([action.id])
  })

  it('reports an empty cursor without touching authority', async () => {
    const { executeUndo, executeRedo } = await import('../UndoService')
    expect((await executeUndo(dispatch, () => storeState)).status).toBe('empty')
    expect((await executeRedo(dispatch, () => storeState)).status).toBe('empty')
    expect(mocks.replayBranchOperation).not.toHaveBeenCalled()
    expect(dispatched).toEqual([])
  })

  it('falls back to the nearest surviving ancestor when the replay removed the active route', async () => {
    const action = moveAction()
    stackState().undoStack.push(action)
    ;(storeState as any).topicBranch.activeBranchIdByTopic['topic-1'] = 'branch-new'
    ;(storeState as any).topicBranch.branchesByTopic['topic-1'] = [
      { id: 'branch-parent', parentBranchId: null },
      { id: 'branch-new', parentBranchId: 'branch-parent' }
    ]
    // The undo removed branch-new: the refreshed catalog reflects Main.
    mocks.fetchTopicBranches.mockImplementation(() => () => {
      ;(storeState as any).topicBranch.branchesByTopic['topic-1'] = [{ id: 'branch-parent', parentBranchId: null }]
      return { type: 'thunk/fetchTopicBranches' }
    })
    // The mocked dispatch calls thunks directly, so the return value is a thunk.
    dispatch = ((action2: unknown) => {
      if (typeof action2 === 'function') return (action2 as () => unknown)()
      return dispatched.push(action2 as { type: string })
    }) as unknown as AppDispatch
    const { executeUndo } = await import('../UndoService')

    const outcome = await executeUndo(dispatch, () => storeState)

    expect(outcome.status).toBe('success')
    expect(dispatched).toContainEqual({
      type: 'topicBranch/activeBranchSet',
      payload: { topicId: 'topic-1', branchId: 'branch-parent' }
    })
    expect(mocks.loadRouteMessages).toHaveBeenCalledWith('topic-1', 'branch-parent', { kind: 'latest' })
  })

  it('undoes a paste on the route it recorded, never the live route', async () => {
    storeState.messages.entities = { p1: makeMessage('p1') } as unknown as Record<string, Message>
    ;(storeState as any).topicBranch.activeBranchIdByTopic['topic-1'] = 'branch-live'
    stackState().undoStack.push(pasteAction({ targetBranchId: 'branch-recorded' }))
    const { executeUndo } = await import('../UndoService')

    const outcome = await executeUndo(dispatch, () => storeState)

    expect(outcome.status).toBe('success')
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['p1'], 'branch-recorded')
    expect(mocks.syncSegmentsAfterMessageDeletion.mock.calls[0][4]).toBe('branch-recorded')
  })

  it('redoes a paste on the route it recorded, never the live route', async () => {
    ;(storeState as any).topicBranch.activeBranchIdByTopic['topic-1'] = 'branch-live'
    stackState().redoStack.push(
      pasteAction({ targetBranchId: 'branch-recorded', targetSegmentSnapshots: [{ id: 'seg-1' }] })
    )
    const { executeRedo } = await import('../UndoService')

    const outcome = await executeRedo(dispatch, () => storeState)

    expect(outcome.status).toBe('success')
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups.mock.calls[0][2]).toBe('branch-recorded')
    expect(mocks.restoreTargetSegments.mock.calls[0][2]).toBe('branch-recorded')
  })

  it('keeps the legacy live-route behavior for a paste action without a recorded route', async () => {
    storeState.messages.entities = { p1: makeMessage('p1') } as unknown as Record<string, Message>
    ;(storeState as any).topicBranch.activeBranchIdByTopic['topic-1'] = 'branch-live'
    stackState().undoStack.push(pasteAction())
    const { executeUndo } = await import('../UndoService')

    await executeUndo(dispatch, () => storeState)

    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['p1'], 'branch-live')
  })

  it('serializes concurrent undos so each recorded action replays exactly once', async () => {
    const first = moveAction()
    const second = { ...moveAction(), id: 'move-2' } as UndoAction
    stackState().undoStack.push(first, second)
    const deferred: { release?: () => void } = {}
    mocks.replayBranchOperation.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.release = () =>
            resolve({ topicId: 'topic-1', kind: 'move', direction: 'undo', branchIds: [], messageIds: [] })
        })
    )
    const { executeUndo } = await import('../UndoService')

    const a = executeUndo(dispatch, () => storeState)
    const b = executeUndo(dispatch, () => storeState).catch(() => undefined)
    // The second call must not have started before the first commits.
    await Promise.resolve()
    expect(mocks.replayBranchOperation).toHaveBeenCalledTimes(1)
    deferred.release?.()
    await a
    // The queued attempt re-reads the cursor and replays the next action.
    await Promise.resolve()
    deferred.release?.()
    await b

    expect(mocks.replayBranchOperation).toHaveBeenCalledTimes(2)
    const replayedIds = mocks.replayBranchOperation.mock.calls.map(
      (call) => (call[2] as { branch: { id: string } }).branch.id
    )
    expect(replayedIds).toEqual(['branch-new', 'branch-new'])
    expect(stackState().undoStack).toEqual([])
    expect(stackState().redoStack.map((entry) => entry.id)).toEqual([second.id, first.id])
  })

  it('holds a concurrent branch push until the in-flight replay commits, so redo stays LIFO', async () => {
    const undone = moveAction()
    stackState().undoStack.push(undone)
    const deferred: { release?: () => void } = {}
    mocks.replayBranchOperation.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.release = () =>
            resolve({ topicId: 'topic-1', kind: 'move', direction: 'undo', branchIds: [], messageIds: [] })
        })
    )
    const { executeUndo } = await import('../UndoService')
    const { recordUndoAction } = await import('@renderer/store/undoStack')

    const inFlight = executeUndo(dispatch, () => storeState)
    await vi.waitFor(() => expect(mocks.replayBranchOperation).toHaveBeenCalledTimes(1))

    // A newer branch operation commits while the replay round-trip is pending.
    const later = { ...moveAction(), id: 'move-later' } as UndoAction
    recordUndoAction(dispatch as never, later)
    await Promise.resolve()
    // Held back: the cursor and the redo chain are still the replay's to move.
    expect(stackState().undoStack.map((entry) => entry.id)).toEqual([undone.id])
    expect(dispatched.some((entry) => entry.type === 'undoStack/pushUndoAction')).toBe(false)

    deferred.release?.()
    const outcome = await inFlight

    expect(outcome.status).toBe('success')
    // The push was applied AFTER the cursor commit, so redo was cleared by the
    // newer operation instead of exposing a stale, non-LIFO redo entry.
    expect(stackState().undoStack.map((entry) => entry.id)).toEqual([later.id])
    expect(stackState().redoStack).toEqual([])
    const types = dispatched.map((entry) => entry.type)
    expect(types.indexOf('undoStack/pushUndoAction')).toBeGreaterThan(types.indexOf('undoStack/commitUndoAction'))
  })
})
