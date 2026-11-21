import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  createLatestMessageWindow,
  createOldestMessageWindow,
  followsAppendedTailCommit,
  reconcileMessageWindow
} from '../messageWindow'

/**
 * Same-route authority append vs. reading anchor (bounded window contract).
 *
 * A tree clipboard paste/replay (or any batch insertion acknowledgment) publishes
 * rows the command itself created at the resident tail. The mounted window is a
 * bounded projection of the loaded route with ONE unified boundary rule: a parked
 * pure-tail append (previous projection id-prefix-stable, tail grew, displayed
 * newest is the previous tail, no held reading row) retains the displayed oldest
 * boundary and extends to the new tail — capacity grows with the retained range
 * up to the explicit bound, and only then does the bounded trim apply. Anything
 * else (reorder, replacement, middle insertion, deletion, an unparked window, a
 * held row) keeps today's derivation:
 *
 * - parked + pure append → the appended rows enter the mounted window in the same
 *   commit and the loaded old end stays (no gesture, no scroll, no forced reset),
 *   and a committed browsing target yields to the live bottom;
 * - a held reading row, a mid-history window, or a projection replacement →
 *   today's derivation is kept, so the anchor never jumps and nothing is pinned.
 */

const message = (id: string, role: Message['role'] = 'user', askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

/** One question/answer turn = two visual groups (ask row, then its answer). */
const turn = (index: number): Message[] => [
  message(`u${index}`, 'user'),
  message(`a${index}`, 'assistant', `u${index}`)
]

const topic = (turnCount: number, from = 0): Message[] =>
  Array.from({ length: turnCount }, (_, offset) => turn(from + offset)).flat()

const idsOf = (window: ReturnType<typeof createLatestMessageWindow>): string[] =>
  window.displayMessages.map((m) => m.id)

/** 7 turns loaded, bounded capacity shows the newest 6 turns (12 messages). */
const CAPACITY_GROUPS = 12
const loadedBefore = topic(7)
const appended = topic(2, 7)
const loadedAfter = [...loadedBefore, ...appended]

const fullWindow = (): ReturnType<typeof createLatestMessageWindow> =>
  createLatestMessageWindow(loadedBefore, CAPACITY_GROUPS)

const bottomFollow = (window: ReturnType<typeof createLatestMessageWindow>) =>
  reconcileMessageWindow(loadedAfter, loadedBefore, window, { atPhysicalBottom: true })

describe('reconcileMessageWindow — same-route appended tail', () => {
  it('carries the appended rows into the mounted window at physical bottom without a gesture', () => {
    const before = fullWindow()
    // The committed window is parked at the resident tail (newest row is the
    // loaded tail) and the viewport rests at the true bottom.
    expect(before.displayMessages[0]?.id).toBe('a6')
    expect(before.groupCount).toBe(CAPACITY_GROUPS)

    const after = bottomFollow(before)

    // The four pasted/published rows are mounted in this commit…
    for (const appendedMessage of appended) {
      expect(idsOf(after)).toContain(appendedMessage.id)
    }
    // …in authority order, as the newest rows of the route.
    expect(idsOf(after).slice(0, 4)).toEqual(['a8', 'u8', 'a7', 'u7'])
    // …while the loaded old end stays mounted: the oldest displayed row does
    // not drift, capacity grows with the retained range instead of re-slicing
    // newest-N. The older resident groups stay traversable, not evicted.
    expect(idsOf(after).at(-1)).toBe(idsOf(before).at(-1))
    expect(after.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 17 })
    expect(after.groupCount).toBe(CAPACITY_GROUPS + 4)
    expect(after.groupCapacity).toBe(CAPACITY_GROUPS + 4)
    expect(after.hasMoreOlder).toBe(true)
    expect(after.hasMoreNewer).toBe(false)
    // Following never invents a retractable browsing target.
    expect(after.paginationTarget).toBeUndefined()
    expect(after.edge).toBe('latest')
  })

  it('is idempotent: a second reconcile over the same projections does not drift', () => {
    const once = bottomFollow(fullWindow())
    const twice = reconcileMessageWindow(loadedAfter, loadedAfter, once, { atPhysicalBottom: true })
    expect(idsOf(twice)).toEqual(idsOf(once))
    expect(twice.range).toEqual(once.range)
  })

  it('keeps a committed browsing target when the viewport is not at the physical bottom', () => {
    // The window an ordinary older pagination published is deliberately exempt
    // from latest-edge rebuilding, so an appended tail does not move it while the
    // reader is anywhere but the true bottom.
    const paginated = { ...fullWindow(), paginationTarget: true as const }
    const after = reconcileMessageWindow(loadedAfter, loadedBefore, paginated, { atPhysicalBottom: false })
    expect(idsOf(after)).toEqual(idsOf(paginated))
    expect(after.range).toEqual(paginated.range)
    expect(after.paginationTarget).toBe(true)
    // Not following also means not mounted: the new rows stay in the projection.
    expect(idsOf(after)).not.toContain('u7')
  })

  it('keeps the reading anchor through the append (no jump, tail not mounted)', () => {
    const before = fullWindow()
    // The shared keeper holds an older visible row; the newest-capacity range
    // would evict it, so retention wins and the reading position stands.
    const after = reconcileMessageWindow(loadedAfter, loadedBefore, before, {
      atPhysicalBottom: true,
      retainMessageId: 'u1'
    })
    expect(idsOf(after)).toEqual(idsOf(before))
    expect(idsOf(after)).toContain('u1')
    expect(idsOf(after)).not.toContain('u7')
  })

  it('lets the live bottom supersede a committed browsing target', () => {
    const paginated = { ...fullWindow(), paginationTarget: true as const }

    const followed = bottomFollow(paginated)
    expect(idsOf(followed).slice(0, 4)).toEqual(['a8', 'u8', 'a7', 'u7'])
    // Returning to the bottom drops the stale hold, exactly like a pagination
    // that reached the latest groups again — and the old end stays mounted
    // instead of being re-sliced away.
    expect(followed.paginationTarget).toBeUndefined()
    expect(followed.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 17 })
    expect(followed.groupCapacity).toBe(CAPACITY_GROUPS + 4)
  })

  it('reconciles a tail removal cleanly (no stale appended rows, capacity ratchets)', () => {
    // Undo/redo reduce the route again: the followed window shrinks with the
    // projection instead of keeping dead rows or re-expanding the tail. The
    // grown capacity is kept (never collapsed back), so the whole remaining
    // resident projection stays visible instead of hiding loaded history.
    const followed = bottomFollow(fullWindow())
    expect(idsOf(followed)).toContain('u7')

    const afterUndo = reconcileMessageWindow(loadedBefore, loadedAfter, followed, { atPhysicalBottom: true })
    expect(idsOf(afterUndo).some((id) => ['u7', 'a7', 'u8', 'a8'].includes(id))).toBe(false)
    expect(idsOf(afterUndo).slice(0, 2)).toEqual(['a6', 'u6'])
    expect(afterUndo.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 13 })
    expect(afterUndo.groupCount).toBe(14)
    expect(afterUndo.groupCapacity).toBe(CAPACITY_GROUPS + 4)
    expect(afterUndo.hasMoreNewer).toBe(false)
    expect(afterUndo.hasMoreOlder).toBe(false)
  })

  it('never pulls a mid-history window forward, even at the container bottom', () => {
    // A fixed window parked on older groups: its newest row is NOT the resident
    // tail, so an append further down the route carries no follow intent for it.
    const midHistory = createOldestMessageWindow(loadedBefore, CAPACITY_GROUPS)
    expect(midHistory.edge).toBe('fixed')
    expect(midHistory.displayMessages[0]?.id).toBe('a5')

    const after = reconcileMessageWindow(loadedAfter, loadedBefore, midHistory, { atPhysicalBottom: true })
    expect(idsOf(after)).toEqual(idsOf(midHistory))
    expect(idsOf(after)).not.toContain('u7')
  })

  it('ignores a projection replacement that is not an append (route/topic reload)', () => {
    const before = fullWindow()
    // A short reload of the same route: the previous tail is gone, so this is a
    // replacement, never "the command appended rows".
    const replaced = topic(3)
    const after = reconcileMessageWindow(replaced, loadedBefore, before, { atPhysicalBottom: true })
    expect(idsOf(after)).toEqual(idsOf(createLatestMessageWindow(replaced, CAPACITY_GROUPS)))
    expect(after.hasMoreOlder).toBe(false)
  })
})

