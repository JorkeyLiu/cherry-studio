/**
 * ClipboardService — opt-in tree clipboard (copy/cut including child branches).
 *
 * Promise guarded here: the opt-in tree path is an EXPLICIT second content kind
 * of the existing clipboard, never a widening of the ordinary one.
 * - ordinary copy/cut keep their group-scoped authority read (no tree read),
 * - an opt-in copy publishes ONE Main closure (roots + included branch
 *   subtrees) with empty `items` and the tree capture,
 * - an opt-in cut is refused without any publication when Main reports
 *   inherited (copy-only) roots, or when the staged source route is no longer
 *   the active loaded route,
 * - a tree paste is ONE Main transaction, records ONE history action carrying
 *   Main's own snapshot, clears the clipboard only for a cut, and converges
 *   both affected topics — a Main refusal leaves clipboard/history untouched.
 */
import type { ClipboardTreeCapture } from '@renderer/types/editMode'
import type { Message } from '@renderer/types/newMessage'
import type {
  ClipboardTreePayload,
  ClipboardTreeRouteProjection,
  FetchClipboardTreeMeta,
  PasteClipboardTreeResponse
} from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchClipboardTree: vi.fn(),
    fetchClipboardGroups: vi.fn(),
    pasteClipboardTree: vi.fn(),
    deleteClipboardTree: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    convergeAfterClipboardTreeWrite: vi.fn(async () => {}),
    requireActiveRouteOf: vi.fn(),
    selectActiveBranchId: vi.fn(),
    requireEditSelectionMutable: vi.fn(),
    setClipboard: vi.fn((p: unknown) => ({ type: 'clipboard/setClipboard', payload: p })),
    clearClipboard: vi.fn(() => ({ type: 'clipboard/clearClipboard' })),
    recordUndoAction: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchClipboardTree: mocks.fetchClipboardTree,
    fetchClipboardGroups: mocks.fetchClipboardGroups,
    pasteClipboardTree: mocks.pasteClipboardTree,
    deleteClipboardTree: mocks.deleteClipboardTree,
    listSegments: vi.fn(async () => [])
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/services/clipboardTreeProjection', () => ({
  convergeAfterClipboardTreeWrite: mocks.convergeAfterClipboardTreeWrite
}))

vi.mock('@renderer/services/insertGroupsAck', () => ({ publishInsertMessageGroupsAck: vi.fn() }))

vi.mock('@renderer/store/clipboard', () => ({
  setClipboard: mocks.setClipboard,
  clearClipboard: mocks.clearClipboard
}))

vi.mock('@renderer/store/closureOwnership', () => ({ withClosureTopics: (action: unknown) => action }))

vi.mock('@renderer/store/messageBlock', () => ({ removeManyBlocks: (p: unknown) => p }))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    removeMessages: (p: unknown) => ({ type: 'newMessages/removeMessages', payload: p })
  },
  selectLoadedMessagesForTopic: () => []
}))

vi.mock('@renderer/store/routeAnswerGroup', () => ({ requireActiveRouteOf: mocks.requireActiveRouteOf }))

vi.mock('@renderer/store/topicBranch', () => ({ selectActiveBranchId: mocks.selectActiveBranchId }))

vi.mock('@renderer/store/editSelection', () => ({
  requireEditSelectionMutable: mocks.requireEditSelectionMutable
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: vi.fn(),
  executeDeleteMessagesWithDependents: vi.fn(),
  executeStagedCutSourceDelete: vi.fn(),
  isDeletePostCommitConvergenceError: () => false
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  deleteSegmentsBySnapshots: vi.fn(),
  syncSegmentsAfterMessageDeletion: vi.fn()
}))

vi.mock('@renderer/store/undoStack', () => ({ recordUndoAction: mocks.recordUndoAction }))

