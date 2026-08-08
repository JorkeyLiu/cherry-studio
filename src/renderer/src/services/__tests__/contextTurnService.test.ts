/**
 * Focused tests for buildContextTurns and turnsToMessages — the pure domain
 * abstraction that groups messages into semantic "turns".
 *
 * These tests verify construction rules ONLY. They do not test context window
 * selection, contextInfoService behavior, or UI rendering.
 */
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { buildContextTurns, resolveAnchorTurnIndex, turnsToMessages } from '../contextTurnService'

// ---------------------------------------------------------------------------
// Test factories — minimal Message objects, no store dependency
// ---------------------------------------------------------------------------

const user = (id: string): Message => ({
  id,
  role: 'user',
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: '2026-07-23T00:00:00.000Z',
  status: UserMessageStatus.SUCCESS,
  blocks: []
})

const assistant = (id: string, askId?: string): Message => ({
  id,
  role: 'assistant',
  askId,
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: '2026-07-23T00:00:00.000Z',
  status: AssistantMessageStatus.SUCCESS,
  blocks: []
})

const system = (id: string): Message => ({
  id,
  role: 'system',
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: '2026-07-23T00:00:00.000Z',
  status: UserMessageStatus.SUCCESS,
  blocks: []
})

const clear = (id: string): Message => ({
  id,
  role: 'user',
  type: 'clear',
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: '2026-07-23T00:00:00.000Z',
  status: UserMessageStatus.SUCCESS,
  blocks: []
})

// ---------------------------------------------------------------------------
// buildContextTurns
// ---------------------------------------------------------------------------

