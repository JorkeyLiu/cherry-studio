import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import {
  applyColumnReverseScroll,
  type BootstrapDecisionInput,
  canHandleUserViewportScroll,
  chooseNavigationWindow,
  type MessageNavigationIntent,
  resolveAdjacentUserMessage,
  resolveBootstrapDecision,
  resolveColumnReverseScrollTarget,
  resolveMessageNavigation,
  runMessageNavigationTransaction,
  shouldPersistNavigationResult
} from '../messageNavigation'
import { createOldestMessageWindow, createTargetMessageWindow, type MessageWindow } from '../messageWindow'

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

const messages = Array.from({ length: 60 }, (_, index) => message(`m${index}`))

const transaction = (intent: MessageNavigationIntent, options: { hidden?: boolean; current?: () => boolean } = {}) => {
  let effectiveWindow: MessageWindow = createTargetMessageWindow(messages, 'm10', 10, 19)
  let hidden = options.hidden ?? false
  const applyWindow = vi.fn(async (_token, window: MessageWindow) => {
    effectiveWindow = window
    return true
  })
  const scrollCalls: Array<{ resolved: { kind: string }; top?: number }> = []
  const scroll = vi.fn((resolved) => {
    const scrollTarget = resolveColumnReverseScrollTarget(resolved, 5000)
    scrollCalls.push({ resolved, top: scrollTarget?.top })
  })
  const cancelLoadsAndTimers = vi.fn()
  const revealTarget = vi.fn(async () => {
    hidden = false
  })
  const finish = vi.fn()
  const cancel = vi.fn()

  const result = runMessageNavigationTransaction(intent, {
    begin: vi.fn(async () => true),
    isCurrent: options.current ?? (() => true),
    cancelLoadsAndTimers,
    resolve: (requested) => resolveMessageNavigation(messages, requested),
    prepareWindow: (resolved) => chooseNavigationWindow(messages, effectiveWindow, resolved, 10),
    applyWindow,
    getTargetStatus: (targetId) =>
      hidden ? 'hidden' : effectiveWindow.displayMessages.some((m) => m.id === targetId) ? 'visible' : 'missing',
    revealTarget,
    settleDom: async () => {},
    beginProgrammaticScroll: async () => true,
    scroll,
    finish,
    cancel
  })

  return { result, applyWindow, scroll, scrollCalls, cancelLoadsAndTimers, revealTarget, finish, cancel }
}

