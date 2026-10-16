/**
 * Natural-boundary correction proof: COMMON local structural-mutation
 * publication contract (concurrency/failure + ALL local-success callsites).
 *
 * Real rootReducer store; DB mocked only. No Messages/viewport edits.
 */
import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUpsert, mockReplace, mockDelete, mockList, mockUpdateMeta, mockDeleteWithDependents } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockReplace: vi.fn(),
  mockDelete: vi.fn(),
  mockList: vi.fn(),
  mockUpdateMeta: vi.fn(),
  mockDeleteWithDependents: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: mockUpsert,
    replaceSegmentMembership: mockReplace,
    deleteSegment: mockDelete,
    listSegments: mockList,
    updateSegmentMetadata: mockUpdateMeta,
    deleteMessagesWithDependents: mockDeleteWithDependents
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import { rootReducer } from '@renderer/store'
import { newMessagesActions, selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import {
  bumpGeneration,
  fingerprintSegmentCatalog,
  publishResidentComplete,
  SEGMENT_CATALOG_PUBLISH_COMPLETE
} from '@renderer/store/residentRegistry'
import { activeBranchSet, selectRouteGeneration } from '@renderer/store/topicBranch'
import { convergeTopicSegmentCatalog, resetCatalogRequestSeqForTests } from '@renderer/utils/topicSegmentCatalog'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'

function windowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({ id })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    mutableMessageIds: [...ids],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

function seg(id: string, topicId: string, sortOrder: number, messageIds: string[], name = id): any {
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

function establishResident(store: ReturnType<typeof configureStore>, topicId: string, ids: string[], segments: any[]) {
  store.dispatch(bumpGeneration(topicId))
  const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
  store.dispatch(
    publishResidentComplete({ topicId, generation: gen, windowResponse: windowResponse(topicId, ids), segments })
  )
  store.dispatch(newMessagesActions.mergeRouteMutability({ topicId, route: null, mutableMessageIds: [...ids] }) as any)
  return gen
}

describe('segment catalog correction — real root store', () => {
  let store: ReturnType<typeof configureStore>
  beforeEach(() => {
    vi.clearAllMocks()
    resetCatalogRequestSeqForTests()
    store = configureStore({ reducer: rootReducer })
  })

  it('rename (metadata-only) converges through the shared publication with no transient blank', async () => {
    const gen = establishResident(store, 't-rename', ['m1', 'm2'], [seg('seg-r', 't-rename', 0, ['m1'])])
    const seen: Array<unknown> = []
    const unsub = store.subscribe(() => {
      seen.push(selectLoadedMessagesForTopic(store.getState() as any, 't-rename') as any)
    })
    mockUpdateMeta.mockResolvedValue(seg('seg-r', 't-rename', 0, ['m1'], 'Renamed'))
    mockList.mockResolvedValue([seg('seg-r', 't-rename', 0, ['m1'], 'Renamed')])
    // Actual hook path: metadata write then shared converge (no raw updateSegment).
    await (await import('@renderer/services/db')).dbService.updateSegmentMetadata('seg-r', 'Renamed')
    await convergeTopicSegmentCatalog(store.dispatch as any, 't-rename', store.getState as any)
    unsub()
    const entry = (store.getState() as any).residentRegistry.entries['t-rename']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    expect((store.getState() as any).topicSegments.segments.entities['seg-r'].name).toBe('Renamed')
    for (const proj of seen) {
      expect(proj).toBeDefined()
      expect([...(proj as any)].map((m: any) => m.id)).toEqual(['m1', 'm2'])
    }
  })

  it('same IDs with changed membership: older late read never overwrites newer accepted snapshot', async () => {
    establishResident(store, 't-sameid', ['m1', 'm2', 'm3'], [seg('seg-s', 't-sameid', 0, ['m1', 'm2'])])
    let resolveOld!: (v: any[]) => void
    mockList
      .mockImplementationOnce(() => new Promise<any[]>((res) => ((resolveOld as any) = res)))
      .mockImplementationOnce(() => Promise.resolve([seg('seg-s', 't-sameid', 0, ['m1', 'm3'])]))
    const pendingOld = convergeTopicSegmentCatalog(store.dispatch as any, 't-sameid', store.getState as any)
    // Newer overlapping request completes first with changed membership.
    await convergeTopicSegmentCatalog(store.dispatch as any, 't-sameid', store.getState as any)
    expect((store.getState() as any).topicSegments.segments.entities['seg-s'].messageIds).toEqual(['m1', 'm3'])
    // Older read arrives late with the previous membership (same IDs, stale content).
    resolveOld([seg('seg-s', 't-sameid', 0, ['m1', 'm2'])])
    await pendingOld
    // No regression: newer membership retained, still resident, no extra bump.
    expect((store.getState() as any).topicSegments.segments.entities['seg-s'].messageIds).toEqual(['m1', 'm3'])
    expect((store.getState() as any).residentRegistry.entries['t-sameid'].residentTopic).toBe(true)
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-sameid')).toBeDefined()
  })

  it('older read after newer successful read with identical content does not invalidate', async () => {
    const gen = establishResident(store, 't-ident', ['m1'], [seg('seg-i', 't-ident', 0, ['m1'])])
    let resolveOld!: (v: any[]) => void
    const catalog = [seg('seg-i', 't-ident', 0, ['m1'])]
    mockList
      .mockImplementationOnce(() => new Promise<any[]>((res) => ((resolveOld as any) = res)))
      .mockImplementationOnce(() => Promise.resolve(catalog.map((s) => ({ ...s }))))
    const pendingOld = convergeTopicSegmentCatalog(store.dispatch as any, 't-ident', store.getState as any)
    await convergeTopicSegmentCatalog(store.dispatch as any, 't-ident', store.getState as any)
    resolveOld(catalog.map((s) => ({ ...s })))
    await pendingOld
    const entry = (store.getState() as any).residentRegistry.entries['t-ident']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-ident']).toEqual(['seg-i'])
  })

  it('failing old read after a healthy successor never bumps the successor window', async () => {
    const gen = establishResident(store, 't-failsucc', ['m1'], [seg('seg-f', 't-failsucc', 0, ['m1'])])
    let rejectOld!: (e: unknown) => void
    mockList.mockImplementationOnce(() => new Promise<any[]>((_res, rej) => ((rejectOld as any) = rej)))
    const pendingOld = convergeTopicSegmentCatalog(store.dispatch as any, 't-failsucc', store.getState as any)
    // Healthy successor: same generation, new window + catalog via joint republish.
    store.dispatch(
      publishResidentComplete({
        topicId: 't-failsucc',
        generation: gen,
        windowResponse: windowResponse('t-failsucc', ['m1', 'm2']),
        segments: [seg('seg-f', 't-failsucc', 0, ['m1', 'm2'])]
      })
    )
    rejectOld(new Error('old list failed'))
    await expect(pendingOld).rejects.toThrow('old list failed')
    const entry = (store.getState() as any).residentRegistry.entries['t-failsucc']
    // Successor window preserved (no bump destroying it).
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    expect(
      [...((selectLoadedMessagesForTopic(store.getState() as any, 't-failsucc') as any) ?? [])].map((m: any) => m.id)
    ).toEqual(['m1', 'm2'])
  })

  it('route away-and-back with identical route/window/catalog discards via route-generation (utility)', async () => {
    const topicId = 't-routetrip-util'
    const gen = establishResident(store, topicId, ['m1', 'm2'], [seg('seg-rt', topicId, 0, ['m1'])])
    expect(selectRouteGeneration(store.getState() as any, topicId)).toBe(0)
    let resolveOld!: (v: any[]) => void
    const identical = [seg('seg-rt', topicId, 0, ['m1'])]
    mockList.mockImplementationOnce(() => new Promise<any[]>((res) => ((resolveOld as any) = res)))
    const pendingOld = convergeTopicSegmentCatalog(store.dispatch as any, topicId, store.getState as any)
    // Route excursion away and back: value returns to main (null) but the
    // existing route-generation token bumps twice.
    store.dispatch(activeBranchSet({ topicId, branchId: 'b-away' }) as any)
    store.dispatch(activeBranchSet({ topicId, branchId: null }) as any)
    expect(selectRouteGeneration(store.getState() as any, topicId)).toBe(2)
    expect((store.getState() as any).topicBranch.activeBranchIdByTopic[topicId] ?? null).toBe(null)
    // Late identical-content read from before the excursion arrives.
    resolveOld(identical.map((s) => ({ ...s })))
    await pendingOld
    const entry = (store.getState() as any).residentRegistry.entries[topicId]
    // Discarded without invalidating the healthy successor: still resident,
    // same applicability generation, projection intact, catalog unoverwritten.
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    expect(
      [...((selectLoadedMessagesForTopic(store.getState() as any, topicId) as any) ?? [])].map((m: any) => m.id)
    ).toEqual(['m1', 'm2'])
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-rt'])
    expect((store.getState() as any).topicSegments.segments.entities['seg-rt'].messageIds).toEqual(['m1'])
  })

  it('route away-and-back with identical route/window/catalog discards via route-generation (root guard)', async () => {
    const topicId = 't-routetrip-root'
    const gen = establishResident(store, topicId, ['m1', 'm2'], [seg('seg-rr', topicId, 0, ['m1'])])
    const beforeCatalog = (store.getState() as any).topicSegments.segmentsByTopic[topicId]
    expect(beforeCatalog).toEqual(['seg-rr'])
    const baseFingerprint = fingerprintSegmentCatalog([
      (store.getState() as any).topicSegments.segments.entities['seg-rr']
    ])
    const staleRouteGeneration = selectRouteGeneration(store.getState() as any, topicId)
    expect(staleRouteGeneration).toBe(0)
    // Excursion away and back: route value identical, token bumped.
    store.dispatch(activeBranchSet({ topicId, branchId: 'b-away' }) as any)
    store.dispatch(activeBranchSet({ topicId, branchId: null }) as any)
    expect(selectRouteGeneration(store.getState() as any, topicId)).toBe(2)
    // Direct fabricated stale publication carrying the pre-excursion token
    // but otherwise identical route/window/catalog must discard fail-closed.
    store.dispatch({
      type: SEGMENT_CATALOG_PUBLISH_COMPLETE,
      payload: {
        topicId,
        generation: gen,
        segments: [seg('seg-fab', topicId, 0, ['m1'])],
        messageIds: ['m1', 'm2'],
        route: null,
        baseFingerprint,
        routeGeneration: staleRouteGeneration
      }
    } as any)
    const entry = (store.getState() as any).residentRegistry.entries[topicId]
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    expect(
      [...((selectLoadedMessagesForTopic(store.getState() as any, topicId) as any) ?? [])].map((m: any) => m.id)
    ).toEqual(['m1', 'm2'])
    // No catalog overwrite from the fabricated stale publication.
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-rr'])
    expect((store.getState() as any).topicSegments.segments.entities['seg-fab']).toBeUndefined()
  })

  it('redoDelete via the shared delete acknowledgment preserves the loaded projection', async () => {
    const topicId = 't-redo'
    const gen = establishResident(store, topicId, ['m1', 'm2', 'm3'], [seg('seg-d', topicId, 0, ['m1', 'm2', 'm3'])])
    const { publishDeleteAuthorityCatalog } = await import('@renderer/store/thunk/messageThunk')
    const response: any = {
      deletedMessageIds: ['m2'],
      deletedBlockIds: [],
      segments: [seg('seg-d', topicId, 0, ['m1', 'm3'])]
    }
    const seen: Array<unknown> = []
    const unsub = store.subscribe(() => {
      seen.push(selectLoadedMessagesForTopic(store.getState() as any, topicId) as any)
    })
    publishDeleteAuthorityCatalog(store.dispatch as any, topicId, response)
    unsub()
    const entry = (store.getState() as any).residentRegistry.entries[topicId]
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['m1', 'm3'])
    expect((store.getState() as any).topicSegments.segments.entities['seg-d'].messageIds).toEqual(['m1', 'm3'])
    for (const proj of seen) {
      if (proj !== undefined) {
        expect([...(proj as any)].map((m: any) => m.id)).not.toEqual([])
      }
    }
    expect(seen.length).toBeGreaterThan(0)
  })
})
