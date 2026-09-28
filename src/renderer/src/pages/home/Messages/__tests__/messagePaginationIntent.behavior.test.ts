/**
 * Pending older-edge intent (InfiniteScroll latch fix) behavior:
 * - `next` queues while anchoring/navigation holds ownership, direct-loads in
 *   normal user state;
 * - replay reads the *committed* viewport (after scroll/end), never a stale
 *   ref — still-anchoring commits keep, user commits replay;
 * - route/topic/generation/deletion/resident/hasMore/left-edge discard;
 * - loading keeps (existing guard, no duplicate);
 * - single replay (cleared before start);
 * - unmount/route/cancel paths clear the ref (source guard, no library internals).
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createPendingOlderIntent, decidePendingOlderReplay, shouldQueueOlderIntent } from '../messagePaginationIntent'
import { createMessageViewportState, type MessageViewportState } from '../messageViewportReducer'

type QueueState = Pick<MessageViewportState, 'navigation' | 'scrollMode'> & {
  window: { hasMoreOlder: boolean }
  loading: { older: boolean }
}

type CommittedState = Pick<MessageViewportState, 'navigation' | 'scrollMode' | 'topicGeneration'>

const idleNavigation = createMessageViewportState().navigation
const pendingNavigation = { ...createMessageViewportState().navigation, phase: 'pending' as const }

const userIdle: QueueState = {
  navigation: idleNavigation,
  scrollMode: 'user' as const,
  window: { hasMoreOlder: true },
  loading: { older: false }
}

const anchoring: QueueState = {
  navigation: idleNavigation,
  scrollMode: 'anchoring' as const,
  window: { hasMoreOlder: true },
  loading: { older: false }
}

const navigating: QueueState = {
  navigation: pendingNavigation,
  scrollMode: 'user' as const,
  window: { hasMoreOlder: true },
  loading: { older: false }
}

const basePending = createPendingOlderIntent({
  topicId: 't1',
  routeId: 'b1',
  topicGeneration: 3,
  deletionGeneration: 0,
  residentGeneration: 7
})

const baseLive = {
  topicId: 't1',
  routeId: 'b1' as string | null,
  topicGeneration: 3,
  deletionGeneration: 0,
  residentGeneration: 7,
  hasMoreOlder: true,
  loadingOlder: false
}

const committedUser: CommittedState = { navigation: idleNavigation, scrollMode: 'user' as const, topicGeneration: 3 }
const committedAnchoring: CommittedState = {
  navigation: idleNavigation,
  scrollMode: 'anchoring' as const,
  topicGeneration: 3
}

describe('shouldQueueOlderIntent (next gate)', () => {
  it('queues while anchoring or navigating, never in normal user state', () => {
    expect(shouldQueueOlderIntent(anchoring)).toBe(true)
    expect(shouldQueueOlderIntent(navigating)).toBe(true)
    expect(shouldQueueOlderIntent(userIdle)).toBe(false)
  })

  it('never queues steady states (no hasMore / active load)', () => {
    expect(shouldQueueOlderIntent({ ...anchoring, window: { hasMoreOlder: false } })).toBe(false)
    expect(shouldQueueOlderIntent({ ...anchoring, loading: { older: true } })).toBe(false)
  })
})

describe('decidePendingOlderReplay (committed-state replay)', () => {
  it('keeps while still anchoring, replays after the scroll/end commit to user', () => {
    // User input cancels the stabilizer but the viewport still commits
    // anchoring: reading the stale pre-cancel ref would early-return again,
    // so the committed anchoring state must keep (no replay before commit).
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: baseLive,
        committed: committedAnchoring,
        atOldestEdge: true
      })
    ).toEqual({ action: 'keep' })
    // After scroll/end commits, the committed user state replays once.
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: baseLive,
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'replay' })
  })

  it('discards on route/topic/generation/deletion/resident change', () => {
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: { ...baseLive, routeId: 'b2' },
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'route' })
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: { ...baseLive, topicId: 't2' },
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'topic' })
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: { ...baseLive, topicGeneration: 4 },
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'topic-generation' })
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: baseLive,
        committed: { ...committedUser, topicGeneration: 4 },
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'topic-generation' })
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: { ...baseLive, deletionGeneration: 1 },
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'deletion' })
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: { ...baseLive, residentGeneration: 8 },
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'resident' })
  })

  it('discards when hasMore is gone or the viewport left the oldest edge', () => {
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: { ...baseLive, hasMoreOlder: false },
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'has-more' })
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: baseLive,
        committed: committedUser,
        atOldestEdge: false
      })
    ).toEqual({ action: 'discard', reason: 'left-oldest' })
  })

  it('keeps while a load is active (existing loading guard, no duplicate start)', () => {
    expect(
      decidePendingOlderReplay({
        pending: basePending,
        live: { ...baseLive, loadingOlder: true },
        committed: committedUser,
        atOldestEdge: true
      })
    ).toEqual({ action: 'keep' })
  })

  it('replays at most once: cleared before start so later commits never refire', () => {
    // Mirrors the Messages effect: clear-then-start on replay/discard.
    let pending: typeof basePending | null = basePending
    let starts = 0
    const runEffect = (committed: CommittedState, atEdge: boolean): void => {
      if (!pending) return
      const decision = decidePendingOlderReplay({ pending, live: baseLive, committed, atOldestEdge: atEdge })
      if (decision.action === 'keep') return
      pending = null
      if (decision.action === 'discard') return
      starts += 1
    }
    runEffect(committedAnchoring, true)
    expect(starts).toBe(0)
    expect(pending).not.toBeNull()
    runEffect(committedUser, true)
    expect(starts).toBe(1)
    expect(pending).toBeNull()
    runEffect(committedUser, true)
    runEffect(committedUser, true)
    expect(starts).toBe(1)
  })
})

describe('production wiring (no library internals)', () => {
  const src = (): string => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  it('queues on temporary ownership, replays from committed state, direct-loads in user state', () => {
    const code = src()
    expect(code).toMatch(/pendingOlderIntentRef/)
    expect(code).toMatch(/shouldQueueOlderIntent/)
    expect(code).toMatch(/decidePendingOlderReplay/)
    expect(code).toMatch(/startOlderWindowLoad/)
    // Replay effect depends on the committed viewport, not only the ref.
    const replayIdx = code.indexOf('decidePendingOlderReplay({')
    expect(replayIdx).toBeGreaterThan(-1)
    expect(code.slice(replayIdx - 800, replayIdx)).toMatch(/const committed = viewportState/)
    expect(code).not.toMatch(/actionTriggered/)
  })

  it('clears the intent on route switch, unmount, and cancelActiveLoads', () => {
    const code = src()
    // cancelActiveLoads owns the clear (route/divider/top paths call it).
    const cancelIdx = code.indexOf('const cancelActiveLoads')
    expect(code.slice(cancelIdx, cancelIdx + 600)).toMatch(/pendingOlderIntentRef\.current = null/)
    // Unmount teardown clears.
    expect(code).toMatch(/pendingOlderIntentRef\.current = null/)
    // Deletion + topic-transition clears.
    expect(code).toMatch(/windowCacheRef\.current\.delete\(topicIdAtSubscribe\)\s+pendingOlderIntentRef/)
  })
})
