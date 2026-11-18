import { describe, expect, it } from 'vitest'

import {
  findStableStartRunIndex,
  resolveGroupSlotHost,
  resolvePresentationStartMessageId
} from '../routeGroupPresentation'

describe('resolvePresentationStartMessageId', () => {
  it('returns the group first member in effective-route order (the normal-flow slot)', () => {
    expect(resolvePresentationStartMessageId({ routeMemberIds: ['u03', 'a03', 'u04', 'a04'] })).toBe('u03')
  })

  it('is the SAME message for every route that shares the group first member', () => {
    // One group, one route per side of a fork inside the group: the parent route
    // also reaches the post-fork members (u04/a04), the child only the shared
    // prefix. The slot must not follow the route-specific suffix.
    const parent = resolvePresentationStartMessageId({ routeMemberIds: ['u03', 'a03', 'u04', 'a04'] })
    const child = resolvePresentationStartMessageId({ routeMemberIds: ['u03', 'a03'] })
    expect(parent).toBe('u03')
    expect(parent).toBe(child)
  })

  it('returns null when the group has no reachable member (never a slot)', () => {
    expect(resolvePresentationStartMessageId({ routeMemberIds: [] })).toBeNull()
    expect(resolvePresentationStartMessageId({ routeMemberIds: [''] })).toBeNull()
  })
})

describe('resolveGroupSlotHost', () => {
  it('hosts the header when the slot is mounted and the head resolves on this route', () => {
    expect(resolveGroupSlotHost({ hasMountedMember: true, slotInWindow: true, headerInRoute: true })).toBe('header')
  })

  it('hosts the equal-height continuation when the head lives on another route', () => {
    expect(resolveGroupSlotHost({ hasMountedMember: true, slotInWindow: true, headerInRoute: false })).toBe(
      'continuation'
    )
  })

  it('hosts no row when the slot is outside the window (window crops, never elects)', () => {
    expect(resolveGroupSlotHost({ hasMountedMember: true, slotInWindow: false, headerInRoute: true })).toBe('rail-only')
    expect(resolveGroupSlotHost({ hasMountedMember: true, slotInWindow: false, headerInRoute: false })).toBe(
      'rail-only'
    )
  })

  it('fails closed when no member of the group is mounted (stale qualification)', () => {
    expect(resolveGroupSlotHost({ hasMountedMember: false, slotInWindow: false, headerInRoute: true })).toBe('none')
    expect(resolveGroupSlotHost({ hasMountedMember: false, slotInWindow: true, headerInRoute: false })).toBe('none')
  })
})

describe('findStableStartRunIndex', () => {
  it('returns -1 for a null or empty slot (never elects a row)', () => {
    const runs = [[{ messageIds: ['m-a'] }]]
    expect(findStableStartRunIndex(runs, null)).toBe(-1)
    expect(findStableStartRunIndex(runs, '')).toBe(-1)
  })

  it('finds the run mounting the slot across multi-entry runs', () => {
    const runs = [
      [{ messageIds: ['m-newer'] }],
      [{ messageIds: ['m-mid-a'] }, { messageIds: ['m-mid-b', 'm-start'] }],
      [{ messageIds: ['m-older'] }]
    ]
    expect(findStableStartRunIndex(runs, 'm-start')).toBe(1)
  })

  it('returns -1 when the slot is outside the mounted window', () => {
    const runs = [[{ messageIds: ['m-a'] }], [{ messageIds: ['m-b'] }]]
    expect(findStableStartRunIndex(runs, 'm-head')).toBe(-1)
  })

  it('returns -1 when runs carry no message ids (never a window-elected slot)', () => {
    const runs = [[{}], [{}]]
    expect(findStableStartRunIndex(runs, 'm-head')).toBe(-1)
  })

  it('returns the first run when the slot message repeats (duplicated ids never shift the group)', () => {
    const runs = [[{ messageIds: ['m-start'] }], [{ messageIds: ['m-start'] }]]
    expect(findStableStartRunIndex(runs, 'm-start')).toBe(0)
  })
})
