/**
 * ROOT-BOUNDARY: cut-time SOURCE projection eligibility vs paste-time authority.
 *
 * Real Redux store + real clipboard/messages reducers + real ClipboardService
 * cut/paste + real staged-delete helper + real UndoService. Only Main IPC
 * (`dbService`) is mocked with deterministic authority; segment/anchor side
 * effects are no-ops to isolate projection semantics.
 *
 * Scenario (same topic, disjoint windows):
 *  - A = [uA, aA] loaded on main (null route); cut records A eligibility.
 *  - Switch projection to B = [uB, aB] on branch-b (disjoint ids).
 *  - Paste to B: insert copies + staged source delete of A. The undo
 *    `sourceGroupAnchors.loadedMessageIds` must be A (preserved eligibility),
 *    never B and never empty.
 *  - Switch/rebase back to main, then undo: A restores into the ACTIVE main
 *    projection immediately (no route reload), B copies are removed safely,
 *    redo works, and offscreen/outside-window members never leak.
 */

import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { activeBranchSet } from '@renderer/store/topicBranch'
import type { CutPasteUndoAction } from '@renderer/types/editMode'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchClipboardGroups: vi.fn(),
    listSegments: vi.fn(async () => []),
    insertMessageGroups: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    deleteMessagesWithSegments: vi.fn(async () => ({ affectedFileIds: [], remainingReferenceCounts: {} })),
    updateFileCount: vi.fn(),
    upsertSegment: vi.fn(),
    listSegmentsForConverge: vi.fn(async () => []),
    consumeFileCleanupResult: vi.fn(async () => {}),
    transferAnchorsWithAuthorityGroupKeys: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchClipboardGroups: mocks.fetchClipboardGroups,
    listSegments: mocks.listSegments,
    insertMessageGroups: mocks.insertMessageGroups,
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents,
    deleteMessagesWithSegments: mocks.deleteMessagesWithSegments,
    updateFileCount: mocks.updateFileCount,
    upsertSegment: mocks.upsertSegment
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
  deleteSegmentsBySnapshots: vi.fn(async () => {}),
  restoreSegmentsAfterUndo: vi.fn(async () => {}),
  restoreTargetSegments: vi.fn(async () => {}),
  syncSegmentsAfterMessageDeletion: vi.fn(async () => {}),
  convergeTopicSegmentCatalog: vi.fn(async () => {})
}))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

function windowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({
      id,
      topicId,
      role: id.startsWith('u') ? 'user' : 'assistant',
      askId: id.startsWith('a') ? (ids.find((x) => x.startsWith('u')) ?? undefined) : undefined,
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

const topicId = 't-root-boundary'

function authorityClipboardForA() {
  const uA = { id: 'uA', topicId, role: 'user', blocks: [] }
  const aA = { id: 'aA', topicId, role: 'assistant', askId: 'uA', blocks: [] }
  return {
    messages: [uA, aA],
    blocks: [],
    groups: [{ groupId: 'uA', messageIds: ['uA', 'aA'], positionIndex: 0 }],
    clipboard: {
      completeness: 'clipboard-groups',
      topicId,
      requestedCount: 1,
      returnedCount: 1,
      returnedMessageCount: 2,
      firstMessageId: 'uA',
      lastMessageId: 'aA'
    }
  }
}

describe('cut-paste source eligibility (real reducers, real services)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listSegments.mockResolvedValue([])
  })

  it('same-topic A→B→return-A→undo restores A immediately with preserved eligibility (not B)', async () => {
    const store = configureStore({ reducer: rootReducer })
    // Seed A window on main route.
    store.dispatch(bumpGeneration(topicId))
    let gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: windowResponse(topicId, ['uA', 'aA']),
        segments: [],
        route: null
      })
    )
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['uA', 'aA'])

    mocks.fetchClipboardGroups.mockResolvedValue(authorityClipboardForA())

    const { cutMessages, pasteMessages } = await import('../ClipboardService')
    const cutCount = await cutMessages(store.dispatch, store.getState, topicId, ['uA'], null)
    expect(cutCount).toBe(2)
    const clip = (store.getState() as any).clipboard
    expect(clip.mode).toBe('cut')
    // Cut-time eligibility is the SOURCE (A) loaded set.
    expect(clip.sourceProjection).toEqual({
      sourceTopicId: topicId,
      sourceBranchId: null,
      loadedMessageIds: ['uA', 'aA']
    })

    // Switch projection to disjoint B on branch-b (same topicId key, new ids + route).
    store.dispatch(activeBranchSet({ topicId, branchId: 'branch-b' }))
    store.dispatch(bumpGeneration(topicId))
    gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: windowResponse(topicId, ['uB', 'aB']),
        segments: [],
        route: 'branch-b'
      })
    )
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['uB', 'aB'])

    // Deterministic Main mocks for paste insert + staged source delete.
    mocks.insertMessageGroups.mockImplementation(async (tid: string, groups: any[], route: any) => {
      const flatIds = groups.flatMap((g: any) => g.entries.map((e: any) => e.message.id))
      const current: string[] = (store.getState() as any).messages.messageIdsByTopic[tid] ?? []
      const before = current.length > 0 ? current[current.length - 1] : null
      return {
        affectedFileIds: [],
        remainingReferenceCounts: {},
        topicId: tid,
        branchId: route,
        insertedMessages: flatIds.map((id: string) => ({ id, topicId: tid, role: 'user', blocks: [] })),
        insertedBlocks: [],
        insertedMessageIds: flatIds,
        mutableMessageIds: [...flatIds],
        groups: groups.map((g: any) => ({
          insertedMessageIds: g.entries.map((e: any) => e.message.id),
          beforeMessageId: before,
          nextMessageId: null
        }))
      }
    })
    const fullAMessages = [
      { id: 'uA', topicId, role: 'user', blocks: [] },
      { id: 'aA', topicId, role: 'assistant', askId: 'uA', blocks: [] }
    ]
    mocks.deleteMessagesWithDependents.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      deletedMessageIds: ['uA', 'aA'],
      deletedBlockIds: [],
      previousUserMessageIds: ['uA'],
      remainingUserMessageIds: [],
      segments: [],
      restoreGroups: [
        {
          entries: fullAMessages.map((m) => ({ message: m, blocks: [] })),
          positionIndex: 0,
          anchorMessageId: null
        }
      ],
      segmentSnapshots: []
    })

    // Paste to B tail (live route branch-b).
    const pasted = await pasteMessages(store.dispatch, store.getState, topicId, '')
    expect(pasted).toBe(2)
    // B projection now holds B + 2 copies.
    const afterPaste: string[] = (store.getState() as any).messages.messageIdsByTopic[topicId]
    expect(afterPaste.slice(0, 2)).toEqual(['uB', 'aB'])
    expect(afterPaste).toHaveLength(4)
    const pastedIds = afterPaste.slice(2)

    // Authority undo anchors use preserved A eligibility — never B, never empty.
    const undoTop = (store.getState() as any).undoStack.undoStack.at(-1) as CutPasteUndoAction
    expect(undoTop.type).toBe('cut_paste')
    expect(undoTop.sourceGroupAnchors).toHaveLength(1)
    expect(undoTop.sourceGroupAnchors[0].loadedMessageIds).toEqual(['uA', 'aA'])
    expect(undoTop.sourceGroupAnchors[0].loadedMessageIds).not.toEqual(expect.arrayContaining(['uB', 'aB']))
    // Redo carries the same cut-time eligibility for later re-delete.
    expect(undoTop.sourceProjection).toEqual({
      sourceTopicId: topicId,
      sourceBranchId: null,
      loadedMessageIds: ['uA', 'aA']
    })

    // Return to source A BEFORE undo: rebase to the post-delete A remainder
    // (empty here) on the main route. Undo must then inject A immediately
    // without any route reload/refresh.
    store.dispatch(activeBranchSet({ topicId, branchId: null }))
    store.dispatch(
      (newMessagesActions as any).rebaseRouteMessages({ topicId, messages: [], route: null, mutableMessageIds: [] })
    )
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual([])

    const { executeUndo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch, store.getState)
    expect(undone?.type).toBe('cut_paste')
    const afterUndo: string[] = (store.getState() as any).messages.messageIdsByTopic[topicId]
    // Immediate visibility: originals are in the ACTIVE main projection now.
    expect(afterUndo).toEqual(expect.arrayContaining(['uA', 'aA']))
    // B copies are removed from entities safely (no duplicate retention).
    const entities = (store.getState() as any).messages.entities
    for (const pid of pastedIds) {
      expect(entities[pid]).toBeUndefined()
    }
    expect(entities['uA']).toBeDefined()
    expect(entities['aA']).toBeDefined()
    // Mutable rights for the restored main window are correct.
    const mutable: string[] = (store.getState() as any).messages.mutableMessageIdsByTopic[topicId] ?? []
    expect(mutable).toEqual(expect.arrayContaining(['uA', 'aA']))

    // Redo re-deletes A via the preserved eligibility and re-inserts copies.
    const { executeRedo } = await import('../UndoService')
    mocks.deleteMessagesWithDependents.mockClear()
    const redone = await executeRedo(store.dispatch, store.getState)
    expect(redone?.type).toBe('cut_paste')
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledTimes(1)
    // Staged re-delete still addresses the SOURCE route (null), never live B.
    expect(mocks.deleteMessagesWithDependents.mock.calls[0][2]).toBe(null)
  })

  it('active-target undo leaves the B projection correct and offscreen source members do not leak', async () => {
    const store = configureStore({ reducer: rootReducer })
    // A window with only [uA] resident; authority group is [uA, aA-outside].
    store.dispatch(bumpGeneration(topicId))
    let gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: windowResponse(topicId, ['uA']),
        segments: [],
        route: null
      })
    )
    mocks.fetchClipboardGroups.mockResolvedValue({
      messages: [
        { id: 'uA', topicId, role: 'user', blocks: [] },
        { id: 'aA-out', topicId, role: 'assistant', askId: 'uA', blocks: [] }
      ],
      blocks: [],
      groups: [{ groupId: 'uA', messageIds: ['uA', 'aA-out'], positionIndex: 0 }],
      clipboard: {
        completeness: 'clipboard-groups',
        topicId,
        requestedCount: 1,
        returnedCount: 1,
        returnedMessageCount: 2,
        firstMessageId: 'uA',
        lastMessageId: 'aA-out'
      }
    })
    const { cutMessages, pasteMessages } = await import('../ClipboardService')
    // Gate needs the loaded group resolvable: seed the outside member as
    // non-resident authority only (loaded stays [uA]), so cut refuses here.
    // Instead drive the eligibility path directly: cut with a fully-loaded A
    // then shrink eligibility to prove outside-window non-injection on undo.
    // Use the real cut with [uA] loaded but authority-complete payload.
    // The gate resolves the loaded subset; Main payload stays complete.
    // For this focused case the loaded group is user-only, so cut succeeds.
    const cutCount = await cutMessages(store.dispatch, store.getState, topicId, ['uA'], null)
    expect(cutCount).toBe(2)
    const clip = (store.getState() as any).clipboard
    // Eligibility is exactly the cut-time loaded window ([uA]), not authority-complete.
    expect(clip.sourceProjection.loadedMessageIds).toEqual(['uA'])

    // Paste to B then undo WHILE active is still B: source restore must not
    // inflate the B window with offscreen A rows.
    store.dispatch(activeBranchSet({ topicId, branchId: 'branch-b' }))
    store.dispatch(bumpGeneration(topicId))
    gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: windowResponse(topicId, ['uB', 'aB']),
        segments: [],
        route: 'branch-b'
      })
    )
    mocks.insertMessageGroups.mockImplementation(async (tid: string, groups: any[], route: any) => {
      const flatIds = groups.flatMap((g: any) => g.entries.map((e: any) => e.message.id))
      const current: string[] = (store.getState() as any).messages.messageIdsByTopic[tid] ?? []
      const before = current.length > 0 ? current[current.length - 1] : null
      return {
        affectedFileIds: [],
        remainingReferenceCounts: {},
        topicId: tid,
        branchId: route,
        insertedMessages: flatIds.map((id: string) => ({ id, topicId: tid, role: 'user', blocks: [] })),
        insertedBlocks: [],
        insertedMessageIds: flatIds,
        mutableMessageIds: [...flatIds],
        groups: groups.map((g: any) => ({
          insertedMessageIds: g.entries.map((e: any) => e.message.id),
          beforeMessageId: before,
          nextMessageId: null
        }))
      }
    })
    mocks.deleteMessagesWithDependents.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      deletedMessageIds: ['uA', 'aA-out'],
      deletedBlockIds: [],
      previousUserMessageIds: ['uA'],
      remainingUserMessageIds: [],
      segments: [],
      restoreGroups: [
        {
          entries: [
            { message: { id: 'uA', topicId, role: 'user', blocks: [] }, blocks: [] },
            { message: { id: 'aA-out', topicId, role: 'assistant', askId: 'uA', blocks: [] }, blocks: [] }
          ],
          positionIndex: 0,
          anchorMessageId: null
        }
      ],
      segmentSnapshots: []
    })
    await pasteMessages(store.dispatch, store.getState, topicId, '')
    const undoTop = (store.getState() as any).undoStack.undoStack.at(-1) as CutPasteUndoAction
    // Outside-window member excluded from eligibility intersection.
    expect(undoTop.sourceGroupAnchors[0].loadedMessageIds).toEqual(['uA'])

    const { executeUndo } = await import('../UndoService')
    // Undo while active route is still the B target: B copies removed, B
    // window stays correct, and the offscreen A restore does not leak into B.
    // Switch semantics: undo restores source on main but active is B, so the
    // bounded guard must keep B projection free of A rows.
    const beforeUndoB: string[] = [...(store.getState() as any).messages.messageIdsByTopic[topicId]]
    expect(beforeUndoB.slice(0, 2)).toEqual(['uB', 'aB'])
    await executeUndo(store.dispatch, store.getState)
    const afterUndoB: string[] = (store.getState() as any).messages.messageIdsByTopic[topicId]
    expect(afterUndoB).toEqual(['uB', 'aB'])
    expect(afterUndoB).not.toContain('uA')
    expect(afterUndoB).not.toContain('aA-out')
  })

  it('missing/stale source provenance fails closed with zero writes; ordinary delete unchanged', async () => {
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: windowResponse(topicId, ['uA', 'aA']),
        segments: [],
        route: null
      })
    )
    const { executeStagedCutSourceDelete, executeDeleteMessagesWithDependents } = await import(
      '@renderer/store/thunk/messageThunk'
    )
    // Missing provenance: zero Main calls.
    await expect(
      executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: null,
        rootIds: ['uA']
      })
    ).rejects.toThrow('Missing staged source projection')
    // Stale route provenance (branch mismatch): zero Main calls.
    await expect(
      executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: 'branch-staged',
        rootIds: ['uA'],
        sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: ['uA', 'aA'] }
      })
    ).rejects.toThrow('route mismatch')
    expect(mocks.deleteMessagesWithDependents).not.toHaveBeenCalled()

    // Ordinary immediate delete keeps its live pre-delete snapshot path.
    mocks.deleteMessagesWithDependents.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      deletedMessageIds: ['uA', 'aA'],
      deletedBlockIds: [],
      previousUserMessageIds: ['uA'],
      remainingUserMessageIds: [],
      segments: [],
      restoreGroups: [
        {
          entries: [
            { message: { id: 'uA' }, blocks: [] },
            { message: { id: 'aA' }, blocks: [] }
          ],
          positionIndex: 0,
          anchorMessageId: null
        }
      ],
      segmentSnapshots: []
    })
    const res = await executeDeleteMessagesWithDependents(store.dispatch, store.getState as any, topicId, ['uA'])
    expect(res.undoParts.groupAnchors[0].loadedMessageIds).toEqual(['uA', 'aA'])
  })
})
