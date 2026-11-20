import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import {
  chooseNavigationWindow,
  type MessageNavigationIntent,
  type MessageNavigationPrepareDeps,
  prepareMessageNavigationTarget,
  resolveMessageNavigation,
  runMessageNavigationTransaction
} from '../messageNavigation'
import {
  createMessageViewportState,
  type MessageViewportAction,
  messageViewportReducer,
  type MessageViewportState
} from '../messageViewportReducer'
import { createTargetMessageWindow } from '../messageWindow'
import { createViewportCommitWaiter } from '../viewportCommitWaiter'

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

/**
 * Production-shaped prepare harness: the real reducer plus the real
 * commit waiter, wired exactly like `runPrepareOnlyTransaction` in
 * Messages.tsx — `begin` awaits the navigation-token commit,
 * `applyWindow` awaits the window commit, `cancel` closes the token
 * (the committed projection survives the close).
 */
const buildHarness = (options: { hidden?: boolean; current?: () => boolean; settleDom?: () => Promise<void> } = {}) => {
  const all = Array.from({ length: 60 }, (_, index) => message(`m${index}`))
  const initialWindow = createTargetMessageWindow(all, 'm10', 10, 19)
  let state = createMessageViewportState(initialWindow)
  const waiter = createViewportCommitWaiter<MessageViewportState>()
  const dispatch = (action: MessageViewportAction) => {
    state = messageViewportReducer(state, action)
    waiter.notify(state)
  }
  let hidden = options.hidden ?? false
  const revealTarget = vi.fn(async () => {
    hidden = false
  })
  const cancelLoadsAndTimers = vi.fn()
  const getState = () => state
  const begin: MessageNavigationPrepareDeps['begin'] = (token, targetId, source, alignment) => {
    const generation = getState().navigation.generation
    const committed = waiter.wait(getState(), (committedState) => {
      if (committedState.navigation.token === token) return true
      if (committedState.navigation.generation > generation) return false
      return null
    })
    dispatch({ type: 'navigation/begin', token, targetId, source, alignment })
    return committed
  }
  const applyWindow: MessageNavigationPrepareDeps['applyWindow'] = (token, window) => {
    const initialState = getState()
    const committed = waiter.wait(initialState, (committedState) => {
      if (committedState.navigation.token !== token) return false
      return committedState.window === window ? true : null
    })
    dispatch({ type: 'navigation/apply-window', token, window })
    return committed
  }
  const prepareDeps: MessageNavigationPrepareDeps = {
    begin,
    isCurrent: options.current ?? ((token) => getState().navigation.token === token),
    cancelLoadsAndTimers,
    resolve: (intent) => resolveMessageNavigation(all, intent),
    prepareWindow: (resolved) => chooseNavigationWindow(all, getState().window, resolved, 10),
    applyWindow,
    getTargetStatus: (targetId) =>
      hidden
        ? 'hidden'
        : getState().window?.displayMessages.some((item) => item.id === targetId)
          ? 'visible'
          : 'missing',
    revealTarget,
    settleDom: options.settleDom ?? (async () => {}),
    cancel: (token) => dispatch({ type: 'navigation/cancel', token })
  }
  return { all, initialWindow, getState, dispatch, prepareDeps, revealTarget, cancelLoadsAndTimers }
}

