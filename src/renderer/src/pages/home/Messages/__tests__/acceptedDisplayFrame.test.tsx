import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  type DisplayContextVisual,
  displayFrameKey,
  resolveAcceptedContextVisual,
  useAcceptedDisplayFrame,
  useRouteLocalFoldBrowse
} from '../acceptedDisplayFrame'

const visual = (
  boundaryMessageId: string | null,
  anchorGroupKey: string | null,
  pending: boolean
): DisplayContextVisual => ({
  boundaryMessageId,
  anchorGroupKey,
  pending
})

const OLD_KEY = displayFrameKey('topic-a', null)
const NEW_KEY = displayFrameKey('topic-a', 'branch-b')

describe('displayFrameKey', () => {
  it('keys the main route without a branch suffix', () => {
    expect(displayFrameKey('topic-a', null)).toBe('topic-a::main')
    expect(displayFrameKey('topic-a', 'branch-b')).toBe('topic-a::branch-b')
  })
})

describe('resolveAcceptedContextVisual', () => {
  it('adopts the live visual when settled, including an authoritative ready null that clears the old boundary', () => {
    const live = visual(null, null, false)
    const out = resolveAcceptedContextVisual({
      displayedKey: NEW_KEY,
      selectedKey: NEW_KEY,
      live,
      retainedForDisplayed: visual('old-boundary', 'old-anchor', false),
      persistedAnchorForDisplayed: 'new-anchor'
    })
    expect(out).toBe(live)
  })

  it('keeps the old window visual while the selected target is ahead of the window', () => {
    const retained = visual('old-boundary', 'old-anchor', false)
    const out = resolveAcceptedContextVisual({
      displayedKey: OLD_KEY,
      selectedKey: NEW_KEY,
      live: visual(null, 'new-anchor', true),
      retainedForDisplayed: retained,
      persistedAnchorForDisplayed: 'old-anchor'
    })
    expect(out).toBe(retained)
  })

  it('metadata-first never moves the old window: a ready target visual stays parked until the window commits', () => {
    const retained = visual('old-boundary', 'old-anchor', false)
    const out = resolveAcceptedContextVisual({
      displayedKey: OLD_KEY,
      selectedKey: NEW_KEY,
      live: visual('new-boundary', 'new-anchor', false),
      retainedForDisplayed: retained,
      persistedAnchorForDisplayed: 'old-anchor'
    })
    expect(out).toBe(retained)
  })

  it('window-data-before-metadata resolves to explicit pending, never to a stale boundary', () => {
    const livePending = visual(null, 'new-anchor', true)
    const settled = resolveAcceptedContextVisual({
      displayedKey: NEW_KEY,
      selectedKey: NEW_KEY,
      live: livePending,
      retainedForDisplayed: null,
      persistedAnchorForDisplayed: 'new-anchor'
    })
    expect(settled).toBe(livePending)
    const inFlight = resolveAcceptedContextVisual({
      displayedKey: NEW_KEY,
      selectedKey: displayFrameKey('topic-a', 'branch-c'),
      live: visual(null, 'other-anchor', true),
      retainedForDisplayed: null,
      persistedAnchorForDisplayed: 'new-anchor'
    })
    expect(inFlight).toEqual(visual(null, null, true))
  })

  it('rejects a stale retained visual whose anchor no longer matches the displayed route', () => {
    const out = resolveAcceptedContextVisual({
      displayedKey: OLD_KEY,
      selectedKey: NEW_KEY,
      live: visual(null, 'new-anchor', true),
      retainedForDisplayed: visual('old-boundary', 'old-anchor', false),
      persistedAnchorForDisplayed: 'moved-anchor'
    })
    expect(out).toEqual(visual(null, null, true))
  })

  it('distinguishes explicit pending from an authoritative ready null', () => {
    const pending = resolveAcceptedContextVisual({
      displayedKey: NEW_KEY,
      selectedKey: NEW_KEY,
      live: visual(null, 'new-anchor', true),
      retainedForDisplayed: null,
      persistedAnchorForDisplayed: 'new-anchor'
    })
    const readyNone = resolveAcceptedContextVisual({
      displayedKey: NEW_KEY,
      selectedKey: NEW_KEY,
      live: visual(null, null, false),
      retainedForDisplayed: null,
      persistedAnchorForDisplayed: 'new-anchor'
    })
    expect(pending.pending).toBe(true)
    expect(readyNone.pending).toBe(false)
    expect(readyNone.boundaryMessageId).toBeNull()
  })
})

