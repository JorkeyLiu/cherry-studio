/**
 * Actual `useTopicSegments` mounted-hook catalog preservation.
 *
 * Real rootReducer store + actual hook callbacks, DB mocked only. Proves the
 * stable-success path (create/dissolve/membership/rename) preserves the
 * resident message projection with no intermediate undefined:
 * - `selectLoadedMessagesForTopic` stays defined with the exact window IDs
 * - resident generation unchanged, still resident
 * - full authority catalog installed (no transient blank)
 *
 * The rename case exercises the actual `updateSegmentName` callback (prior
 * sequence-only coverage reproduced the converge without the hook).
 */
import { configureStore } from '@reduxjs/toolkit'
import { renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUpsert, mockReplace, mockDelete, mockList, mockUpdateMeta } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockReplace: vi.fn(),
  mockDelete: vi.fn(),
  mockList: vi.fn(),
  mockUpdateMeta: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: mockUpsert,
    replaceSegmentMembership: mockReplace,
    deleteSegment: mockDelete,
    listSegments: mockList,
    updateSegmentMetadata: mockUpdateMeta
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import { dbService } from '@renderer/services/db'
import { rootReducer } from '@renderer/store'
import { newMessagesActions, selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { resetCatalogRequestSeqForTests } from '@renderer/utils/topicSegmentCatalog'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'

import { useTopicSegments } from '../useTopicSegments'

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

function trackLoaded(
  store: ReturnType<typeof configureStore>,
  topicId: string
): { seen: Array<unknown>; stop: () => void } {
  const seen: Array<unknown> = []
  const unsub = store.subscribe(() => {
    seen.push(selectLoadedMessagesForTopic(store.getState() as any, topicId) as any)
  })
  return { seen, stop: unsub }
}

function expectStableProjection(
  store: ReturnType<typeof configureStore>,
  topicId: string,
  gen: number,
  ids: string[],
  seen: Array<unknown>
) {
  const entry = (store.getState() as any).residentRegistry.entries[topicId]
  expect(entry.residentTopic).toBe(true)
  expect(entry.applicabilityGeneration).toBe(gen)
  const msgs = selectLoadedMessagesForTopic(store.getState() as any, topicId) as any
  expect(msgs).toBeDefined()
  expect([...msgs].map((m: any) => m.id)).toEqual(ids)
  expect(seen.length).toBeGreaterThan(0)
  for (const proj of seen) {
    expect(proj).toBeDefined()
    expect([...(proj as any)].map((m: any) => m.id)).toEqual(ids)
  }
}

describe('useTopicSegments mounted-hook catalog preservation — real root store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCatalogRequestSeqForTests()
  })

  it('actual createSegment preserves the loaded projection with no intermediate undefined', async () => {
    const topicId = 't-hook-create'
    const store = configureStore({ reducer: rootReducer })
    const gen = establishResident(store, topicId, ['m1', 'm2', 'm3'], [seg('seg-old', topicId, 0, ['m1'])])
    let createdId = ''
    ;(dbService.upsertSegment as any).mockImplementation(
      (id: string, tid: string, name: string, messageIds: string[], color: string) => {
        createdId = id
        return Promise.resolve({
          id,
          topicId: tid,
          name,
          messageIds: [...messageIds],
          color,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          sortOrder: 0,
          firstMessageId: messageIds[0] ?? null,
          lastMessageId: messageIds[messageIds.length - 1] ?? null,
          messageCount: messageIds.length
        })
      }
    )
    ;(dbService.listSegments as any).mockImplementation((tid: string) =>
      Promise.resolve([seg(createdId, tid, 0, ['m2', 'm3'], 'New'), seg('seg-old', tid, 1, ['m1'])])
    )
    const { seen, stop } = trackLoaded(store, topicId)
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments(topicId), { wrapper })
    const created = await result.current.createSegment(topicId, 'New', ['m2', 'm3'])
    stop()
    expect(created.id).toBe(createdId)
    expectStableProjection(store, topicId, gen, ['m1', 'm2', 'm3'], seen)
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual([createdId, 'seg-old'])
  })

  it('actual deleteSegment (dissolve) preserves the loaded projection', async () => {
    const topicId = 't-hook-dissolve'
    const store = configureStore({ reducer: rootReducer })
    const gen = establishResident(
      store,
      topicId,
      ['m1', 'm2'],
      [seg('seg-a', topicId, 0, ['m1']), seg('seg-b', topicId, 1, ['m2'])]
    )
    ;(dbService.deleteSegment as any).mockResolvedValue(undefined)
    ;(dbService.listSegments as any).mockResolvedValue([seg('seg-b', topicId, 0, ['m2'])])
    const { seen, stop } = trackLoaded(store, topicId)
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments(topicId), { wrapper })
    await result.current.deleteSegment('seg-a')
    stop()
    expectStableProjection(store, topicId, gen, ['m1', 'm2'], seen)
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-b'])
    expect((store.getState() as any).topicSegments.segments.entities['seg-a']).toBeUndefined()
  })

  it('actual updateSegmentMessageIds preserves the loaded projection and installs boundaries', async () => {
    const topicId = 't-hook-member'
    const store = configureStore({ reducer: rootReducer })
    const gen = establishResident(store, topicId, ['m1', 'm2', 'm3'], [seg('seg-m', topicId, 0, ['m1', 'm2'])])
    ;(dbService.replaceSegmentMembership as any).mockResolvedValue(seg('seg-m', topicId, 0, ['m1', 'm3']))
    ;(dbService.listSegments as any).mockResolvedValue([seg('seg-m', topicId, 0, ['m1', 'm3'])])
    const { seen, stop } = trackLoaded(store, topicId)
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments(topicId), { wrapper })
    await result.current.updateSegmentMessageIds('seg-m', ['m1', 'm3'])
    stop()
    expectStableProjection(store, topicId, gen, ['m1', 'm2', 'm3'], seen)
    const updated = (store.getState() as any).topicSegments.segments.entities['seg-m']
    expect(updated.messageIds).toEqual(['m1', 'm3'])
    expect(updated.firstMessageId).toBe('m1')
    expect(updated.lastMessageId).toBe('m3')
  })

  it('actual updateSegmentName (rename) preserves the loaded projection with no transient blank', async () => {
    const topicId = 't-hook-rename'
    const store = configureStore({ reducer: rootReducer })
    const gen = establishResident(store, topicId, ['m1', 'm2'], [seg('seg-r', topicId, 0, ['m1'])])
    ;(dbService.updateSegmentMetadata as any).mockResolvedValue(seg('seg-r', topicId, 0, ['m1'], 'Renamed'))
    ;(dbService.listSegments as any).mockResolvedValue([seg('seg-r', topicId, 0, ['m1'], 'Renamed')])
    const { seen, stop } = trackLoaded(store, topicId)
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments(topicId), { wrapper })
    await result.current.updateSegmentName('seg-r', 'Renamed')
    stop()
    expectStableProjection(store, topicId, gen, ['m1', 'm2'], seen)
    expect((store.getState() as any).topicSegments.segments.entities['seg-r'].name).toBe('Renamed')
  })
})
