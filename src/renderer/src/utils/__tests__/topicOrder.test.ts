/**
 * Topic ordering helpers — the one-shot "by creation time" order, the
 * authoritative latest-message-instant order ("by update time"), the two
 * continuous single-topic moves, and the bounded filtered-drag merge that must
 * never drop hidden topics.
 */
import type { TopicOrderMode } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TOPIC_ORDER_MODE,
  hasExplicitTopicOrderMode,
  mergeVisibleTopicReorder,
  moveTopicToOrdinaryHead,
  placeTopicBySortKey,
  resolveTopicOrderMode,
  sortTopicsByCreatedAtDesc,
  sortTopicsByMessageTimeDesc,
  topicSortKeyMs
} from '../topicOrder'

type T = { id: string; name: string; createdAt?: string; pinned?: boolean }

const topic = (id: string, createdAt: string, pinned = false): T => ({ id, name: id, createdAt, pinned })

const ids = (topics: T[]) => topics.map((item) => item.id)

describe('resolveTopicOrderMode', () => {
  it('defaults topics with no explicit choice to "by update time"', () => {
    expect(DEFAULT_TOPIC_ORDER_MODE).toBe<TopicOrderMode>('updated')
    expect(resolveTopicOrderMode(undefined)).toBe<TopicOrderMode>('updated')
    expect(resolveTopicOrderMode(null)).toBe<TopicOrderMode>('updated')
    expect(resolveTopicOrderMode('whatever')).toBe<TopicOrderMode>('updated')
  })

  it('honors every explicit choice', () => {
    expect(resolveTopicOrderMode('manual')).toBe<TopicOrderMode>('manual')
    expect(resolveTopicOrderMode('updated')).toBe<TopicOrderMode>('updated')
  })
})

describe('hasExplicitTopicOrderMode', () => {
  it('separates a persisted choice from the never-decided state', () => {
    expect(hasExplicitTopicOrderMode('manual')).toBe(true)
    expect(hasExplicitTopicOrderMode('updated')).toBe(true)
    expect(hasExplicitTopicOrderMode(undefined)).toBe(false)
    expect(hasExplicitTopicOrderMode(null)).toBe(false)
    expect(hasExplicitTopicOrderMode('')).toBe(false)
    expect(hasExplicitTopicOrderMode('whatever')).toBe(false)
  })
})

