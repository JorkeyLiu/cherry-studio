/**
 * Bounded click-to-pause streaming follow (pure predicates + pause journey).
 *
 * - Press gate: primary mouse only (`button === 0`, known non-mouse pointers
 *   excluded). EVERY bubbled press target inside `#messages` pauses —
 *   reading content, blank viewport, buttons, links, inputs/editors, answer
 *   tabs, menus, collapse toggles, and media — while keeping its normal
 *   native action (the pause never prevents/stops/rewrites it). Containment
 *   is structural (the handler lives on `#messages`), so topbar/inputbar
 *   presses never reach the gate.
 * - Stream predicate: assistant `pending`/`processing`/`searching` or a
 *   member block with block-level `streaming` status. Non-assistant messages
 *   never qualify, so other-route generation cannot pause this route.
 * - Pause journey (controller-owned, same single-writer `userTakeover` path
 *   as scroll): declare → takeover with the measured row (kept EVEN when
 *   measured `isAtBottom` is true) → truthful snapshot commit (never a
 *   fabricated anchor, never a rewritten `isAtBottom`) → session close so
 *   the keeper resumes holding the row. Repeated pauses stay paused (never
 *   toggle back to bottom); unmeasurable viewports refuse fail-closed.
 */
import { commitSnapshotForRoute } from '@renderer/hooks/useScrollPosition'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RouteViewportController } from '../routeViewportController'
import {
  hasActiveStreamingReply,
  isActiveAssistantReplyStatus,
  isPrimaryMousePointerDown,
  shouldPauseStreamingOnPrimaryMouseDown
} from '../streamingPause'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  subscribeDeletionGeneration: vi.fn(() => () => {})
}))

let store: Map<string, unknown>

beforeEach(() => {
  store = new Map()
  document.body.innerHTML = ''
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
    remove: (key: string) => {
      store.delete(key)
    }
  }
})

const driveStableMessage = (controller: RouteViewportController, messageId: string, offset: number): void => {
  const { epoch } = controller.request({
    kind: 'top',
    topicId: 't1',
    targetRoute: null,
    saved: { scrollTop: -400, messageId, intraRowOffset: offset, isAtBottom: false }
  })
  controller.appliedWindow(epoch)
  controller.firstPositioned(epoch, 'placed')
  controller.revealed(epoch)
  const out = controller.commitStable(epoch, { messageId, intraRowOffset: offset, scrollTop: -400, isAtBottom: false })
  expect(out.committed).toBe(true)
}

describe('primary mouse press gate', () => {
  it('accepts button 0 mouse presses, including an absent pointerType', () => {
    expect(isPrimaryMousePointerDown({ button: 0, pointerType: 'mouse' })).toBe(true)
    expect(isPrimaryMousePointerDown({ button: 0 })).toBe(true)
    expect(isPrimaryMousePointerDown({ button: 0, pointerType: '' })).toBe(true)
  })

  it('rejects right/middle buttons, touch/pen pointers, and missing events', () => {
    expect(isPrimaryMousePointerDown({ button: 2, pointerType: 'mouse' })).toBe(false)
    expect(isPrimaryMousePointerDown({ button: 1, pointerType: 'mouse' })).toBe(false)
    expect(isPrimaryMousePointerDown({ button: 0, pointerType: 'touch' })).toBe(false)
    expect(isPrimaryMousePointerDown({ button: 0, pointerType: 'pen' })).toBe(false)
    expect(isPrimaryMousePointerDown(null)).toBe(false)
    expect(isPrimaryMousePointerDown(undefined)).toBe(false)
    expect(isPrimaryMousePointerDown({})).toBe(false)
  })
})

describe('viewport press gate (all bubbled targets pause)', () => {
  it('pauses on every press target inside the viewport — controls keep their action', () => {
    document.body.innerHTML = `<div id="messages"><button>copy</button><a href="https://example.com">link</a><p>reading</p></div>`
    // Gate is target-agnostic: the primary press alone qualifies. Native
    // control behavior is untouched (pure predicate — no preventDefault /
    // stopPropagation / inert), proven by the native click firing below.
    expect(shouldPauseStreamingOnPrimaryMouseDown({ button: 0, pointerType: 'mouse' })).toBe(true)
    expect(shouldPauseStreamingOnPrimaryMouseDown({ button: 0 })).toBe(true)
  })

  it('proves a button/link press both qualifies AND fires its normal action', () => {
    document.body.innerHTML = `<div id="messages"><button id="b">copy</button><a id="l" href="https://example.com">link</a></div>`
    let buttonClicks = 0
    let linkClicks = 0
    const button = document.getElementById('b') as HTMLButtonElement
    const link = document.getElementById('l') as HTMLAnchorElement
    button.addEventListener('click', () => {
      buttonClicks += 1
    })
    link.addEventListener('click', (e) => {
      e.preventDefault()
      linkClicks += 1
    })
    // Pointer gate qualifies the press …
    expect(shouldPauseStreamingOnPrimaryMouseDown({ button: 0, pointerType: 'mouse' })).toBe(true)
    // … while the ordinary native action still executes exactly once.
    button.click()
    link.click()
    expect(buttonClicks).toBe(1)
    expect(linkClicks).toBe(1)
  })

  it('fail-closes on non-primary presses and missing events', () => {
    expect(shouldPauseStreamingOnPrimaryMouseDown({ button: 2, pointerType: 'mouse' })).toBe(false)
    expect(shouldPauseStreamingOnPrimaryMouseDown({ button: 0, pointerType: 'touch' })).toBe(false)
    expect(shouldPauseStreamingOnPrimaryMouseDown(null)).toBe(false)
    expect(shouldPauseStreamingOnPrimaryMouseDown(undefined)).toBe(false)
  })
})