describe('buildContextTurns', () => {
  // --- Empty / edge cases ---

  it('returns empty array for empty input', () => {
    expect(buildContextTurns([])).toEqual([])
  })

  // --- Normal Q&A ---

  it('groups a user + assistant into a single turn', () => {
    const messages = [user('u1'), assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toEqual([messages[0], messages[1]])
  })

  it('groups two Q&A pairs into two turns', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(2)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toEqual([messages[0], messages[1]])
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toEqual([messages[2], messages[3]])
  })

  // --- Retries (consecutive assistants with same askId) ---

  it('groups multiple assistant retries into the same turn', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), assistant('a1_retry', 'u1'), assistant('a1_retry2', 'u1')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toHaveLength(4)
    expect(turns[0].messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a1_retry', 'a1_retry2'])
  })

  it('groups user + assistant + retry + second Q&A correctly', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), assistant('a1_retry', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(2)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toHaveLength(3) // u1, a1, a1_retry
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toHaveLength(2) // u2, a2
  })

  // --- Adjacent users ---

  it('adjacent user messages start separate turns', () => {
    const messages = [user('u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(2)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toEqual([messages[0]])
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toEqual([messages[1], messages[2]])
  })

  it('three adjacent users each start separate turns', () => {
    const messages = [user('u1'), user('u2'), user('u3'), assistant('a3', 'u3')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(3)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toHaveLength(1)
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toHaveLength(1)
    expect(turns[2].key).toBe('u3')
    expect(turns[2].messages).toHaveLength(2)
  })

  // --- Trailing user (no assistant response yet) ---

  it('trailing user creates a turn with only the user message', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      user('u2') // pending — no assistant response yet
    ]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(2)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toHaveLength(2)
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toEqual([messages[2]])
  })

  // --- Trailing assistant ---

  it('trailing assistant (after user) stays in its turn', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      user('u2'),
      assistant('a2', 'u2') // trailing assistant
    ]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(2)
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toEqual([messages[2], messages[3]])
  })

  // --- Orphan assistant with askId ---

  it('orphan assistant with askId creates a turn keyed by askId', () => {
    // No preceding user message with id 'u1' — assistant is orphan
    const messages = [assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].key).toBe('u1') // uses askId as key
    expect(turns[0].messages).toEqual([messages[0]])
  })

  // --- Orphan assistant without askId ---

  it('orphan assistant without askId creates a turn keyed by own id', () => {
    const messages = [assistant('a1')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].key).toBe('a1') // uses own id as key
    expect(turns[0].messages).toEqual([messages[0]])
  })

  // --- Non-consecutive same askId ---

  it('non-consecutive assistants with same askId create separate turns', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      user('u2'), // breaks consecutiveness
      assistant('a2', 'u1') // same askId but non-consecutive
    ]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(3)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toEqual([messages[0], messages[1]])
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toEqual([messages[2]])
    // a2 has askId=u1 but is non-consecutive → new turn keyed by askId
    expect(turns[2].key).toBe('u1')
    expect(turns[2].messages).toEqual([messages[3]])
  })

  it('non-consecutive same askId with different assistant between them', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      assistant('a_other', 'u_other'), // different askId breaks consecutiveness
      assistant('a2', 'u1') // same askId as a1 but non-consecutive
    ]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(3)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toEqual([messages[0], messages[1]])
    expect(turns[1].key).toBe('u_other')
    expect(turns[1].messages).toEqual([messages[2]])
    expect(turns[2].key).toBe('u1')
    expect(turns[2].messages).toEqual([messages[3]])
  })

  // --- Clear message filtering ---

  it('filters clear messages and everything before them', () => {
    const messages = [user('u0'), assistant('a0', 'u0'), clear('clear1'), user('u1'), assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    // u0 and a0 are before the clear → filtered out
    expect(turns).toHaveLength(1)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toEqual([messages[3], messages[4]])
  })

  it('last clear message wins when multiple clears exist', () => {
    const messages = [
      user('u0'),
      assistant('a0', 'u0'),
      clear('clear1'),
      user('u1'),
      assistant('a1', 'u1'),
      clear('clear2'),
      user('u2'),
      assistant('a2', 'u2')
    ]
    const turns = buildContextTurns(messages)

    // Only messages after the last clear (clear2) remain
    expect(turns).toHaveLength(1)
    expect(turns[0].key).toBe('u2')
    expect(turns[0].messages).toEqual([messages[6], messages[7]])
  })

  it('clear at the end returns empty turns', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), clear('clear1')]
    const turns = buildContextTurns(messages)

    expect(turns).toEqual([])
  })

  it('clear at the start preserves all messages after it', () => {
    const messages = [clear('clear1'), user('u1'), assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].key).toBe('u1')
  })

  // --- Preserve chronological order ---

  it('preserves chronological order of all messages within turns', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      assistant('a1_r1', 'u1'),
      user('u2'),
      assistant('a2', 'u2'),
      assistant('a2_r1', 'u2')
    ]
    const turns = buildContextTurns(messages)

    expect(turns[0].messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a1_r1'])
    expect(turns[1].messages.map((m) => m.id)).toEqual(['u2', 'a2', 'a2_r1'])
  })

  // --- System messages as standalone turns ---

  it('system message becomes a standalone turn keyed by its own id', () => {
    const messages = [system('s1'), user('u1'), assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    // s1 is its own turn; u1 + a1 form a second turn
    expect(turns).toHaveLength(2)
    expect(turns[0].key).toBe('s1')
    expect(turns[0].messages).toEqual([messages[0]])
    expect(turns[1].key).toBe('u1')
    expect(turns[1].messages).toEqual([messages[1], messages[2]])
  })

  it('multiple system messages each become separate standalone turns', () => {
    const messages = [system('s1'), system('s2'), user('u1'), assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(3)
    expect(turns[0].key).toBe('s1')
    expect(turns[0].messages).toEqual([messages[0]])
    expect(turns[1].key).toBe('s2')
    expect(turns[1].messages).toEqual([messages[1]])
    expect(turns[2].key).toBe('u1')
    expect(turns[2].messages).toEqual([messages[2], messages[3]])
  })

  // --- Assistant changes currentTurnKey for non-matching askId ---

  it('assistant with askId not matching current turn creates new turn with askId key', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      assistant('a2', 'u_other') // askId doesn't match current turn key 'u1'
    ]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(2)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toEqual([messages[0], messages[1]])
    expect(turns[1].key).toBe('u_other')
    expect(turns[1].messages).toEqual([messages[2]])
  })

  // --- Complex scenario: mixed Q&A, retries, adjacent users ---

  it('handles complex realistic conversation flow', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      assistant('a1_retry', 'u1'),
      user('u2'),
      user('u3'), // adjacent user
      assistant('a3', 'u3'),
      user('u4'),
      assistant('a4', 'u4'),
      assistant('a4_retry', 'u4')
    ]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(4)
    expect(turns[0].key).toBe('u1')
    expect(turns[0].messages).toHaveLength(3) // u1, a1, a1_retry
    expect(turns[1].key).toBe('u2')
    expect(turns[1].messages).toHaveLength(1) // u2 alone
    expect(turns[2].key).toBe('u3')
    expect(turns[2].messages).toHaveLength(2) // u3, a3
    expect(turns[3].key).toBe('u4')
    expect(turns[3].messages).toHaveLength(3) // u4, a4, a4_retry
  })

  // --- Error/pending messages remain present ---

  it('error-status assistant messages remain in turns', () => {
    const errorAssistant: Message = {
      ...assistant('a1_err', 'u1'),
      status: AssistantMessageStatus.ERROR
    }
    const messages = [user('u1'), errorAssistant]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].messages).toHaveLength(2)
    expect(turns[0].messages[1].status).toBe(AssistantMessageStatus.ERROR)
  })

  it('pending-status assistant messages remain in turns', () => {
    const pendingAssistant: Message = {
      ...assistant('a1_pending', 'u1'),
      status: AssistantMessageStatus.PENDING
    }
    const messages = [user('u1'), pendingAssistant]
    const turns = buildContextTurns(messages)

    expect(turns).toHaveLength(1)
    expect(turns[0].messages).toHaveLength(2)
    expect(turns[0].messages[1].status).toBe(AssistantMessageStatus.PENDING)
  })
})

