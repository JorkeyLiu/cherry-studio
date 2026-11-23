import type { TopicSegment } from '@renderer/types/topicSegment'
import { describe, expect, it } from 'vitest'

import {
  committedChromeRouteKey,
  selectOrderedSegmentsForTopic,
  type TopicSegmentCatalogState
} from '../routeCommittedChrome'

function seg(id: string, sortOrder: number, messageIds: string[], extra: Partial<TopicSegment> = {}): TopicSegment {
  return {
    id,
    topicId: 'T',
    name: id,
    messageIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length,
    ...extra
  }
}

function catalogState(topicId: string, segments: TopicSegment[]): TopicSegmentCatalogState {
  const entities: Record<string, TopicSegment | undefined> = {}
  for (const s of segments) entities[s.id] = s
  return { topicSegments: { segments: { entities }, segmentsByTopic: { [topicId]: segments.map((s) => s.id) } } }
}

describe('committedChromeRouteKey', () => {
  it('keys null branch as main', () => {
    expect(committedChromeRouteKey('T', null)).toBe('T::main')
    expect(committedChromeRouteKey('T', 'b')).toBe('T::b')
  })
})

describe('selectOrderedSegmentsForTopic', () => {
  it('orders by Main sortOrder ascending with a stable id tie-break', () => {
    const state = catalogState('T', [seg('s-b', 1, ['m1']), seg('s-a', 0, ['m2']), seg('s-c', 0, ['m3'])])
    expect(selectOrderedSegmentsForTopic(state, 'T').map((s) => s.id)).toEqual(['s-a', 's-c', 's-b'])
  })

  it('skips catalog ids without an entity and unknown topics', () => {
    const state = catalogState('T', [seg('s-a', 0, ['m1'])])
    state.topicSegments.segmentsByTopic['T'] = ['s-a', 's-gone']
    expect(selectOrderedSegmentsForTopic(state, 'T').map((s) => s.id)).toEqual(['s-a'])
    expect(selectOrderedSegmentsForTopic(state, 'nope')).toEqual([])
  })
})
