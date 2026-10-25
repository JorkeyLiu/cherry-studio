import { describe, expect, it } from 'vitest'

import { COLUMN_REVERSE_BOTTOM_THRESHOLD_PX, isAtBottom } from '../columnReverseGeometry'
import { RouteViewportController } from '../routeViewportController'

/**
 * Navigation anchor handoff contract (Messages.tsx scroll callback).
 *
 * Defect: the message-navigation transaction scrolled `#messages`
 * arithmetically but never installed the post-scroll row anchor. The keeper
 * kept holding the old live anchor (bottom null after a send/bottom, or a
 * stale reading row) and pulled back on the next Resize/Mutation
 * (`getAnchorFor(displayed) == null => scrollTop 0`, else hold old offset).
 *
 * Fix: the scroll callback synchronously installs the actual navigated row
 * via the existing `adoptInteractionViewport` (row kept even in bottom
 * vicinity, unlike the send/bottom programmatic path) + commits the snapshot
 * + notifies, fail-closed on currency skip or missing physical target.
 * Navigation to a user ID is a reading row even when `isAtBottom` vicinity
 * is true — never an auto-resume follow.
 */
const driveStableBottom = (controller: RouteViewportController): void => {
  // Bottom semantic: live anchor null. Drive via the existing send-bottom
  // suspension + programmatic adopt (the only bottom producer), not by hand.
  const target = { topicId: 't1', route: null as string | null }
  expect(controller.beginSendBottom(target, { expectedEpoch: controller.currentEpoch })).toBe(true)
  const out = controller.adoptProgrammaticViewport(
    target,
    { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true },
    { expectedEpoch: controller.currentEpoch }
  )
  expect(out.taken).toBe(true)
  expect(controller.getAnchorFor(target)).toBeNull()
}

describe('message navigation anchor handoff', () => {
  it('bottom live anchor -> navigate row installs the row so the keeper holds the target, not the bottom', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    // Reach a clean stable viewport first (bootstrap rebase with proof).
    expect(controller.rebaseClean({ topicId: 't1', route: null }, 'oldest::newest::20')).toBe(true)
    driveStableBottom(controller)
    const target = { topicId: 't1', route: null as string | null }
    const epoch = controller.currentEpoch

    // Simulated post-scroll measurement for a resident historical target:
    // scrolled to -1293, target at the container top (offset ~0.2).
    const postScrollTop = -1293
    const intraRowOffset = 0.2
    const atBottom = isAtBottom(postScrollTop, COLUMN_REVERSE_BOTTOM_THRESHOLD_PX)
    expect(atBottom).toBe(false)
    const out = controller.adoptInteractionViewport(
      target,
      { messageId: 't-old', intraRowOffset, scrollTop: postScrollTop, isAtBottom: atBottom },
      { expectedEpoch: epoch }
    )
    expect(out.taken).toBe(true)
    // Keeper source now resolves the navigated row (not bottom null).
    expect(controller.getAnchorFor(target)).toEqual({
      kind: 'message',
      messageId: 't-old',
      offset: intraRowOffset
    })
  })

  it('near-bottom navigated row is kept as a row even when truthfully in bottom vicinity (no auto follow)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    expect(controller.rebaseClean({ topicId: 't1', route: null }, 'oldest::newest::14')).toBe(true)
    driveStableBottom(controller)
    const target = { topicId: 't1', route: null as string | null }
    // T2 attach shape: target near newest, clamped scroll keeps it inside the
    // viewport while truthfully in the 50px bottom vicinity.
    const postScrollTop = -30
    expect(isAtBottom(postScrollTop, COLUMN_REVERSE_BOTTOM_THRESHOLD_PX)).toBe(true)
    const out = controller.adoptInteractionViewport(
      target,
      { messageId: 't-attach', intraRowOffset: 566, scrollTop: postScrollTop, isAtBottom: true },
      { expectedEpoch: controller.currentEpoch }
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.snapshot).toMatchObject({ messageId: 't-attach', isAtBottom: true })
    // Row kept — follow (null anchor) is NOT resumed by vicinity.
    expect(controller.getAnchorFor(target)).toEqual({
      kind: 'message',
      messageId: 't-attach',
      offset: 566
    })
  })

  it('stale route / stale epoch / owned viewport fails closed without disturbing the live anchor', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    expect(controller.rebaseClean({ topicId: 't1', route: null }, 'w1')).toBe(true)
    driveStableBottom(controller)
    const target = { topicId: 't1', route: null as string | null }
    const epoch = controller.currentEpoch
    const good = controller.adoptInteractionViewport(
      target,
      { messageId: 't-old', intraRowOffset: 0, scrollTop: -500, isAtBottom: false },
      { expectedEpoch: epoch }
    )
    expect(good.taken).toBe(true)

    // Stale epoch (route swapped under the transaction).
    const stale = controller.adoptInteractionViewport(
      target,
      { messageId: 't-other', intraRowOffset: 0, scrollTop: -600, isAtBottom: false },
      { expectedEpoch: epoch + 99 }
    )
    expect(stale.taken).toBe(false)
    expect(controller.getAnchorFor(target)).toEqual({ kind: 'message', messageId: 't-old', offset: 0 })

    // Foreign route never adopts.
    const foreign = controller.adoptInteractionViewport(
      { topicId: 't1', route: 'b1' },
      { messageId: 't-other', intraRowOffset: 0, scrollTop: -600, isAtBottom: false },
      { expectedEpoch: controller.currentEpoch }
    )
    expect(foreign.taken).toBe(false)
    expect(controller.getAnchorFor(target)).toEqual({ kind: 'message', messageId: 't-old', offset: 0 })

    // Owned transition refuses.
    const owned = new RouteViewportController({ topicId: 't1', route: null })
    expect(owned.rebaseClean({ topicId: 't1', route: null }, 'w1')).toBe(true)
    owned.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    const refused = owned.adoptInteractionViewport(
      { topicId: 't1', route: null },
      { messageId: 't-old', intraRowOffset: 0, scrollTop: -500, isAtBottom: false }
    )
    expect(refused.taken).toBe(false)
  })

  it('explicit bottom still follows via the send/bottom programmatic path (null anchor, not a row)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    expect(controller.rebaseClean({ topicId: 't1', route: null }, 'w1')).toBe(true)
    const target = { topicId: 't1', route: null as string | null }
    // Reading row first (post-navigation state).
    const row = controller.adoptInteractionViewport(
      target,
      { messageId: 't-old', intraRowOffset: 0, scrollTop: -500, isAtBottom: false },
      { expectedEpoch: controller.currentEpoch }
    )
    expect(row.taken).toBe(true)
    // Explicit bottom navigation suspends to the bottom semantic then adopts
    // the measured bottom through the programmatic path (existing
    // scrollToBottom / runSendBottomIntent binding).
    expect(controller.beginSendBottom(target, { expectedEpoch: controller.currentEpoch })).toBe(true)
    expect(controller.getAnchorFor(target)).toBeNull()
    const bottom = controller.adoptProgrammaticViewport(
      target,
      { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true },
      { expectedEpoch: controller.currentEpoch }
    )
    expect(bottom.taken).toBe(true)
    expect(controller.getAnchorFor(target)).toBeNull()
  })
})
