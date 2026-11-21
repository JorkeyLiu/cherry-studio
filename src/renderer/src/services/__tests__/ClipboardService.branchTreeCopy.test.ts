/**
 * ClipboardService — branch-row tree copy (`copyBranchTree`).
 *
 * Promise guarded here: copying ONE branch row from the selector captures the
 * branch's OWN rows as the root trunk plus every descendant branch's own rows,
 * through ONE Main read, and publishes it as the existing tree content kind.
 * - the request is the explicit branch-owned shape (no `groupIds`),
 * - no loaded-projection / resident-message selection is consulted,
 * - a failed or empty capture publishes nothing,
 * - the ordinary copy/cut/paste paths are untouched.
 */
import type { ClipboardTreeCapture } from '@renderer/types/editMode'
import type { ClipboardTreePayload, FetchClipboardTreeMeta, FetchClipboardTreeRequest } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchClipboardTree: vi.fn(),
    fetchClipboardGroups: vi.fn(),
    pasteClipboardTree: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    convergeAfterClipboardTreeWrite: vi.fn(async () => {}),
    requireActiveRouteOf: vi.fn(),
    selectActiveBranchId: vi.fn(),
    selectLoadedMessagesForTopic: vi.fn(() => []),
    requireEditSelectionMutable: vi.fn(),
    setClipboard: vi.fn((p: unknown) => ({ type: 'clipboard/setClipboard', payload: p })),
    clearClipboard: vi.fn(() => ({ type: 'clipboard/clearClipboard' })),
    recordUndoAction: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mocks.logger
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchClipboardTree: mocks.fetchClipboardTree,
    fetchClipboardGroups: mocks.fetchClipboardGroups,
    pasteClipboardTree: mocks.pasteClipboardTree,
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
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
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

vi.mock('uuid', () => ({ v4: () => 'generated-id' }))

const { copyBranchTree } = await import('../ClipboardService')

// ── Fixtures ───────────────────────────────────────────────────────────────

const branchPayload = {
  source: { topicId: 'topic-1', branchId: 'b-own' },
  roots: [
    { groupId: 'u-own', messageIds: ['u-own', 'a-own'], positionIndex: 0 },
    { groupId: 'u-child', messageIds: ['u-child'], positionIndex: 2 }
  ],
  messages: [
    { id: 'u-own', role: 'user' },
    { id: 'a-own', role: 'assistant' },
    { id: 'u-child', role: 'user' }
  ],
  blocks: [],
  branches: [
    {
      sourceBranchId: 'b-child',
      parentSourceBranchId: 'b-own',
      anchorMessageId: 'u-own',
      name: 'child',
      depth: 1,
      overflow: {}
    }
  ],
  segments: []
} as unknown as ClipboardTreePayload

function branchMeta(overrides: Partial<FetchClipboardTreeMeta> = {}): FetchClipboardTreeMeta {
  return {
    completeness: 'clipboard-tree',
    topicId: 'topic-1',
    branchId: 'b-own',
    requestedCount: 1,
    returnedCount: 2,
    returnedMessageCount: 3,
    returnedBranchCount: 1,
    returnedSegmentCount: 0,
    ownedRootMessageIds: ['u-own', 'u-child'],
    inheritedRootMessageIds: [],
    firstMessageId: 'u-own',
    lastMessageId: 'u-child',
    ...overrides
  }
}

const dispatch = vi.fn()

function publishedPayload(): any {
  expect(mocks.setClipboard).toHaveBeenCalledTimes(1)
  return mocks.setClipboard.mock.calls[0][0]
}

beforeEach(() => {
  vi.clearAllMocks()
  dispatch.mockReset()
})

describe('copyBranchTree', () => {
  it('requests only the explicit branch-owned shape and publishes the tree content kind', async () => {
    mocks.fetchClipboardTree.mockResolvedValue({ tree: branchPayload, clipboard: branchMeta() })

    const count = await copyBranchTree(dispatch, 'topic-1', 'b-own')

    expect(count).toBe(3)
    expect(mocks.fetchClipboardTree).toHaveBeenCalledTimes(1)
    const request = mocks.fetchClipboardTree.mock.calls[0][0] as FetchClipboardTreeRequest
    expect(request).toEqual({ topicId: 'topic-1', branchId: 'b-own', capture: 'branch-owned' })
    expect(request).not.toHaveProperty('groupIds')

    const payload = publishedPayload()
    expect(payload.mode).toBe('copy')
    expect(payload.items).toEqual([])
    expect(payload.segmentSnapshots).toEqual([])
    expect(payload.sourceTopicId).toBe('topic-1')
    expect(payload.sourceBranchId).toBe('b-own')
    expect(payload.tree).toEqual({
      payload: branchPayload,
      meta: branchMeta()
    } satisfies ClipboardTreeCapture)
  })

  it('consults no resident-message selection or loaded projection', async () => {
    mocks.fetchClipboardTree.mockResolvedValue({ tree: branchPayload, clipboard: branchMeta() })

    await copyBranchTree(dispatch, 'topic-1', 'b-own')

    expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(mocks.selectActiveBranchId).not.toHaveBeenCalled()
    expect(mocks.requireActiveRouteOf).not.toHaveBeenCalled()
    expect(mocks.fetchClipboardGroups).not.toHaveBeenCalled()
  })

  it('captures an inactive branch (no active-route requirement)', async () => {
    mocks.selectActiveBranchId.mockReturnValue('b-active')
    mocks.fetchClipboardTree.mockResolvedValue({ tree: branchPayload, clipboard: branchMeta() })

    const count = await copyBranchTree(dispatch, 'topic-1', 'b-own')

    expect(count).toBe(3)
    expect(mocks.fetchClipboardTree.mock.calls[0][0]).toEqual({
      topicId: 'topic-1',
      branchId: 'b-own',
      capture: 'branch-owned'
    })
    expect(publishedPayload().sourceBranchId).toBe('b-own')
  })

  it('publishes nothing when the Main read fails', async () => {
    mocks.fetchClipboardTree.mockRejectedValue(new Error('dangling anchor'))

    const count = await copyBranchTree(dispatch, 'topic-1', 'b-own')

    expect(count).toBe(0)
    expect(mocks.setClipboard).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.logger.error).toHaveBeenCalled()
  })

  it('publishes nothing for an empty trunk', async () => {
    mocks.fetchClipboardTree.mockResolvedValue({
      tree: { ...branchPayload, roots: [] },
      clipboard: branchMeta({ returnedCount: 0, returnedMessageCount: 0 })
    })

    const count = await copyBranchTree(dispatch, 'topic-1', 'b-own')

    expect(count).toBe(0)
    expect(mocks.setClipboard).not.toHaveBeenCalled()
    expect(mocks.logger.warn).toHaveBeenCalled()
  })

  it('does not reach Main without an explicit branch id', async () => {
    const count = await copyBranchTree(dispatch, 'topic-1', '')

    expect(count).toBe(0)
    expect(mocks.fetchClipboardTree).not.toHaveBeenCalled()
    expect(mocks.setClipboard).not.toHaveBeenCalled()
  })
})
