import {
  buildRouteViewport,
  chooseRouteWindowRequest,
  createTargetMessageWindow,
  diffRouteRebase,
  rebaseRouteWindow
} from '@renderer/pages/home/Messages/messageWindow'
import messagesReducer, { newMessagesActions } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

function msg(id: string): Message {
  return { id, role: 'user', topicId: 't1', createdAt: new Date().toISOString() } as unknown as Message
}

describe('route rebase pure diff (conservative, no mixed route)', () => {
  it('partial overlap: positional shared prefix proven, old exclusive suffix removed', () => {
    const oldIds = ['u1', 'a1', 'u2', 'a2-old', 'u3-old']
    const windowMsgs = [msg('u1'), msg('a1'), msg('u2'), msg('a2-new'), msg('u3-new')]
    const diff = diffRouteRebase(oldIds, windowMsgs)
    expect(diff.commonPrefixLen).toBe(3)
    expect(diff.removedIds.sort()).toEqual(['a2-old', 'u3-old'].sort())
    expect(diff.addedIds.sort()).toEqual(['a2-new', 'u3-new'].sort())
    // nextIds is exactly the target (valid route) order — never a union.
    expect(diff.nextIds).toEqual(['u1', 'a1', 'u2', 'a2-new', 'u3-new'])
  })

  it('identical routes are a no-op rebase (full prefix retained)', () => {
    const oldIds = ['u1', 'a1']
    const diff = diffRouteRebase(oldIds, [msg('u1'), msg('a1')])
    expect(diff.commonPrefixLen).toBe(2)
    expect(diff.removedIds).toEqual([])
    expect(diff.addedIds).toEqual([])
    expect(diff.nextIds).toEqual(oldIds)
  })

  it('disjoint branch tails drop the entire old suffix atomically', () => {
    const diff = diffRouteRebase(['u9', 'a9'], [msg('u1'), msg('a1')])
    expect(diff.commonPrefixLen).toBe(0)
    expect(diff.nextIds).toEqual(['u1', 'a1'])
    // No mixed route: nextIds contain only target window IDs.
    expect(diff.nextIds).not.toContain('u9')
  })

  it('window starting mid-route never retains the unprovable pre-window prefix', () => {
    // Old resident starts at m1; the target window starts mid-route at m2.
    // m1 cannot be proven to belong to the target route → degraded to the
    // target window only (no guessing of the non-overlapping prefix).
    const oldIds = ['m1', 'm2', 'm3', 'm4-old']
    const windowMsgs = [msg('m2'), msg('m3'), msg('m4-new')]
    const diff = diffRouteRebase(oldIds, windowMsgs)
    expect(diff.nextIds).toEqual(['m2', 'm3', 'm4-new'])
    expect(diff.nextIds).not.toContain('m1')
    expect(diff.nextIds).not.toContain('m4-old')
    expect(diff.removedIds).toContain('m1')
    expect(diff.removedIds).toContain('m4-old')
  })

  it('trimmed shared prefix: old resident missing the route head still rebases to the window', () => {
    // Old resident was trimmed (missing u1); the target window holds the full
    // head. The rebase must equal the window — no old-exclusive IDs survive.
    const oldIds = ['a1', 'u2', 'a2-old']
    const windowMsgs = [msg('u1'), msg('a1'), msg('u2'), msg('a2-new')]
    const diff = diffRouteRebase(oldIds, windowMsgs)
    expect(diff.nextIds).toEqual(['u1', 'a1', 'u2', 'a2-new'])
    expect(diff.removedIds).toEqual(['a2-old'])
  })

  it('old exclusive suffix is always removed, never retained', () => {
    const diff = diffRouteRebase(['u1', 'a1', 'u2-old'], [msg('u1'), msg('a1'), msg('u2-new')])
    expect(diff.nextIds).toEqual(['u1', 'a1', 'u2-new'])
    expect(diff.nextIds).not.toContain('u2-old')
    expect(diff.removedIds).toEqual(['u2-old'])
  })

  it('empty target window clears to [] (atomic clear, no residual)', () => {
    const diff = diffRouteRebase(['u1', 'a1'], [])
    expect(diff.nextIds).toEqual([])
    expect(diff.commonPrefixLen).toBe(0)
    expect(diff.removedIds.sort()).toEqual(['a1', 'u1'])
  })

  it('complete large group window rebases without loss (window contract, no perf claim)', () => {
    const oldIds = Array.from({ length: 100 }, (_, i) => `m${i}`)
    const windowMsgs = oldIds.map((id) => msg(id))
    const diff = diffRouteRebase(oldIds, windowMsgs)
    expect(diff.nextIds).toEqual(oldIds)
    expect(diff.commonPrefixLen).toBe(100)
    expect(diff.removedIds).toEqual([])
  })
})

