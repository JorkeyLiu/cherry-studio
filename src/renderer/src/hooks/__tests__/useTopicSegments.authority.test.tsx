import { configureStore } from '@reduxjs/toolkit'
import { renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTopicSegments } from '../useTopicSegments'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: vi.fn(),
    updateSegmentMetadata: vi.fn(),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: vi.fn(),
    listSegments: vi.fn()
  }
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import { dbService } from '@renderer/services/db'
import messagesReducer, { newMessagesActions } from '@renderer/store/newMessage'
import topicSegmentReducer from '@renderer/store/topicSegment'

function makeSeg(id: string, sortOrder: number, messageIds: string[], first: string | null, last: string | null) {
  return {
    id,
    topicId: 't1',
    name: id,
    messageIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: first,
    lastMessageId: last,
    messageCount: messageIds.length
  }
}

function setupStore() {
  const store = configureStore({
    reducer: { topicSegments: topicSegmentReducer, messages: messagesReducer as any }
  })
  // Authority order: seg-b sortOrder 0, seg-a sortOrder 1. Loaded window only
  // contains ['m-window']; seg-b's authority first is outside the window.
  // Catalog order must still be seg-b, seg-a (authority), not window order.
  store.dispatch({
    type: 'topicSegments/replaceSegmentsForTopic',
    payload: {
      topicId: 't1',
      segments: [
        makeSeg('seg-b', 0, ['m-outside', 'm-window'], 'm-outside', 'm-window'),
        makeSeg('seg-a', 1, ['m-window-2'], 'm-window-2', 'm-window-2')
      ]
    }
  } as any)
  store.dispatch(
    newMessagesActions.messagesReceived({
      topicId: 't1',
      messages: [{ id: 'm-window' }, { id: 'm-window-2' }] as any
    })
  )
  return store
}

describe('useTopicSegments authority catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('orders by authority sortOrder then id, unaffected by windowed messageIds', () => {
    const store = setupStore()
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments('t1'), { wrapper })
    expect(result.current.orderedSegmentsForTopic.map((s) => s.id)).toEqual(['seg-b', 'seg-a'])
  })

  it('exposes authority first/last range and boundary markers, not array endpoints', () => {
    const store = setupStore()
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments('t1'), { wrapper })
    expect(result.current.getSegmentMessageRange('seg-b')).toEqual({
      firstMessageId: 'm-outside',
      lastMessageId: 'm-window'
    })
    // Outside-window first is still the boundary marker.
    expect(result.current.isMessageFirstInSegment('m-outside')?.id).toBe('seg-b')
    expect(result.current.isMessageLastInSegment('m-window')?.id).toBe('seg-b')
    // Membership includes still uses full messageIds.
    expect(result.current.isMessageInSegment('m-outside')?.id).toBe('seg-b')
    expect(result.current.isMessageInSegment('m-window-2')?.id).toBe('seg-a')
  })

  it('wire→segment mapping omits the color own property when the wire has no color', async () => {
    const wire = {
      id: 'seg-no-color',
      topicId: 't1',
      name: 'NoColor',
      messageIds: ['m-window'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-window',
      lastMessageId: 'm-window',
      messageCount: 1
    }
    ;(dbService.upsertSegment as any).mockResolvedValue(wire)
    ;(dbService.listSegments as any).mockResolvedValue([wire])
    const store = setupStore()
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments('t1'), { wrapper })
    await result.current.createSegment('t1', 'NoColor', ['m-window'])
    const entity = (store.getState() as any).topicSegments.segments.entities['seg-no-color']
    expect(entity).toBeTruthy()
    expect('color' in entity).toBe(false)
    expect(JSON.parse(JSON.stringify(entity))).toEqual(entity)
  })

  it('reverse-position create converges shifted sibling via exactly one list+replace', async () => {
    // Warm Renderer holds stale late:0; Main shifts it to 1 when early is inserted.
    const store = configureStore({
      reducer: { topicSegments: topicSegmentReducer, messages: messagesReducer as any }
    })
    const lateStale = makeSeg('seg-late', 0, ['m-late'], 'm-late', 'm-late')
    store.dispatch({
      type: 'topicSegments/replaceSegmentsForTopic',
      payload: { topicId: 't1', segments: [lateStale] }
    } as any)

    let capturedId = ''
    ;(dbService.upsertSegment as any).mockImplementation(
      (id: string, topicId: string, name: string, messageIds: string[], color: string) =>
        Promise.resolve({
          id,
          topicId,
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
    )
    ;(dbService.listSegments as any).mockImplementation((topicId: string) => {
      const upsertCall = (dbService.upsertSegment as any).mock.calls[0]
      capturedId = upsertCall[0]
      return Promise.resolve([
        {
          id: capturedId,
          topicId,
          name: 'Early',
          messageIds: ['m-early'],
          color: `color-${capturedId}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          sortOrder: 0,
          firstMessageId: 'm-early',
          lastMessageId: 'm-early',
          messageCount: 1
        },
        {
          id: 'seg-late',
          topicId,
          name: 'seg-late',
          messageIds: ['m-late'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          sortOrder: 1,
          firstMessageId: 'm-late',
          lastMessageId: 'm-late',
          messageCount: 1
        }
      ])
    })

    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments('t1'), { wrapper })
    const created = await result.current.createSegment('t1', 'Early', ['m-early'])

    expect(dbService.upsertSegment).toHaveBeenCalledTimes(1)
    expect(dbService.listSegments).toHaveBeenCalledTimes(1)
    expect(dbService.listSegments).toHaveBeenCalledWith('t1')
    // Returned wire is the new segment; catalog holds the shifted sibling.
    expect(created.id).toBe(capturedId)
    const state = (store.getState() as any).topicSegments
    expect(state.segments.entities['seg-late'].sortOrder).toBe(1)
    expect(state.segments.entities[capturedId].sortOrder).toBe(0)
    expect(state.segmentsByTopic['t1']).toEqual([capturedId, 'seg-late'])
  })

  it('list failure fallback keeps the new wire visible without fabricating siblings', async () => {
    const store = configureStore({
      reducer: { topicSegments: topicSegmentReducer, messages: messagesReducer as any }
    })
    const lateStale = makeSeg('seg-late', 0, ['m-late'], 'm-late', 'm-late')
    store.dispatch({
      type: 'topicSegments/replaceSegmentsForTopic',
      payload: { topicId: 't1', segments: [lateStale] }
    } as any)

    const newWire = {
      id: 'seg-new',
      topicId: 't1',
      name: 'New',
      messageIds: ['m-new'],
      color: 'color-seg-new',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-new',
      lastMessageId: 'm-new',
      messageCount: 1
    }
    ;(dbService.upsertSegment as any).mockImplementation((id: string) => Promise.resolve({ ...newWire, id }))
    ;(dbService.listSegments as any).mockRejectedValue(new Error('list failed'))

    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
    const { result } = renderHook(() => useTopicSegments('t1'), { wrapper })
    const created = await result.current.createSegment('t1', 'New', ['m-new'])

    expect(dbService.upsertSegment).toHaveBeenCalledTimes(1)
    expect(dbService.listSegments).toHaveBeenCalledTimes(1)
    // Main mutation succeeded so the new wire stays visible; stale sibling is
    // kept as-is, never fabricated or rolled back.
    const state = (store.getState() as any).topicSegments
    expect(created.messageIds).toEqual(['m-new'])
    expect(state.segments.entities[created.id]).toBeTruthy()
    expect(state.segments.entities[created.id].messageIds).toEqual(['m-new'])
    expect(state.segments.entities['seg-late'].sortOrder).toBe(0)
  })
})
