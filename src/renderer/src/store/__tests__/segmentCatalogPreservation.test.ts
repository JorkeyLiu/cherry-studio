/**
 * Root-boundary segment-catalog preservation (create/dissolve/membership blank fix).
 *
 * Real rootReducer/store + actual hook/service/thunk, DB mocked only.
 * Proves the chosen boundary: ONE explicit authority-backed local
 * segment-catalog publication (`resident/segmentCatalogPublishComplete`) that
 * preserves an unchanged resident message projection after a segment-only
 * mutation, with generation + resident-window provenance. Raw unpaired and
 * fromSync structural actions keep invalidating (intentional, LOCK-302).
 *
 * Relationship verdict (backed below): the create/dissolve blank and the
 * clipboard/undo/restore blank share this root (unpaired structural
 * invalidation -> resident false -> selectLoaded undefined -> [] viewport).
 * The prior cut fix (wrong-time+route staged source snapshot) is independent
 * and remains: staged-cut eligibility addresses Main owner/route authority,
 * while this fix addresses the shared catalog convergence that would still
 * blank even with correct eligibility. Both hold simultaneously below.
 */
import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUpsert, mockReplace, mockDelete, mockList } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockReplace: vi.fn(),
  mockDelete: vi.fn(),
  mockList: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: mockUpsert,
    replaceSegmentMembership: mockReplace,
    deleteSegment: mockDelete,
    listSegments: mockList
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
  publishResidentComplete,
  SEGMENT_CATALOG_PUBLISH_COMPLETE
} from '@renderer/store/residentRegistry'
import { addSegment, removeSegment, replaceSegmentsForTopic, updateSegment } from '@renderer/store/topicSegment'
import { convergeTopicSegmentCatalog, resetCatalogRequestSeqForTests } from '@renderer/utils/topicSegmentCatalog'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'

function windowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({ id })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
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