describe('rebaseRouteWindow boundaries (resident == window, hasMore exact)', () => {
  it('retained prefix never extends coverage: hasMore rides through exactly', () => {
    const plan = rebaseRouteWindow(['u1', 'a1', 'u2', 'a2-old'], [msg('u1'), msg('a1'), msg('u2'), msg('a2-new')], {
      hasMoreBefore: true,
      hasMoreAfter: false
    })
    expect(plan.nextIds).toEqual(['u1', 'a1', 'u2', 'a2-new'])
    expect(plan.hasMoreBefore).toBe(true)
    expect(plan.hasMoreAfter).toBe(false)
    expect(plan.degraded).toBe(false)
  })

  it('response hasMoreBefore=false never combines with an extra retained prefix', () => {
    // Full-route window (no more before): resident starts exactly at the
    // window head, so false stays exact — no hidden retained head.
    const plan = rebaseRouteWindow(['u1', 'a1'], [msg('u1'), msg('a1')], {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expect(plan.nextIds[0]).toBe('u1')
    expect(plan.hasMoreBefore).toBe(false)
    expect(plan.hasMoreAfter).toBe(false)
  })

  it('disjoint / middle-start windows are flagged degraded (safe replacement)', () => {
    const plan = rebaseRouteWindow(['u9', 'a9'], [msg('u1'), msg('a1')], {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expect(plan.nextIds).toEqual(['u1', 'a1'])
    expect(plan.degraded).toBe(true)
    // Boundaries still ride through exactly (resident == window).
    expect(plan.hasMoreBefore).toBe(false)
    expect(plan.hasMoreAfter).toBe(false)
  })
})

describe('rebaseRouteMessages reducer (atomic, no blank, production diff path)', () => {
  function stateWith(t1: string[]) {
    return {
      ids: [...t1] as any,
      entities: Object.fromEntries(t1.map((id) => [id, msg(id)])) as any,
      messageIdsByTopic: { t1: [...t1], tOther: ['x1'] },
      // Production invariant (newMessage initialState): capability maps
      // always exist; absent capability clears fail-closed on rebase.
      mutableMessageIdsByTopic: {},
      mutableRouteByTopic: {},
      currentTopicId: 't1',
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10
    } as any
  }

  it('publishes target window in one commit without clearing other topics', () => {
    const s0 = messagesReducer(
      stateWith(['u1', 'a1', 'u2-old']),
      newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [msg('u1'), msg('a1'), msg('u2-new')] })
    )
    expect(s0.messageIdsByTopic['t1']).toEqual(['u1', 'a1', 'u2-new'])
    // Common entities retained (still present), other topics untouched.
    expect(s0.entities['u1']).toBeDefined()
    expect(s0.entities['a1']).toBeDefined()
    expect(s0.messageIdsByTopic['tOther']).toEqual(['x1'])
    // Topic stays fixed (no currentTopicId transition).
    expect(s0.currentTopicId).toBe('t1')
  })

  it('middle-start window drops the unprovable pre-window prefix via the reducer', () => {
    const s0 = messagesReducer(
      stateWith(['m1', 'm2', 'm3-old']),
      newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [msg('m2'), msg('m3-new')] })
    )
    expect(s0.messageIdsByTopic['t1']).toEqual(['m2', 'm3-new'])
    expect(s0.messageIdsByTopic['t1']).not.toContain('m1')
    expect(s0.messageIdsByTopic['t1']).not.toContain('m3-old')
  })

  it('empty target window atomically clears the topic projection', () => {
    const s0 = messagesReducer(
      stateWith(['u1', 'a1']),
      newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [] })
    )
    expect(s0.messageIdsByTopic['t1']).toEqual([])
    expect(s0.messageIdsByTopic['tOther']).toEqual(['x1'])
    expect(s0.currentTopicId).toBe('t1')
  })
})

