import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { resolveChromeAuthoritySegment, useRetainedRouteSegments } from '../useRetainedRouteSegments'

const TOPIC = 'T'
const PARENT_KEY = `${TOPIC}::main`
const CHILD_KEY = `${TOPIC}::child`

function seg(id: string, headerOwnedByRoute = true): RouteScopedSegment {
  return {
    id,
    name: id,
    memberIds: [id],
    messageCount: 1,
    firstMessageId: id,
    headerMessageId: id,
    headerInRoute: true,
    headerOwnedByRoute,
    presentationStartMessageId: id
  } as unknown as RouteScopedSegment
}

interface Props {
  topicId: string
  routeKey: string
  segments: RouteScopedSegment[]
  isCurrent: boolean
  displayedKey: string
}

const baseProps = (segments: RouteScopedSegment[]): Props => ({
  topicId: TOPIC,
  routeKey: PARENT_KEY,
  segments,
  isCurrent: true,
  displayedKey: PARENT_KEY
})

function setup(initial: Props) {
  return renderHook(
    ({ topicId, routeKey, segments, isCurrent, displayedKey }: Props) =>
      useRetainedRouteSegments(topicId, routeKey, segments, isCurrent, displayedKey),
    { initialProps: initial }
  )
}

describe('useRetainedRouteSegments', () => {
  it('returns the accepted projection while it is current and displayed', () => {
    const fresh = [seg('s-main')]
    const { result } = setup(baseProps(fresh))
    expect(result.current.segments).toBe(fresh)
    expect(result.current.isDisplayCurrent).toBe(true)
  })

  it('retains the previous route entries while the new projection is pending', () => {
    const oldEntries = [seg('s-main')]
    const { result, rerender } = setup(baseProps(oldEntries))
    // Route switch: the scoped hook clears first, currency drops.
    rerender({ ...baseProps([]), routeKey: CHILD_KEY, isCurrent: false })
    expect(result.current.segments).toBe(oldEntries)
    expect(result.current.isDisplayCurrent).toBe(false)
  })

  it('adopts the new accepted projection once it lands and the window commits', () => {
    const oldEntries = [seg('s-main')]
    const nextEntries = [seg('s-child')]
    const { result, rerender } = setup(baseProps(oldEntries))
    rerender({ ...baseProps([]), routeKey: CHILD_KEY, isCurrent: false })
    expect(result.current.segments).toBe(oldEntries)
    rerender({ ...baseProps(nextEntries), routeKey: CHILD_KEY, displayedKey: CHILD_KEY })
    expect(result.current.segments).toBe(nextEntries)
    expect(result.current.isDisplayCurrent).toBe(true)
  })

  it('never reuses another topic entries on a topic switch', () => {
    const oldEntries = [seg('s-main')]
    const { result, rerender } = setup(baseProps(oldEntries))
    rerender({ topicId: 'T2', routeKey: 'T2::main', segments: [], isCurrent: false, displayedKey: 'T2::main' })
    expect(result.current.segments).toEqual([])
    expect(result.current.isDisplayCurrent).toBe(false)
  })

  it('renders nothing on first mount while pending (nothing retained)', () => {
    const { result } = setup({ ...baseProps([]), isCurrent: false })
    expect(result.current.segments).toEqual([])
  })

  it('drops retention for a genuinely empty accepted projection', () => {
    const oldEntries = [seg('s-main')]
    const { result, rerender } = setup(baseProps(oldEntries))
    rerender({ ...baseProps([]), routeKey: CHILD_KEY, isCurrent: false })
    expect(result.current.segments).toBe(oldEntries)
    // Accepted, but the route genuinely has no groups: no stale headers.
    rerender({ ...baseProps([]), routeKey: CHILD_KEY, displayedKey: CHILD_KEY })
    expect(result.current.segments).toEqual([])
    expect(result.current.isDisplayCurrent).toBe(true)
  })

  it('projection-before-window holds the displayed route structure without authority', () => {
    // Parent accepted and displayed. Child projection lands first (window still old).
    const parentEntries = [seg('s-parent')]
    const childEntries = [seg('s-child')]
    const { result, rerender } = setup(baseProps(parentEntries))
    rerender({ ...baseProps(childEntries), routeKey: CHILD_KEY })
    // New chrome must NOT jump onto the old window: old structure held, read-only.
    expect(result.current.segments).toBe(parentEntries)
    expect(result.current.isDisplayCurrent).toBe(false)
    // Window commits to the child: same transaction switches structure + authority.
    rerender({ ...baseProps(childEntries), routeKey: CHILD_KEY, displayedKey: CHILD_KEY })
    expect(result.current.segments).toBe(childEntries)
    expect(result.current.isDisplayCurrent).toBe(true)
  })

  it('window-before-projection holds shared-prefix structure without mutability', () => {
    // The outgoing parent entry claims ownership of its own route.
    const parentEntries = [seg('s-shared', true)]
    const { result, rerender } = setup(baseProps(parentEntries))
    // Child window commits first (shared prefix covers it); projection pending.
    rerender({ ...baseProps([]), routeKey: CHILD_KEY, isCurrent: false, displayedKey: CHILD_KEY })
    // Old structure held for the shared prefix (no teardown), but the retained
    // ownership claim must not read as writable for the selected route.
    expect(result.current.segments).toBe(parentEntries)
    expect(result.current.isDisplayCurrent).toBe(false)
    expect(resolveChromeAuthoritySegment(parentEntries[0], result.current.isDisplayCurrent)).toBeNull()
    // Accepted child projection lands: structure + authority commit together.
    const childEntries = [seg('s-shared', true)]
    rerender({ ...baseProps(childEntries), routeKey: CHILD_KEY, displayedKey: CHILD_KEY })
    expect(result.current.segments).toBe(childEntries)
    expect(result.current.isDisplayCurrent).toBe(true)
    expect(resolveChromeAuthoritySegment(childEntries[0], result.current.isDisplayCurrent)).toBe(childEntries[0])
  })

  it('keeps the outgoing route across an A-B-A revisit without cross-route reuse', () => {
    const aEntries = [seg('s-a')]
    const bEntries = [seg('s-b')]
    const { result, rerender } = setup({
      topicId: TOPIC,
      routeKey: `${TOPIC}::a`,
      segments: aEntries,
      isCurrent: true,
      displayedKey: `${TOPIC}::a`
    })
    rerender({
      topicId: TOPIC,
      routeKey: `${TOPIC}::b`,
      segments: bEntries,
      isCurrent: true,
      displayedKey: `${TOPIC}::b`
    })
    expect(result.current.segments).toBe(bEntries)
    // Back to A while pending: the retained A projection (not B's) is shown.
    rerender({
      topicId: TOPIC,
      routeKey: `${TOPIC}::a`,
      segments: [],
      isCurrent: false,
      displayedKey: `${TOPIC}::a`
    })
    expect(result.current.segments).toBe(aEntries)
    expect(result.current.isDisplayCurrent).toBe(false)
  })
})

describe('resolveChromeAuthoritySegment', () => {
  it('passes the entry through only when the display is co-committed', () => {
    const entry = seg('s')
    expect(resolveChromeAuthoritySegment(entry, true)).toBe(entry)
    expect(resolveChromeAuthoritySegment(entry, false)).toBeNull()
    expect(resolveChromeAuthoritySegment(undefined, true)).toBeNull()
    expect(resolveChromeAuthoritySegment(null, true)).toBeNull()
  })
})
