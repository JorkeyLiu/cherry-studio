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

import {
  buildContextTurns,
  isMessageInContextTurn,
  resolveAnchorTurnIndex,
  turnsToMessages
} from '../contextTurnService'

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

  it('roundtrip: buildContextTurns → turnsToMessages preserves all messages in order', () => {
    const messages = [user('u1'), assistant('a1', 'u1'), user('u2'), assistant('a2', 'u2'), user('u3')]
    const turns = buildContextTurns(messages)
    const roundtripped = turnsToMessages(turns)

    expect(roundtripped).toEqual(messages)
  })

  it('roundtrip: buildContextTurns → turnsToMessages preserves user, assistant, and system messages', () => {
    const messages = [system('s1'), user('u1'), assistant('a1', 'u1'), system('s2'), user('u2'), assistant('a2', 'u2')]
    const turns = buildContextTurns(messages)
    const roundtripped = turnsToMessages(turns)

    expect(roundtripped).toEqual(messages)
    // Verify system messages are standalone turns
    expect(turns[0].key).toBe('s1')
    expect(turns[0].messages).toHaveLength(1)
    expect(turns[0].messages[0].role).toBe('system')
    expect(turns[2].key).toBe('s2')
    expect(turns[2].messages).toHaveLength(1)
    expect(turns[2].messages[0].role).toBe('system')
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

  // --- Every turn kind resolves back to the exact turn ---

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

    // A bare askId key 'u1' resolves to the user turn (user-preferred)…
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(0)
    // …but the anchor key DERIVED from turn 2 is a2's own message id, which must
    // resolve back to turn 2 exactly, never sliding to turn 0.
    expect(resolveAnchorTurnIndex(turns, 'a2')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// isMessageInContextTurn (per-message anchor membership)
// ---------------------------------------------------------------------------

describe('isMessageInContextTurn', () => {
  it('user message matches its own id (canonical user turn key)', () => {
    expect(isMessageInContextTurn(user('u1'), 'u1')).toBe(true)
    expect(isMessageInContextTurn(user('u1'), 'u2')).toBe(false)
  })

  it('assistant message matches its askId', () => {
    expect(isMessageInContextTurn(assistant('a1', 'u1'), 'u1')).toBe(true)
    expect(isMessageInContextTurn(assistant('a1', 'u1'), 'a1')).toBe(false)
  })

  it('orphan assistant (no askId) matches its own message id', () => {
    expect(isMessageInContextTurn(assistant('a1'), 'a1')).toBe(true)
    expect(isMessageInContextTurn(assistant('a1'), 'u1')).toBe(false)
  })

  it('system message matches its own id', () => {
    expect(isMessageInContextTurn(system('s1'), 's1')).toBe(true)
    expect(isMessageInContextTurn(system('s1'), 'u1')).toBe(false)
  })

  it('returns false for a null/undefined anchor key (no anchor — empty window)', () => {
    expect(isMessageInContextTurn(user('u1'), null)).toBe(false)
    expect(isMessageInContextTurn(user('u1'), undefined)).toBe(false)
  })

  it('round-trips with buildContextTurns start keys for every turn kind', () => {
    const messages = [system('s1'), user('u1'), assistant('a1', 'u1'), assistant('orphan'), user('u2')]
    const turns = buildContextTurns(messages)
    // Every turn's canonical key marks exactly its own first message as in-turn.
    for (const turn of turns) {
      const first = turn.messages[0]
      expect(isMessageInContextTurn(first, turn.key)).toBe(true)
      // A user in another turn is never in this turn.
      for (const other of messages) {
        if (other.id !== first.id && other.role === 'user') {
          expect(isMessageInContextTurn(other, turn.key)).toBe(false)
        }
      }
    }
  })
})

describe('LOCK-R06-005: unknown/null/tool roles are ignored for turn membership and anchor resolution', () => {
  it('isMessageInContextTurn returns false for null/tool/unknown/empty roles even when id matches groupKey', () => {
    const cases: Array<{ role: any; id: string }> = [
      { role: null, id: 'x-null' },
      { role: 'tool', id: 'x-tool' },
      { role: 'unknown', id: 'x-unknown' },
      { role: '', id: 'x-empty' },
      { role: undefined, id: 'x-undef' }
    ]
    for (const c of cases) {
      const msg: any = { id: c.id, role: c.role, askId: 'u1' }
      expect(isMessageInContextTurn(msg, c.id)).toBe(false)
      expect(isMessageInContextTurn(msg, 'u1')).toBe(false)
    }
    // valid roles still correctly resolve
    expect(isMessageInContextTurn(user('u1'), 'u1')).toBe(true)
    expect(isMessageInContextTurn(assistant('a1', 'u1'), 'u1')).toBe(true)
    expect(isMessageInContextTurn(system('s1'), 's1')).toBe(true)
    expect(isMessageInContextTurn(assistant('a1'), 'a1')).toBe(true)
  })

  it('resolveAnchorTurnIndex ignores unknown-role turns and never resolves their id', () => {
    // buildContextTurns ignores unknown roles, so they produce no turn
    const unknownMsg: any = {
      id: 'x-null',
      role: null,
      assistantId: 'a1',
      topicId: 't1',
      createdAt: '2026-07-23T00:00:00.000Z',
      status: UserMessageStatus.SUCCESS,
      blocks: []
    }
    const toolMsg: any = {
      id: 'x-tool',
      role: 'tool',
      assistantId: 'a1',
      topicId: 't1',
      createdAt: '2026-07-23T00:00:00.000Z',
      status: UserMessageStatus.SUCCESS,
      blocks: []
    }
    // Mix unknown rows between valid turns: they should not create turns nor be resolvable
    const messages: Message[] = [user('u1'), unknownMsg, toolMsg, assistant('a1', 'u1'), user('u2')]
    const turns = buildContextTurns(messages as any)
    // Turns should be only user u1 + assistant a1 merged, and user u2 => 2 turns, no unknown turns
    expect(turns).toHaveLength(2)
    // Unknown ids must not resolve
    expect(resolveAnchorTurnIndex(turns, 'x-null')).toBe(-1)
    expect(resolveAnchorTurnIndex(turns, 'x-tool')).toBe(-1)
    // Valid still resolves
    expect(resolveAnchorTurnIndex(turns, 'u1')).toBe(0)
    expect(resolveAnchorTurnIndex(turns, 'u2')).toBe(1)
  })

  it('buildContextTurns ignores unknown roles and preserves consecutive assistant grouping', () => {
    const unknownNull: any = {
      id: 'x-null',
      role: null,
      assistantId: 'a1',
      topicId: 't1',
      createdAt: '2026-07-23T00:00:00.000Z',
      status: UserMessageStatus.SUCCESS,
      blocks: []
    }
    const messages: Message[] = [user('u1'), unknownNull, assistant('a1', 'u1')]
    const turns = buildContextTurns(messages as any)
    // a1 with askId u1 should still join u1 despite unknown row in between (ignored for turn construction)
    expect(turns).toHaveLength(1)
    expect(turns[0].messages.map((m) => m.id)).toEqual(['u1', 'a1'])
  })
})
