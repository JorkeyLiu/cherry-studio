import * as fs from 'node:fs'

import {
  buildRouteViewport,
  claimLoadedRoute,
  createLatestMessageWindow,
  decideDividerDoubleFailureRecovery,
  decideExternalDoubleFailureRecovery,
  initLoadedRouteState,
  isLoadedRouteCurrent,
  markLoadedRouteFailed
} from '@renderer/pages/home/Messages/messageWindow'
import messagesReducer, { newMessagesActions } from '@renderer/store/newMessage'
import { activeBranchSet } from '@renderer/store/topicBranch'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

function msg(id: string): Message {
  return { id, role: 'user', topicId: 't1', createdAt: new Date().toISOString() } as unknown as Message
}

describe('divider double-failure recovery decision (production helper, behavior)', () => {
  it('still on the failed target → roll back to prevRoute', () => {
    const decision = decideDividerDoubleFailureRecovery({
      prevRoute: null,
      targetRoute: 'b-new',
      startTopicId: 't1',
      currentTopicId: 't1',
      currentRoute: 'b-new'
    })
    expect(decision.shouldRollback).toBe(true)
    expect(decision.rollbackTo).toBe(null)

    // Caller dispatch decision driven by the production helper output:
    // rollback dispatches activeBranchSet(prev) and claims the loaded route.
    const dispatch = vi.fn()
    if (decision.shouldRollback) {
      dispatch(activeBranchSet({ topicId: 't1', branchId: decision.rollbackTo }))
    }
    expect(dispatch).toHaveBeenCalledTimes(1)
    const action = dispatch.mock.calls[0][0] as ReturnType<typeof activeBranchSet>
    expect(action.payload).toEqual({ topicId: 't1', branchId: null })
    expect(claimLoadedRoute(decision.rollbackTo)).toEqual({ route: null, loadFailed: false })
  })

  it('user already moved on (route or topic) → no rollback', () => {
    const movedRoute = decideDividerDoubleFailureRecovery({
      prevRoute: null,
      targetRoute: 'b-new',
      startTopicId: 't1',
      currentTopicId: 't1',
      currentRoute: 'b-other'
    })
    expect(movedRoute.shouldRollback).toBe(false)

    const movedTopic = decideDividerDoubleFailureRecovery({
      prevRoute: null,
      targetRoute: 'b-new',
      startTopicId: 't1',
      currentTopicId: 't2',
      currentRoute: 'b-new'
    })
    expect(movedTopic.shouldRollback).toBe(false)

    // No dispatch when the helper says no rollback.
    const dispatch = vi.fn()
    for (const d of [movedRoute, movedTopic]) {
      if (d.shouldRollback) dispatch(activeBranchSet({ topicId: 't1', branchId: d.rollbackTo }))
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('main-route target rolls back to the previous branch id', () => {
    const decision = decideDividerDoubleFailureRecovery({
      prevRoute: 'b-old',
      targetRoute: null,
      startTopicId: 't1',
      currentTopicId: 't1',
      currentRoute: null
    })
    expect(decision).toEqual({ shouldRollback: true, rollbackTo: 'b-old' })
  })
})

describe('top/external double-failure recovery decision (production helper, behavior)', () => {
  it('still on the failed target → clear projection/viewport + mark failed retryable', () => {
    const decision = decideExternalDoubleFailureRecovery({
      targetRoute: 'b-new',
      startTopicId: 't1',
      currentTopicId: 't1',
      currentRoute: 'b-new'
    })
    expect(decision.shouldClear).toBe(true)

    // Caller decision driven by the production helper output: clear the
    // loaded projection atomically via the real reducer, build the atomic
    // empty viewport via the production helper, and mark the loaded route
    // failed with the tagged state (retryable, never trusted as loaded).
    const dispatch = vi.fn()
    const before = {
      ids: ['u1', 'a1'] as any,
      entities: { u1: msg('u1'), a1: msg('a1') } as any,
      messageIdsByTopic: { t1: ['u1', 'a1'] },
      // Production invariant (newMessage initialState): capability maps
      // always exist; the empty-window rebase clears them fail-closed.
      mutableMessageIdsByTopic: {},
      mutableRouteByTopic: {},
      currentTopicId: 't1',
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10
    } as any
    if (decision.shouldClear) {
      const cleared = messagesReducer(before, newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [] }))
      expect(cleared.messageIdsByTopic['t1']).toEqual([])
      dispatch(newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [] }))
    }
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].payload).toEqual({ topicId: 't1', messages: [] })

    const failed = markLoadedRouteFailed('b-new')
    expect(failed).toEqual({ route: 'b-new', loadFailed: true })
    // Failed is never treated as current even though the route matches, so
    // the next route effect retries instead of trusting the empty projection.
    expect(isLoadedRouteCurrent(failed, 'b-new')).toBe(false)

    const { window: emptyWindow, empty } = buildRouteViewport(
      [],
      ['u1'],
      { hasMoreBefore: false, hasMoreAfter: false },
      10,
      19
    )
    expect(empty).toBe(true)
    expect(emptyWindow).not.toBeNull()
    expect(emptyWindow!.displayMessages).toEqual([])
    const directEmpty = createLatestMessageWindow([], 1, { hasMoreBefore: false, hasMoreAfter: false })
    expect(directEmpty.displayMessages).toEqual([])
  })

  it('user already moved on → no clear, loaded state untouched', () => {
    const moved = decideExternalDoubleFailureRecovery({
      targetRoute: 'b-new',
      startTopicId: 't1',
      currentTopicId: 't1',
      currentRoute: 'b-other'
    })
    expect(moved.shouldClear).toBe(false)

    const movedTopic = decideExternalDoubleFailureRecovery({
      targetRoute: 'b-new',
      startTopicId: 't1',
      currentTopicId: 't2',
      currentRoute: 'b-new'
    })
    expect(movedTopic.shouldClear).toBe(false)

    const dispatch = vi.fn()
    for (const d of [moved, movedTopic]) {
      if (d.shouldClear) dispatch(newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [] }))
    }
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('loaded-route tagged state (no magic branch id, behavior)', () => {
  it('failed state keeps the real route key with an explicit flag (never a string)', () => {
    for (const route of [null, 'b-new', '__route_load_failed__'] as const) {
      const failed = markLoadedRouteFailed(route)
      expect(typeof failed).toBe('object')
      expect(typeof failed).not.toBe('string')
      expect(failed.route).toBe(route)
      expect(failed.loadFailed).toBe(true)
      // A failed state can never be mistaken for a loaded route, even when
      // the route key textually equals the old magic marker.
      expect(isLoadedRouteCurrent(failed, route)).toBe(false)
    }
  })

  it('claim/init lifecycle: claimed route is current, failed diverges without new persistence', () => {
    expect(isLoadedRouteCurrent(initLoadedRouteState('b-new'), 'b-new')).toBe(true)
    expect(isLoadedRouteCurrent(initLoadedRouteState('b-new'), 'b-other')).toBe(false)
    expect(isLoadedRouteCurrent(claimLoadedRoute('b-new'), 'b-new')).toBe(true)
    // Clearing the flag by claiming the same route makes it current again
    // (retry path): no persisted state involved, pure renderer-local value.
    expect(isLoadedRouteCurrent(claimLoadedRoute(markLoadedRouteFailed('b-new').route), 'b-new')).toBe(true)
  })

  it('production paths call the decision helpers (wiring pin; behavior above executes them)', () => {
    const source = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    expect(source).toMatch(/decideDividerDoubleFailureRecovery/)
    expect(source).toMatch(/decideExternalDoubleFailureRecovery/)
    expect(source).toMatch(/claimLoadedRoute/)
    expect(source).toMatch(/markLoadedRouteFailed/)
    expect(source).toMatch(/isLoadedRouteCurrent/)
    expect(source).not.toMatch(/ROUTE_LOAD_FAILED_MARKER/)
  })
})