// ---------------------------------------------------------------------------
// turnsToMessages
// ---------------------------------------------------------------------------

describe('turnsToMessages', () => {
  it('returns empty array for empty turns', () => {
    expect(turnsToMessages([])).toEqual([])
  })

  it('flattens a single turn into messages', () => {
    const u1 = user('u1')
    const a1 = assistant('a1', 'u1')
    const turns = buildContextTurns([u1, a1])

    expect(turnsToMessages(turns)).toEqual([u1, a1])
  })

  it('flattens multiple turns preserving chronological order', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    expect(turnsToMessages(turns)).toEqual(messages)
  })

  it('preserves retry messages in order', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), assistant('a1_retry', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    expect(turnsToMessages(turns)).toEqual(messages)
  })

  it('roundtrip: buildContextTurns → turnsToMessages preserves all non-clear messages', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), clear('clear1'), user('u2'), assistant('a2', 'u2'), user('u3')]
    const turns = buildContextTurns(messages)
    const roundtripped = turnsToMessages(turns)

    // Only u2, a2, u3 survive clear filtering
    expect(roundtripped).toEqual([messages[3], messages[4], messages[5]])
  })

  it('roundtrip: buildContextTurns → turnsToMessages preserves user, assistant, and system messages', () => {
    const messages = [
      system('s1'),
      user('u1'),
      assistant('a1', 'u1'),
      clear('clear1'),
      system('s2'),
      user('u2'),
      assistant('a2', 'u2')
    ]
    const turns = buildContextTurns(messages)
    const roundtripped = turnsToMessages(turns)

    // Post-clear: s2, u2, a2 survive; s1, u1, a1 are before clear
    expect(roundtripped).toEqual([messages[4], messages[5], messages[6]])
    // Verify system message is a standalone turn
    expect(turns[0].key).toBe('s2')
    expect(turns[0].messages).toHaveLength(1)
    expect(turns[0].messages[0].role).toBe('system')
  })

  it('subset selection: picks specific turns and flattens correctly', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      user('u2'),
      assistant('a2', 'u2'),
      user('u3'),
      assistant('a3', 'u3')
    ]
    const turns = buildContextTurns(messages)

    // Select only the first and last turn
    const selected = [turns[0], turns[2]]
    expect(turnsToMessages(selected)).toEqual([
      messages[0],
      messages[1], // u1, a1
      messages[4],
      messages[5] // u3, a3
    ])
  })

  it('subset selection with retries', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), assistant('a1_retry', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    // Select only the first turn (with retries)
    expect(turnsToMessages([turns[0]])).toEqual([messages[0], messages[1], messages[2]])
  })
})

// ---------------------------------------------------------------------------
// resolveAnchorTurnIndex
// ---------------------------------------------------------------------------