describe('message navigation transaction', () => {
  it('jumps from an older window to a newer target with one target window, without progressive loading', async () => {
    const olderWindow = createTargetMessageWindow(messages, 'm10', 10, 19)
    const resolved = resolveMessageNavigation(messages, { kind: 'message', targetId: 'm50', source: 'event' })!
    const window = chooseNavigationWindow(messages, olderWindow, resolved, 20)!

    expect(window.displayMessages.some((item) => item.id === 'm50')).toBe(true)
    expect(window.range).toEqual({ oldestGroupIndex: 30, newestGroupIndex: 59 })

    const run = transaction({ kind: 'message', targetId: 'm50', source: 'event' })
    expect(await run.result).toBe('success')
    expect(run.applyWindow).toHaveBeenCalledOnce()
    expect(run.cancelLoadsAndTimers).toHaveBeenCalledTimes(2)
    expect(run.scroll).toHaveBeenCalledOnce()
  })

  it('creates the same target window for reverse navigation and saved restoration', () => {
    const current = createTargetMessageWindow(messages, 'm50', 10, 19)
    const event = resolveMessageNavigation(messages, { kind: 'message', targetId: 'm5', source: 'event' })!
    const restore = resolveMessageNavigation(messages, { kind: 'message', targetId: 'm5', source: 'restore' })!

    expect(chooseNavigationWindow(messages, current, event, 20)).toEqual(
      chooseNavigationWindow(messages, current, restore, 20)
    )
  })

  it('keeps the current window when the target is already rendered', () => {
    const current = createTargetMessageWindow(messages, 'm30', 10, 19)
    const resolved = resolveMessageNavigation(messages, { kind: 'message', targetId: 'm31', source: 'event' })!

    expect(chooseNavigationWindow(messages, current, resolved, 20)).toBeNull()
  })

  it('reveals a folded target before scrolling', async () => {
    const run = transaction({ kind: 'message', targetId: 'm20', source: 'group' }, { hidden: true })

    expect(await run.result).toBe('success')
    expect(run.revealTarget).toHaveBeenCalledWith('m20')
    expect(run.scroll).toHaveBeenCalledOnce()
  })

  it('stops a stale navigation after an awaited stage', async () => {
    let checks = 0
    const run = transaction({ kind: 'message', targetId: 'm20', source: 'event' }, { current: () => ++checks < 3 })

    expect(await run.result).toBe('cancelled')
    expect(run.scroll).not.toHaveBeenCalled()
  })

  it('isolates pending intents to the messages supplied by the current topic', () => {
    expect(
      resolveMessageNavigation(messages, { kind: 'message', targetId: 'other-topic', source: 'pending' })
    ).toBeNull()
  })

  it('suppresses loaders and position saving during window and programmatic navigation scrolls', () => {
    expect(
      canHandleUserViewportScroll({
        navigation: {
          generation: 1,
          token: {},
          targetId: 'm20',
          source: 'event',
          alignment: 'start',
          phase: 'preparing'
        },
        scrollMode: 'user'
      })
    ).toBe(false)
    expect(
      canHandleUserViewportScroll({
        navigation: {
          generation: 1,
          token: null,
          targetId: null,
          source: null,
          alignment: 'start',
          phase: 'idle'
        },
        scrollMode: 'programmatic'
      })
    ).toBe(false)
  })

  it('resolves and executes the top intent through the transaction (oldest window)', async () => {
    const olderWindow = createTargetMessageWindow(messages, 'm10', 10, 19)
    const resolved = resolveMessageNavigation(messages, { kind: 'top', source: 'imperative' })!
    expect(resolved).toEqual({ kind: 'top' })

    const window = chooseNavigationWindow(messages, olderWindow, resolved, 10)!
    expect(window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 9 })
    expect(window.edge).toBe('fixed')

    const run = transaction({ kind: 'top', source: 'imperative' })
    expect(await run.result).toBe('success')
    expect(run.applyWindow).toHaveBeenCalledOnce()
    expect(run.scroll).toHaveBeenCalledOnce()
  })

  it('resolves and executes the bottom intent with imperative source through the transaction', async () => {
    const olderWindow = createTargetMessageWindow(messages, 'm10', 10, 19)
    const resolved = resolveMessageNavigation(messages, { kind: 'bottom', source: 'imperative' })!
    expect(resolved).toEqual({ kind: 'bottom' })

    const window = chooseNavigationWindow(messages, olderWindow, resolved, 10)!
    expect(window.edge).toBe('latest')

    const run = transaction({ kind: 'bottom', source: 'imperative' })
    expect(await run.result).toBe('success')
    expect(run.applyWindow).toHaveBeenCalledOnce()
    expect(run.scroll).toHaveBeenCalledOnce()
  })

  it('top intent creates an oldest window that includes the very first group', () => {
    const window = createOldestMessageWindow(messages, 10)
    expect(window.range?.oldestGroupIndex).toBe(0)
    expect(window.displayMessages.some((m) => m.id === 'm0')).toBe(true)
    expect(window.hasMoreOlder).toBe(false)
    expect(window.hasMoreNewer).toBe(true)
  })

  it('bottom intent from imperative source produces the same window as from restore source', () => {
    const olderWindow = createTargetMessageWindow(messages, 'm10', 10, 19)
    const imperative = resolveMessageNavigation(messages, { kind: 'bottom', source: 'imperative' })!
    const restore = resolveMessageNavigation(messages, { kind: 'bottom', source: 'restore' })!

    expect(chooseNavigationWindow(messages, olderWindow, imperative, 20)).toEqual(
      chooseNavigationWindow(messages, olderWindow, restore, 20)
    )
  })

  it('top intent cancels stale navigation after window switch', async () => {
    let checks = 0
    const run = transaction({ kind: 'top', source: 'imperative' }, { current: () => ++checks < 3 })

    expect(await run.result).toBe('cancelled')
    expect(run.scroll).not.toHaveBeenCalled()
  })

  it('scroll adapter: top intent produces negative scrollTop for column-reverse layout', async () => {
    const run = transaction({ kind: 'top', source: 'imperative' })
    expect(await run.result).toBe('success')
    expect(run.scrollCalls).toHaveLength(1)
    expect(run.scrollCalls[0].resolved.kind).toBe('top')
    expect(run.scrollCalls[0].top).toBeLessThan(0)
  })

  it('scroll adapter: bottom intent produces scrollTop of exactly 0', async () => {
    const run = transaction({ kind: 'bottom', source: 'imperative' })
    expect(await run.result).toBe('success')
    expect(run.scrollCalls).toHaveLength(1)
    expect(run.scrollCalls[0].resolved.kind).toBe('bottom')
    expect(run.scrollCalls[0].top).toBe(0)
  })
})

