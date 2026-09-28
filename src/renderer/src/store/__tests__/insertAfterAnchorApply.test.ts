/**
 * applyInsertedMessagesAfterAnchor — authoritative insert application.
 *
 * Verifies the single reducer path applies canonical message data +
 * stable-neighbor placement + same-route capability atomically:
 * - branch suffix-start placement after the resident predecessor with
 *   immediate mutability (the reported branch case);
 * - conservative append when neither neighbor is resident (no false exact
 *   position, capability still published);
 * - route mismatch fails closed (no order, no capability change).
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

function residentState() {
  let s = reducer(undefined, { type: '@@init' } as never)
  s = reducer(
    s,
    newMessagesActions.rebaseRouteMessages({
      topicId: 't1',
      messages: [msg('m0'), msg('m1'), msg('c0')],
      route: 'b1',
      mutableMessageIds: ['c0']
    })
  )
  return s
}

describe('applyInsertedMessagesAfterAnchor', () => {
  it('applies suffix-start placement with immediate capability (branch case)', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessagesAfterAnchor({
        topicId: 't1',
        route: 'b1',
        messages: [msg('n1'), msg('n2')],
        beforeMessageId: 'm1',
        nextMessageId: 'c0',
        insertedMessageIds: ['n1', 'n2'],
        mutableMessageIds: ['n1', 'n2']
      })
    )
    // Durable order: prefix through branch anchor, then new rows, then previous suffix.
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'n1', 'n2', 'c0'])
    // Immediate Main-authoritative mutability for the new rows (no route switch needed).
    expect(new Set(selectMutableMessageIdsForTopicShim(s, 't1', 'b1'))).toEqual(new Set(['c0', 'n1', 'n2']))
    expect(isMutableShim(s, 't1', 'n1', 'b1')).toBe(true)
    expect(isMutableShim(s, 't1', 'n2', 'b1')).toBe(true)
    // Ancestor references stay immutable.
    expect(isMutableShim(s, 't1', 'm1', 'b1')).toBe(false)
  })

  it('falls back to conservative append when neither neighbor is resident', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessagesAfterAnchor({
        topicId: 't1',
        route: 'b1',
        messages: [msg('n1')],
        beforeMessageId: 'ghost-before',
        nextMessageId: 'ghost-next',
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1']
      })
    )
    // No false exact position: appended for visibility; capability still published.
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'c0', 'n1'])
    expect(isMutableShim(s, 't1', 'n1', 'b1')).toBe(true)
  })

  it('route mismatch fails closed (no order, no capability)', () => {
    let s = residentState()
    const before = s.messageIdsByTopic['t1']
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessagesAfterAnchor({
        topicId: 't1',
        route: 'other-branch',
        messages: [msg('n1')],
        beforeMessageId: 'm1',
        nextMessageId: 'c0',
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(before)
    expect(s.entities['n1']).toBeUndefined()
    expect(s.mutableRouteByTopic['t1']).toBe('b1')
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['c0'])
  })

  it('never unions guessed ids outside the authoritative delta', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessagesAfterAnchor({
        topicId: 't1',
        route: 'b1',
        messages: [msg('n1')],
        beforeMessageId: 'm1',
        nextMessageId: 'c0',
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1']
      })
    )
    // Only the Main delta joins; ancestor refs are not inferred mutable.
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('m1')
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('m0')
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
