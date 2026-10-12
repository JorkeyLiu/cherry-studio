/**
 * applyInsertedMessageGroups — authoritative batch insert application.
 *
 * Verifies the single batch reducer path applies canonical rows + stable
 * per-group placement + same-route capability atomically:
 * - prior same-route capability retained, inserted delta unioned (trimmed);
 * - route mismatch fails closed with zero change and no capability leak;
 * - filtered undo subsets project only visible runs in authority order;
 * - non-tail runs with nonresident neighbors inject nothing;
 * - tail runs append; empty visible runs inject nothing.
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
      messages: [msg('m0'), msg('m1'), msg('m2')],
      route: null,
      mutableMessageIds: ['m0']
    })
  )
  return s
}

describe('applyInsertedMessageGroups', () => {
  it('retains prior capability and unions the inserted delta atomically', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('n1')],
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1'],
        groups: [{ insertedMessageIds: ['n1'], beforeMessageId: 'm1', nextMessageId: 'm2', visibleMessageIds: ['n1'] }]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'n1', 'm2'])
    expect(new Set(selectMutableMessageIdsForTopicShim(s, 't1', null))).toEqual(new Set(['m0', 'n1']))
    expect(isMutableShim(s, 't1', 'n1', null)).toBe(true)
  })

  it('route mismatch fails closed with zero change and no capability leak', () => {
    let s = residentState()
    const before = s.messageIdsByTopic['t1']
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: 'branch-x',
        messages: [msg('n1')],
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1'],
        groups: [{ insertedMessageIds: ['n1'], beforeMessageId: 'm1', nextMessageId: 'm2', visibleMessageIds: ['n1'] }]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(before)
    expect(s.entities['n1']).toBeUndefined()
    expect(s.mutableRouteByTopic['t1']).toBeNull()
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m0'])
  })

  it('projects only the filtered undo subset in authority order (partial run)', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('r1'), msg('r2'), msg('r3')],
        insertedMessageIds: ['r1', 'r2', 'r3'],
        mutableMessageIds: ['r1', 'r2', 'r3'],
        groups: [
          {
            insertedMessageIds: ['r1', 'r2', 'r3'],
            beforeMessageId: 'm1',
            nextMessageId: 'm2',
            visibleMessageIds: ['r1', 'r3']
          }
        ]
      })
    )
    // Only loaded-intersection rows enter, preserving authority order; r2 (outside-loaded) never injected.
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'r1', 'r3', 'm2'])
    expect(s.entities['r2']).toBeUndefined()
    expect(isMutableShim(s, 't1', 'r1', null)).toBe(true)
    expect(isMutableShim(s, 't1', 'r3', null)).toBe(true)
  })

  it('non-tail run with nonresident neighbors injects nothing', () => {
    let s = residentState()
    const before = [...s.messageIdsByTopic['t1']]
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('n1')],
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1'],
        groups: [
          {
            insertedMessageIds: ['n1'],
            beforeMessageId: 'ghost-before',
            nextMessageId: 'ghost-next',
            visibleMessageIds: ['n1']
          }
        ]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(before)
    // Capability still unions the delta trimmed to resident (n1 not resident → no leak).
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m0'])
  })

  it('tail run appends and empty visible injects nothing', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('t1-n'), msg('empty-n')],
        insertedMessageIds: ['t1-n', 'empty-n'],
        mutableMessageIds: ['t1-n', 'empty-n'],
        groups: [
          { insertedMessageIds: ['t1-n'], beforeMessageId: 'm2', nextMessageId: null, visibleMessageIds: ['t1-n'] },
          { insertedMessageIds: ['empty-n'], beforeMessageId: null, nextMessageId: null, visibleMessageIds: [] }
        ]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'm2', 't1-n'])
    expect(isMutableShim(s, 't1', 't1-n', null)).toBe(true)
    expect(s.entities['empty-n']).toBeUndefined()
  })

  it('never unions guessed ids outside the authoritative delta', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('n1')],
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1', 'm1', 'ghost'],
        groups: [{ insertedMessageIds: ['n1'], beforeMessageId: 'm1', nextMessageId: 'm2', visibleMessageIds: ['n1'] }]
      })
    )
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('m1')
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('ghost')
    expect(s.mutableMessageIdsByTopic['t1']).toContain('n1')
  })

  it('visible middle sandwich through invisible same-batch siblings projects once with capability', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('g0a'), msg('mid'), msg('g2a')],
        insertedMessageIds: ['g0a', 'mid', 'g2a'],
        mutableMessageIds: ['g0a', 'mid', 'g2a'],
        groups: [
          { insertedMessageIds: ['g0a'], beforeMessageId: 'm1', nextMessageId: 'mid', visibleMessageIds: [] },
          { insertedMessageIds: ['mid'], beforeMessageId: 'g0a', nextMessageId: 'g2a', visibleMessageIds: ['mid'] },
          { insertedMessageIds: ['g2a'], beforeMessageId: 'mid', nextMessageId: 'm2', visibleMessageIds: [] }
        ]
      })
    )
    // Physical [m0,m1,g0a,mid,g2a,m2]; only the loaded middle row enters, once.
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'mid', 'm2'])
    expect(s.entities['mid']).toBeDefined()
    expect(isMutableShim(s, 't1', 'mid', null)).toBe(true)
    // Invisible same-batch siblings are never injected and never gain capability.
    expect(s.entities['g0a']).toBeUndefined()
    expect(s.entities['g2a']).toBeUndefined()
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('g0a')
    expect(s.mutableMessageIdsByTopic['t1']).not.toContain('g2a')
  })

  it('multi-visible chain preserves Main physical order independent of request order', () => {
    let s = residentState()
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        // Flat request order [a,b] differs from Main physical [b,a].
        messages: [msg('a'), msg('b')],
        insertedMessageIds: ['a', 'b'],
        mutableMessageIds: ['a', 'b'],
        groups: [
          { insertedMessageIds: ['a'], beforeMessageId: 'b', nextMessageId: 'm2', visibleMessageIds: ['a'] },
          { insertedMessageIds: ['b'], beforeMessageId: 'm1', nextMessageId: 'a', visibleMessageIds: ['b'] }
        ]
      })
    )
    // Main physical [m0,m1,b,a,m2] wins over request-group order; each once.
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'b', 'a', 'm2'])
    expect(isMutableShim(s, 't1', 'a', null)).toBe(true)
    expect(isMutableShim(s, 't1', 'b', null)).toBe(true)
  })

  it('genuine external missing anchor injects nothing with no invisible injection', () => {
    let s = residentState()
    const before = [...s.messageIdsByTopic['t1']]
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('n1')],
        insertedMessageIds: ['n1'],
        mutableMessageIds: ['n1'],
        groups: [
          {
            insertedMessageIds: ['n1'],
            beforeMessageId: 'ghost-before',
            nextMessageId: 'ghost-next',
            visibleMessageIds: ['n1']
          }
        ]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(before)
    // Placed-only upsert: skipped rows leave no orphan entities.
    expect(s.entities['n1']).toBeUndefined()
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m0'])
  })

  it('tail ghost and batch cycle fail closed with no tail fallback', () => {
    let s = residentState()
    const before = [...s.messageIdsByTopic['t1']]
    s = reducer(
      s,
      newMessagesActions.applyInsertedMessageGroups({
        topicId: 't1',
        route: null,
        messages: [msg('t-ghost'), msg('c0'), msg('c1')],
        insertedMessageIds: ['t-ghost', 'c0', 'c1'],
        mutableMessageIds: ['t-ghost', 'c0', 'c1'],
        groups: [
          {
            insertedMessageIds: ['t-ghost'],
            beforeMessageId: 'ghost-before',
            nextMessageId: null,
            visibleMessageIds: ['t-ghost']
          },
          {
            insertedMessageIds: ['c0'],
            beforeMessageId: 'c1',
            nextMessageId: 'ghost-a',
            visibleMessageIds: ['c0']
          },
          {
            insertedMessageIds: ['c1'],
            beforeMessageId: 'c0',
            nextMessageId: 'ghost-b',
            visibleMessageIds: ['c1']
          }
        ]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(before)
    expect(s.entities['t-ghost']).toBeUndefined()
    expect(s.entities['c0']).toBeUndefined()
    expect(s.entities['c1']).toBeUndefined()
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m0'])
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