describe('resolveColumnReverseScrollTarget', () => {
  const scrollHeight = 4000

  it('returns { top: -scrollHeight } for top kind (negative direction)', () => {
    const target = resolveColumnReverseScrollTarget({ kind: 'top' }, scrollHeight)
    expect(target).toEqual({ top: -scrollHeight })
    expect(target!.top).toBeLessThan(0)
  })

  it('returns { top: 0 } for bottom kind', () => {
    const target = resolveColumnReverseScrollTarget({ kind: 'bottom' }, scrollHeight)
    expect(target).toEqual({ top: 0 })
  })

  it('returns { top: <value> } for scrollTop kind', () => {
    const target = resolveColumnReverseScrollTarget({ kind: 'scrollTop', scrollTop: -1500 }, scrollHeight)
    expect(target).toEqual({ top: -1500 })
  })

  it('returns null for message kind (requires DOM element lookup)', () => {
    const target = resolveColumnReverseScrollTarget(
      { kind: 'message', targetId: 'm1', alignment: 'start' },
      scrollHeight
    )
    expect(target).toBeNull()
  })

  it('handles zero scrollHeight gracefully for top kind', () => {
    const target = resolveColumnReverseScrollTarget({ kind: 'top' }, 0)
    expect(target).toEqual({ top: -0 })
    // -0 and 0 are functionally identical for scrollTo
    expect(Object.is(target!.top, 0) || Object.is(target!.top, -0)).toBe(true)
  })
})