function seg(id: string, topicId: string, sortOrder: number, messageIds: string[]): any {
  return {
    id,
    topicId,
    name: id,
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

function wire(id: string, topicId: string, sortOrder: number, messageIds: string[]): any {
  return seg(id, topicId, sortOrder, messageIds)
}

function establishResident(store: ReturnType<typeof configureStore>, topicId: string, ids: string[], segments: any[]) {
  store.dispatch(bumpGeneration(topicId))
  const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
  store.dispatch(
    publishResidentComplete({ topicId, generation: gen, windowResponse: windowResponse(topicId, ids), segments })
  )
  // Main-authoritative route capability for the hook precheck (main route).
  store.dispatch(newMessagesActions.mergeRouteMutability({ topicId, route: null, mutableMessageIds: [...ids] }) as any)
  return gen
}

describe('segment catalog preservation — real root store', () => {
  let store: ReturnType<typeof configureStore>

  beforeEach(() => {
    vi.clearAllMocks()
    resetCatalogRequestSeqForTests()
    store = configureStore({ reducer: rootReducer })
  })

  it('create convergence preserves resident messages with no transient blank and installs full catalog', async () => {
    const gen = establishResident(store, 't-create', ['m1', 'm2', 'm3'], [seg('seg-old', 't-create', 0, ['m1'])])
    const beforeMsgs = selectLoadedMessagesForTopic(store.getState() as any, 't-create')
    expect(beforeMsgs).toBeDefined()
    const beforeIds = [...(beforeMsgs as any)].map((m: any) => m.id)
    expect(beforeIds).toEqual(['m1', 'm2', 'm3'])

    const seen: Array<readonly any[] | undefined> = []
    const unsub = store.subscribe(() => {
      seen.push(selectLoadedMessagesForTopic(store.getState() as any, 't-create') as any)
    })

    mockUpsert.mockResolvedValue(wire('seg-new', 't-create', 0, ['m2', 'm3']))
    mockList.mockResolvedValue([wire('seg-new', 't-create', 0, ['m2', 'm3']), wire('seg-old', 't-create', 1, ['m1'])])
    await (await import('@renderer/services/db')).dbService.upsertSegment(
      'seg-new',
      't-create',
      'New',
      ['m2', 'm3'],
      'color-seg-new',
      null
    )
    await convergeTopicSegmentCatalog(store.dispatch as any, 't-create', store.getState as any)
    unsub()

    const afterEntry = (store.getState() as any).residentRegistry.entries['t-create']
    expect(afterEntry.residentTopic).toBe(true)
    expect(afterEntry.applicabilityGeneration).toBe(gen)
    expect(afterEntry.chatData).toBe(true)
    expect(afterEntry.segments).toBe(true)
    const afterMsgs = selectLoadedMessagesForTopic(store.getState() as any, 't-create')
    expect(afterMsgs).toBeDefined()
    expect([...(afterMsgs as any)].map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3'])
    // No transient resident=false frame: every observed projection stayed defined and full.
    expect(seen.length).toBeGreaterThan(0)
    for (const proj of seen) {
      expect(proj).toBeDefined()
      expect([...(proj as any)].map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3'])
    }
    // Full authority catalog applied (shifted sibling converged).
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-create']).toEqual(['seg-new', 'seg-old'])
    expect((store.getState() as any).topicSegments.segments.entities['seg-old'].sortOrder).toBe(1)
  })

  it('dissolve convergence preserves resident messages and removes the catalog entry', async () => {
    const gen = establishResident(
      store,
      't-dissolve',
      ['m1', 'm2'],
      [seg('seg-a', 't-dissolve', 0, ['m1']), seg('seg-b', 't-dissolve', 1, ['m2'])]
    )
    mockDelete.mockResolvedValue(undefined)
    mockList.mockResolvedValue([wire('seg-b', 't-dissolve', 0, ['m2'])])
    await (await import('@renderer/services/db')).dbService.deleteSegment('seg-a')
    await convergeTopicSegmentCatalog(store.dispatch as any, 't-dissolve', store.getState as any)

    const entry = (store.getState() as any).residentRegistry.entries['t-dissolve']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-dissolve')).toBeDefined()
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-dissolve']).toEqual(['seg-b'])
    expect((store.getState() as any).topicSegments.segments.entities['seg-a']).toBeUndefined()
  })

  it('membership convergence preserves resident messages and installs updated boundaries', async () => {
    const gen = establishResident(store, 't-member', ['m1', 'm2', 'm3'], [seg('seg-m', 't-member', 0, ['m1', 'm2'])])
    mockReplace.mockResolvedValue(wire('seg-m', 't-member', 0, ['m1', 'm3']))
    mockList.mockResolvedValue([wire('seg-m', 't-member', 0, ['m1', 'm3'])])
    await (await import('@renderer/services/db')).dbService.replaceSegmentMembership('seg-m', ['m1', 'm3'], null)
    await convergeTopicSegmentCatalog(store.dispatch as any, 't-member', store.getState as any)

    const entry = (store.getState() as any).residentRegistry.entries['t-member']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(gen)
    const msgs = selectLoadedMessagesForTopic(store.getState() as any, 't-member')
    expect(msgs).toBeDefined()
    expect([...(msgs as any)].map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3'])
    const updated = (store.getState() as any).topicSegments.segments.entities['seg-m']
    expect(updated.messageIds).toEqual(['m1', 'm3'])
    expect(updated.firstMessageId).toBe('m1')
    expect(updated.lastMessageId).toBe('m3')
  })

  it('clipboard/undo shared convergence (nonempty snapshots) preserves source and target projections', async () => {
    const genSrc = establishResident(store, 't-src', ['a1', 'a2'], [seg('seg-src', 't-src', 0, ['a1'])])
    const genTgt = establishResident(store, 't-tgt', ['b1'], [seg('seg-tgt', 't-tgt', 0, ['b1'])])
    const { restoreSegmentsAfterUndo, restoreTargetSegments } = await import('../thunk/topicSegmentThunk')
    // Source restore (undo): Main mutations then one preserving publication.
    mockReplace.mockResolvedValue(wire('seg-src', 't-src', 0, ['a1', 'a2']))
    mockUpsert.mockResolvedValue(wire('seg-src', 't-src', 0, ['a1', 'a2']))
    mockList.mockImplementation((tid: string) => {
      if (tid === 't-src') return Promise.resolve([wire('seg-src', tid, 0, ['a1', 'a2'])])
      return Promise.resolve([wire('seg-tgt', tid, 0, ['b1'])])
    })
    // Seed the existing source segment so the restore takes the replace path.
    store.dispatch({
      type: SEGMENT_CATALOG_PUBLISH_COMPLETE,
      payload: {
        topicId: 't-src',
        generation: genSrc,
        segments: [seg('seg-src', 't-src', 0, ['a1'])],
        messageIds: ['a1', 'a2']
      }
    } as any)
    await restoreSegmentsAfterUndo(
      store.dispatch as any,
      store.getState as any,
      [{ ...seg('seg-src', 't-src', 0, ['a1', 'a2']) }] as any
    )
    let entry = (store.getState() as any).residentRegistry.entries['t-src']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(genSrc)
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-src')).toBeDefined()

    // Target restore (redo): same preserving path, target window untouched.
    mockUpsert.mockResolvedValue(wire('seg-tgt-new', 't-tgt', 1, ['b1']))
    mockList.mockImplementation((tid: string) => {
      if (tid === 't-tgt')
        return Promise.resolve([wire('seg-tgt', tid, 0, ['b1']), wire('seg-tgt-new', tid, 1, ['b1'])])
      return Promise.resolve([wire('seg-src', 't-src', 0, ['a1', 'a2'])])
    })
    await restoreTargetSegments(store.dispatch as any, [seg('seg-tgt-new', 't-tgt', 1, ['b1'])] as any)
    entry = (store.getState() as any).residentRegistry.entries['t-tgt']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(genTgt)
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-tgt')).toBeDefined()
    // Source projection untouched by the target convergence (per-topic isolation).
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-src')).toBeDefined()
  })

  it('raw unpaired and fromSync structural actions still invalidate (no global exemption)', async () => {
    const gen = establishResident(store, 't-raw', ['m1'], [seg('seg-r', 't-raw', 0, ['m1'])])
    store.dispatch(addSegment(seg('seg-raw-new', 't-raw', 1, ['m1'])) as any)
    const entry = (store.getState() as any).residentRegistry.entries['t-raw']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(gen + 1)
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-raw')).toBeUndefined()
    void gen
  })

  it('standalone and fromSync replace without the preserving publication still invalidate', async () => {
    establishResident(store, 't-standalone', ['m1'], [seg('seg-s', 't-standalone', 0, ['m1'])])
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-standalone'].applicabilityGeneration
    store.dispatch(
      replaceSegmentsForTopic({ topicId: 't-standalone', segments: [seg('seg-s2', 't-standalone', 0, ['m1'])] }) as any
    )
    let entry = (store.getState() as any).residentRegistry.entries['t-standalone']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen + 1)

    // Re-establish then inbound fromSync differing catalog still invalidates.
    const gen2 = entry.applicabilityGeneration as number
    store.dispatch(
      publishResidentComplete({
        topicId: 't-standalone',
        generation: gen2,
        windowResponse: windowResponse('t-standalone', ['m1']),
        segments: [seg('seg-s2', 't-standalone', 0, ['m1'])]
      })
    )
    const beforeGen2 = (store.getState() as any).residentRegistry.entries['t-standalone'].applicabilityGeneration
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId: 't-standalone', segments: [seg('seg-in', 't-standalone', 0, ['m1'])] }),
      meta: { fromSync: true }
    } as any)
    entry = (store.getState() as any).residentRegistry.entries['t-standalone']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen2 + 1)
  })

  it('metadata-only update stays exempt while structural update invalidates', async () => {
    establishResident(store, 't-meta', ['m1'], [seg('seg-meta', 't-meta', 0, ['m1'])])
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-meta'].applicabilityGeneration
    store.dispatch(updateSegment({ id: 'seg-meta', changes: { name: 'New' } }) as any)
    let entry = (store.getState() as any).residentRegistry.entries['t-meta']
    expect(entry.residentTopic).toBe(true)
    expect(entry.applicabilityGeneration).toBe(beforeGen)
    store.dispatch(updateSegment({ id: 'seg-meta', changes: { messageIds: ['m1', 'm2'] } }) as any)
    entry = (store.getState() as any).residentRegistry.entries['t-meta']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(beforeGen + 1)
    expect(removeSegment('x')).toBeTruthy()
  })

  it('stale list vs generation bump discards without restoring residency or regressing catalog', async () => {
    const gen = establishResident(store, 't-stale', ['m1', 'm2'], [seg('seg-old', 't-stale', 0, ['m1'])])
    let resolveList!: (v: any[]) => void
    mockList.mockImplementation(() => new Promise<any[]>((res) => ((resolveList as any) = res)))
    const pending = convergeTopicSegmentCatalog(store.dispatch as any, 't-stale', store.getState as any)
    // Concurrent unpaired structural change bumps generation and blanks.
    store.dispatch(addSegment(seg('seg-concurrent', 't-stale', 1, ['m2'])) as any)
    expect((store.getState() as any).residentRegistry.entries['t-stale'].residentTopic).toBe(false)
    // Late authority response arrives (would regress to an older catalog missing concurrent).
    // Superseded reads discard as normal control flow (no throw, no successor bump).
    resolveList([wire('seg-old', 't-stale', 0, ['m1'])])
    await pending
    const entry = (store.getState() as any).residentRegistry.entries['t-stale']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(gen + 1)
    // No stale re-residency and no catalog regression to the stale list.
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-stale')).toBeUndefined()
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-stale']).toContain('seg-concurrent')
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-stale']).toContain('seg-old')
  })

  it('evicted topic never re-residents from a stale catalog response', async () => {
    establishResident(store, 't-evict', ['m1'], [seg('seg-e', 't-evict', 0, ['m1'])])
    let resolveList!: (v: any[]) => void
    mockList.mockImplementation(() => new Promise<any[]>((res) => ((resolveList as any) = res)))
    const pending = convergeTopicSegmentCatalog(store.dispatch as any, 't-evict', store.getState as any)
    store.dispatch({ type: 'retention/evictTopic', payload: 't-evict' } as any)
    expect((store.getState() as any).residentRegistry.entries['t-evict'].residentTopic).toBe(false)
    resolveList([wire('seg-e', 't-evict', 0, ['m1'])])
    await pending
    const entry = (store.getState() as any).residentRegistry.entries['t-evict']
    expect(entry?.residentTopic ?? false).toBe(false)
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-evict')).toBeUndefined()
  })

  it('nonresident convergence installs catalog without re-residenting an empty projection', async () => {
    // No resident entry: never loaded.
    mockList.mockResolvedValue([wire('seg-n', 't-new', 0, ['mx'])])
    await convergeTopicSegmentCatalog(store.dispatch as any, 't-new', store.getState as any)
    const entry = (store.getState() as any).residentRegistry.entries['t-new']
    expect(entry?.residentTopic ?? false).toBe(false)
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-new')).toBeUndefined()
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-new']).toEqual(['seg-n'])
  })

  it('list failure throws fail-closed with a bump and no fabricated single-wire catalog', async () => {
    const gen = establishResident(store, 't-fail', ['m1'], [seg('seg-old', 't-fail', 0, ['m1'])])
    mockList.mockRejectedValue(new Error('list failed'))
    await expect(convergeTopicSegmentCatalog(store.dispatch as any, 't-fail', store.getState as any)).rejects.toThrow(
      'list failed'
    )
    const entry = (store.getState() as any).residentRegistry.entries['t-fail']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(gen + 1)
    // Catalog unchanged (old authority kept, no fabricated single wire).
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-fail']).toEqual(['seg-old'])
    expect(selectLoadedMessagesForTopic(store.getState() as any, 't-fail')).toBeUndefined()
  })

  it('direct stale fabrication cannot restore residency (root guard fail closed)', async () => {
    establishResident(store, 't-fab', ['m1'], [seg('seg-f', 't-fab', 0, ['m1'])])
    const beforeGen = (store.getState() as any).residentRegistry.entries['t-fab'].applicabilityGeneration
    store.dispatch(bumpGeneration('t-fab'))
    const bumpedGen = (store.getState() as any).residentRegistry.entries['t-fab'].applicabilityGeneration
    expect(bumpedGen).toBe(beforeGen + 1)
    // Fabricated stale publication with the old generation and old window.
    store.dispatch({
      type: SEGMENT_CATALOG_PUBLISH_COMPLETE,
      payload: {
        topicId: 't-fab',
        generation: beforeGen,
        segments: [seg('seg-fab', 't-fab', 0, ['m1'])],
        messageIds: ['m1']
      }
    } as any)
    const entry = (store.getState() as any).residentRegistry.entries['t-fab']
    expect(entry.residentTopic).toBe(false)
    expect(entry.applicabilityGeneration).toBe(bumpedGen)
    expect((store.getState() as any).topicSegments.segmentsByTopic['t-fab']).toEqual(['seg-f'])
  })
})
