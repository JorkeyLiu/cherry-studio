/**
 * Tests for the pure context-window helpers
 * (single stable anchor-to-topic-end model, docs/context-window.md):
 *   - resolveDefaultAnchorIndex: default window start from contextCount
 *   - deriveDefaultAnchorKey: default window position as a turn group key
 *   - isResolvableAnchor: persisted anchor validity against real turns
 *   - resolveAnchorEstablishDecision: first establishment / compatibility
 *     repair (exactly-once, never recalculates a valid anchor)
 *   - resolveAnchorReanchorDecision: TokenCount re-anchor (current default
 *     position; empty topic is a no-op; never leaves a topic anchorless)
 *   - resolveMessageAnchorDecision: message-anchor click (move to turn;
 *     clicking the current anchor re-anchors to the default position)
 *   - contextCountToSliderValue / sliderValueToContextCount: identical
 *     slider semantics on both assistant setting surfaces (1..99 finite,
 *     endpoint 100 → ∞ → null)
 */
import type { ContextTurn } from '@renderer/services/contextTurnService'
import type { ContextWindowAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  buildSettingsResetPatch,
  contextCountToSliderValue,
  deriveDefaultAnchorKey,
  isResolvableAnchor,
  resolveAnchorEstablishDecision,
  resolveAnchorReanchorDecision,
  resolveDefaultAnchorIndex,
  resolveMessageAnchorDecision,
  sliderValueToContextCount
} from '../contextWindowService'

// --- Fixtures ---

const userMsg = (id: string): Message => ({ id, role: 'user' }) as unknown as Message

const assistantMsg = (id: string, askId?: string): Message => ({ id, role: 'assistant', askId }) as unknown as Message

const turn = (key: string, messages: Message[]): ContextTurn => ({ key, messages })

const anchor = (key: string): ContextWindowAnchor => ({ kind: 'active', groupKey: key })

// --- resolveDefaultAnchorIndex ---