describe('topicSortKeyMs', () => {
  it('prefers the authoritative latest message instant over the topic createdAt', () => {
    expect(topicSortKeyMs('2026-05-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(
      Date.parse('2026-05-01T00:00:00.000Z')
    )
  })

  it('falls back to the topic createdAt when the message instant is missing, empty or unusable', () => {
    const created = Date.parse('2026-01-01T00:00:00.000Z')
    expect(topicSortKeyMs(null, '2026-01-01T00:00:00.000Z')).toBe(created)
    expect(topicSortKeyMs(undefined, '2026-01-01T00:00:00.000Z')).toBe(created)
    expect(topicSortKeyMs('', '2026-01-01T00:00:00.000Z')).toBe(created)
    expect(topicSortKeyMs('not-a-date', '2026-01-01T00:00:00.000Z')).toBe(created)
  })

  it('reports no usable instant instead of fabricating one', () => {
    expect(topicSortKeyMs(null, null)).toBeNull()
    expect(topicSortKeyMs(undefined, '')).toBeNull()
    expect(topicSortKeyMs('garbage', 'garbage')).toBeNull()
  })
})

describe('sortTopicsByCreatedAtDesc', () => {
  it('orders non-pinned topics newest-created first', () => {
    const input = [
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('c', '2026-03-01T00:00:00.000Z'),
      topic('b', '2026-02-01T00:00:00.000Z')
    ]
    expect(ids(sortTopicsByCreatedAtDesc(input))).toEqual(['c', 'b', 'a'])
    // Source array is never mutated.
    expect(ids(input)).toEqual(['a', 'c', 'b'])
  })

  it('keeps equal createdAt ties in their source order', () => {
    const same = '2026-01-01T00:00:00.000Z'
    const input = [topic('a', same), topic('b', same), topic('c', '2026-02-01T00:00:00.000Z')]
    expect(ids(sortTopicsByCreatedAtDesc(input))).toEqual(['c', 'a', 'b'])
  })

  it('keeps pinned topics first with their own relative order', () => {
    const input = [
      topic('p2', '2025-01-01T00:00:00.000Z', true),
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('p1', '2025-06-01T00:00:00.000Z', true),
      topic('b', '2026-02-01T00:00:00.000Z')
    ]
    expect(ids(sortTopicsByCreatedAtDesc(input))).toEqual(['p2', 'p1', 'b', 'a'])
  })

  it('sorts topics with no usable createdAt last without reordering them', () => {
    const input = [
      topic('bad', 'not-a-date'),
      topic('b', '2026-02-01T00:00:00.000Z'),
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('missing', '')
    ]
    expect(ids(sortTopicsByCreatedAtDesc(input))).toEqual(['b', 'a', 'bad', 'missing'])
  })
})

describe('sortTopicsByMessageTimeDesc', () => {
  const keys: Record<string, number | null> = {
    a: Date.parse('2026-01-03T00:00:00.000Z'),
    b: Date.parse('2026-01-01T00:00:00.000Z'),
    c: Date.parse('2026-01-02T00:00:00.000Z')
  }
  const keyOf = (entry: T) => keys[entry.id] ?? null

  it('orders non-pinned topics by the authoritative instant, newest first', () => {
    const input = [
      topic('b', '2026-01-01T00:00:00.000Z'),
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('c', '2026-01-02T00:00:00.000Z')
    ]
    expect(ids(sortTopicsByMessageTimeDesc(input, keyOf))).toEqual(['a', 'c', 'b'])
    expect(ids(input)).toEqual(['b', 'a', 'c'])
  })

  it('keeps equal instants in their current relative order', () => {
    const same = Date.parse('2026-01-05T00:00:00.000Z')
    const tied = [topic('x', '2026-01-01T00:00:00.000Z'), topic('y', '2026-01-02T00:00:00.000Z')]
    expect(ids(sortTopicsByMessageTimeDesc(tied, () => same))).toEqual(['x', 'y'])
  })

  it('keeps pinned topics first with their own relative order', () => {
    const input = [
      topic('p1', '2025-01-01T00:00:00.000Z', true),
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('p2', '2025-02-01T00:00:00.000Z', true),
      topic('b', '2026-01-02T00:00:00.000Z')
    ]
    const keysWithPinned: Record<string, number | null> = {
      ...keys,
      p1: Date.parse('2099-01-01T00:00:00.000Z'),
      p2: null,
      a: Date.parse('2026-01-02T00:00:00.000Z'),
      b: Date.parse('2026-01-01T00:00:00.000Z')
    }
    expect(ids(sortTopicsByMessageTimeDesc(input, (entry) => keysWithPinned[entry.id] ?? null))).toEqual([
      'p1',
      'p2',
      'a',
      'b'
    ])
  })

  it('places topics without a usable instant last, in their current order', () => {
    const input = [
      topic('unknown', ''),
      topic('b', '2026-01-02T00:00:00.000Z'),
      topic('a', '2026-01-03T00:00:00.000Z'),
      topic('also-unknown', '')
    ]
    const partial: Record<string, number | null> = {
      a: Date.parse('2026-01-03T00:00:00.000Z'),
      b: Date.parse('2026-01-02T00:00:00.000Z')
    }
    expect(ids(sortTopicsByMessageTimeDesc(input, (entry) => partial[entry.id] ?? null))).toEqual([
      'a',
      'b',
      'unknown',
      'also-unknown'
    ])
  })
})

describe('moveTopicToOrdinaryHead', () => {
  const p = topic('p', '2025-01-01T00:00:00.000Z', true)
  const a = topic('a', '2026-01-01T00:00:00.000Z')
  const b = topic('b', '2026-01-02T00:00:00.000Z')
  const c = topic('c', '2026-01-03T00:00:00.000Z')

  it('moves exactly the advanced non-pinned topic to the ordinary head', () => {
    expect(ids(moveTopicToOrdinaryHead([p, a, b, c], 'c'))).toEqual(['p', 'c', 'a', 'b'])
  })

  it('leaves every other topic in place', () => {
    expect(ids(moveTopicToOrdinaryHead([p, a, b, c], 'b'))).toEqual(['p', 'b', 'a', 'c'])
  })

  it('is a no-op (same reference) when already at the ordinary head, pinned or unknown', () => {
    const same = [p, a, b, c]
    expect(moveTopicToOrdinaryHead(same, 'a')).toBe(same)
    expect(moveTopicToOrdinaryHead(same, 'p')).toBe(same)
    expect(moveTopicToOrdinaryHead(same, 'nope')).toBe(same)
  })

  it('never touches the pinned group', () => {
    expect(ids(moveTopicToOrdinaryHead([p, a, b, c], 'c')).slice(0, 1)).toEqual(['p'])
  })
})

describe('placeTopicBySortKey', () => {
  const p = topic('p', '2025-01-01T00:00:00.000Z', true)
  const a = topic('a', '2026-01-01T00:00:00.000Z')
  const b = topic('b', '2026-01-02T00:00:00.000Z')
  const c = topic('c', '2026-01-03T00:00:00.000Z')
  const keys: Record<string, number | null> = {
    p: null,
    a: Date.parse('2026-01-01T00:00:00.000Z'),
    b: Date.parse('2026-01-03T00:00:00.000Z'),
    c: Date.parse('2026-01-02T00:00:00.000Z')
  }
  const keyOf = (entry: T) => keys[entry.id] ?? null

  it('places a topic whose instant regressed relative to the others, keeping their order', () => {
    // "c" lost its newest message: it now belongs between nothing and "a"
    // would stay, i.e. it drops below both a and b.
    const input = [p, c, b, a]
    const lowered = Date.parse('2025-12-31T00:00:00.000Z')
    expect(ids(placeTopicBySortKey(input, 'c', lowered, keyOf))).toEqual(['p', 'b', 'a', 'c'])
  })

  it('places a topic according to its new instant between the other topics', () => {
    const input = [p, b, a, c]
    // The new instant sits below "b" (2026-01-03) and above "a" (2026-01-01).
    expect(ids(placeTopicBySortKey(input, 'c', Date.parse('2026-01-02T00:00:00.000Z'), keyOf))).toEqual([
      'p',
      'b',
      'c',
      'a'
    ])
  })

  it('is a no-op (same reference) when the resulting order is unchanged', () => {
    // Already in the position its key implies: last among the others.
    const input = [p, b, c, a]
    expect(placeTopicBySortKey(input, 'a', Date.parse('2026-01-01T00:00:00.000Z'), keyOf)).toBe(input)
  })

  it('sorts a topic with no usable instant last', () => {
    const input = [p, c, b, a]
    expect(ids(placeTopicBySortKey(input, 'c', null, keyOf))).toEqual(['p', 'b', 'a', 'c'])
  })

  it('never moves a pinned or unknown topic', () => {
    const input = [p, c, b, a]
    expect(placeTopicBySortKey(input, 'p', null, keyOf)).toBe(input)
    expect(placeTopicBySortKey(input, 'nope', null, keyOf)).toBe(input)
  })
})

describe('mergeVisibleTopicReorder', () => {
  const p1 = topic('p1', '2025-01-01T00:00:00.000Z', true)
  const p2 = topic('p2', '2025-01-02T00:00:00.000Z', true)
  const alpha = topic('alpha', '2026-01-01T00:00:00.000Z')
  const beta = topic('beta', '2026-01-02T00:00:00.000Z')
  const gamma = topic('gamma', '2026-01-03T00:00:00.000Z')
  const full = [p1, p2, alpha, beta, gamma]

  it('keeps every hidden topic when only a searched subset is dragged', () => {
    // Search shows [alpha, beta]; the user drags beta above alpha.
    const visible = [alpha, beta]
    const reordered = [beta, alpha]
    expect(ids(mergeVisibleTopicReorder(full, visible, reordered))).toEqual(['p1', 'p2', 'beta', 'alpha', 'gamma'])
  })

  it('preserves hidden topics around the visible slots and never loses one', () => {
    const visible = [alpha, gamma]
    const reordered = [gamma, alpha]
    const merged = mergeVisibleTopicReorder(full, visible, reordered)
    expect(merged).toHaveLength(full.length)
    expect(ids(merged)).toEqual(['p1', 'p2', 'gamma', 'beta', 'alpha'])
    expect(new Set(ids(merged))).toEqual(new Set(ids(full)))
  })

  it('rejects a non-permutation instead of dropping or duplicating topics', () => {
    expect(mergeVisibleTopicReorder(full, [alpha, beta], [beta])).toBe(full)
    expect(mergeVisibleTopicReorder(full, [alpha, beta], [alpha, beta, gamma])).toBe(full)
    expect(mergeVisibleTopicReorder(full, [alpha, beta], [beta, beta])).toBe(full)
    expect(mergeVisibleTopicReorder(full, [alpha, beta], [beta, gamma])).toBe(full)
    expect(mergeVisibleTopicReorder(full, [], [])).toBe(full)
  })

  it('keeps pinned topics ahead of ordinary ones even for a cross-group drag', () => {
    // The visible list includes a pinned row; dragging an ordinary row above it
    // must not move that row into the pinned group.
    const visible = [p2, alpha]
    const merged = mergeVisibleTopicReorder(full, visible, [alpha, p2])
    expect(ids(merged)).toEqual(['p1', 'p2', 'alpha', 'beta', 'gamma'])
  })
})
