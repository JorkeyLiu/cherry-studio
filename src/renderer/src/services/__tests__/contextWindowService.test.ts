/**
 * Tests for the pure, mode-neutral context-window derivation helpers
 * (LOCK-CTX-1, LOCK-CTX-2, LOCK-CTX-3, LOCK-CTX-9):
 *   - resolveDefaultAnchorIndex: default window start from contextCount
 *   - getTurnAnchorGroupKey: anchor group key for a turn
 *   - contextCountToSliderValue / sliderValueToContextCount: identical
 *     slider semantics on both assistant setting surfaces (1..99 finite,
 *     endpoint 100 → ∞ → null)
 */
import type { ContextTurn } from '@renderer/services/contextTurnService'
import { buildContextTurns, resolveAnchorTurnIndex } from '@renderer/services/contextTurnService'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  contextCountToSliderValue,
  getTurnAnchorGroupKey,
  resolveDefaultAnchorIndex,
  resolveDefaultAnchorPersistence,
  sliderValueToContextCount
} from '../contextWindowService'

// --- Fixtures ---

const userMsg = (id: string): Message => ({ id, role: 'user' }) as unknown as Message

const assistantMsg = (id: string, askId?: string): Message => ({ id, role: 'assistant', askId }) as unknown as Message

const systemMsg = (id: string): Message => ({ id, role: 'system' }) as unknown as Message

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

// --- getTurnAnchorGroupKey ---

describe('getTurnAnchorGroupKey', () => {
  it('prefers the user message id inside the turn', () => {
    const t = turn('ask-1', [userMsg('u1'), assistantMsg('a1', 'u1')])
    expect(getTurnAnchorGroupKey(t)).toBe('u1')
  })

  it('uses the assistant message id for assistant-initiated turns (never the colliding askId)', () => {
    // The turn is keyed by its askId ('ask-7'), but the derived anchor key is the
    // assistant message's OWN id — unique, so the anchor cannot slide to another
    // turn sharing the same askId value (LOCK-FIX-1, LOCK-FIX-2).
    const t = turn('ask-7', [assistantMsg('a7', 'ask-7')])
    expect(getTurnAnchorGroupKey(t)).toBe('a7')
  })

  it('uses the system message id for a standalone system turn', () => {
    const t = turn('s1', [systemMsg('s1')])
    expect(getTurnAnchorGroupKey(t)).toBe('s1')
  })

  it('returns null for an empty turn', () => {
    expect(getTurnAnchorGroupKey(turn('k', []))).toBeNull()
  })

  it('round-trips every turn kind back to the exact turn (LOCK-FIX-1)', () => {
    // Realistic messages covering all four turn kinds buildContextTurns produces:
    // user-initiated, assistant-initiated (orphan with askId), orphan without
    // askId, standalone system, and a non-consecutive assistant whose askId
    // collides with an earlier user turn's key.
    const messages: Message[] = [
      userMsg('u1'),
      assistantMsg('a1', 'u1'), // joins turn 0 (user-initiated)
      assistantMsg('a2', 'u2'), // assistant-initiated (orphan, user u2 not yet present)
      assistantMsg('a3'), // orphan assistant without askId
      systemMsg('s1'), // standalone system turn
      userMsg('u2'),
      assistantMsg('a4', 'u2'), // joins turn 4 (user-initiated)
      assistantMsg('a5', 'u1') // non-consecutive — separate turn sharing askId u1
    ]
    const turns = buildContextTurns(messages)

    turns.forEach((t, index) => {
      const key = getTurnAnchorGroupKey(t)
      expect(key).not.toBeNull()
      expect(resolveAnchorTurnIndex(turns, key as string)).toBe(index)
    })
  })
})

// --- resolveDefaultAnchorPersistence (default-anchor persistence effect decision) ---

describe('resolveDefaultAnchorPersistence', () => {
  const twoUserTurns: ContextTurn[] = [turn('u1', [userMsg('u1')]), turn('u2', [userMsg('u2')])]

  it('empty post-clear segment with a persisted anchor → delete (LOCK-FIX-3)', () => {
    expect(resolveDefaultAnchorPersistence([], 5, { kind: 'active', groupKey: 'u1' })).toEqual({ type: 'delete' })
  })

  it('empty post-clear segment without an anchor → none (single-dispatch guard, no loop)', () => {
    expect(resolveDefaultAnchorPersistence([], 5, undefined)).toEqual({ type: 'none' })
  })

  it('a valid active anchor is authoritative → none (no rewrite churn)', () => {
    expect(resolveDefaultAnchorPersistence(twoUserTurns, 1, { kind: 'active', groupKey: 'u1' })).toEqual({
      type: 'none'
    })
  })

  it('a resolvable orphan/system anchor is authoritative too (LOCK-FIX-1)', () => {
    // Without the message-id resolution rule this anchor would be unresolvable
    // and the effect would re-derive + rewrite the anchor on every render.
    const orphanTurns: ContextTurn[] = [turn('a1', [assistantMsg('a1')]), turn('s1', [systemMsg('s1')])]
    expect(resolveDefaultAnchorPersistence(orphanTurns, null, { kind: 'active', groupKey: 'a1' })).toEqual({
      type: 'none'
    })
    expect(resolveDefaultAnchorPersistence(orphanTurns, null, { kind: 'active', groupKey: 's1' })).toEqual({
      type: 'none'
    })
  })

  it('persists the derived default anchor when none exists', () => {
    expect(resolveDefaultAnchorPersistence(twoUserTurns, 1, undefined)).toEqual({
      type: 'persist',
      anchor: { kind: 'active', groupKey: 'u2' }
    })
  })

  it('persists the derived anchor when the current anchor is stale (unresolvable)', () => {
    expect(resolveDefaultAnchorPersistence(twoUserTurns, 1, { kind: 'active', groupKey: 'ghost' })).toEqual({
      type: 'persist',
      anchor: { kind: 'active', groupKey: 'u2' }
    })
  })

  it('no-op when the persisted anchor already equals the derived key', () => {
    expect(resolveDefaultAnchorPersistence(twoUserTurns, 1, { kind: 'active', groupKey: 'u2' })).toEqual({
      type: 'none'
    })
  })

  it('null (unlimited) derives the first turn of the segment', () => {
    expect(resolveDefaultAnchorPersistence(twoUserTurns, null, undefined)).toEqual({
      type: 'persist',
      anchor: { kind: 'active', groupKey: 'u1' }
    })
  })
})

// --- Slider semantics (LOCK-CTX-9) ---

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
