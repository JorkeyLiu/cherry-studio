import type { Message } from '@renderer/types/newMessage'

/**
 * A ContextTurn groups consecutive messages into a semantic "turn" —
 * a user question and the assistant responses that belong to it,
 * or a standalone system message.
 *
 * Invariants:
 *   - `key` is the semantic group identifier: user.id for user-initiated turns,
 *     askId for assistant-initiated turns, the assistant's own id if no askId,
 *     or the message id for standalone system messages.
 *   - `messages` preserves chronological order and contains ALL messages in the turn
 *     (no filtering of error-only, empty, pending, tool, or reasoning messages).
 *   - Turns are ordered chronologically by their first message.
 *   - Only consecutive messages may join a turn; non-consecutive messages with the
 *     same askId create a separate turn.
 *   - System messages each produce a single-message turn keyed by their own id,
 *     ensuring no product messages are silently dropped.
 */
export interface ContextTurn {
  /** Semantic group key: user.id, askId, orphan assistant id, or system message id */
  readonly key: string
  /** All messages in this turn, in chronological order */
  readonly messages: readonly Message[]
}

/**
 * Mutable internal variant used only during construction to allow `.push()`.
 * The public {@link ContextTurn} exposes `messages` as `readonly Message[]`.
 */
interface MutableContextTurn {
  readonly key: string
  readonly messages: Message[]
}

/**
 * Builds ContextTurns from chronological messages.
 *
 * Construction rules:
 *   1. A user message starts a new turn keyed by its own id.
 *   2. An assistant message with askId matching the current turn's key
 *      joins that turn (consecutive retry).
 *   3. An assistant message with a different or missing askId starts a
 *      new turn: keyed by askId if present, otherwise by its own id.
 *   4. Adjacent user messages each start their own separate turn.
 *   5. A system message produces a standalone single-message turn keyed by
 *      its own id, so that no product messages are lost.
 *   6. Only consecutive messages may join; non-consecutive same askId
 *      creates a separate turn.
 *
 * All real turns in the topic participate — there is no clear-marker
 * trimming at this layer.
 *
 * This is a pure function with no side effects and no store dependencies.
 */
export function buildContextTurns(messages: Message[]): ContextTurn[] {
  const turns: MutableContextTurn[] = []
  let currentTurnKey: string | null = null

  for (const message of messages) {
    if (message.role === 'system') {
      // System messages are standalone turns — each keyed by its own id.
      // This ensures no product messages are silently dropped.
      currentTurnKey = message.id
      turns.push({ key: currentTurnKey, messages: [message] })
    } else if (message.role === 'user') {
      // User always starts a new turn keyed by its own id
      currentTurnKey = message.id
      turns.push({ key: currentTurnKey, messages: [message] })
    } else if (message.role === 'assistant') {
      if (message.askId && message.askId === currentTurnKey) {
        // Consecutive assistant with askId matching the current turn → join it
        turns[turns.length - 1].messages.push(message)
      } else {
        // Non-consecutive, different askId, or no askId → new turn
        if (message.askId) {
          currentTurnKey = message.askId
        } else {
          currentTurnKey = message.id
        }
        turns.push({ key: currentTurnKey, messages: [message] })
      }
    }
  }

  return turns
}

/**
 * Locates the index of the anchor turn in the given ContextTurn array.
 *
 * Resolution order (LOCK-FIX-1, LOCK-FIX-2):
 *   1. Prefer the turn containing a user message whose id equals groupKey —
 *      the canonical group key of a user-initiated turn.
 *   2. If no such user turn exists, fall back to the first turn containing
 *      an assistant message whose askId equals groupKey — this keeps legacy
 *      (migration 216) and manually persisted askId anchors resolvable,
 *      including orphan assistant turns whose user question is absent.
 *   3. If neither matches, fall back to the turn containing a non-user message
 *      whose OWN id equals groupKey. This resolves the anchor keys derived for
 *      orphan-assistant turns (keyed by their own id when askId is missing) and
 *      standalone system turns (keyed by their own id).
 *   4. Return -1 when nothing matches.
 *
 * The anchor key derived for every turn kind is exactly a message id within
 * that turn, so the resolver makes each turn round-trip to itself. The
 * ordering matters for collisions: a key that is both a user id and
 * an assistant askId (a non-consecutive assistant referencing an earlier user
 * question) must NOT be claimed by a generic turn-key match — the existing
 * preferred user-id / assistant-askId semantics (rules 1-2) always win, and the
 * generic message-id fallback (rule 3) only ever matches message ids that rules
 * 1-2 cannot (message ids are unique, so they cannot collide across turns).
 */
export function resolveAnchorTurnIndex(turns: readonly ContextTurn[], groupKey: string): number {
  // 1. Prefer user-initiated turn: contains a user message with id === groupKey
  const userTurnIdx = turns.findIndex((t) => t.messages.some((m) => m.role === 'user' && m.id === groupKey))
  if (userTurnIdx >= 0) return userTurnIdx

  // 2. Fall back: turn containing an assistant message with askId === groupKey
  const assistantAskIdTurnIdx = turns.findIndex((t) =>
    t.messages.some((m) => m.role === 'assistant' && m.askId === groupKey)
  )
  if (assistantAskIdTurnIdx >= 0) return assistantAskIdTurnIdx

  // 3. Fall back: turn containing a non-user message whose own id === groupKey
  //    (orphan-assistant turn keyed by its own id, or standalone system turn).
  const messageIdTurnIdx = turns.findIndex((t) => t.messages.some((m) => m.role !== 'user' && m.id === groupKey))
  if (messageIdTurnIdx >= 0) return messageIdTurnIdx

  // 4. Not found
  return -1
}

/**
 * Expands selected turns back into a flat, chronological Message[].
 *
 * This is the inverse of buildContextTurns — given a subset of turns,
 * it produces the original message ordering for those turns.
 *
 * Useful for the next phase where turn-based context window selection
 * will need to convert selected turns back to Message[] for the SDK pipeline.
 */
export function turnsToMessages(turns: readonly ContextTurn[]): Message[] {
  const result: Message[] = []
  for (const turn of turns) {
    for (const message of turn.messages) {
      result.push(message)
    }
  }
  return result
}
