/**
 * Shared interaction intent (arbitrary regions over message/group scopes).
 *
 * Pins the controller-owned shared state the keeper arbitrates: scope +
 * region identity, layout-owner fingerprint recording, current/stale/quiet
 * lifecycle, bottom refusal, and user-takeover/send/request/detach
 * invalidation. No editor metadata appears anywhere: completion distinguishes
 * real effects from no-effect clicks purely through scope-dimension
 * fingerprints versus live geometry (keeper + E2E region oracle).
 */
import { describe, expect, it } from 'vitest'

import { RouteViewportController } from '../routeViewportController'

const driveStableMessage = (controller: RouteViewportController, messageId: string, offset: number): void => {
  const { epoch } = controller.request({
    kind: 'top',
    topicId: 't1',
    targetRoute: null,
    saved: { scrollTop: -400, messageId, intraRowOffset: offset, isAtBottom: false },
    snapshotInvalid: false
  })
  controller.appliedWindow(epoch)
  controller.firstPositioned(epoch, 'placed')
  controller.revealed(epoch)
  const out = controller.commitStable(epoch, { messageId, intraRowOffset: offset, scrollTop: -400, isAtBottom: false })
  expect(out.committed).toBe(true)
}

const MSG = (id: string) => ({ kind: 'message' as const, id })
const GROUP = (id: string) => ({ kind: 'group' as const, id })

describe('shared interaction intent', () => {
  it('arms arbitrary region identities in message and group scopes with fingerprints', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(
      c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120, {
        fingerprint: { scopeH: 300, scopeW: 400 }
      })
    ).toBe(true)
    expect(c.activeInteractionIntent).toMatchObject({
      scopeKind: 'message',
      scopeId: 'm1',
      region: 'message-controls',
      offset: 120,
      fingerprint: { scopeH: 300, scopeW: 400 }
    })
    expect(typeof c.activeInteractionIntent?.gestureId).toBe('number')
    expect(typeof c.activeInteractionIntent?.capturedAt).toBe('number')
    // Tab compatibility view stays null for a non-tab gesture.
    expect(c.activeAnswerTabIntent).toBeNull()

    expect(
      c.beginInteractionIntent({ topicId: 't1', route: null }, GROUP('group:ask-1'), 'fold-controls', 210, {
        fingerprint: { scopeH: 500, scopeW: 400 }
      })
    ).toBe(true)
    expect(c.activeInteractionIntent).toMatchObject({
      scopeKind: 'group',
      scopeId: 'group:ask-1',
      region: 'fold-controls',
      offset: 210
    })
  })

  it('tab entry still arms through the shared owner with the same gesture order', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(c.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    expect(c.activeAnswerTabIntent).toEqual({
      topicId: 't1',
      route: null,
      epoch: c.currentEpoch,
      tabMessageId: 'short',
      tabOffset: 200,
      gestureId: 1
    })
    // The shared view observes the same gesture under scope identity.
    expect(c.activeInteractionIntent).toMatchObject({
      scopeKind: 'message',
      scopeId: 'short',
      region: 'answer-tab',
      offset: 200
    })
  })

  it('a newer capture overwrites; stale clears refuse (current/stale/quiet)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 100)).toBe(true)
    const first = c.activeInteractionIntent
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 104)).toBe(true)
    const second = c.activeInteractionIntent
    expect(second?.gestureId).toBe((first?.gestureId ?? 0) + 1)
    // Stale completion for the first gesture refuses and keeps the newer one.
    expect(c.clearInteractionIntent(first?.epoch, first?.scopeId, first?.gestureId, first?.region)).toBe(false)
    expect(c.activeInteractionIntent?.gestureId).toBe(second?.gestureId)
    // Current gesture clears.
    expect(c.clearInteractionIntent(second?.epoch, second?.scopeId, second?.gestureId, second?.region)).toBe(true)
    expect(c.activeInteractionIntent).toBeNull()
  })

  it('stale tab clear never clears a newer hold and vice versa', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(c.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    const tab = c.activeAnswerTabIntent
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120)).toBe(true)
    // The tab gesture is superseded by the newer overwrite; the stale tab
    // clear refuses (no scope match on the live hold).
    expect(c.clearAnswerTabSwitch(tab?.epoch, tab?.tabMessageId, tab?.gestureId)).toBe(false)
    expect(c.activeInteractionIntent?.region).toBe('message-controls')
  })

  it('refuses while owned, dirty, user-live, wrong route, or at bottom for non-tab regions', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: null, saved: null, snapshotInvalid: false })
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 10)).toBe(false)
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'placed')
    c.revealed(epoch)
    const out = c.commitStable(epoch, { messageId: 'm1', intraRowOffset: -100, scrollTop: -400, isAtBottom: false })
    expect(out.committed).toBe(true)
    expect(c.beginInteractionIntent({ topicId: 't1', route: 'branch-a' }, MSG('m1'), 'message-controls', 10)).toBe(
      false
    )
    c.declareUserIntent()
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 10)).toBe(false)
    c.clearUserIntent()

    // Bottom (no live row anchor) refuses every non-tab region — including
    // group scopes — while tabs still arm. The keeper bottom pin owns
    // clamped geometry there; a region hold would pull off the bottom.
    const b = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch: be } = b.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: 0, messageId: null, intraRowOffset: null, isAtBottom: true },
      snapshotInvalid: false
    })
    b.appliedWindow(be)
    b.firstPositioned(be, 'placed')
    b.revealed(be)
    const bout = b.commitStable(be, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true })
    expect(bout.committed).toBe(true)
    expect(b.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 10)).toBe(false)
    expect(b.beginInteractionIntent({ topicId: 't1', route: null }, GROUP('g'), 'fold-controls', 10)).toBe(false)
    expect(b.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
  })

  it('rejects malformed fingerprints fail-closed', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(
      c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 10, {
        fingerprint: { scopeH: Number.NaN, scopeW: 10 }
      })
    ).toBe(false)
    expect(c.activeInteractionIntent).toBeNull()
  })

  it('clears on user takeover, send-bottom, request, and detach (no stale trap)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120)).toBe(true)
    c.declareUserIntent()
    expect(c.activeInteractionIntent).toBeNull()
    c.clearUserIntent()

    // Takeover path: a live declare already cleared the hold above; the
    // takeover itself succeeds with no intent surviving.
    const t = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(t, 'm1', -100)
    expect(t.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120)).toBe(true)
    t.declareUserIntent()
    const token = t.activeInteractionToken
    const taken = t.userTakeover(
      { messageId: 'm1', intraRowOffset: -100, scrollTop: -400, isAtBottom: false },
      undefined,
      token ?? undefined
    )
    expect(taken.taken).toBe(true)
    expect(t.activeInteractionIntent).toBeNull()

    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120)).toBe(true)
    expect(c.beginSendBottom({ topicId: 't1', route: null })).toBe(true)
    expect(c.activeInteractionIntent).toBeNull()
    // Send-bottom suspends the row keeper to the bottom semantic (live anchor
    // null): re-drive a stable row anchor before the next sub-case, since
    // non-tab holds honestly refuse at the bottom.
    driveStableMessage(c, 'm1', -100)

    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120)).toBe(true)
    c.request({ kind: 'top', topicId: 't1', targetRoute: null, saved: null, snapshotInvalid: false })
    expect(c.activeInteractionIntent).toBeNull()

    const d = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(d, 'm1', -100)
    expect(d.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120)).toBe(true)
    d.detach()
    expect(d.activeInteractionIntent).toBeNull()
  })

  it('fail-closed on non-finite geometry and empty identity', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG(''), 'message-controls', 10)).toBe(false)
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, { kind: 'note' as never, id: 'x' }, 'r', 10)).toBe(
      false
    )
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), '', 10)).toBe(false)
    expect(c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', Number.NaN)).toBe(
      false
    )
    expect(c.activeInteractionIntent).toBeNull()
  })
})