describe('prepareMessageNavigationTarget (owned bootstrap prepare stage)', () => {
  it('owned bootstrap prepare commits the target window with 0 scroll / 0 adoption and a closed token', async () => {
    const harness = buildHarness()
    const intent: MessageNavigationIntent = { kind: 'message', targetId: 'm50', source: 'pending' }

    // The prepare contract exposes no viewport mover and no controller
    // adoption: an owned (fetch-hold) session can never meet the
    // owned-active refusal the executing scroll path hits.
    expect('scroll' in harness.prepareDeps).toBe(false)
    expect('beginProgrammaticScroll' in harness.prepareDeps).toBe(false)
    expect('finish' in harness.prepareDeps).toBe(false)

    const result = await prepareMessageNavigationTarget(intent, harness.prepareDeps)

    expect(result.status).toBe('prepared')
    if (result.status !== 'prepared') return
    expect(result.resolved).toEqual({ kind: 'message', targetId: 'm50', alignment: 'start', restoreOffset: null })
    // Target projection committed: the applied window covers the target.
    expect(harness.getState().window?.displayMessages.some((item) => item.id === 'm50')).toBe(true)
    expect(harness.cancelLoadsAndTimers).toHaveBeenCalledTimes(2)
    // Token closed on the prepared exit: navigation idle, no programmatic
    // scroll token left behind (no waiter hang, no leftover ownership).
    expect(harness.getState().navigation.phase).toBe('idle')
    expect(harness.getState().navigation.token).toBeNull()
    expect(harness.getState().scrollMode).toBe('user')
    expect(harness.getState().scrollToken).toBeNull()
    expect(harness.getState().scrollGeneration).toBe(0)

    // The closed prepare leaves reusable infrastructure: a follow-up FULL
    // transaction on the same state/waiter still scrolls once and finishes.
    const scroll = vi.fn(() => 'success' as const)
    const finish = vi.fn((token: object) => {
      harness.dispatch({ type: 'navigation/finish', token })
    })
    const fullResult = await runMessageNavigationTransaction(intent, {
      ...harness.prepareDeps,
      beginProgrammaticScroll: async () => true,
      scroll,
      finish
    })
    expect(fullResult).toBe('success')
    expect(scroll).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    expect(harness.getState().navigation.phase).toBe('idle')
  })

  it('normal full transaction still scrolls once and finishes (no prepare regression)', async () => {
    const harness = buildHarness()
    const scroll = vi.fn(() => 'success' as const)
    const finish = vi.fn((token: object) => {
      harness.dispatch({ type: 'navigation/finish', token })
    })

    const result = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm50', source: 'event' },
      {
        ...harness.prepareDeps,
        beginProgrammaticScroll: async () => true,
        scroll,
        finish
      }
    )

    expect(result).toBe('success')
    expect(scroll).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    expect(harness.getState().navigation.phase).toBe('idle')
  })

  it('stale navigation cancels with the token closed and the window untouched', async () => {
    const harness = buildHarness({ current: () => false })

    const result = await prepareMessageNavigationTarget(
      { kind: 'message', targetId: 'm50', source: 'pending' },
      harness.prepareDeps
    )

    expect(result).toEqual({ status: 'cancelled' })
    expect(harness.getState().navigation.phase).toBe('idle')
    expect(harness.getState().navigation.token).toBeNull()
    expect(harness.getState().window).toBe(harness.initialWindow)
  })

  it('unresolvable intent returns not-found with the token closed', async () => {
    const harness = buildHarness()

    const result = await prepareMessageNavigationTarget(
      { kind: 'message', targetId: 'no-such-message', source: 'pending' },
      harness.prepareDeps
    )

    expect(result).toEqual({ status: 'not-found' })
    expect(harness.getState().navigation.phase).toBe('idle')
    expect(harness.getState().navigation.token).toBeNull()
    expect(harness.getState().window).toBe(harness.initialWindow)
  })

  it('a throwing settle stage fails closed to cancelled with the token closed', async () => {
    const harness = buildHarness({
      settleDom: async () => {
        throw new Error('settlement exploded')
      }
    })

    const result = await prepareMessageNavigationTarget(
      { kind: 'message', targetId: 'm50', source: 'pending' },
      harness.prepareDeps
    )

    expect(result).toEqual({ status: 'cancelled' })
    expect(harness.getState().navigation.phase).toBe('idle')
    expect(harness.getState().navigation.token).toBeNull()
    // Never a permanently hidden transition: the token is closed even when
    // a stage throws.
    expect(harness.getState().scrollMode).toBe('user')
  })

  it('a folded (hidden) target is revealed before the prepared commit', async () => {
    const harness = buildHarness({ hidden: true })

    const result = await prepareMessageNavigationTarget(
      { kind: 'message', targetId: 'm20', source: 'pending' },
      harness.prepareDeps
    )

    expect(harness.revealTarget).toHaveBeenCalledWith('m20')
    expect(result.status).toBe('prepared')
    expect(harness.getState().window?.displayMessages.some((item) => item.id === 'm20')).toBe(true)
    expect(harness.getState().navigation.phase).toBe('idle')
    expect(harness.getState().navigation.token).toBeNull()
  })
})
