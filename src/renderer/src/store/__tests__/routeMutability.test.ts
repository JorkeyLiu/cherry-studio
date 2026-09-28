/**
 * Route mutability capability (renderer runtime, never persisted).
 *
 * - rebase replaces atomically (route + set); absent clears fail-closed.
 * - merge unions same-route, replaces on route mismatch (no cross-route reuse).
 * - remove/prune paths drop IDs; route switch never reuses the old set.
 * - Selectors are fail-closed on unknown/stale/route-mismatch/non-resident.
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

function stateWithLoaded(topicId: string, ids: string[], entities?: Record<string, Message>) {
  const base = reducer(undefined, { type: '@@init' } as never)
  const withMessages = reducer(
    base,
    newMessagesActions.messagesReceived({ topicId, messages: ids.map((id) => entities?.[id] ?? msg(id)) })
  )
  return withMessages
}

describe('route mutability capability', () => {
  it('rebase publishes capability atomically; removed IDs are pruned', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1', 'm2'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m0', 'm1', 'mX']
      })
    )
    // mX pruned (not resident); route stored.
    expect(s.mutableRouteByTopic['t1']).toBeNull()
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m0', 'm1'])
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1'])
  })

  it('rebase without capability clears fail-closed (no cross-route reuse)', () => {
    let s = stateWithLoaded('t1', ['m0'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0')],
        route: 'b1',
        mutableMessageIds: ['m0']
      })
    )
    expect(selectMutableMessageIdsForTopicShim(s, 't1', 'b1')).toEqual(['m0'])
    s = reducer(s, newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [msg('m0')] }))
    expect(s.mutableMessageIdsByTopic['t1']).toBeUndefined()
    expect(s.mutableRouteByTopic['t1']).toBeUndefined()
  })

  it('merge unions same-route and replaces on route mismatch', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1', 'm2'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0')],
        route: null,
        mutableMessageIds: ['m0']
      })
    )
    s = reducer(s, newMessagesActions.mergeRouteMutability({ topicId: 't1', route: null, mutableMessageIds: ['m1'] }))
    expect(new Set(s.mutableMessageIdsByTopic['t1'])).toEqual(new Set(['m0', 'm1']))
    // Route switch replaces atomically.
    s = reducer(s, newMessagesActions.mergeRouteMutability({ topicId: 't1', route: 'b1', mutableMessageIds: ['c0'] }))
    expect(s.mutableRouteByTopic['t1']).toBe('b1')
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['c0'])
  })

  it('remove paths prune the capability set', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m0', 'm1']
      })
    )
    s = reducer(s, newMessagesActions.removeMessage({ topicId: 't1', messageId: 'm0' }))
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m1'])
    s = reducer(s, newMessagesActions.removeMessages({ topicId: 't1', messageIds: ['m1'] }))
    expect(s.mutableMessageIdsByTopic['t1']).toEqual([])
  })

  it('invalidate clears the resident capability', () => {
    let s = stateWithLoaded('t1', ['m0'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0')],
        route: null,
        mutableMessageIds: ['m0']
      })
    )
    s = reducer(s, newMessagesActions.invalidateRouteMutability({ topicId: 't1' }))
    expect(s.mutableMessageIdsByTopic['t1']).toBeUndefined()
  })

  it('selectors fail closed on route mismatch, unknown, and non-resident IDs', () => {
    // Build a resident state via the real joint-publish path shape.
    let s = stateWithLoaded('t1', ['m0', 'm1'])
    s = {
      ...s,
      mutableRouteByTopic: { t1: null },
      mutableMessageIdsByTopic: { t1: ['m1'] }
    }
    const root = (extra: object) =>
      ({
        messages: s,
        residentRegistry: { entries: { t1: { residentTopic: true } } },
        ...extra
      }) as never
    // Owned-unshared + resident: mutable.
    expect(selectIsMessageMutable(root({}), 't1', 'm1', null)).toBe(true)
    // Inherited/shared (absent from set): immutable.
    expect(selectIsMessageMutable(root({}), 't1', 'm0', null)).toBe(false)
    // Route mismatch (active branch, stored main): fail-closed.
    expect(selectIsMessageMutable(root({}), 't1', 'm1', 'b1')).toBe(false)
    // Unknown capability: fail-closed.
    const noCap = { ...s, mutableMessageIdsByTopic: {}, mutableRouteByTopic: {} }
    expect(
      selectIsMessageMutable(
        { messages: noCap, residentRegistry: { entries: { t1: { residentTopic: true } } } } as never,
        't1',
        'm1',
        null
      )
    ).toBe(false)
    // Non-resident topic: fail-closed.
    expect(selectIsMessageMutable({ messages: s, residentRegistry: { entries: {} } } as never, 't1', 'm1', null)).toBe(
      false
    )
  })

  it('main-null ownership resolves through the capability, not branchId guessing', () => {
    const s = {
      ...stateWithLoaded('t1', ['m0']),
      mutableRouteByTopic: { t1: null },
      mutableMessageIdsByTopic: { t1: ['m0'] }
    }
    const root = { messages: s, residentRegistry: { entries: { t1: { residentTopic: true } } } } as never
    expect(selectIsMessageMutable(root, 't1', 'm0', null)).toBe(true)
    expect(selectMutableMessageIdsForTopic(root, 't1', null)).toEqual(['m0'])
  })
})

describe('messagesWindowMerged (atomic pagination merge)', () => {
  it('older merge installs merged order + unions same-route capability in one commit', () => {
    let s = stateWithLoaded('t1', ['m2', 'm3'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m2'), msg('m3')],
        route: null,
        mutableMessageIds: ['m2']
      })
    )
    // Pagination older window brings m0/m1 with capability for m0/m1.
    s = reducer(
      s,
      newMessagesActions.messagesWindowMerged({
        topicId: 't1',
        messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')],
        route: null,
        mutableMessageIds: ['m0', 'm1']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(s.mutableRouteByTopic['t1']).toBeNull()
    expect(new Set(s.mutableMessageIdsByTopic['t1'])).toEqual(new Set(['m0', 'm1', 'm2']))
  })

  it('newer merge retains old capability and adds new capability', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m0']
      })
    )
    s = reducer(
      s,
      newMessagesActions.messagesWindowMerged({
        topicId: 't1',
        messages: [msg('m0'), msg('m1'), msg('m2')],
        route: null,
        mutableMessageIds: ['m2']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'm1', 'm2'])
    expect(new Set(s.mutableMessageIdsByTopic['t1'])).toEqual(new Set(['m0', 'm2']))
  })

  it('route mismatch adopts only the response capability (no cross-route leak)', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m0', 'm1']
      })
    )
    s = reducer(
      s,
      newMessagesActions.messagesWindowMerged({
        topicId: 't1',
        messages: [msg('m0'), msg('c0')],
        route: 'b1',
        mutableMessageIds: ['c0']
      })
    )
    expect(s.mutableRouteByTopic['t1']).toBe('b1')
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['c0'])
    expect(s.messageIdsByTopic['t1']).toEqual(['m0', 'c0'])
  })

  it('empty response capability retains same-route resident capability', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m0', 'm1']
      })
    )
    s = reducer(
      s,
      newMessagesActions.messagesWindowMerged({
        topicId: 't1',
        messages: [msg('m0'), msg('m1'), msg('m2')],
        route: null,
        mutableMessageIds: []
      })
    )
    expect(s.mutableRouteByTopic['t1']).toBeNull()
    expect(new Set(s.mutableMessageIdsByTopic['t1'])).toEqual(new Set(['m0', 'm1']))
  })

  it('rebase still precisely replaces (empty clears) while merge retains', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m0', 'm1']
      })
    )
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0')],
        route: null,
        mutableMessageIds: []
      })
    )
    expect(s.mutableMessageIdsByTopic['t1']).toEqual([])
  })

  it('incoming IDs outside the merged resident are trimmed; leaving IDs are pruned with entities', () => {
    let s = stateWithLoaded('t1', ['m0', 'm1'])
    s = reducer(
      s,
      newMessagesActions.rebaseRouteMessages({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m0', 'm1']
      })
    )
    // Response claims mX (not resident) plus m1; merged drops m0.
    s = reducer(
      s,
      newMessagesActions.messagesWindowMerged({
        topicId: 't1',
        messages: [msg('m1'), msg('m2')],
        route: null,
        mutableMessageIds: ['m1', 'mX']
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['m1', 'm2'])
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m1'])
    expect(s.entities['m0']).toBeUndefined()
    expect(s.entities['m1']).toBeTruthy()
  })

  it('first window merge without stored capability adopts the response set', () => {
    let s = stateWithLoaded('t1', ['m0'])
    // messagesReceived clears capability; first pagination adopts.
    expect(s.mutableMessageIdsByTopic['t1']).toBeUndefined()
    s = reducer(
      s,
      newMessagesActions.messagesWindowMerged({
        topicId: 't1',
        messages: [msg('m0'), msg('m1')],
        route: null,
        mutableMessageIds: ['m1']
      })
    )
    expect(s.mutableRouteByTopic['t1']).toBeNull()
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['m1'])
  })
})

function selectMutableMessageIdsForTopicShim(s: ReturnType<typeof reducer>, topicId: string, route: string | null) {
  const root = { messages: s, residentRegistry: { entries: { [topicId]: { residentTopic: true } } } } as never
  return selectMutableMessageIdsForTopic(root, topicId, route)
}