describe('captureInteractionIntent (structural, fail-closed)', () => {
  it('returns false without a legitimate structural mapping (never guesses)', async () => {
    const mod = await import('../routeViewportContext')
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    // No container in the document: fail-closed, no intent armed.
    document.body.innerHTML = ''
    expect(mod.captureInteractionIntent(c, MSG('m1'), 'message-controls', null)).toBe(false)
    expect(c.activeInteractionIntent).toBeNull()
    // Region key with no annotated element in scope: fail-closed.
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.append(container)
    expect(mod.captureInteractionIntent(c, MSG('m1'), 'no-such-region', container)).toBe(false)
    expect(c.activeInteractionIntent).toBeNull()
    // Event without a region ancestor arms nothing.
    const btn = document.createElement('button')
    container.append(btn)
    expect(mod.captureInteractionFromEvent(c, { target: btn }, container)).toBe(false)
    expect(c.activeInteractionIntent).toBeNull()
    document.body.innerHTML = ''
  })

  it('resolves arbitrary region keys in message and group scopes', async () => {
    const mod = await import('../routeViewportContext')
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    document.body.innerHTML = ''
    const container = document.createElement('div')
    container.id = 'messages'
    const row = document.createElement('div')
    row.id = 'message-m1'
    row.setAttribute('data-message-id', 'm1')
    const footer = document.createElement('div')
    footer.setAttribute('data-interaction-region', 'message-controls')
    footer.setAttribute('data-viewport-baseline-edge', 'end')
    row.append(footer)
    const group = document.createElement('div')
    group.setAttribute('data-stable-group-id', 'group:ask-1')
    const toggle = document.createElement('div')
    toggle.setAttribute('data-interaction-region', 'fold-controls')
    group.append(toggle)
    container.append(row, group)
    document.body.append(container)
    const rect = (top: number, h: number, w: number) =>
      ({ top, bottom: top + h, height: h, width: w, left: 0, right: w, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    container.getBoundingClientRect = () => rect(0, 600, 300)
    footer.getBoundingClientRect = () => rect(100, 26, 300)
    row.getBoundingClientRect = () => rect(0, 300, 300)
    toggle.getBoundingClientRect = () => rect(400, 26, 300)
    group.getBoundingClientRect = () => rect(350, 200, 300)
    // Message edit controls declare the `end` baseline: footer top 100 + 26 =
    // bottom 126 stays invariant across the footer ↔ action-bar swap.
    expect(mod.captureInteractionIntent(c, MSG('m1'), 'message-controls', container)).toBe(true)
    expect(c.activeInteractionIntent).toMatchObject({
      scopeKind: 'message',
      scopeId: 'm1',
      region: 'message-controls',
      offset: 126,
      fingerprint: { scopeH: 300, scopeW: 300 }
    })
    // Fold keeps the default TOP baseline (no `end` declaration): toggle top
    // 400 is the correct model, not the 426 bottom.
    // Group scope capture carries the group fingerprint, not the row's.
    expect(mod.captureInteractionIntent(c, GROUP('group:ask-1'), 'fold-controls', container)).toBe(true)
    expect(c.activeInteractionIntent).toMatchObject({
      scopeKind: 'group',
      scopeId: 'group:ask-1',
      region: 'fold-controls',
      offset: 400,
      fingerprint: { scopeH: 200, scopeW: 300 }
    })
    // Click boundary derives the group scope structurally (no row ancestor).
    const unnested = document.createElement('span')
    toggle.append(unnested)
    expect(mod.captureInteractionFromEvent(c, { target: unnested }, container)).toBe(true)
    expect(c.activeInteractionIntent).toMatchObject({ scopeKind: 'group', region: 'fold-controls' })
    document.body.innerHTML = ''
  })
})

describe('continuous drag uses the shared discrete hold (no deferred settle)', () => {
  it('a plain controls hold carries no settle flag; invalidation still clears via the locked path', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(
      c.beginInteractionIntent({ topicId: 't1', route: null }, MSG('m1'), 'message-controls', 120, {
        fingerprint: { scopeH: 300, scopeW: 300 }
      })
    ).toBe(true)
    expect((c.activeInteractionIntent as unknown as { deferSettle?: unknown }).deferSettle).toBeUndefined()
    c.declareUserIntent()
    expect(c.activeInteractionIntent).toBeNull()
  })
})

describe('visual baseline edge (default start vs declared end)', () => {
  it('default measures TOP; declared end measures BOTTOM through the same helper', async () => {
    const mod = await import('../routeViewportContext')
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    document.body.innerHTML = ''
    const container = document.createElement('div')
    container.id = 'messages'
    const row = document.createElement('div')
    row.id = 'message-m1'
    row.setAttribute('data-message-id', 'm1')
    const plain = document.createElement('div')
    plain.setAttribute('data-interaction-region', 'plain-region')
    row.append(plain)
    const endRegion = document.createElement('div')
    endRegion.setAttribute('data-interaction-region', 'message-controls')
    endRegion.setAttribute('data-viewport-baseline-edge', 'end')
    row.append(endRegion)
    container.append(row)
    document.body.append(container)
    const rect = (top: number, h: number, w: number) =>
      ({ top, bottom: top + h, height: h, width: w, left: 0, right: w, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    container.getBoundingClientRect = () => rect(0, 600, 300)
    row.getBoundingClientRect = () => rect(0, 300, 300)
    plain.getBoundingClientRect = () => rect(120, 26, 300)
    endRegion.getBoundingClientRect = () => rect(120, 26, 300)
    expect(mod.captureInteractionIntent(c, MSG('m1'), 'plain-region', container)).toBe(true)
    expect(c.activeInteractionIntent).toMatchObject({ region: 'plain-region', offset: 120 })
    expect(mod.captureInteractionIntent(c, MSG('m1'), 'message-controls', container)).toBe(true)
    expect(c.activeInteractionIntent).toMatchObject({ region: 'message-controls', offset: 146 })
    expect(mod.resolveViewportBaselineEdge(plain)).toBe('start')
    expect(mod.resolveViewportBaselineEdge(endRegion)).toBe('end')
    expect(mod.measureViewportRegionOffset(plain, container)).toBe(120)
    expect(mod.measureViewportRegionOffset(endRegion, container)).toBe(146)
    document.body.innerHTML = ''
  })

  it('missing/illegal declarations fail to the default TOP (never a second end)', async () => {
    const mod = await import('../routeViewportContext')
    const el = document.createElement('div')
    expect(mod.resolveViewportBaselineEdge(null)).toBe('start')
    expect(mod.resolveViewportBaselineEdge(undefined)).toBe('start')
    expect(mod.resolveViewportBaselineEdge(el)).toBe('start')
    el.setAttribute('data-viewport-baseline-edge', 'bottom')
    expect(mod.resolveViewportBaselineEdge(el)).toBe('start')
    el.setAttribute('data-viewport-baseline-edge', '')
    expect(mod.resolveViewportBaselineEdge(el)).toBe('start')
    el.setAttribute('data-viewport-baseline-edge', 'end')
    expect(mod.resolveViewportBaselineEdge(el)).toBe('end')
    el.removeAttribute('data-viewport-baseline-edge')
    expect(mod.resolveViewportBaselineEdge(el)).toBe('start')
  })
})