describe('applyColumnReverseScroll — production scroll adapter', () => {
  const makeContainer = (scrollHeight = 4000) => ({
    scrollHeight,
    scrollTo: vi.fn()
  })

  it('top: calls container.scrollTo with negative scrollHeight', () => {
    const container = makeContainer(5000)
    applyColumnReverseScroll({ kind: 'top' }, container, vi.fn())
    expect(container.scrollTo).toHaveBeenCalledOnce()
    expect(container.scrollTo).toHaveBeenCalledWith({ top: -5000 })
  })

  it('bottom: calls container.scrollTo with 0', () => {
    const container = makeContainer(5000)
    applyColumnReverseScroll({ kind: 'bottom' }, container, vi.fn())
    expect(container.scrollTo).toHaveBeenCalledOnce()
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0 })
  })

  it('scrollTop: passes through the scrollTop value to container.scrollTo', () => {
    const container = makeContainer(5000)
    applyColumnReverseScroll({ kind: 'scrollTop', scrollTop: -1800 }, container, vi.fn())
    expect(container.scrollTo).toHaveBeenCalledOnce()
    expect(container.scrollTo).toHaveBeenCalledWith({ top: -1800 })
  })

  it('message: delegates to scrollElementIntoView callback with targetId and alignment', () => {
    const container = makeContainer()
    const scrollIntoView = vi.fn()
    applyColumnReverseScroll({ kind: 'message', targetId: 'msg-42', alignment: 'center' }, container, scrollIntoView)
    expect(container.scrollTo).not.toHaveBeenCalled()
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView).toHaveBeenCalledWith('msg-42', 'center')
  })

  it('message: default alignment is start when not specified in resolved', () => {
    const scrollIntoView = vi.fn()
    applyColumnReverseScroll(
      { kind: 'message', targetId: 'msg-10', alignment: 'start' },
      makeContainer(),
      scrollIntoView
    )
    expect(scrollIntoView).toHaveBeenCalledWith('msg-10', 'start')
  })

  it('null container: no-op for top (no scrollTo, no scrollIntoView)', () => {
    const scrollIntoView = vi.fn()
    applyColumnReverseScroll({ kind: 'top' }, null, scrollIntoView)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('undefined container: no-op for bottom', () => {
    const scrollIntoView = vi.fn()
    applyColumnReverseScroll({ kind: 'bottom' }, undefined, scrollIntoView)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('null container with message kind: still calls scrollElementIntoView', () => {
    const scrollIntoView = vi.fn()
    applyColumnReverseScroll({ kind: 'message', targetId: 'msg-5', alignment: 'end' }, null, scrollIntoView)
    expect(scrollIntoView).toHaveBeenCalledWith('msg-5', 'end')
  })

  it('top with zero scrollHeight: calls scrollTo with -0', () => {
    const container = makeContainer(0)
    applyColumnReverseScroll({ kind: 'top' }, container, vi.fn())
    expect(container.scrollTo).toHaveBeenCalledWith({ top: -0 })
  })

  it('each kind produces exactly one scrollTo or one scrollIntoView, never both', () => {
    const kinds = [
      { kind: 'top' as const },
      { kind: 'bottom' as const },
      { kind: 'scrollTop' as const, scrollTop: -100 },
      { kind: 'message' as const, targetId: 'm1', alignment: 'start' as const }
    ]

    for (const resolved of kinds) {
      const container = makeContainer()
      const scrollIntoView = vi.fn()
      applyColumnReverseScroll(resolved, container, scrollIntoView)

      if (resolved.kind === 'message') {
        expect(container.scrollTo).not.toHaveBeenCalled()
        expect(scrollIntoView).toHaveBeenCalledOnce()
      } else {
        expect(container.scrollTo).toHaveBeenCalledOnce()
        expect(scrollIntoView).not.toHaveBeenCalled()
      }
    }
  })
})

const baseInput: BootstrapDecisionInput = {
  phase: 'idle',
  isTopicLoading: false,
  topicId: 'topic-1',
  pending: null,
  savedPosition: null,
  savedRestoreHandled: false
}

describe('resolveBootstrapDecision', () => {
  it('returns wait when topic is loading', () => {
    expect(resolveBootstrapDecision({ ...baseInput, isTopicLoading: true })).toEqual({ action: 'wait' })
  })

  it('returns done when phase is already done', () => {
    expect(resolveBootstrapDecision({ ...baseInput, phase: 'done' })).toEqual({ action: 'done' })
  })

  it('returns wait when pending navigation is in flight', () => {
    expect(resolveBootstrapDecision({ ...baseInput, phase: 'pending-in-flight' })).toEqual({ action: 'wait' })
  })

  it('selects matching pending over saved restore', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      pending: { messageId: 'msg-42', topicId: 'topic-1' },
      savedPosition: { scrollTop: 100, anchorId: 'msg-5', isAtBottom: false }
    })

    expect(decision).toEqual({
      action: 'pending',
      intent: { kind: 'message', targetId: 'msg-42', source: 'pending' }
    })
  })

  it('does not consume pending for a different topic', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      pending: { messageId: 'msg-42', topicId: 'other-topic' },
      savedPosition: { scrollTop: 100, anchorId: 'msg-5', isAtBottom: false }
    })

    expect(decision.action).toBe('restore')
    if (decision.action === 'restore') {
      expect(decision.intent).toEqual({ kind: 'message', targetId: 'msg-5', source: 'restore' })
    }
  })

  it('selects saved restore when no matching pending exists', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      savedPosition: { scrollTop: 50, anchorId: 'msg-10', isAtBottom: false }
    })

    expect(decision).toEqual({
      action: 'restore',
      intent: { kind: 'message', targetId: 'msg-10', source: 'restore' }
    })
  })

  it('selects bottom restore when saved position is at bottom', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      savedPosition: { scrollTop: 0, anchorId: null, isAtBottom: true }
    })

    expect(decision).toEqual({
      action: 'restore',
      intent: { kind: 'bottom', source: 'restore' }
    })
  })

  it('selects scrollTop restore when saved position has scrollTop but no anchor', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      savedPosition: { scrollTop: 350, anchorId: null, isAtBottom: false }
    })

    expect(decision).toEqual({
      action: 'restore',
      intent: { kind: 'scrollTop', scrollTop: 350, source: 'restore' }
    })
  })

  it('skips restore when already handled and falls through to done', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      savedPosition: { scrollTop: 100, anchorId: 'msg-5', isAtBottom: false },
      savedRestoreHandled: true
    })

    expect(decision).toEqual({ action: 'done' })
  })

  it('returns done when no pending and no saved position', () => {
    expect(resolveBootstrapDecision(baseInput)).toEqual({ action: 'done' })
  })

  it('cancelled pending allows idle phase to retry on next trigger', () => {
    // Simulate: first call selects pending → sets phase to pending-in-flight
    const first = resolveBootstrapDecision({
      ...baseInput,
      pending: { messageId: 'msg-42', topicId: 'topic-1' }
    })
    expect(first.action).toBe('pending')

    // Simulate: pending cancelled → component sets phase to 'done' (ownership terminated).
    // The pure function still handles phase='idle' → returns 'pending', but the component
    // no longer resets to 'idle' after cancellation (it sets 'done' to prevent busy-loop).
    // This test verifies the pure function contract for phase='idle':
    const afterCancel = resolveBootstrapDecision({
      ...baseInput,
      phase: 'idle',
      pending: { messageId: 'msg-42', topicId: 'topic-1' }
    })
    expect(afterCancel.action).toBe('pending')
  })

  it('new pending arriving after done is not consumed by the bootstrap', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      phase: 'done',
      pending: { messageId: 'msg-new', topicId: 'topic-1' }
    })

    expect(decision).toEqual({ action: 'done' })
  })

  it('pending with wrong topicId is ignored and falls through to saved restore', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      pending: { messageId: 'msg-42', topicId: 'wrong-topic' },
      savedPosition: { scrollTop: 200, anchorId: 'msg-10', isAtBottom: false }
    })

    expect(decision.action).toBe('restore')
    if (decision.action === 'restore') {
      expect(decision.intent).toEqual({ kind: 'message', targetId: 'msg-10', source: 'restore' })
    }
  })

  it('loading completion allows pending to proceed (wait → pending on next run)', () => {
    // First call: topic is loading → wait
    const loading = resolveBootstrapDecision({
      ...baseInput,
      isTopicLoading: true,
      pending: { messageId: 'msg-42', topicId: 'topic-1' }
    })
    expect(loading).toEqual({ action: 'wait' })

    // Loading completes → pending is selected
    const loaded = resolveBootstrapDecision({
      ...baseInput,
      isTopicLoading: false,
      pending: { messageId: 'msg-42', topicId: 'topic-1' }
    })
    expect(loaded).toEqual({
      action: 'pending',
      intent: { kind: 'message', targetId: 'msg-42', source: 'pending' }
    })
  })

  it('new pending identity after done phase gets no special treatment from bootstrap (handled by NAVIGATE_TO_MESSAGE event)', () => {
    // First pending handled → phase done
    const firstDone = resolveBootstrapDecision({
      ...baseInput,
      phase: 'done',
      pending: { messageId: 'msg-old', topicId: 'topic-1' }
    })
    expect(firstDone).toEqual({ action: 'done' })

    // New pending identity arrives → bootstrap still returns done (event handler owns it)
    const newPending = resolveBootstrapDecision({
      ...baseInput,
      phase: 'done',
      pending: { messageId: 'msg-new', topicId: 'topic-1' }
    })
    expect(newPending).toEqual({ action: 'done' })
  })

  it('pending with matching topicId but any messageId is selected by bootstrap (messageId checked at handler level)', () => {
    // The bootstrap decision only checks topicId, not messageId.
    // The NAVIGATE_TO_MESSAGE handler is responsible for exact messageId matching.
    const decision = resolveBootstrapDecision({
      ...baseInput,
      pending: { messageId: 'any-message', topicId: 'topic-1' }
    })

    expect(decision).toEqual({
      action: 'pending',
      intent: { kind: 'message', targetId: 'any-message', source: 'pending' }
    })
  })
})