describe('active stream predicate', () => {
  it('recognizes assistant pending/processing/searching, never success/error/paused', () => {
    expect(isActiveAssistantReplyStatus('pending')).toBe(true)
    expect(isActiveAssistantReplyStatus('processing')).toBe(true)
    expect(isActiveAssistantReplyStatus('searching')).toBe(true)
    expect(isActiveAssistantReplyStatus('success')).toBe(false)
    expect(isActiveAssistantReplyStatus('error')).toBe(false)
    expect(isActiveAssistantReplyStatus('paused')).toBe(false)
    expect(isActiveAssistantReplyStatus(undefined)).toBe(false)
  })

  it('matches message-level activity without any block lookup', () => {
    expect(hasActiveStreamingReply([{ role: 'assistant', status: 'processing', blocks: [] }])).toBe(true)
    expect(hasActiveStreamingReply([{ role: 'assistant', status: 'success', blocks: [] }])).toBe(false)
    expect(hasActiveStreamingReply([])).toBe(false)
    expect(hasActiveStreamingReply(null)).toBe(false)
  })

  it('matches block-level streaming for assistant messages only', () => {
    const streaming = [{ role: 'assistant', status: 'success', blocks: ['b1'] }]
    expect(hasActiveStreamingReply(streaming, () => 'streaming')).toBe(true)
    expect(hasActiveStreamingReply(streaming, () => 'success')).toBe(false)
    expect(hasActiveStreamingReply(streaming)).toBe(false)
    // Generation on another role never pauses this route.
    expect(hasActiveStreamingReply([{ role: 'user', status: 'processing', blocks: ['b1'] }], () => 'streaming')).toBe(
      false
    )
  })
})

describe('pause journey keeps the reading row without moving the viewport', () => {
  const driveBottomFollow = (controller: RouteViewportController): void => {
    driveStableMessage(controller, 'm2', -60)
    const adopted = controller.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true },
      { expectedEpoch: controller.currentEpoch }
    )
    expect(adopted.taken).toBe(true)
    // Bottom semantic: no row anchor (keeper pins scrollTop 0 through growth).
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
  }

  const pressPause = (controller: RouteViewportController) => {
    const token = controller.declareUserIntent()
    // Measured at the press: the top-crossing reading row, still at bottom
    // (stream has not pulled away yet). No scrollTop write happens anywhere.
    const out = controller.userTakeover(
      { messageId: 'm2', intraRowOffset: -60, scrollTop: 0, isAtBottom: true },
      undefined,
      token
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return null
    const ok = commitSnapshotForRoute(out.routeKey, {
      scrollTop: out.snapshot.scrollTop,
      anchorId: out.snapshot.messageId,
      messageId: out.snapshot.messageId,
      intraRowOffset: out.snapshot.intraRowOffset,
      rawScrollTop: out.snapshot.scrollTop,
      isAtBottom: out.snapshot.isAtBottom
    })
    expect(ok).toBe(true)
    controller.clearUserIntent()
    return out
  }

  it('primary content press adopts the reading row truthfully and closes the press session', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveBottomFollow(controller)

    const out = pressPause(controller)
    expect(out).not.toBeNull()
    // Row anchor kept EVEN with measured isAtBottom true; snapshot carries
    // the measured truth (never a fabricated anchor, never a rewritten flag).
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    expect(out?.snapshot).toMatchObject({ messageId: 'm2', scrollTop: 0, isAtBottom: true })
    const saved = store.get('scroll:topic-t1::main') as { messageId: string; isAtBottom: boolean; scrollTop: number }
    expect(saved.messageId).toBe('m2')
    expect(saved.isAtBottom).toBe(true)
    expect(saved.scrollTop).toBe(0)
    // The press session closed at once so the keeper resumes holding the
    // row through stream growth (a no-scroll press never gets scrollend).
    expect(controller.userIntentPending).toBe(false)
  })

  it('repeated content presses stay paused (never toggle back to bottom)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveBottomFollow(controller)
    pressPause(controller)
    pressPause(controller)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).not.toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    expect(controller.userIntentPending).toBe(false)
  })

  it('unmeasurable viewports refuse fail-closed (no fabricated anchor)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveBottomFollow(controller)
    const token = controller.declareUserIntent()
    const out = controller.userTakeover(
      { messageId: null, intraRowOffset: null, scrollTop: -500, isAtBottom: false },
      undefined,
      token
    )
    expect(out.taken).toBe(false)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
  })
})
