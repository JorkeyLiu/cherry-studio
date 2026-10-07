/**
 * applyAppendAcknowledgments — plural Main-issued append acknowledgment batch.
 *
 * Verifies the single-commit plural path installs every stub row plus the
 * unioned same-route capability atomically with the exact singular guard
 * semantics per entry:
 * - one commit installs N rows + unioned capability (no transient frames);
 * - per-entry delta trimmed to created ∩ resident IDs (no guessing);
 * - route mismatch fails the WHOLE batch closed (no row, no capability);
 * - malformed entries are skipped without discarding valid siblings;
 * - duplicate rows never append twice; replay stays idempotent.
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

function mutableOf(s: ReturnType<typeof reducer>, topicId: string, route: string | null) {
  return selectMutableMessageIdsForTopic(
    {
      messages: s,
      residentRegistry: { entries: { [topicId]: { residentTopic: true } } }
    } as never,
    topicId,
    route
  )
}

function isMutable(s: ReturnType<typeof reducer>, topicId: string, messageId: string, route: string | null) {
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

describe('applyAppendAcknowledgments', () => {
  it('installs N rows plus unioned same-route capability in one commit', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgments({
        topicId: 't1',
        route: null,
        entries: [
          { message: msg('a1'), createdMessageIds: ['a1'], mutableMessageIds: ['a1'] },
          { message: msg('a2'), createdMessageIds: ['a2'], mutableMessageIds: ['a2'] }
        ]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['a1', 'a2'])
    expect(new Set(mutableOf(s, 't1', null))).toEqual(new Set(['a1', 'a2']))
    expect(isMutable(s, 't1', 'a1', null)).toBe(true)
    expect(isMutable(s, 't1', 'a2', null)).toBe(true)
  })

  it('matches sequential singular commits (row order + capability union)', () => {
    const entries = [
      { message: msg('a1'), createdMessageIds: ['a1'], mutableMessageIds: ['a1'] },
      { message: msg('a2'), createdMessageIds: ['a2'], mutableMessageIds: ['a2'] }
    ]
    let batch = reducer(undefined, { type: '@@init' } as never)
    batch = reducer(batch, newMessagesActions.applyAppendAcknowledgments({ topicId: 't1', route: null, entries }))
    let sequential = reducer(undefined, { type: '@@init' } as never)
    for (const e of entries) {
      sequential = reducer(
        sequential,
        newMessagesActions.applyAppendAcknowledgment({
          topicId: 't1',
          route: null,
          message: e.message,
          createdMessageIds: e.createdMessageIds,
          mutableMessageIds: e.mutableMessageIds
        })
      )
    }
    expect(batch.messageIdsByTopic['t1']).toEqual(sequential.messageIdsByTopic['t1'])
    expect(new Set(mutableOf(batch, 't1', null))).toEqual(new Set(mutableOf(sequential, 't1', null)))
  })

  it('route mismatch fails the whole batch closed (no row, no capability change)', () => {
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
      newMessagesActions.applyAppendAcknowledgments({
        topicId: 't1',
        route: 'other-branch',
        entries: [{ message: msg('n1'), createdMessageIds: ['n1'], mutableMessageIds: ['n1'] }]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(before)
    expect(s.entities['n1']).toBeUndefined()
    expect(s.mutableRouteByTopic['t1']).toBe('b1')
    expect(s.mutableMessageIdsByTopic['t1']).toEqual(['c0'])
  })

  it('skips malformed entries without discarding valid siblings', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgments({
        topicId: 't1',
        route: null,
        entries: [
          { message: msg('a1'), createdMessageIds: ['a1'], mutableMessageIds: ['a1'] },
          { message: { topicId: 't1' } as unknown as Message, createdMessageIds: [], mutableMessageIds: [] },
          { message: msg('a2'), createdMessageIds: ['a2'], mutableMessageIds: ['a2'] }
        ]
      })
    )
    expect(s.messageIdsByTopic['t1']).toEqual(['a1', 'a2'])
    expect(new Set(mutableOf(s, 't1', null))).toEqual(new Set(['a1', 'a2']))
  })

  it('trims each delta to created ∩ resident IDs (no guessing)', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    s = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgments({
        topicId: 't1',
        route: null,
        entries: [{ message: msg('a1'), createdMessageIds: ['a1'], mutableMessageIds: ['a1', 'ghost', 'm0'] }]
      })
    )
    expect(mutableOf(s, 't1', null)).toEqual(['a1'])
  })

  it('never appends duplicate rows and stays idempotent on replay', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    const batch = {
      topicId: 't1',
      route: null,
      entries: [
        { message: msg('a1'), createdMessageIds: ['a1'], mutableMessageIds: ['a1'] },
        { message: msg('a1'), createdMessageIds: ['a1'], mutableMessageIds: ['a1'] },
        { message: msg('a2'), createdMessageIds: ['a2'], mutableMessageIds: ['a2'] }
      ]
    }
    s = reducer(s, newMessagesActions.applyAppendAcknowledgments({ ...batch, entries: [...batch.entries] }))
    expect(s.messageIdsByTopic['t1']).toEqual(['a1', 'a2'])
    const replayed = reducer(
      s,
      newMessagesActions.applyAppendAcknowledgments({ ...batch, entries: [...batch.entries] })
    )
    expect(replayed.messageIdsByTopic['t1']).toEqual(['a1', 'a2'])
    expect(new Set(mutableOf(replayed, 't1', null))).toEqual(new Set(['a1', 'a2']))
  })

  it('empty batch is a no-op', () => {
    let s = reducer(undefined, { type: '@@init' } as never)
    const before = s
    s = reducer(s, newMessagesActions.applyAppendAcknowledgments({ topicId: 't1', route: null, entries: [] }))
    expect(s).toBe(before)
  })
})