describe('resolveAdjacentUserMessage', () => {
  const msg = (id: string, role: Message['role'] = 'user'): Message => ({
    id,
    role,
    assistantId: 'assistant',
    topicId: 'topic',
    createdAt: '2026-07-19T00:00:00.000Z',
    status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
    blocks: []
  })

  it('finds next user message in a multi-model assistant topic', () => {
    const sequence: Message[] = [
      msg('u1'),
      msg('a1', 'assistant'),
      msg('a2', 'assistant'),
      msg('u2'),
      msg('a3', 'assistant'),
      msg('u3')
    ]
    expect(resolveAdjacentUserMessage(sequence, 'u1', 'newer')).toBe('u2')
    expect(resolveAdjacentUserMessage(sequence, 'u2', 'newer')).toBe('u3')
  })

  it('finds previous user message in a multi-model assistant topic', () => {
    const sequence: Message[] = [
      msg('u1'),
      msg('a1', 'assistant'),
      msg('a2', 'assistant'),
      msg('u2'),
      msg('a3', 'assistant'),
      msg('u3')
    ]
    expect(resolveAdjacentUserMessage(sequence, 'u3', 'older')).toBe('u2')
    expect(resolveAdjacentUserMessage(sequence, 'u2', 'older')).toBe('u1')
  })

  it('returns null at true first boundary (oldest user message)', () => {
    const sequence: Message[] = [msg('u1'), msg('a1', 'assistant'), msg('u2')]
    expect(resolveAdjacentUserMessage(sequence, 'u1', 'older')).toBeNull()
  })

  it('returns null at true last boundary (newest user message)', () => {
    const sequence: Message[] = [msg('u1'), msg('a1', 'assistant'), msg('u2')]
    expect(resolveAdjacentUserMessage(sequence, 'u2', 'newer')).toBeNull()
  })

  it('handles single user message topic — returns null in both directions', () => {
    const sequence: Message[] = [msg('u1'), msg('a1', 'assistant')]
    expect(resolveAdjacentUserMessage(sequence, 'u1', 'newer')).toBeNull()
    expect(resolveAdjacentUserMessage(sequence, 'u1', 'older')).toBeNull()
  })

  it('returns null when current message is not found', () => {
    const sequence: Message[] = [msg('u1'), msg('a1', 'assistant'), msg('u2')]
    expect(resolveAdjacentUserMessage(sequence, 'nonexistent', 'newer')).toBeNull()
    expect(resolveAdjacentUserMessage(sequence, 'nonexistent', 'older')).toBeNull()
  })
})