describe('chooseRouteWindowRequest (top-selector choice, behavior)', () => {
  it('isAtBottom selects latest', () => {
    expect(chooseRouteWindowRequest({ scrollTop: 100, anchorId: 'u1', isAtBottom: true })).toEqual({ kind: 'latest' })
  })

  it('saved anchor selects around it', () => {
    expect(chooseRouteWindowRequest({ scrollTop: 10, anchorId: 'u2', isAtBottom: false })).toEqual({
      kind: 'around',
      anchorMessageId: 'u2'
    })
  })

  it('missing snapshot selects latest', () => {
    expect(chooseRouteWindowRequest(null)).toEqual({ kind: 'latest' })
    expect(chooseRouteWindowRequest({ scrollTop: 0, anchorId: null, isAtBottom: false })).toEqual({ kind: 'latest' })
  })
})

describe('buildRouteViewport (anchor order + atomic empty clear, behavior)', () => {
  it('prefers the fork anchor when resident, else visual, else tail', () => {
    const loaded = [msg('u1'), msg('a1'), msg('u2'), msg('a2')]
    const forkFirst = buildRouteViewport(loaded, ['u1', 'u2'], { hasMoreBefore: true, hasMoreAfter: true }, 10, 19)
    expect(forkFirst.empty).toBe(false)
    expect(forkFirst.window).not.toBeNull()
    expect(forkFirst.window!.displayMessages.map((m) => m.id)).toContain('u1')

    const visualFallback = buildRouteViewport(loaded, ['missing-fork', 'u2'], undefined, 10, 19)
    expect(visualFallback.window!.displayMessages.map((m) => m.id)).toContain('u2')

    const tailFallback = buildRouteViewport(loaded, [null, undefined], undefined, 10, 19)
    expect(tailFallback.window!.displayMessages.map((m) => m.id)).toContain('a2')
  })

  it('empty loaded clears atomically with authoritative empty flags (no residual)', () => {
    const cleared = buildRouteViewport([], ['u1'], { hasMoreBefore: false, hasMoreAfter: false }, 10, 19)
    expect(cleared.empty).toBe(true)
    expect(cleared.window).not.toBeNull()
    expect(cleared.window!.displayMessages).toEqual([])
    expect(cleared.window!.hasMoreOlder).toBe(false)
    expect(cleared.window!.hasMoreNewer).toBe(false)
  })
})

describe('route window authoritative hasMore propagation', () => {
  it('target window carries Main hasMore into the viewport (pagination continues)', () => {
    const loaded = [msg('u1'), msg('a1'), msg('u2'), msg('a2'), msg('u3')]
    const w = createTargetMessageWindow(loaded, 'u2', 10, 19, { hasMoreBefore: true, hasMoreAfter: true })
    expect(w.hasMoreOlder).toBe(true)
    expect(w.hasMoreNewer).toBe(true)
    expect(w.authoritativeHasMoreBefore).toBe(true)
    expect(w.authoritativeHasMoreAfter).toBe(true)
  })

  it('explicit false is preserved (no derived true without trim)', () => {
    const loaded = [msg('u1'), msg('a1')]
    const w = createTargetMessageWindow(loaded, 'u1', 10, 19, { hasMoreBefore: false, hasMoreAfter: false })
    expect(w.hasMoreOlder).toBe(false)
    expect(w.hasMoreNewer).toBe(false)
  })
})