/**
 * The keeper's bottom semantic is a consequence of the SAME decision, resolved
 * by the caller in the same layout phase (see `suspendKeeperForAppendedTailBottom`
 * in `Messages.tsx`), so the two can never diverge: wherever the derivation
 * actually depends on follow intent — a committed browsing range, which is what
 * a route that paged through older history renders — the rule's answer IS the
 * derived outcome.
 */
describe('followsAppendedTailCommit — the shared follow rule', () => {
  /** The rendered case after paging older history: a committed range retained by design. */
  const paged = (): ReturnType<typeof createLatestMessageWindow> => ({ ...fullWindow(), paginationTarget: true })
  const mountedTail = (window: ReturnType<typeof createLatestMessageWindow>): boolean =>
    window.displayMessages[0]?.id === loadedAfter.at(-1)?.id

  it('agrees with the derivation wherever follow intent decides the outcome', () => {
    for (const options of [{ atPhysicalBottom: true }, { atPhysicalBottom: false }]) {
      const before = paged()
      const derived = reconcileMessageWindow(loadedAfter, loadedBefore, before, options)
      expect(followsAppendedTailCommit(loadedAfter, loadedBefore, before, options)).toBe(mountedTail(derived))
    }
    // At the bottom the committed browsing range yields and the tail mounts…
    expect(followsAppendedTailCommit(loadedAfter, loadedBefore, paged(), { atPhysicalBottom: true })).toBe(true)
    expect(idsOf(reconcileMessageWindow(loadedAfter, loadedBefore, paged(), { atPhysicalBottom: true }))[0]).toBe('a8')
    // …while reading above it neither follows nor moves.
    expect(followsAppendedTailCommit(loadedAfter, loadedBefore, paged(), { atPhysicalBottom: false })).toBe(false)
    expect(idsOf(reconcileMessageWindow(loadedAfter, loadedBefore, paged(), { atPhysicalBottom: false }))).toEqual(
      idsOf(paged())
    )
  })

  it('is not follow intent for reading, mid-history, or a projection replacement', () => {
    // A retained row the newest-capacity range would evict (the reading anchor).
    expect(
      followsAppendedTailCommit(loadedAfter, loadedBefore, fullWindow(), {
        atPhysicalBottom: true,
        retainMessageId: 'u1'
      })
    ).toBe(false)
    // A window parked on older groups: its newest row is not the resident tail.
    expect(
      followsAppendedTailCommit(loadedAfter, loadedBefore, createOldestMessageWindow(loadedBefore, CAPACITY_GROUPS), {
        atPhysicalBottom: true
      })
    ).toBe(false)
    // Reading anywhere but the physical bottom.
    expect(followsAppendedTailCommit(loadedAfter, loadedBefore, fullWindow(), { atPhysicalBottom: false })).toBe(false)
    // A route/topic reload replaces the projection instead of appending to it.
    expect(followsAppendedTailCommit(topic(3), loadedBefore, fullWindow(), { atPhysicalBottom: true })).toBe(false)
  })
})
