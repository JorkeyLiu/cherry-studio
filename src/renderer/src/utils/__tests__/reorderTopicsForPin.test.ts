/**
 * LOCK-002: reorderTopicsForPin places the toggled topic at the top of its
 * target group, never duplicates it, and keeps every other topic's relative
 * order — for both pin and unpin.
 */
import { describe, expect, it } from 'vitest'

import { reorderTopicsForPin } from '../sort'

interface TopicLike {
  id: string
  pinned?: boolean
}

const topic = (id: string, pinned?: boolean): TopicLike => ({ id, pinned })

describe('reorderTopicsForPin (LOCK-002)', () => {
  it('pin: moves the topic to the top of the pinned group without duplicating it', () => {
    const input = [topic('a'), topic('b', true), topic('c'), topic('d', true)]
    const updated = { id: 'a', pinned: true }

    const reordered = reorderTopicsForPin(input, updated)

    expect(reordered.map((t) => t.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(reordered.filter((t) => t.id === 'a')).toHaveLength(1)
  })

  it('unpin: moves the topic to the top of the unpinned group without duplicating it', () => {
    const input = [topic('a', true), topic('b'), topic('c', true), topic('d')]
    const updated = { id: 'a', pinned: false }

    const reordered = reorderTopicsForPin(input, updated)

    expect(reordered.map((t) => t.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(reordered.filter((t) => t.id === 'a')).toHaveLength(1)
  })

  it('pin: keeps the updated topic at the very top of the list', () => {
    const input = [topic('a', true), topic('b', true), topic('c')]
    const updated = { id: 'c', pinned: true }

    expect(reorderTopicsForPin(input, updated).map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('unpin: keeps other pinned topics above the updated topic', () => {
    const input = [topic('a', true), topic('b', true), topic('c')]
    const updated = { id: 'b', pinned: false }

    expect(reorderTopicsForPin(input, updated).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('never returns duplicate ids in the reordered list', () => {
    const input = [topic('a'), topic('b', true), topic('c'), topic('d', true), topic('e')]

    for (const target of input) {
      const updated = { id: target.id, pinned: !target.pinned }
      const reordered = reorderTopicsForPin(input, updated)
      const ids = reordered.map((t) => t.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toContain(target.id)
    }
  })

  it('preserves the relative order of untouched topics', () => {
    const input = [topic('a'), topic('b'), topic('c', true), topic('d')]
    const updated = { id: 'c', pinned: false }

    // 'c' moves to the top of the unpinned group; 'a', 'b', 'd' keep their
    // original relative order behind it.
    expect(reorderTopicsForPin(input, updated).map((t) => t.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('returns a new array and does not mutate the input', () => {
    const input = [topic('a'), topic('b', true)]
    const reordered = reorderTopicsForPin(input, { id: 'a', pinned: true })

    expect(reordered).not.toBe(input)
    expect(input.map((t) => t.id)).toEqual(['a', 'b'])
    expect(input[0]?.pinned).toBeUndefined()
  })

  it('handles an empty list', () => {
    expect(reorderTopicsForPin([], { id: 'x', pinned: true }).map((t) => t.id)).toEqual(['x'])
  })
})
