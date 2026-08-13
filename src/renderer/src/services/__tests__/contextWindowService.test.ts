/**
 * Tests for the pure, mode-neutral context-window derivation helpers
 * (single anchor-to-topic-end model, default derivation, reset semantics,
 * slider mapping):
 *   - resolveDefaultAnchorIndex: default window start from contextCount
 *   - resolveContextStartOverrideReset: TokenCount reset deletes the persisted
 *     user context-start override — the only Inputbar override mutation
 *   - contextCountToSliderValue / sliderValueToContextCount: identical
 *     slider semantics on both assistant setting surfaces (1..99 finite,
 *     endpoint 100 → ∞ → null)
 */
import type { ContextTurn } from '@renderer/services/contextTurnService'
import type { ContextStartOverride } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  contextCountToSliderValue,
  resolveContextStartOverrideReset,
  resolveDefaultAnchorIndex,
  sliderValueToContextCount
} from '../contextWindowService'

// --- Fixtures ---

const userMsg = (id: string): Message => ({ id, role: 'user' }) as unknown as Message

const assistantMsg = (id: string, askId?: string): Message => ({ id, role: 'assistant', askId }) as unknown as Message

const turn = (key: string, messages: Message[]): ContextTurn => ({ key, messages })

// --- resolveDefaultAnchorIndex ---

describe('resolveDefaultAnchorIndex', () => {
  const turns: ContextTurn[] = Array.from({ length: 10 }, (_, i) =>
    turn(`t${i}`, [userMsg(`u${i}`), assistantMsg(`a${i}`, `u${i}`)])
  )

  it('returns -1 for an empty turn list', () => {
    expect(resolveDefaultAnchorIndex([], 5)).toBe(-1)
    expect(resolveDefaultAnchorIndex([], null)).toBe(-1)
  })

  it('null (unlimited) selects the first turn of the segment', () => {
    expect(resolveDefaultAnchorIndex(turns, null)).toBe(0)
  })

  it('finite N selects the most recent N turns', () => {
    expect(resolveDefaultAnchorIndex(turns, 5)).toBe(5)
    expect(resolveDefaultAnchorIndex(turns, 1)).toBe(9)
  })

  it('topic smaller than N → start at first turn', () => {
    expect(resolveDefaultAnchorIndex(turns, 20)).toBe(0)
    expect(resolveDefaultAnchorIndex(turns, 10)).toBe(0)
  })

  it('legacy 0 is clamped to a minimum of 1 turn', () => {
    // N=0 (pre-migration) must behave like N=1, never empty.
    expect(resolveDefaultAnchorIndex(turns, 0)).toBe(9)
  })

  it('finite N never selects more than N turns', () => {
    const start = resolveDefaultAnchorIndex(turns, 3)
    expect(turns.length - start).toBeLessThanOrEqual(3)
  })
})

// --- resolveContextStartOverrideReset (TokenCount reset — delete the override) ---

describe('resolveContextStartOverrideReset', () => {
  const topicA = 'topic-a'
  const topicB = 'topic-b'
  const overrideA: ContextStartOverride = { kind: 'active', groupKey: 'u1' }
  const overrideB: ContextStartOverride = { kind: 'active', groupKey: 'u9' }

  it('deletes the override entry for the topic (reset removes designation)', () => {
    const decision = resolveContextStartOverrideReset({ [topicA]: overrideA, [topicB]: overrideB }, topicA)
    expect(decision.changed).toBe(true)
    expect(decision.overrides[topicA]).toBeUndefined()
    // Other topics' overrides are untouched.
    expect(decision.overrides[topicB]).toEqual(overrideB)
  })

  it('never creates an entry when the topic has no override (no churn)', () => {
    const overrides = { [topicB]: overrideB }
    const decision = resolveContextStartOverrideReset(overrides, topicA)
    expect(decision.changed).toBe(false)
    expect(decision.overrides).toEqual(overrides)
  })

  it('handles an absent override map as a no-op (nothing to delete)', () => {
    const decision = resolveContextStartOverrideReset(undefined, topicA)
    expect(decision.changed).toBe(false)
    expect(decision.overrides).toEqual({})
    expect(decision.overrides[topicA]).toBeUndefined()
  })

  it('reset is strictly deletion — it never creates or replaces an override', () => {
    const decision = resolveContextStartOverrideReset({}, topicA)
    expect(decision.changed).toBe(false)
    expect(decision.overrides[topicA]).toBeUndefined()
  })

  it('is pure — the input override map is not mutated', () => {
    const input = { [topicA]: overrideA }
    resolveContextStartOverrideReset(input, topicA)
    expect(input).toEqual({ [topicA]: overrideA })
  })
})

// --- Slider semantics ---

describe('slider semantics', () => {
  describe('contextCountToSliderValue', () => {
    it('null (unlimited) maps to the ∞ endpoint 100', () => {
      expect(contextCountToSliderValue(null)).toBe(100)
    })

    it('finite values map to themselves (1..99)', () => {
      expect(contextCountToSliderValue(1)).toBe(1)
      expect(contextCountToSliderValue(5)).toBe(5)
      expect(contextCountToSliderValue(99)).toBe(99)
    })

    it('legacy 0 and undefined clamp to the minimum position 1', () => {
      expect(contextCountToSliderValue(0)).toBe(1)
      expect(contextCountToSliderValue(undefined)).toBe(1)
    })

    it('a stray finite 100 clamps into the finite range', () => {
      expect(contextCountToSliderValue(100)).toBe(99)
    })
  })

  describe('sliderValueToContextCount', () => {
    it('endpoint 100 stores null (unlimited)', () => {
      expect(sliderValueToContextCount(100)).toBeNull()
    })

    it('finite positions store the finite count', () => {
      expect(sliderValueToContextCount(1)).toBe(1)
      expect(sliderValueToContextCount(50)).toBe(50)
      expect(sliderValueToContextCount(99)).toBe(99)
    })

    it('values below 1 clamp to 1', () => {
      expect(sliderValueToContextCount(0)).toBe(1)
    })
  })
})