describe('resolveDefaultAnchorIndex', () => {
  const turns: ContextTurn[] = Array.from({ length: 10 }, (_, i) =>
    turn(`t${i}`, [userMsg(`u${i}`), assistantMsg(`a${i}`, `u${i}`)])
  )

  it('returns -1 for an empty turn list', () => {
    expect(resolveDefaultAnchorIndex([], 5)).toBe(-1)
    expect(resolveDefaultAnchorIndex([], null)).toBe(-1)
  })

  it('null (unlimited) selects the first turn of the topic', () => {
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

// --- deriveDefaultAnchorKey ---

describe('deriveDefaultAnchorKey', () => {
  const turns: ContextTurn[] = [
    turn('u1', [userMsg('u1'), assistantMsg('a1', 'u1')]),
    turn('u2', [userMsg('u2'), assistantMsg('a2', 'u2')]),
    turn('u3', [userMsg('u3'), assistantMsg('a3', 'u3')])
  ]

  it('returns null for an empty turn list', () => {
    expect(deriveDefaultAnchorKey([], 5)).toBeNull()
    expect(deriveDefaultAnchorKey([], null)).toBeNull()
  })

  it('null (unlimited) derives the first turn key', () => {
    expect(deriveDefaultAnchorKey(turns, null)).toBe('u1')
  })

  it('finite N derives the turn key leaving at most N turns', () => {
    expect(deriveDefaultAnchorKey(turns, 2)).toBe('u2')
    expect(deriveDefaultAnchorKey(turns, 1)).toBe('u3')
  })

  it('topic smaller than N derives the first turn key', () => {
    expect(deriveDefaultAnchorKey(turns, 25)).toBe('u1')
  })
})

// --- isResolvableAnchor ---

describe('isResolvableAnchor', () => {
  const turns: ContextTurn[] = [
    turn('u1', [userMsg('u1'), assistantMsg('a1', 'u1')]),
    turn('u2', [userMsg('u2'), assistantMsg('a2', 'u2')])
  ]

  it('an active anchor whose group key matches a turn is resolvable', () => {
    expect(isResolvableAnchor(anchor('u1'), turns)).toBe(true)
    expect(isResolvableAnchor(anchor('u2'), turns)).toBe(true)
  })

  it('a group key absent from the turns is unresolvable', () => {
    expect(isResolvableAnchor(anchor('ghost'), turns)).toBe(false)
  })

  it('undefined is not a resolvable anchor', () => {
    expect(isResolvableAnchor(undefined, turns)).toBe(false)
  })
})

// --- resolveAnchorEstablishDecision (first establishment / compatibility repair) ---

describe('resolveAnchorEstablishDecision', () => {
  const topicA = 'topic-a'
  const topicB = 'topic-b'
  const turns: ContextTurn[] = [
    turn('u1', [userMsg('u1'), assistantMsg('a1', 'u1')]),
    turn('u2', [userMsg('u2'), assistantMsg('a2', 'u2')]),
    turn('u3', [userMsg('u3'), assistantMsg('a3', 'u3')])
  ]

  it('establishes the default-derived anchor when the topic has none', () => {
    const decision = resolveAnchorEstablishDecision(undefined, topicA, turns, 2)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u2'))
  })

  it('never recalculates a valid persisted anchor', () => {
    const map = { [topicA]: anchor('u1') }
    const decision = resolveAnchorEstablishDecision(map, topicA, turns, 2)
    expect(decision.changed).toBe(false)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u1'))
  })

  it('repairs an unresolvable (legacy) anchor with the default-derived position', () => {
    const map = { [topicA]: anchor('ghost') }
    const decision = resolveAnchorEstablishDecision(map, topicA, turns, 1)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u3'))
  })

  it('is exactly-once / idempotent: re-running after establishment is a no-op', () => {
    const first = resolveAnchorEstablishDecision(undefined, topicA, turns, 2)
    const second = resolveAnchorEstablishDecision(first.anchorMap, topicA, turns, 2)
    expect(second.changed).toBe(false)
    expect(second.anchorMap[topicA]).toEqual(first.anchorMap[topicA])
  })

  it('an empty turn list never receives an anchor (empty topics have none)', () => {
    const decision = resolveAnchorEstablishDecision(undefined, topicA, [], 2)
    expect(decision.changed).toBe(false)
    expect(decision.anchorMap[topicA]).toBeUndefined()
  })

  it('other topics in the map are preserved', () => {
    const map = { [topicB]: anchor('u9') }
    const decision = resolveAnchorEstablishDecision(map, topicA, turns, 2)
    expect(decision.anchorMap[topicB]).toEqual(anchor('u9'))
  })

  it('uses null contextCount → first turn (whole topic)', () => {
    const decision = resolveAnchorEstablishDecision(undefined, topicA, turns, null)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u1'))
  })

  it('is pure — the input anchor map is not mutated', () => {
    const input = { [topicA]: anchor('u1') }
    resolveAnchorEstablishDecision(input, topicA, turns, 2)
    expect(input).toEqual({ [topicA]: anchor('u1') })
  })
})

// --- resolveAnchorReanchorDecision (TokenCount click) ---

describe('resolveAnchorReanchorDecision', () => {
  const topicA = 'topic-a'
  const turns: ContextTurn[] = [
    turn('u1', [userMsg('u1'), assistantMsg('a1', 'u1')]),
    turn('u2', [userMsg('u2'), assistantMsg('a2', 'u2')]),
    turn('u3', [userMsg('u3'), assistantMsg('a3', 'u3')])
  ]

  it('re-anchors to the current default position derived from current contextCount', () => {
    const map = { [topicA]: anchor('u1') }
    // Current contextCount=2 → default position is turn u2.
    const decision = resolveAnchorReanchorDecision(map, topicA, turns, 2)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u2'))
  })

  it('re-anchors with contextCount=null to the first turn (whole topic)', () => {
    const map = { [topicA]: anchor('u3') }
    const decision = resolveAnchorReanchorDecision(map, topicA, turns, null)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u1'))
  })

  it('reports no change when the anchor already sits at the default position', () => {
    const map = { [topicA]: anchor('u2') }
    const decision = resolveAnchorReanchorDecision(map, topicA, turns, 2)
    expect(decision.changed).toBe(false)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u2'))
  })

  it('empty topic is a no-op (never creates an anchor)', () => {
    const decision = resolveAnchorReanchorDecision(undefined, topicA, [], 2)
    expect(decision.changed).toBe(false)
    expect(decision.anchorMap[topicA]).toBeUndefined()
  })

  it('establishes an anchor from nothing on a non-empty topic', () => {
    const decision = resolveAnchorReanchorDecision(undefined, topicA, turns, 2)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u2'))
  })

  it('never leaves a non-empty topic anchorless', () => {
    const decision = resolveAnchorReanchorDecision(undefined, topicA, turns, 1)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u3'))
  })
})

// --- resolveMessageAnchorDecision (message-anchor click) ---

describe('resolveMessageAnchorDecision', () => {
  const topicA = 'topic-a'
  const turns: ContextTurn[] = [
    turn('u1', [userMsg('u1'), assistantMsg('a1', 'u1')]),
    turn('u2', [userMsg('u2'), assistantMsg('a2', 'u2')]),
    turn('u3', [userMsg('u3'), assistantMsg('a3', 'u3')])
  ]

  it('clicking a non-anchored turn moves the anchor there', () => {
    const map = { [topicA]: anchor('u1') }
    const decision = resolveMessageAnchorDecision(map, topicA, turns, 'u3', 2)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u3'))
  })

  it('clicking the CURRENT anchored turn re-anchors to the current default position', () => {
    const map = { [topicA]: anchor('u3') }
    // contextCount=2 → default position is u2; clicking anchored u3 re-anchors there.
    const decision = resolveMessageAnchorDecision(map, topicA, turns, 'u3', 2)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u2'))
  })

  it('clicking the current anchor with default position unchanged reports no change', () => {
    const map = { [topicA]: anchor('u2') }
    const decision = resolveMessageAnchorDecision(map, topicA, turns, 'u2', 2)
    expect(decision.changed).toBe(false)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u2'))
  })

  it('an unresolvable desired turn re-anchors to the default position (never anchorless)', () => {
    const map = { [topicA]: anchor('u1') }
    const decision = resolveMessageAnchorDecision(map, topicA, turns, 'ghost', 1)
    expect(decision.changed).toBe(true)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u3'))
  })

  it('a null desired key is a no-op', () => {
    const map = { [topicA]: anchor('u1') }
    const decision = resolveMessageAnchorDecision(map, topicA, turns, null, 2)
    expect(decision.changed).toBe(false)
    expect(decision.anchorMap[topicA]).toEqual(anchor('u1'))
  })

  it('empty topic is a no-op', () => {
    const decision = resolveMessageAnchorDecision(undefined, topicA, [], 'u1', 2)
    expect(decision.changed).toBe(false)
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

// --- buildSettingsResetPatch (generic reset preserves topic anchors) ---

describe('buildSettingsResetPatch', () => {
  const defaults = {
    contextCount: 20,
    temperature: 0.7,
    contextWindowAnchor: {}
  } as unknown as Parameters<typeof buildSettingsResetPatch>[1]

  it('resets defaults but PRESERVES the current per-topic anchor map', () => {
    const current = {
      contextCount: 5,
      temperature: 0.2,
      contextWindowAnchor: { 'topic-a': anchor('u1'), 'topic-b': anchor('u3') }
    }
    const patch = buildSettingsResetPatch(current as never, defaults)

    expect(patch.contextCount).toBe(20) // defaults reset
    expect(patch.temperature).toBe(0.7) // defaults reset
    expect(patch.contextWindowAnchor).toEqual({ 'topic-a': anchor('u1'), 'topic-b': anchor('u3') }) // anchors kept
  })

  it('produces an empty anchor map when the current settings have none', () => {
    const current = { contextCount: 3, contextWindowAnchor: undefined }
    const patch = buildSettingsResetPatch(current as never, defaults)
    expect(patch.contextWindowAnchor).toEqual({})
  })

  it('is a no-op guard for undefined current settings (fresh assistant)', () => {
    const patch = buildSettingsResetPatch(undefined, defaults)
    expect(patch.contextCount).toBe(20)
    expect(patch.contextWindowAnchor).toEqual({})
  })
})
