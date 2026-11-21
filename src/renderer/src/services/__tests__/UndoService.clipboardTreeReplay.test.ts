/**
 * Undo/redo of one tree copy/cut: ONE Main replay transaction carrying Main's
 * own snapshot, then projection convergence of both affected topics.
 *
 * Real rootReducer store + real UndoService; Main IPC and the convergence
 * helper are mocked so the assertions can be about the history contract:
 * - the replay request is exactly `{direction, snapshot}` from the history
 *   action (no renderer-reconstructed intent),
 * - the cursor only advances after Main committed,
 * - a Main rejection keeps the action retryable and converges nothing,
 * - a post-commit convergence failure advances history (typed committed marker)
 *   so the already-committed mutation is never issued a second time.
 */
import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    replayClipboardTree: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    convergeAfterClipboardTreeWrite: vi.fn(async () => {})
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    replayClipboardTree: mocks.replayClipboardTree,
    updateFileCount: vi.fn(async () => {})
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/services/clipboardTreeProjection', () => ({
  convergeAfterClipboardTreeWrite: mocks.convergeAfterClipboardTreeWrite
}))
vi.mock('@renderer/services/anchorService', () => ({
  transferAnchorsWithAuthorityGroupKeys: vi.fn(),
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

import { executeRedo, executeUndo } from '@renderer/services/UndoService'
import { rootReducer } from '@renderer/store'
import { pushUndoAction } from '@renderer/store/undoStack'
import type { ClipboardTreeUndoAction } from '@renderer/types/editMode'
import type { ClipboardTreeRouteProjection, ClipboardTreeSnapshot, ReplayClipboardTreeResponse } from '@shared/chatDb'

const TARGET_TOPIC = 'topic-target'
const SOURCE_TOPIC = 'topic-source'

function snapshot(mode: 'copy' | 'cut' = 'cut'): ClipboardTreeSnapshot {
  return {
    kind: 'clipboard-tree',
    mode,
    idMap: [{ kind: 'message', sourceId: 'm1', targetId: 'm1-copy' }],
    placement: {
      topicId: TARGET_TOPIC,
      branchId: null,
      intent: { kind: 'topic-tail' },
      ownerIndex: 0,
      prevOwnerMessageId: null,
      nextOwnerMessageId: null
    },
    inserted: { messages: [], blocks: [], branches: [], segments: [] },
    sourceRemoved: null
  }
}

function treeAction(mode: 'copy' | 'cut' = 'cut'): ClipboardTreeUndoAction {
  return { id: 'tree-1', type: 'clipboard_tree', timestamp: 1, targetTopicId: TARGET_TOPIC, snapshot: snapshot(mode) }
}

/**
 * One route-scoped delta of the replay transaction: the target route loses the
 * inserted run. The service must forward exactly this to convergence — never a
 * renderer-reconstructed removed-rows map.
 */
function replayDelta(): ClipboardTreeRouteProjection {
  return {
    topicId: TARGET_TOPIC,
    branchId: null,
    removedMessageIds: ['m1-copy'],
    insertedRuns: [],
    mutableMessageIds: [],
    messages: [],
    blocks: []
  }
}

function replayResponse(direction: 'undo' | 'redo', mode: 'copy' | 'cut' = 'cut'): ReplayClipboardTreeResponse {
  return {
    direction,
    mode,
    targetTopicId: TARGET_TOPIC,
    sourceTopicId: SOURCE_TOPIC,
    removedMessageIds: ['m1-copy'],
    removedBranchIds: [],
    restoredMessageIds: ['m1'],
    restoredBranchIds: [],
    projections: [replayDelta()],
    affectedFileIds: [],
    remainingReferenceCounts: {}
  }
}

function makeStore(action: ClipboardTreeUndoAction, into: 'undo' | 'redo' = 'undo') {
  const store = configureStore({ reducer: rootReducer })
  store.dispatch(pushUndoAction(action))
  if (into === 'redo') {
    // Completed undo: the action now lives on the redo stack.
    store.dispatch({ type: 'undoStack/commitUndoAction', payload: action.id })
  }
  return store
}

function flush() {
  return Promise.resolve()
}

describe('UndoService clipboard_tree replay (real store, real history cursor)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined)
    mocks.convergeAfterClipboardTreeWrite.mockResolvedValue(undefined)
  })

  it('undo replays Main snapshot once, advances the cursor and converges both topics', async () => {
    const action = treeAction('cut')
    const store = makeStore(action)
    mocks.replayClipboardTree.mockResolvedValue(replayResponse('undo'))

    const outcome = await executeUndo(store.dispatch, store.getState)

    expect(outcome.status).toBe('success')
    expect(mocks.replayClipboardTree).toHaveBeenCalledTimes(1)
    expect(mocks.replayClipboardTree).toHaveBeenCalledWith({ direction: 'undo', snapshot: action.snapshot })
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledTimes(1)
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledWith(replayResponse('undo'))
    expect(mocks.convergeAfterClipboardTreeWrite).toHaveBeenCalledTimes(1)
    const convergeArgs = mocks.convergeAfterClipboardTreeWrite.mock.calls[0] as unknown as unknown[]
    expect(convergeArgs[2]).toEqual([TARGET_TOPIC, SOURCE_TOPIC])
    // The command's own committed deltas are forwarded verbatim: convergence
    // must never invent removed rows or route ownership of its own.
    expect(convergeArgs[4]).toEqual([replayDelta()])

    const history = store.getState().undoStack
    expect(history.undoStack).toHaveLength(0)
    expect(history.redoStack.map((entry) => entry.id)).toEqual([action.id])
  })

  it('redo replays in the redo direction and moves the action back to the undo stack', async () => {
    const action = treeAction('copy')
    const store = makeStore(action, 'redo')
    mocks.replayClipboardTree.mockResolvedValue(replayResponse('redo', 'copy'))

    const outcome = await executeRedo(store.dispatch, store.getState)

    expect(outcome.status).toBe('success')
    expect(mocks.replayClipboardTree).toHaveBeenCalledTimes(1)
    expect(mocks.replayClipboardTree).toHaveBeenCalledWith({ direction: 'redo', snapshot: action.snapshot })
    expect(mocks.convergeAfterClipboardTreeWrite).toHaveBeenCalledTimes(1)

    const history = store.getState().undoStack
    expect(history.redoStack).toHaveLength(0)
    expect(history.undoStack.map((entry) => entry.id)).toEqual([action.id])
  })

  it('Main rejection keeps the action retryable and converges nothing', async () => {
    const action = treeAction('cut')
    const store = makeStore(action)
    mocks.replayClipboardTree.mockRejectedValueOnce(new Error('snapshot conflict'))

    const outcome = await executeUndo(store.dispatch, store.getState)

    expect(outcome.status).toBe('failed')
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    expect(mocks.convergeAfterClipboardTreeWrite).not.toHaveBeenCalled()
    const history = store.getState().undoStack
    expect(history.undoStack.map((entry) => entry.id)).toEqual([action.id])
    expect(history.redoStack).toHaveLength(0)

    // Same action is issued again on retry (nothing was consumed by the failure).
    mocks.replayClipboardTree.mockResolvedValueOnce(replayResponse('undo'))
    const retry = await executeUndo(store.dispatch, store.getState)
    expect(retry.status).toBe('success')
    expect(mocks.replayClipboardTree).toHaveBeenCalledTimes(2)
    expect(mocks.replayClipboardTree.mock.calls[1][0]).toEqual({ direction: 'undo', snapshot: action.snapshot })
    expect(store.getState().undoStack.redoStack.map((entry) => entry.id)).toEqual([action.id])
  })

  it('post-commit convergence failure advances history without replaying the mutation', async () => {
    const action = treeAction('cut')
    const store = makeStore(action)
    mocks.replayClipboardTree.mockResolvedValue(replayResponse('undo'))
    // Typed committed marker shape understood by the history cursor.
    mocks.convergeAfterClipboardTreeWrite.mockRejectedValue(
      Object.assign(new Error('catalog read failed after commit'), {
        catalogConvergence: true,
        topicId: SOURCE_TOPIC
      })
    )

    const outcome = await executeUndo(store.dispatch, store.getState)
    await flush()

    expect(outcome.status).toBe('success')
    expect(mocks.replayClipboardTree).toHaveBeenCalledTimes(1)
    const history = store.getState().undoStack
    expect(history.undoStack).toHaveLength(0)
    expect(history.redoStack.map((entry) => entry.id)).toEqual([action.id])
  })
})
