/**
 * applyAppendAcknowledgment — Main-issued append acknowledgment application.
 *
 * Verifies the single reducer path installs one ordinary-send row plus its
 * authoritative capability atomically (no reload needed for mutability):
 * - fresh topics publish row + capability in one commit;
 * - sequential user/assistant acknowledgments union same-route;
 * - route mismatch fails closed (no row, no capability change);
 * - the delta is trimmed to created ∩ resident IDs (no guessing);
 * - existing-id patches retain existing capability and stay idempotent.
 */
import reducer, {
  newMessagesActions,
  selectIsMessageMutable,
  selectMutableMessageIdsForTopic
} from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

function msg(id: string): Message {
  return { id, topicId: 't1' } as unknown as Message
}

describe('applyAppendAcknowledgment', () => {
  it('publishes a fresh-topic row with immediate capability (no reload)', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: msg('u1'),
        createdMessageIds: ['u1'],
        mutableMessageIds: ['u1']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['u1'])
    expect(s.entities['u1']?.id).toBe('u1')
    expect(s.mutableRouteByTopic['t1']).toBeNull()
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['u1'])
    expect(isMutableShim(s, 't1', 'u1', null)).toBe(true)
  })

  it('unions sequential user + assistant acknowledgments same-route', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: msg('u1'),
        createdMessageIds: ['u1'],
        mutableMessageIds: ['u1']
      })
    )
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: msg('a1'),
        createdMessageIds: ['a1'],
        mutableMessageIds: ['a1']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['u1', 'a1'])
    expect(new Set(selectMutableMessageIdsForTopicShim(s, 't1', null))).toEqual(new Set(['u1', 'a1']))
    expect(isMutableShim(s, 't1', 'u1', null)).toBe(true)
    expect(isMutableShim(s, 't1', 'a1', null)).toBe(true)
  })

  it('route mismatch fails closed (no row, no capability change)', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('c0')],
        route: 'b1',
        mutableMessageIds: ['c0']
      })
    )
    const before = s.messageIdsByTopic['t1']
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: 'other-branch',
        message: msg('n1'),
        createdMessageIds: ['n1'],
        mutableMessageIds: ['n1']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(before)
    expect(s.entities['n1']).toBeUndefined()
    expect(s.mutableRouteByTopic['t1']).toBe('b1')
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['c0'])
  })

  it('trims the delta to created ∩ resident IDs (no guessing)', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: msg('u1'),
        createdMessageIds: ['u1'],
        mutableMessageIds: ['u1', 'ghost', 'm0']
      })
    )
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['u1'])
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('ghost')
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('m0')
  })

  it('existing-id patches retain existing capability and stay idempotent', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: msg('u1'),
        createdMessageIds: ['u1'],
        mutableMessageIds: ['u1']
      })
    )
    // Same id re-applied as a patch (empty delta): row kept, capability kept.
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: msg('u1'),
        createdMessageIds: [],
        mutableMessageIds: []
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['u1'])
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['u1'])
    expect(isMutableShim(s, 't1', 'u1', null)).toBe(true)
    // Full re-application of the original ack never duplicates.
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: msg('u1'),
        createdMessageIds: ['u1'],
        mutableMessageIds: ['u1']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['u1'])
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['u1'])
  })

  it('rejects a malformed message without touching state', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    const before = s
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgment({
        topicId: 't1',
        route: null,
        message: { topicId: 't1' } as unknown as Message,
        createdMessageIds: [],
        mutableMessageIds: []
      })
    )
    expect(s).toBe(before)
  })
})

function selectMutableMessageIdsForTopicShim(
  s: ReturnType<typeof reducer>,
  topicId: string,
  route: string | null
): readonly string[] | undefined {
  return selectMutableMessageIdsForTopic(
    {
      messages: s,
      residentRegistry: { entries: { [topicId]: { residentTopic: true } } }
    } as never,
    topicId,
    route
  )
}

function isMutableShim(
  s: ReturnType<typeof reducer>,
  topicId: string,
  messageId: string,
  route: string | null
): boolean {
  return selectIsMessageMutable(
    {
      messages: s,
      residentRegistry: { entries: { [topicId]: { residentTopic: true } } }
    } as never,
    topicId,
    messageId,
    route
  )
}