describe('navigation result contract', () => {
  it('calls cancel (not finish) when target is not found', async () => {
    const run = transaction({ kind: 'message', targetId: 'nonexistent', source: 'event' })
    expect(await run.result).toBe('not-found')
    expect(run.cancel).toHaveBeenCalled()
    expect(run.finish).not.toHaveBeenCalled()
  })

  it('does not call finish when navigation is cancelled by stale token', async () => {
    let checks = 0
    const run = transaction({ kind: 'message', targetId: 'm20', source: 'event' }, { current: () => ++checks < 2 })
    expect(await run.result).toBe('cancelled')
    expect(run.finish).not.toHaveBeenCalled()
  })

  it('returns success for all source kinds — persistence eligibility is decided by the caller', async () => {
    const intents: MessageNavigationIntent[] = [
      { kind: 'bottom', source: 'imperative' },
      { kind: 'top', source: 'imperative' },
      { kind: 'message', targetId: 'm15', source: 'imperative' },
      { kind: 'message', targetId: 'm15', source: 'event' },
      { kind: 'message', targetId: 'm15', source: 'pending' },
      { kind: 'message', targetId: 'm15', source: 'group' },
      { kind: 'message', targetId: 'm15', source: 'restore' }
    ]

    for (const intent of intents) {
      const run = transaction(intent)
      expect(await run.result).toBe('success')
      expect(run.finish).toHaveBeenCalledOnce()
    }
  })
})

describe('shouldPersistNavigationResult', () => {
  it('returns true for success', () => {
    expect(shouldPersistNavigationResult('success')).toBe(true)
  })

  it('returns false for cancelled', () => {
    expect(shouldPersistNavigationResult('cancelled')).toBe(false)
  })

  it('returns false for not-found', () => {
    expect(shouldPersistNavigationResult('not-found')).toBe(false)
  })
})