vi.mock('@renderer/utils/topicSegmentCatalog', () => ({
  convergeTopicSegmentCatalog: vi.fn(),
  mapSegmentWireToTopicSegment: vi.fn()
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({ getSegmentColor: () => '#000' }))

vi.mock('i18next', () => ({ t: (key: string) => key, default: { t: (key: string) => key } }))

const { copyMessages, cutMessages, pasteMessages, deleteTreeSelectedMessages } = await import('../ClipboardService')

const deleteSnapshot = {
  kind: 'clipboard-tree',
  mode: 'delete',
  idMap: [],
  placement: {
    topicId: 'topic-src',
    branchId: 'branch-src',
    intent: { kind: 'topic-tail' },
    ownerIndex: 0,
    prevOwnerMessageId: null,
    nextOwnerMessageId: null
  },
  inserted: { messages: [], blocks: [], branches: [], segments: [] },
  sourceRemoved: { topicId: 'topic-src', branchId: 'branch-src' }
}

const deleteResult = {
  affectedFileIds: [],
  remainingReferenceCounts: {},
  topicId: 'topic-src',
  branchId: 'branch-src',
  deletedMessageIds: ['u1', 'a1'],
  deletedBranchIds: ['branch-child'],
  snapshot: deleteSnapshot,
  projections: [{ topicId: 'topic-src', branchId: 'branch-src' }]
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const treePayload = {
  source: { topicId: 'topic-src', branchId: 'branch-src' },
  roots: [{ groupId: 'u1', messageIds: ['u1', 'a1'], positionIndex: 0 }],
  messages: [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant' }
  ],
  blocks: [],
  branches: [
    {
      sourceBranchId: 'branch-child',
      parentSourceBranchId: 'branch-src',
      anchorMessageId: 'u1',
      name: 'child',
      depth: 1,
      overflow: {}
    }
  ],
  segments: []
} as unknown as ClipboardTreePayload

function treeMeta(overrides: Partial<FetchClipboardTreeMeta> = {}): FetchClipboardTreeMeta {
  return {
    completeness: 'clipboard-tree',
    topicId: 'topic-src',
    branchId: 'branch-src',
    requestedCount: 1,
    returnedCount: 1,
    returnedMessageCount: 4,
    returnedBranchCount: 1,
    returnedSegmentCount: 0,
    ownedRootMessageIds: ['u1'],
    inheritedRootMessageIds: [],
    firstMessageId: 'u1',
    lastMessageId: 'a2',
    ...overrides
  }
}

const treeCapture = { payload: treePayload, meta: treeMeta() } as unknown as ClipboardTreeCapture

interface StoreState {
  clipboard: {
    mode: 'copy' | 'cut' | null
    items: unknown[]
    sourceTopicId: string | null
    sourceBranchId: string | null
    segmentSnapshots: unknown[]
    tree?: ClipboardTreeCapture | null
  }
  messages: { entities: Record<string, Message>; messageIdsByTopic: Record<string, string[]> }
  undoStack: { undoStack: unknown[]; redoStack: unknown[] }
}

const emptyState = (): StoreState => ({
  clipboard: {
    mode: null,
    items: [],
    sourceTopicId: null,
    sourceBranchId: null,
    segmentSnapshots: []
  },
  messages: { entities: {}, messageIdsByTopic: {} },
  undoStack: { undoStack: [], redoStack: [] }
})

let storeState: StoreState
const dispatch = vi.fn()

function publishedPayload(): any {
  expect(mocks.setClipboard).toHaveBeenCalledTimes(1)
  return mocks.setClipboard.mock.calls[0][0]
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState = emptyState()
  dispatch.mockReset()
  mocks.selectActiveBranchId.mockReturnValue('branch-src')
  mocks.requireActiveRouteOf.mockReturnValue('branch-t')
  mocks.requireEditSelectionMutable.mockReturnValue(undefined)
  mocks.fetchClipboardGroups.mockResolvedValue({
    messages: [],
    blocks: [],
    groups: [],
    clipboard: { completeness: 'clipboard-groups', topicId: 'topic-src' }
  })
})

// ── Capture ────────────────────────────────────────────────────────────────

describe('opt-in tree capture', () => {
  it('copies ONE Main closure and publishes the tree content kind only', async () => {
    mocks.fetchClipboardTree.mockResolvedValue({ tree: treePayload, clipboard: treeMeta() })

    const count = await copyMessages(dispatch, 'topic-src', ['u1'], 'branch-src', { includeChildBranches: true })

    expect(count).toBe(4)
    expect(mocks.fetchClipboardGroups).not.toHaveBeenCalled()
    expect(mocks.fetchClipboardTree).toHaveBeenCalledWith({
      topicId: 'topic-src',
      branchId: 'branch-src',
      groupIds: ['u1']
    })
    const payload = publishedPayload()
    expect(payload.mode).toBe('copy')
    expect(payload.items).toEqual([])
    expect(payload.sourceTopicId).toBe('topic-src')
    expect(payload.sourceBranchId).toBe('branch-src')
    expect(payload.tree).toEqual({ payload: treePayload, meta: treeMeta() })
  })

  it('keeps the ordinary copy on its group-scoped read (no tree capture)', async () => {
    const count = await copyMessages(dispatch, 'topic-src', ['u1'], 'branch-src')

    expect(count).toBe(0)
    expect(mocks.fetchClipboardGroups).toHaveBeenCalledTimes(1)
    expect(mocks.fetchClipboardTree).not.toHaveBeenCalled()
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })

  it('publishes nothing when the authority closure read fails', async () => {
    mocks.fetchClipboardTree.mockRejectedValue(new Error('boom'))

    const count = await copyMessages(dispatch, 'topic-src', ['u1'], 'branch-src', { includeChildBranches: true })

    expect(count).toBe(0)
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })

  it('refuses a tree cut whose closure contains inherited (copy-only) roots', async () => {
    mocks.fetchClipboardTree.mockResolvedValue({
      tree: treePayload,
      clipboard: treeMeta({ ownedRootMessageIds: [], inheritedRootMessageIds: ['u1'] })
    })

    const count = await cutMessages(dispatch, () => storeState as never, 'topic-src', ['u1'], 'branch-src', {
      includeChildBranches: true
    })

    expect(count).toBe(0)
    expect(mocks.requireEditSelectionMutable).toHaveBeenCalledTimes(1)
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })

  it('refuses a tree cut when the staged source route is no longer the active route', async () => {
    mocks.selectActiveBranchId.mockReturnValue('branch-other')
    mocks.fetchClipboardTree.mockResolvedValue({ tree: treePayload, clipboard: treeMeta() })

    const count = await cutMessages(dispatch, () => storeState as never, 'topic-src', ['u1'], 'branch-src', {
      includeChildBranches: true
    })

    expect(count).toBe(0)
    expect(mocks.fetchClipboardTree).not.toHaveBeenCalled()
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })

  it('publishes a tree cut when every root is owned', async () => {
    mocks.fetchClipboardTree.mockResolvedValue({ tree: treePayload, clipboard: treeMeta() })

    const count = await cutMessages(dispatch, () => storeState as never, 'topic-src', ['u1'], 'branch-src', {
      includeChildBranches: true
    })

    expect(count).toBe(4)
    const payload = publishedPayload()
    expect(payload.mode).toBe('cut')
    expect(payload.tree.meta.ownedRootMessageIds).toEqual(['u1'])
  })
})

// ── Paste ──────────────────────────────────────────────────────────────────

/**
 * The command's own route-scoped deltas: the target route gains the placed run,
 * the source route loses the cut rows. Convergence must receive exactly these —
 * it is not allowed to re-derive removed rows or route ownership itself.
 */
function pasteDelta(): ClipboardTreeRouteProjection[] {
  return [
    {
      topicId: 'topic-t',
      branchId: 'branch-t',
      removedMessageIds: [],
      insertedRuns: [{ messageIds: ['new-1', 'new-2'], beforeMessageId: null, nextMessageId: null }],
      mutableMessageIds: ['new-1', 'new-2'],
      messages: [],
      blocks: []
    },
    {
      topicId: 'topic-src',
      branchId: 'branch-src',
      removedMessageIds: ['u1', 'a1'],
      insertedRuns: [],
      mutableMessageIds: [],
      messages: [],
      blocks: []
    }
  ]
}

function pasteResponse(overrides: Partial<PasteClipboardTreeResponse> = {}): PasteClipboardTreeResponse {
  return {
    mode: 'cut',
    targetTopicId: 'topic-t',
    targetBranchId: 'branch-t',
    sourceTopicId: 'topic-src',
    sourceBranchId: 'branch-src',
    insertedMessageIds: ['new-1', 'new-2'],
    insertedRootMessageIds: ['new-1'],
    insertedBranchIds: ['branch-copy'],
    insertedSegmentIds: [],
    beforeMessageId: null,
    nextMessageId: null,
    deletedSourceMessageIds: ['u1', 'a1'],
    deletedSourceBranchIds: ['branch-child'],
    idMap: [{ kind: 'message', sourceId: 'u1', targetId: 'new-1' }],
    projections: pasteDelta(),
    snapshot: {
      kind: 'clipboard-tree',
      mode: 'cut',
      idMap: [],
      placement: {
        topicId: 'topic-t',
        branchId: 'branch-t',
        intent: { kind: 'topic-tail' },
        ownerIndex: 0,
        prevOwnerMessageId: null,
        nextOwnerMessageId: null
      },
      inserted: { messages: [], blocks: [], branches: [], segments: [] },
      sourceRemoved: null
    },
    affectedFileIds: ['file-1'],
    remainingReferenceCounts: { 'file-1': 0 },
    ...overrides
  } as unknown as PasteClipboardTreeResponse
}

function seedTreeClipboard(mode: 'copy' | 'cut') {
  storeState.clipboard = {
    mode,
    items: [],
    sourceTopicId: 'topic-src',
    sourceBranchId: 'branch-src',
    segmentSnapshots: [],
    tree: treeCapture
  }
}

describe('tree paste', () => {
  it('runs ONE Main transaction, records ONE snapshot action, and clears a cut clipboard', async () => {
    seedTreeClipboard('cut')
    const response = pasteResponse()
    mocks.pasteClipboardTree.mockResolvedValue(response)

    const count = await pasteMessages(dispatch, () => storeState as never, 'topic-t', '')

    expect(count).toBe(2)
    expect(mocks.pasteClipboardTree).toHaveBeenCalledTimes(1)
    expect(mocks.pasteClipboardTree).toHaveBeenCalledWith({
      mode: 'cut',
      payload: treePayload,
      target: { topicId: 'topic-t', branchId: 'branch-t', intent: { kind: 'topic-tail' } }
    })
    // File lifecycle comes from the command's own affected set.
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledWith(response)
    // ONE history action carrying Main's own snapshot.
    expect(mocks.recordUndoAction).toHaveBeenCalledTimes(1)
    const recorded = mocks.recordUndoAction.mock.calls[0][1]
    expect(recorded.type).toBe('clipboard_tree')
    expect(recorded.targetTopicId).toBe('topic-t')
    expect(recorded.snapshot).toBe(response.snapshot)
    // A cut consumed the payload; both affected topics converge from authority.
    expect(mocks.clearClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.convergeAfterClipboardTreeWrite).toHaveBeenCalledWith(
      dispatch,
      expect.any(Function),
      ['topic-t', 'topic-src'],
      'pasteTreeClipboard:cut',
      // The command's own committed route deltas are forwarded verbatim.
      response.projections
    )
  })

  it('keeps a copy payload reusable and uses the selected target group tail', async () => {
    seedTreeClipboard('copy')
    mocks.pasteClipboardTree.mockResolvedValue(
      pasteResponse({ mode: 'copy', deletedSourceMessageIds: [], deletedSourceBranchIds: [] })
    )

    const count = await pasteMessages(dispatch, () => storeState as never, 'topic-t', 'g1')

    expect(count).toBe(2)
    expect(mocks.pasteClipboardTree.mock.calls[0][0].target).toEqual({
      topicId: 'topic-t',
      branchId: 'branch-t',
      intent: { kind: 'after-group-tail', messageId: 'g1' }
    })
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
  })

  it('pins the target route resolved at command time (a later route switch cannot retarget it)', async () => {
    seedTreeClipboard('copy')
    mocks.requireActiveRouteOf.mockReturnValueOnce('branch-t').mockReturnValue('branch-switched')
    mocks.pasteClipboardTree.mockImplementation(async (request: any) => {
      // The UI route changes while the command is in flight.
      expect(request.target.branchId).toBe('branch-t')
      return pasteResponse({ mode: 'copy' })
    })

    await pasteMessages(dispatch, () => storeState as never, 'topic-t', '')

    expect(mocks.requireActiveRouteOf).toHaveBeenCalledTimes(1)
    expect(mocks.pasteClipboardTree.mock.calls[0][0].target.branchId).toBe('branch-t')
    // The captured source route is pinned inside the payload as well.
    expect(mocks.pasteClipboardTree.mock.calls[0][0].payload.source).toEqual({
      topicId: 'topic-src',
      branchId: 'branch-src'
    })
  })

  it('leaves clipboard, selection and history untouched when Main refuses', async () => {
    seedTreeClipboard('cut')
    mocks.pasteClipboardTree.mockRejectedValue(new Error('source drifted'))

    await expect(pasteMessages(dispatch, () => storeState as never, 'topic-t', '')).rejects.toThrow(/Tree cut failed/)

    expect(mocks.recordUndoAction).not.toHaveBeenCalled()
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    expect(mocks.convergeAfterClipboardTreeWrite).not.toHaveBeenCalled()
  })

  it('still dispatches no clipboard/selection change and no history when the intent target is invalid', async () => {
    seedTreeClipboard('copy')
    mocks.pasteClipboardTree.mockRejectedValue(new Error('Message ghost is not in topic topic-t'))

    await expect(pasteMessages(dispatch, () => storeState as never, 'topic-t', 'ghost')).rejects.toThrow()

    expect(mocks.recordUndoAction).not.toHaveBeenCalled()
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
  })
})

// ── Tree delete ────────────────────────────────────────────────────────────

describe('tree delete', () => {
  it('deletes through ONE Main transaction and records ONE replayable history action', async () => {
    mocks.deleteClipboardTree.mockResolvedValue(deleteResult)

    const count = await deleteTreeSelectedMessages(
      dispatch,
      () => storeState as never,
      'topic-src',
      ['u1'],
      'branch-src'
    )

    expect(count).toBe(2)
    expect(mocks.deleteClipboardTree).toHaveBeenCalledTimes(1)
    expect(mocks.deleteClipboardTree).toHaveBeenCalledWith({
      topicId: 'topic-src',
      branchId: 'branch-src',
      groupIds: ['u1']
    })
    // No clipboard write and no paste on a delete.
    expect(mocks.setClipboard).not.toHaveBeenCalled()
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledTimes(1)
    expect(mocks.recordUndoAction).toHaveBeenCalledTimes(1)
    const action = mocks.recordUndoAction.mock.calls[0][1]
    expect(action.type).toBe('clipboard_tree')
    expect(action.snapshot).toEqual(deleteSnapshot)
    expect(mocks.convergeAfterClipboardTreeWrite).toHaveBeenCalledWith(
      dispatch,
      expect.any(Function),
      ['topic-src'],
      'deleteTreeClipboard:delete',
      deleteResult.projections
    )
  })

  it('dedupes unstable group ids and refuses an empty selection without IPC', async () => {
    mocks.deleteClipboardTree.mockResolvedValue(deleteResult)

    const empty = await deleteTreeSelectedMessages(dispatch, () => storeState as never, 'topic-src', [], 'branch-src')
    expect(empty).toBe(0)
    const count = await deleteTreeSelectedMessages(
      dispatch,
      () => storeState as never,
      'topic-src',
      ['u1', 'u1', ''],
      'branch-src'
    )
    expect(count).toBe(2)
    expect(mocks.deleteClipboardTree).toHaveBeenCalledTimes(1)
    expect(mocks.deleteClipboardTree).toHaveBeenCalledWith({
      topicId: 'topic-src',
      branchId: 'branch-src',
      groupIds: ['u1']
    })
  })

  it('refuses an immutable selection without IPC', async () => {
    mocks.requireEditSelectionMutable.mockImplementation(() => {
      throw new Error('immutable')
    })

    const count = await deleteTreeSelectedMessages(
      dispatch,
      () => storeState as never,
      'topic-src',
      ['u1'],
      'branch-src'
    )

    expect(count).toBe(0)
    expect(mocks.deleteClipboardTree).not.toHaveBeenCalled()
    expect(mocks.recordUndoAction).not.toHaveBeenCalled()
  })

  it('refuses a delete whose staged source route is no longer the active route', async () => {
    mocks.selectActiveBranchId.mockReturnValue('branch-other')

    const count = await deleteTreeSelectedMessages(
      dispatch,
      () => storeState as never,
      'topic-src',
      ['u1'],
      'branch-src'
    )

    expect(count).toBe(0)
    expect(mocks.deleteClipboardTree).not.toHaveBeenCalled()
    expect(mocks.recordUndoAction).not.toHaveBeenCalled()
    expect(mocks.convergeAfterClipboardTreeWrite).not.toHaveBeenCalled()
  })

  it('throws on a Main refusal and leaves clipboard, selection and history untouched', async () => {
    mocks.deleteClipboardTree.mockRejectedValue(new Error('copy-only'))

    await expect(
      deleteTreeSelectedMessages(dispatch, () => storeState as never, 'topic-src', ['u1'], 'branch-src')
    ).rejects.toThrow(/Tree delete failed/)

    expect(mocks.recordUndoAction).not.toHaveBeenCalled()
    expect(mocks.setClipboard).not.toHaveBeenCalled()
    expect(mocks.clearClipboard).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    expect(mocks.convergeAfterClipboardTreeWrite).not.toHaveBeenCalled()
  })
})