describe('resolveAnchorTurnIndex', () => {
  it('finds user turn by user message id', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(0)
    expect(resolveAnchorTurnIndex(turns, 'u2')).toBe(1)
  })

  it('returns -1 when neither user nor assistant matches', () => {
    const messages = [user('u1'), assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    expect(resolveAnchorTurnIndex(turns, 'nonexistent')).toBe(-1)
  })

  it('returns -1 for empty turns', () => {
    expect(resolveAnchorTurnIndex([], 'u1')).toBe(-1)
  })

  it('duplicate key: user turn wins over later non-consecutive assistant with same askId', () => {
    // u1 turn (key=u1), u2 turn (key=u2), then non-consecutive a2 with askId=u1 (key=u1)
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      user('u2'),
      assistant('a2', 'u1') // non-consecutive, same askId as u1's turn
    ]
    const turns = buildContextTurns(messages)

    // Turn 0: [u1, a1] (key=u1, has user u1)
    // Turn 1: [u2] (key=u2)
    // Turn 2: [a2] (key=u1, askId=u1 — no user message)
    expect(turns).toHaveLength(3)
    expect(turns[0].key).toBe('u1')
    expect(turns[2].key).toBe('u1') // duplicate key

    // User turn (index 0) should win over assistant-only turn (index 2)
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(0)
  })

  it('orphan assistant fallback: assistant turn found when user is absent', () => {
    // Orphan assistant with askId='u1' but no user with id='u1'
    const messages = [assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    // Turn 0: [a1] (key=u1, assistant with askId=u1, no user)
    // Turn 1: [u2, a2] (key=u2)
    expect(turns).toHaveLength(2)
    expect(turns[0].key).toBe('u1')

    // No user turn with id='u1' → falls back to assistant with askId='u1'
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(0)
  })

  it('orphan assistant without askId does not match', () => {
    // Assistant with no askId — turn key is its own id
    const messages = [assistant('a1')]
    const turns = buildContextTurns(messages)

    // Turn key is 'a1', but no message has id='u1' or askId='u1'
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(-1)
  })

  it('multiple assistant turns with same askId: first match wins', () => {
    // Two non-consecutive orphan assistants with same askId
    const messages = [
      assistant('a1', 'u1'),
      user('u2'),
      assistant('a2', 'u1') // same askId, non-consecutive
    ]
    const turns = buildContextTurns(messages)

    // Turn 0: [a1] (key=u1, askId=u1)
    // Turn 1: [u2] (key=u2)
    // Turn 2: [a2] (key=u1, askId=u1)
    expect(turns).toHaveLength(3)

    // First assistant turn with askId=u1 wins (index 0)
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(0)
  })

  it('user turn with matching id wins even when assistant turn comes first', () => {
    // Edge case: assistant orphan with askId=u1 comes before user u1
    // This can't happen with buildContextTurns (orphan assistant gets key=u1,
    // then user u1 starts a new turn with key=u1), but test the resolver anyway.
    const messages = [assistant('a1', 'u1'), user('u1'), assistant('a2', 'u1')]
    const turns = buildContextTurns(messages)

    // Turn 0: [a1] (key=u1, assistant askId=u1, no user)
    // Turn 1: [u1, a2] (key=u1, has user u1)
    expect(turns).toHaveLength(2)

    // User turn (index 1) should win over assistant-only turn (index 0)
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(1)
  })

  // --- LOCK-FIX-1: every turn kind resolves back to the exact turn ---

  it('resolves an orphan assistant with askId by its own message id (assistant-first boundary)', () => {
    // Segment starts with an assistant turn whose user question is absent.
    const messages = [assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    // Turn 0: [a1] (key=u1, askId=u1); Turn 1: [u2, a2] (key=u2)
    expect(turns[0].key).toBe('u1')
    // The derived anchor key for turn 0 is a1's own message id (not the askId),
    // and it must resolve back to turn 0.
    expect(resolveAnchorTurnIndex(turns, 'a1')).toBe(0)
  })

  it('resolves an orphan assistant without askId by its own message id', () => {
    const messages = [assistant('a1'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)

    expect(turns[0].key).toBe('a1')
    expect(resolveAnchorTurnIndex(turns, 'a1')).toBe(0)
  })

  it('resolves a standalone system turn by its own message id', () => {
    const messages = [system('s1'), user('u1'), assistant('a1', 'u1')]
    const turns = buildContextTurns(messages)

    expect(turns[0].key).toBe('s1')
    expect(resolveAnchorTurnIndex(turns, 's1')).toBe(0)
  })

  it('exact round-trip: derived key of a non-consecutive assistant turn resolves to that turn, not the earlier user turn', () => {
    // user u1 turn, then u2, then a2 with the same askId=u1 non-consecutively.
    const messages = [
      user('u1'),
      assistant('a1', 'u1'),
      user('u2'),
      assistant('a2', 'u1') // non-consecutive — separate turn keyed by askId u1
    ]
    const turns = buildContextTurns(messages)

    // Turn 0: [u1, a1] (key=u1); Turn 1: [u2] (key=u2); Turn 2: [a2] (key=u1)
    expect(turns[2].key).toBe('u1') // duplicate key value with turn 0

    // A bare askId key 'u1' resolves to the user turn (user-preferred, LOCK-FIX-2)…
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(0)
    // …but the anchor key DERIVED from turn 2 is a2's own message id, which must
    // resolve back to turn 2 exactly (LOCK-FIX-1), never sliding to turn 0.
    expect(resolveAnchorTurnIndex(turns, 'a2')).toBe(2)
  })
})
