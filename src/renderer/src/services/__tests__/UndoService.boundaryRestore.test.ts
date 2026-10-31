/**
 * Undo snapshot transfer for edit-mode delete / cut: the inheritance
 * boundaries Main reported for the delete travel back with the restore, and
 * the Main-authoritative branch catalog is re-read afterwards.
 *
 * Real Redux store + real UndoService. Only the data source, the segment
 * thunk, and the anchor transfer are mocked: this test asserts WHAT crosses
 * the boundary (snapshot in, catalog refresh out), never a renderer-side
 * branch write.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { prepareUndo, pushUndoAction } from '@renderer/store/undoStack'
import type { CutPasteUndoAction, DeleteUndoAction, GroupAnchor } from '@renderer/types/editMode'
import type { InheritanceBoundarySnapshot } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesWithDependents: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    insertMessageGroups: vi.fn(),
    listBranches: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    transferAnchorsWithAuthorityGroupKeys: vi.fn(),
    restoreSegmentsAfterUndo: vi.fn(async () => {}),
    syncSegmentsAfterMessageDeletion: vi.fn(async () => {}),
    deleteSegmentsBySnapshots: vi.fn(async () => {}),
    restoreTargetSegments: vi.fn(async () => {})
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents,
    deleteMessagesWithSegments: mocks.deleteMessagesWithSegments,
    insertMessageGroups: mocks.insertMessageGroups,
    listBranches: mocks.listBranches,
    updateFileCount: vi.fn()
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/services/anchorService', () => ({
  transferAnchorsWithAuthorityGroupKeys: mocks.transferAnchorsWithAuthorityGroupKeys,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn(),
  deleteSegmentsBySnapshots: mocks.deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo: mocks.restoreSegmentsAfterUndo,
  restoreTargetSegments: mocks.restoreTargetSegments,
  syncSegmentsAfterMessageDeletion: mocks.syncSegmentsAfterMessageDeletion
}))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

const BOUNDARY: InheritanceBoundarySnapshot = {
  kind: 'branch',
  id: 'branch-1',
  anchorMessageId: 'm1',
  expectedAnchorMessageId: 'm0'
}

function makeGroupAnchor(): GroupAnchor {
  return {
    messages: [{ id: 'm1', topicId: 't1', role: 'user', blocks: [] } as never],
    blocks: [],
    positionIndex: 1,
    anchorMessageId: 'm2',
    loadedMessageIds: ['m1']
  }
}

function makeAck(topicId: string, branchId: string | null, boundaryRestores: unknown[]) {
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    topicId,
    branchId,
    insertedMessages: [{ id: 'm1', topicId, role: 'user', blocks: [] }],
    insertedBlocks: [],
    insertedMessageIds: ['m1'],
    mutableMessageIds: ['m1'],
    groups: [{ insertedMessageIds: ['m1'], beforeMessageId: 'm0', nextMessageId: 'm2' }],
    boundaryRestores
  }
}

describe('undo transfers Main inheritance-boundary snapshots and re-reads the catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.insertMessageGroups.mockImplementation(async (topicId: string, _groups: unknown, branchId?: string | null) =>
      makeAck(topicId, branchId ?? null, [])
    )
    mocks.listBranches.mockResolvedValue({ topicId: 't1', branches: [] })
  })

  it('undoDelete sends the recorded boundary snapshots with the restore and refreshes the branch catalog', async () => {
    const store = configureStore({ reducer: rootReducer })
    const action: DeleteUndoAction = {
      id: 'undo-boundary-1',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 't1',
      rootMessageIds: ['m1'],
      insertedMessageIds: ['m1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [makeGroupAnchor()],
      segmentSnapshots: [],
      boundarySnapshots: [BOUNDARY]
    }
    store.dispatch(pushUndoAction(action))
    mocks.insertMessageGroups.mockImplementation(async (topicId: string, _groups: unknown, branchId?: string | null) =>
      makeAck(topicId, branchId ?? null, [{ kind: 'branch', id: 'branch-1', anchorMessageId: 'm1', restored: true }])
    )

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)
    expect(undone?.type).toBe('delete')

    // Exactly one insertion transaction, carrying the boundary restores.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('t1', expect.any(Array), null, [BOUNDARY])
    // Main rewrote the boundaries: the branch catalog is re-read (Main is the
    // only writer of branch anchors; the renderer never patches one locally).
    expect(mocks.listBranches).toHaveBeenCalledWith('t1')
  })

  it('a legacy delete action without recorded boundaries keeps the ordinary insertion wire', async () => {
    const store = configureStore({ reducer: rootReducer })
    const action: DeleteUndoAction = {
      id: 'undo-boundary-legacy',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 't1',
      rootMessageIds: ['m1'],
      insertedMessageIds: ['m1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [makeGroupAnchor()],
      segmentSnapshots: []
    }
    store.dispatch(pushUndoAction(action))

    const { executeUndo } = await import('../UndoService')
    await executeUndo(store.dispatch as any, store.getState as any)

    // No recorded boundary facts = no boundary work: the restore keeps the
    // exact ordinary three-argument command (nothing to compare-and-set).
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('t1', expect.any(Array), null)
  })

  it('undoCutPaste restores the source boundaries and refreshes the source catalog', async () => {
    const store = configureStore({ reducer: rootReducer })
    const action: CutPasteUndoAction = {
      id: 'undo-boundary-cut',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 't2',
      insertedMessageIds: ['copy-1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0,
      sourceTopicId: 't1',
      sourceBranchId: null,
      targetBranchId: null,
      sourceRootIds: ['m1'],
      sourceGroupAnchors: [makeGroupAnchor()],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      sourceBoundarySnapshots: [{ ...BOUNDARY, id: 'ref-target', kind: 'reference' }]
    }
    store.dispatch(pushUndoAction(action))

    const { executeUndo } = await import('../UndoService')
    await executeUndo(store.dispatch as any, store.getState as any)

    // Source restore first, with its boundary restores.
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('t1', expect.any(Array), null, [
      { ...BOUNDARY, id: 'ref-target', kind: 'reference' }
    ])
    expect(mocks.listBranches).toHaveBeenCalledWith('t1')
  })

  it('undoDelete restores onto the route the delete addressed, not the live route', async () => {
    const store = configureStore({ reducer: rootReducer })
    // The live route for t1 stays the main route; the delete addressed branch-1.
    const action: DeleteUndoAction = {
      id: 'undo-boundary-route',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 't1',
      rootMessageIds: ['m1'],
      deletedBranchId: 'branch-1',
      insertedMessageIds: ['m1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [makeGroupAnchor()],
      segmentSnapshots: [],
      boundarySnapshots: [BOUNDARY]
    }
    store.dispatch(pushUndoAction(action))

    const { executeUndo } = await import('../UndoService')
    await executeUndo(store.dispatch as any, store.getState as any)

    // Original owner/position restored: the recorded route travels with both
    // the restore command and the ack publication.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('t1', expect.any(Array), 'branch-1', [BOUNDARY])
  })

  it('redoDelete re-deletes through the recorded route after a branch switch', async () => {
    const store = configureStore({ reducer: rootReducer })
    const action: DeleteUndoAction = {
      id: 'redo-boundary-route',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 't1',
      rootMessageIds: ['m1'],
      deletedBranchId: 'branch-1',
      insertedMessageIds: ['m1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [makeGroupAnchor()],
      segmentSnapshots: []
    }
    // Push, then move it from the undo stack to the redo stack.
    store.dispatch(pushUndoAction(action))
    store.dispatch(prepareUndo())
    mocks.deleteMessagesWithDependents.mockResolvedValue({
      topicId: 't1',
      branchId: 'branch-1',
      deletedMessageIds: ['m1'],
      deletedBlockIds: [],
      affectedFileIds: [],
      remainingReferenceCounts: {},
      segments: []
    })

    const { executeRedo } = await import('../UndoService')
    await executeRedo(store.dispatch as any, store.getState as any)

    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledWith('t1', ['m1'], 'branch-1')

    // The redo delete moved the same boundaries in Main; the catalog is a
    // Main projection, so it is re-read for the topic the redo addressed —
    // the delete command reports no boundary payload of its own.
    expect(mocks.listBranches).toHaveBeenCalledWith('t1')
  })

  it('redoDelete keeps the committed re-delete when the catalog re-read fails', async () => {
    const store = configureStore({ reducer: rootReducer })
    const action: DeleteUndoAction = {
      id: 'redo-boundary-read-failure',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 't1',
      rootMessageIds: ['m1'],
      // Recorded route: the redo addresses the route the delete addressed and
      // skips the live-route capability precheck (Main stays final).
      deletedBranchId: 'branch-1',
      insertedMessageIds: ['m1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [makeGroupAnchor()],
      segmentSnapshots: []
    }
    store.dispatch(pushUndoAction(action))
    store.dispatch(prepareUndo())
    mocks.deleteMessagesWithDependents.mockResolvedValue({
      topicId: 't1',
      branchId: null,
      deletedMessageIds: ['m1'],
      deletedBlockIds: [],
      affectedFileIds: [],
      remainingReferenceCounts: {},
      segments: []
    })
    mocks.listBranches.mockRejectedValue(new Error('catalog read failed'))

    const { executeRedo } = await import('../UndoService')
    const redone = await executeRedo(store.dispatch as any, store.getState as any)

    // Projection failure is never promoted to a transaction failure: Main
    // already deleted the rows, so history stays advanced.
    expect(redone?.type).toBe('delete')
    expect(mocks.listBranches).toHaveBeenCalledWith('t1')
  })

  it('undoDelete completes when Main reports no boundary it could restore (compare-and-set miss)', async () => {
    const store = configureStore({ reducer: rootReducer })
    // The requested snapshot no longer matches Main's relation value, so Main
    // keeps the newer boundary and applies none: the undo is still complete
    // and must not claim a restored boundary.
    mocks.insertMessageGroups.mockImplementation(async (topicId: string, _groups: unknown, branchId?: string | null) =>
      makeAck(topicId, branchId ?? null, [])
    )
    const action: DeleteUndoAction = {
      id: 'undo-boundary-cas-miss',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 't1',
      rootMessageIds: ['m1'],
      insertedMessageIds: ['m1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [makeGroupAnchor()],
      segmentSnapshots: [],
      boundarySnapshots: [BOUNDARY]
    }
    store.dispatch(pushUndoAction(action))

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)

    expect(undone?.type).toBe('delete')
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('t1', expect.any(Array), null, [BOUNDARY])
  })

  // Main re-derives a branch head from the restored message even when the
  // delete recorded no boundary snapshot (no surviving predecessor ⇒ the
  // boundary id is kept and nothing is pushed). The committed restore still
  // invalidates the projected catalog, so the addressed topic is re-read and
  // the restore keeps its ordinary three-argument wire.
  it('undoDelete refreshes the branch catalog when the delete recorded no boundary snapshot', async () => {
    const store = configureStore({ reducer: rootReducer })
    const action: DeleteUndoAction = {
      id: 'undo-boundary-empty',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 't1',
      rootMessageIds: ['m1'],
      insertedMessageIds: ['m1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [makeGroupAnchor()],
      segmentSnapshots: [],
      boundarySnapshots: []
    }
    store.dispatch(pushUndoAction(action))

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)

    expect(undone?.type).toBe('delete')
    // No restored boundary permission travels: the plain three-argument wire.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('t1', expect.any(Array), null)
    // The message restore alone makes the projected head stale: re-read it.
    expect(mocks.listBranches).toHaveBeenCalledWith('t1')
  })

  it('undoCutPaste refreshes the source catalog when the cut recorded no boundary snapshot', async () => {
    const store = configureStore({ reducer: rootReducer })
    const action: CutPasteUndoAction = {
      id: 'undo-boundary-cut-empty',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 't2',
      insertedMessageIds: ['copy-1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0,
      sourceTopicId: 't1',
      sourceBranchId: null,
      targetBranchId: null,
      sourceRootIds: ['m1'],
      sourceGroupAnchors: [makeGroupAnchor()],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      sourceBoundarySnapshots: []
    }
    store.dispatch(pushUndoAction(action))

    const { executeUndo } = await import('../UndoService')
    await executeUndo(store.dispatch as any, store.getState as any)

    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('t1', expect.any(Array), null)
    // The restored source message re-derives the source head: re-read it.
    expect(mocks.listBranches).toHaveBeenCalledWith('t1')
  })
})
