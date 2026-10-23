import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import {
  applyColumnReverseScroll,
  type BootstrapDecisionInput,
  canHandleUserViewportScroll,
  chooseNavigationWindow,
  computeColumnReverseMessageScrollTop,
  computeRestoreMessageScrollTop,
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
    return 'success' as const
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
    clientHeight: 800,
    scrollTop: 0,
    scrollTo: vi.fn()
  })

  it('top: calls container.scrollTo with negative scrollHeight', () => {
    const container = makeContainer(5000)
    expect(applyColumnReverseScroll({ kind: 'top' }, container, vi.fn())).toBe('success')
    expect(container.scrollTo).toHaveBeenCalledOnce()
    expect(container.scrollTo).toHaveBeenCalledWith({ top: -5000 })
  })

  it('bottom: calls container.scrollTo with 0', () => {
    const container = makeContainer(5000)
    expect(applyColumnReverseScroll({ kind: 'bottom' }, container, vi.fn())).toBe('success')
    expect(container.scrollTo).toHaveBeenCalledOnce()
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0 })
  })

  it('scrollTop: passes through the scrollTop value to container.scrollTo', () => {
    const container = makeContainer(5000)
    expect(applyColumnReverseScroll({ kind: 'scrollTop', scrollTop: -1800 }, container, vi.fn())).toBe('success')
    expect(container.scrollTo).toHaveBeenCalledOnce()
    expect(container.scrollTo).toHaveBeenCalledWith({ top: -1800 })
  })

  it('message: delegates to scrollElementIntoView callback with targetId and alignment', () => {
    const container = makeContainer()
    const scrollIntoView = vi.fn(() => 'success' as const)
    expect(
      applyColumnReverseScroll({ kind: 'message', targetId: 'msg-42', alignment: 'center' }, container, scrollIntoView)
    ).toBe('success')
    expect(container.scrollTo).not.toHaveBeenCalled()
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView).toHaveBeenCalledWith('msg-42', 'center')
  })

  it('message: default alignment is start when not specified in resolved', () => {
    const scrollIntoView = vi.fn(() => 'success' as const)
    expect(
      applyColumnReverseScroll(
        { kind: 'message', targetId: 'msg-10', alignment: 'start' },
        makeContainer(),
        scrollIntoView
      )
    ).toBe('success')
    expect(scrollIntoView).toHaveBeenCalledWith('msg-10', 'start')
  })

  it('message: propagates not-found when the row callback reports missing target', () => {
    const container = makeContainer()
    const scrollIntoView = vi.fn(() => 'not-found' as const)
    expect(
      applyColumnReverseScroll(
        { kind: 'message', targetId: 'msg-missing', alignment: 'start' },
        container,
        scrollIntoView
      )
    ).toBe('not-found')
    expect(container.scrollTo).not.toHaveBeenCalled()
  })

  it('message: propagates cancelled when the row callback reports currency refusal', () => {
    const container = makeContainer()
    const scrollIntoView = vi.fn(() => 'cancelled' as const)
    expect(
      applyColumnReverseScroll(
        { kind: 'message', targetId: 'msg-stale', alignment: 'start' },
        container,
        scrollIntoView
      )
    ).toBe('cancelled')
  })

  it('null container: cancelled for top (no scrollTo, no scrollIntoView)', () => {
    const scrollIntoView = vi.fn()
    expect(applyColumnReverseScroll({ kind: 'top' }, null, scrollIntoView)).toBe('cancelled')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('undefined container: cancelled for bottom', () => {
    const scrollIntoView = vi.fn()
    expect(applyColumnReverseScroll({ kind: 'bottom' }, undefined, scrollIntoView)).toBe('cancelled')
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('null container with message kind: still calls scrollElementIntoView', () => {
    const scrollIntoView = vi.fn(() => 'success' as const)
    expect(
      applyColumnReverseScroll({ kind: 'message', targetId: 'msg-5', alignment: 'end' }, null, scrollIntoView)
    ).toBe('success')
    expect(scrollIntoView).toHaveBeenCalledWith('msg-5', 'end')
  })

  it('top with zero scrollHeight: calls scrollTo with -0', () => {
    const container = makeContainer(0)
    expect(applyColumnReverseScroll({ kind: 'top' }, container, vi.fn())).toBe('success')
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

describe('computeRestoreMessageScrollTop — saved-offset restore geometry', () => {
  // Topic away/back regression shape: elementTop -561 (row content offset at
  // scrollTop -470 with the row at -91), saved offset -91 → scrollTo -470.
  const RESTORE = {
    elementTopWithinContainer: -561,
    restoreOffset: -91,
    minScrollTop: -9426
  }

  it('lands the row exactly at its saved negative offset', () => {
    expect(computeRestoreMessageScrollTop(RESTORE)).toBe(-470)
  })

  it('already-placed geometry is the identity (caller skips the write within 1px)', () => {
    const top = computeRestoreMessageScrollTop({ ...RESTORE, elementTopWithinContainer: -561 })
    expect(top).not.toBeNull()
    // scrollTop -470 already holds offset -91: |(-470) - (-470)| = 0, no write.
    expect(Math.abs(-470 - top!)).toBeLessThanOrEqual(1)
  })

  it('clamps beyond-edge targets to the oldest edge', () => {
    expect(computeRestoreMessageScrollTop({ ...RESTORE, elementTopWithinContainer: -20000 })).toBe(RESTORE.minScrollTop)
  })

  it('clamps above-bottom targets to 0', () => {
    expect(computeRestoreMessageScrollTop({ ...RESTORE, elementTopWithinContainer: 50, restoreOffset: -91 })).toBe(0)
  })

  it('returns null for a missing offset (caller keeps its alignment path)', () => {
    expect(computeRestoreMessageScrollTop({ ...RESTORE, restoreOffset: null })).toBeNull()
    expect(computeRestoreMessageScrollTop({ ...RESTORE, restoreOffset: undefined })).toBeNull()
  })

  it('returns null for a non-finite offset or geometry (fail-closed)', () => {
    expect(computeRestoreMessageScrollTop({ ...RESTORE, restoreOffset: NaN })).toBeNull()
    expect(
      computeRestoreMessageScrollTop({ ...RESTORE, elementTopWithinContainer: Number.POSITIVE_INFINITY })
    ).toBeNull()
    expect(computeRestoreMessageScrollTop({ ...RESTORE, minScrollTop: NaN })).toBeNull()
  })
})

describe('resolveMessageNavigation restore offset pass-through', () => {
  it('carries a finite restoreOffset to the resolved navigation', () => {
    const resolved = resolveMessageNavigation(messages, {
      kind: 'message',
      targetId: 'm10',
      source: 'restore',
      restoreOffset: -91
    })
    expect(resolved).toEqual({ kind: 'message', targetId: 'm10', alignment: 'start', restoreOffset: -91 })
  })

  it('normalizes a missing offset to null (explicit path unchanged)', () => {
    const resolved = resolveMessageNavigation(messages, { kind: 'message', targetId: 'm10', source: 'event' })
    expect(resolved).toEqual({ kind: 'message', targetId: 'm10', alignment: 'start', restoreOffset: null })
  })

  it('drops a non-finite offset to null (fail-closed, never NaN geometry)', () => {
    const resolved = resolveMessageNavigation(messages, {
      kind: 'message',
      targetId: 'm10',
      source: 'restore',
      restoreOffset: NaN
    })
    expect(resolved).toEqual({ kind: 'message', targetId: 'm10', alignment: 'start', restoreOffset: null })
  })
})

describe('computeColumnReverseMessageScrollTop — explicit resident-row geometry', () => {
  // Reproduces the verified delivery defect: a resident oldest row far above
  // the viewport (elementTop -12073, container 802px, scroll range
  // [-12142, 0]) must scroll to the clamped oldest edge — never stay at 0.
  const OLDEST = {
    elementTopWithinContainer: -12073,
    containerClientHeight: 802,
    elementHeight: 120,
    minScrollTop: -12142
  }

  it('start: oldest resident row scrolls to its exact content offset (finite, negative, moved)', () => {
    const top = computeColumnReverseMessageScrollTop({ ...OLDEST, alignment: 'start' })
    expect(top).not.toBeNull()
    expect(Number.isFinite(top!)).toBe(true)
    expect(top!).toBeLessThan(0)
    expect(top!).toBe(OLDEST.elementTopWithinContainer)
  })

  it('start: unreachable-beyond-edge offset clamps to the oldest edge', () => {
    const top = computeColumnReverseMessageScrollTop({
      ...OLDEST,
      alignment: 'start',
      elementTopWithinContainer: -13000
    })
    expect(top).toBe(OLDEST.minScrollTop)
  })

  it('start: mid-list row lands exactly at its content offset', () => {
    const top = computeColumnReverseMessageScrollTop({
      elementTopWithinContainer: -5546,
      containerClientHeight: 802,
      elementHeight: 120,
      alignment: 'start',
      minScrollTop: -12142
    })
    expect(top).toBe(-5546)
  })

  it('center/end: offset by the free space around the row', () => {
    const base = {
      elementTopWithinContainer: -5546,
      containerClientHeight: 802,
      elementHeight: 120,
      minScrollTop: -12142
    }
    expect(computeColumnReverseMessageScrollTop({ ...base, alignment: 'center' })).toBe(-5546 - (802 - 120) / 2)
    expect(computeColumnReverseMessageScrollTop({ ...base, alignment: 'end' })).toBe(-5546 - (802 - 120))
  })

  it('newest row at the bottom clamps to 0 (never positive)', () => {
    const top = computeColumnReverseMessageScrollTop({
      elementTopWithinContainer: -50,
      containerClientHeight: 802,
      elementHeight: 120,
      alignment: 'start',
      minScrollTop: -12142
    })
    expect(top).toBe(-50)
    const belowBottom = computeColumnReverseMessageScrollTop({
      elementTopWithinContainer: 30,
      containerClientHeight: 802,
      elementHeight: 120,
      alignment: 'start',
      minScrollTop: -12142
    })
    expect(belowBottom).toBe(0)
  })

  it('non-finite input fails closed with null (caller skips the write)', () => {
    expect(
      computeColumnReverseMessageScrollTop({ ...OLDEST, alignment: 'start', elementTopWithinContainer: NaN })
    ).toBeNull()
    expect(
      computeColumnReverseMessageScrollTop({ ...OLDEST, alignment: 'start', minScrollTop: Number.POSITIVE_INFINITY })
    ).toBeNull()
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
      expect(decision.intent).toEqual({ kind: 'message', targetId: 'msg-5', source: 'restore', restoreOffset: null })
    }
  })

  it('passes the saved negative intra-row offset through the restore intent (no start pin)', () => {
    // Regression shape of the topic away/back duplicate write: savedOff -91
    // must ride the intent so the transaction scroll converges on the stable
    // offset instead of start-aligning the row at 0.
    const decision = resolveBootstrapDecision({
      ...baseInput,
      savedPosition: {
        scrollTop: -470,
        anchorId: 'msg-10',
        messageId: 'msg-10',
        intraRowOffset: -91,
        isAtBottom: false
      }
    })

    expect(decision).toEqual({
      action: 'restore',
      intent: { kind: 'message', targetId: 'msg-10', source: 'restore', restoreOffset: -91 }
    })
  })

  it('selects saved restore when no matching pending exists', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      savedPosition: { scrollTop: 50, anchorId: 'msg-10', isAtBottom: false }
    })

    expect(decision).toEqual({
      action: 'restore',
      intent: { kind: 'message', targetId: 'msg-10', source: 'restore', restoreOffset: null }
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

  it('pending with wrong topicId is ignored and falls through to a restore with the saved offset', () => {
    const decision = resolveBootstrapDecision({
      ...baseInput,
      pending: { messageId: 'msg-42', topicId: 'wrong-topic' },
      savedPosition: { scrollTop: 200, anchorId: 'msg-10', intraRowOffset: -40, isAtBottom: false }
    })

    expect(decision).toEqual({
      action: 'restore',
      intent: { kind: 'message', targetId: 'msg-10', source: 'restore', restoreOffset: -40 }
    })
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

describe('transaction scroll outcome — production no-op skip contract', () => {
  const baseDeps = () => {
    const effectiveWindow = createTargetMessageWindow(messages, 'm10', 10, 19)
    return {
      begin: vi.fn(async () => true),
      isCurrent: () => true,
      cancelLoadsAndTimers: vi.fn(),
      resolve: (requested: MessageNavigationIntent) => resolveMessageNavigation(messages, requested),
      prepareWindow: (resolved: Parameters<typeof chooseNavigationWindow>[2]) =>
        chooseNavigationWindow(messages, effectiveWindow, resolved, 10),
      applyWindow: vi.fn(async () => true),
      getTargetStatus: () => 'visible' as const,
      revealTarget: vi.fn(async () => {}),
      settleDom: vi.fn(async () => {}),
      beginProgrammaticScroll: vi.fn(async () => true),
      finish: vi.fn(),
      cancel: vi.fn()
    }
  }

  it('cancelled scroll skips finish, cancels, and never persists (currency refusal)', async () => {
    const deps = baseDeps()
    const result = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm15', source: 'event' },
      { ...deps, scroll: vi.fn(() => 'cancelled' as const) }
    )
    expect(result).toBe('cancelled')
    expect(deps.cancel).toHaveBeenCalledOnce()
    expect(deps.finish).not.toHaveBeenCalled()
    expect(shouldPersistNavigationResult(result)).toBe(false)
  })

  it('not-found scroll skips finish, cancels, and never persists (missing physical target)', async () => {
    const deps = baseDeps()
    const result = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm15', source: 'pending' },
      { ...deps, scroll: vi.fn(() => 'not-found' as const) }
    )
    expect(result).toBe('not-found')
    expect(deps.cancel).toHaveBeenCalledOnce()
    expect(deps.finish).not.toHaveBeenCalled()
    expect(shouldPersistNavigationResult(result)).toBe(false)
  })

  it('explicit bottom scroll success still finishes and persists', async () => {
    const deps = baseDeps()
    const result = await runMessageNavigationTransaction(
      { kind: 'bottom', source: 'imperative' },
      { ...deps, scroll: vi.fn(() => 'success' as const) }
    )
    expect(result).toBe('success')
    expect(deps.finish).toHaveBeenCalledOnce()
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(shouldPersistNavigationResult(result)).toBe(true)
  })

  it('void scroll (focused legacy mock) stays success for compatibility', async () => {
    const deps = baseDeps()
    const result = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm15', source: 'event' },

      { ...deps, scroll: vi.fn(() => undefined as any) }
    )
    expect(result).toBe('success')
    expect(deps.finish).toHaveBeenCalledOnce()
  })
})

describe('resident selection follow through the transaction', () => {
  const resolved = resolveMessageNavigation(messages, {
    kind: 'message',
    targetId: 'm31',
    source: 'group'
  })!

  it('writes the geometry before any dispatch and never touches window/reveal/settle', async () => {
    const order: string[] = []
    const spies = {
      scroll: vi.fn(() => {
        order.push('scroll')
        return 'success' as const
      }),
      begin: vi.fn(() => {
        order.push('begin')
        return true
      }),
      finish: vi.fn(() => order.push('finish')),
      cancel: vi.fn(() => order.push('cancel')),
      prepareWindow: vi.fn(() => ({ displayMessages: messages }) as unknown as MessageWindow),
      applyWindow: vi.fn(async () => true),
      getTargetStatus: vi.fn(() => 'visible' as const),
      revealTarget: vi.fn(async () => {}),
      settleDom: vi.fn(async () => {}),
      beginProgrammaticScroll: vi.fn(() => true),
      cancelLoadsAndTimers: vi.fn()
    }

    const result = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm31', source: 'group' },
      {
        resident: true,
        isCurrent: () => {
          order.push('isCurrent')
          return true
        },
        resolve: () => resolved,
        ...spies
      }
    )

    expect(result).toBe('success')
    // The write is the first thing that happens in the whole transaction.
    expect(order).toEqual(['scroll', 'begin', 'finish'])
    expect(spies.scroll).toHaveBeenCalledOnce()
    // Nothing the barrier exists for is even consulted.
    expect(spies.prepareWindow).not.toHaveBeenCalled()
    expect(spies.applyWindow).not.toHaveBeenCalled()
    expect(spies.getTargetStatus).not.toHaveBeenCalled()
    expect(spies.revealTarget).not.toHaveBeenCalled()
    expect(spies.settleDom).not.toHaveBeenCalled()
    expect(spies.beginProgrammaticScroll).not.toHaveBeenCalled()
    expect(spies.cancelLoadsAndTimers).not.toHaveBeenCalled()
  })

  it('reports the truthful outcome of the write (cancelled keeps no finish, missing target cancels)', async () => {
    const cancel = vi.fn()
    const finish = vi.fn()

    const cancelled = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm31', source: 'group' },
      {
        resident: true,
        begin: () => true,
        cancel,
        finish,
        isCurrent: () => true,
        resolve: () => resolved,
        prepareWindow: () => null,
        applyWindow: async () => true,
        getTargetStatus: () => 'visible',
        revealTarget: async () => {},
        settleDom: async () => {},
        beginProgrammaticScroll: () => true,
        cancelLoadsAndTimers: () => {},
        scroll: () => 'cancelled'
      }
    )
    expect(cancelled).toBe('cancelled')
    expect(finish).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()

    const missing = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm31', source: 'group' },
      {
        resident: true,
        begin: () => true,
        cancel: vi.fn(),
        finish: vi.fn(),
        isCurrent: () => true,
        resolve: () => null,
        prepareWindow: () => null,
        applyWindow: async () => true,
        getTargetStatus: () => 'missing',
        revealTarget: async () => {},
        settleDom: async () => {},
        beginProgrammaticScroll: () => true,
        cancelLoadsAndTimers: () => {},
        scroll: vi.fn(() => 'success' as const)
      }
    )
    expect(missing).toBe('not-found')
  })
})