describe('useAcceptedDisplayFrame', () => {
  const renderFrame = (initial: {
    displayedKey: string
    selectedKey: string
    live: DisplayContextVisual
    persistedAnchorForDisplayed: string | null
  }) =>
    renderHook(
      ({ displayedKey, selectedKey, live, persistedAnchorForDisplayed }) =>
        useAcceptedDisplayFrame({ displayedKey, selectedKey, live, persistedAnchorForDisplayed }),
      { initialProps: initial }
    )

  it('retains the old window visual while the target loads, then adopts the target on settle', () => {
    const { result, rerender } = renderFrame({
      displayedKey: OLD_KEY,
      selectedKey: OLD_KEY,
      live: visual('old-boundary', 'old-anchor', false),
      persistedAnchorForDisplayed: 'old-anchor'
    })
    expect(result.current.boundaryMessageId).toBe('old-boundary')

    // Selected target advances before the window: the frame must not blank or borrow.
    rerender({
      displayedKey: OLD_KEY,
      selectedKey: NEW_KEY,
      live: visual(null, 'new-anchor', true),
      persistedAnchorForDisplayed: 'old-anchor'
    })
    expect(result.current.boundaryMessageId).toBe('old-boundary')
    expect(result.current.pending).toBe(false)

    // Target window commits while its closure is still pending: explicit pending, no stale boundary.
    rerender({
      displayedKey: NEW_KEY,
      selectedKey: NEW_KEY,
      live: visual(null, 'new-anchor', true),
      persistedAnchorForDisplayed: 'new-anchor'
    })
    expect(result.current.boundaryMessageId).toBeNull()
    expect(result.current.pending).toBe(true)

    // Same-route closure arrival is a legitimate update, not a frozen display.
    rerender({
      displayedKey: NEW_KEY,
      selectedKey: NEW_KEY,
      live: visual('new-boundary', 'new-anchor', false),
      persistedAnchorForDisplayed: 'new-anchor'
    })
    expect(result.current.boundaryMessageId).toBe('new-boundary')
    expect(result.current.pending).toBe(false)
  })

  it('A→B→A never leaks the superseded route visual: each key keeps its own retained frame', () => {
    const { result, rerender } = renderFrame({
      displayedKey: OLD_KEY,
      selectedKey: OLD_KEY,
      live: visual('a-boundary', 'a-anchor', false),
      persistedAnchorForDisplayed: 'a-anchor'
    })
    // B commits and settles with its own boundary.
    rerender({
      displayedKey: NEW_KEY,
      selectedKey: NEW_KEY,
      live: visual('b-boundary', 'b-anchor', false),
      persistedAnchorForDisplayed: 'b-anchor'
    })
    expect(result.current.boundaryMessageId).toBe('b-boundary')
    // Back to A: the frame is A's retained visual, never B's.
    rerender({
      displayedKey: OLD_KEY,
      selectedKey: OLD_KEY,
      live: visual('a-boundary', 'a-anchor', false),
      persistedAnchorForDisplayed: 'a-anchor'
    })
    expect(result.current.boundaryMessageId).toBe('a-boundary')
  })

  it('a stale retained anchor resolves to pending instead of a cross-topic boundary', () => {
    const { result, rerender } = renderFrame({
      displayedKey: OLD_KEY,
      selectedKey: OLD_KEY,
      live: visual('old-boundary', 'old-anchor', false),
      persistedAnchorForDisplayed: 'old-anchor'
    })
    expect(result.current.boundaryMessageId).toBe('old-boundary')
    // Deletion transfer moves the displayed route's anchor while a switch is pending.
    rerender({
      displayedKey: OLD_KEY,
      selectedKey: NEW_KEY,
      live: visual(null, 'new-anchor', true),
      persistedAnchorForDisplayed: 'moved-anchor'
    })
    expect(result.current.pending).toBe(true)
    expect(result.current.boundaryMessageId).toBeNull()
  })
})

describe('useRouteLocalFoldBrowse', () => {
  it('keeps expansions while the selected intent runs ahead, and clears them on the accepted display route change', () => {
    const { result, rerender } = renderHook(
      ({ displayedKey }: { displayedKey: string }) => useRouteLocalFoldBrowse(displayedKey),
      { initialProps: { displayedKey: OLD_KEY } }
    )

    act(() => {
      result.current.toggleExpandFoldSection('block-a')
    })
    expect(result.current.expandedFoldSectionIds.has('block-a')).toBe(true)

    // Same displayed key (selected target ahead, old window still visible): no early clear.
    rerender({ displayedKey: OLD_KEY })
    expect(result.current.expandedFoldSectionIds.has('block-a')).toBe(true)

    // Accepted display route commits to the target: the old expansion is released.
    rerender({ displayedKey: NEW_KEY })
    expect(result.current.expandedFoldSectionIds.size).toBe(0)
  })
})
