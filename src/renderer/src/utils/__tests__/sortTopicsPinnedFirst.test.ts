/**
 * LOCK-002: pinned topics always sort/stay at the top, and the sort is stable
 * within the pinned and unpinned groups.
 */
import { describe, expect, it } from 'vitest'

import { sortTopicsPinnedFirst } from '../sort'

interface TopicLike {
  id: string
  pinned?: boolean
}

const topic = (id: string, pinned?: boolean): TopicLike => ({ id, pinned })

describe('sortTopicsPinnedFirst (LOCK-002)', () => {
  it('puts pinned topics before unpinned topics', () => {
    const input = [topic('a'), topic('b', true), topic('c'), topic('d', true)]
    const sorted = sortTopicsPinnedFirst(input)
    expect(sorted.map((t) => t.id)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('keeps the original relative order inside each group (stable)', () => {
    const input = [topic('a', true), topic('b'), topic('c', true), topic('d'), topic('e', true)]
    const sorted = sortTopicsPinnedFirst(input)
    expect(sorted.map((t) => t.id)).toEqual(['a', 'c', 'e', 'b', 'd'])
  })

  it('returns a new array and does not mutate the input', () => {
    const input = [topic('a'), topic('b', true)]
    const sorted = sortTopicsPinnedFirst(input)
    expect(sorted).not.toBe(input)
    expect(input.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('handles an empty list', () => {
    expect(sortTopicsPinnedFirst([])).toEqual([])
  })
})
