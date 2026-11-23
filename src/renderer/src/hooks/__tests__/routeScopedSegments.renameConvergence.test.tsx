/**
 * Metadata-only rename converges the route-scoped accepted projection on the
 * same route (drawer staleness triage, slice-2 defect-3: the projection was
 * proven correct; the observed staleness was a probe overlay-toggle artifact).
 */
import { configureStore } from '@reduxjs/toolkit'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchWindow } = vi.hoisted(() => ({ mockFetchWindow: vi.fn() }))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: { fetchMessagesWindow: (...args: unknown[]) => mockFetchWindow(...args) }
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import { rootReducer } from '@renderer/store'

import { useRouteScopedSegments } from '../useRouteScopedSegments'

type Any = any

function seg(id: string, name: string) {
  return {
    id,
    topicId: 'T',
    name,
    messageIds: ['m5', 'm6'],
    color: `color-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder: 0,
    firstMessageId: 'm5',
    lastMessageId: 'm6',
    messageCount: 2
  }
}

function structureWithName(topicId: string, segId: string, name: string) {
  const catalog = [
    {
      id: segId,
      topicId,
      name,
      messageIds: ['m5', 'm6'],
      headerMessageId: 'm5',
      ownerTopicId: topicId,
      ownerBranchId: null,
      createdAt: null,
      updatedAt: null,
      sortOrder: 0,
      firstMessageId: 'm5',
      lastMessageId: 'm6',
      messageCount: 2
    }
  ]
  const qualifications = [
    {
      segmentId: segId,
      headerInRoute: true,
      headerOwnedByRoute: true,
      routeMemberMessageIds: ['m5', 'm6'],
      turnCount: 1
    }
  ]
  return {
    messages: [],
    blocks: [],
    window: { kind: 'latest' },
    mutableMessageIds: [],
    reference: null,
    structure: { catalog, route: { topicId, branchId: null, qualifications } }
  } as Any
}

const wrapperFor =
  (store: Any) =>
  ({ children }: { children: React.ReactNode }) =>
    createElement(Provider, { store, children } as Any)

describe('route-scoped rename convergence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts a metadata-only rename on the same route', async () => {
    const store = configureStore({ reducer: rootReducer as Any })
    store.dispatch({ type: 'topicBranch/activeBranchSet', payload: { topicId: 'T', branchId: null } })
    store.dispatch({
      type: 'topicSegments/replaceSegmentsForTopic',
      payload: { topicId: 'T', segments: [seg('s1', 'Old')] }
    })
    mockFetchWindow.mockResolvedValue(structureWithName('T', 's1', 'Old'))

    const { result } = renderHook(() => useRouteScopedSegments('T'), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.name)).toEqual(['Old']), { timeout: 5000 })

    mockFetchWindow.mockResolvedValue(structureWithName('T', 's1', 'New'))
    act(() => {
      store.dispatch({
        type: 'topicSegments/replaceSegmentsForTopic',
        payload: { topicId: 'T', segments: [seg('s1', 'New')] }
      })
    })

    await waitFor(() => expect(result.current.segments.map((s) => s.name)).toEqual(['New']), { timeout: 5000 })
  })
})
