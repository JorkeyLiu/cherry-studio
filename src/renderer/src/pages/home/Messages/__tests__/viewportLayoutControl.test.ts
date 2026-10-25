/**
 * Layout-control classification for the message-editor top-edge resize
 * handle (VIEWPORT-13/14 same-arbiter LAYOUTCONTROL, not user-scroll).
 *
 * Proves the narrow trusted marker: a real connected handle owned by a
 * message row classifies as layout (pointer/nav keys must not declare a
 * genuine-scroll session); wheels stay genuine; untagged presses stay
 * genuine; the shared controller still fails closed while a real user
 * session is live (prior wheel retains priority); and the existing
 * message-controls hold path used by the resize gesture still arms.
 */
import { describe, expect, it } from 'vitest'

import {
  captureInteractionIntent,
  isViewportLayoutControlTarget,
  isViewportLayoutResizeKey
} from '../routeViewportContext'
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

const buildLayoutDom = (): {
  container: HTMLElement
  row: HTMLElement
  handle: HTMLElement
  grip: HTMLElement
  body: HTMLElement
} => {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  container.id = 'messages'
  const row = document.createElement('div')
  row.id = 'message-m1'
  row.setAttribute('data-message-id', 'm1')
  const editorArea = document.createElement('div')
  editorArea.className = 'message-editor-area'
  const handle = document.createElement('div')
  handle.setAttribute('data-testid', 'message-editor-resize-handle')
  handle.setAttribute('data-viewport-layout-control', 'message-editor-resize')
  handle.setAttribute('role', 'separator')
  handle.tabIndex = 0
  const grip = document.createElement('span')
  handle.append(grip)
  const footer = document.createElement('div')
  footer.setAttribute('data-interaction-region', 'message-controls')
  footer.setAttribute('data-viewport-baseline-edge', 'end')
  row.append(editorArea)
  editorArea.append(handle)
  row.append(footer)
  const body = document.createElement('div')
  body.textContent = 'untagged body'
  row.append(body)
  container.append(row)
  document.body.append(container)
  const rect = (top: number, h: number, w: number): DOMRect =>
    ({ top, bottom: top + h, height: h, width: w, left: 0, right: w, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  container.getBoundingClientRect = () => rect(0, 600, 300)
  row.getBoundingClientRect = () => rect(0, 300, 300)
  handle.getBoundingClientRect = () => rect(0, 12, 300)
  footer.getBoundingClientRect = () => rect(100, 26, 300)
  return { container, row, handle, grip, body }
}

describe('viewport layout-control marker', () => {
  it('classifies the trusted handle and its grip child as layout, not the body', () => {
    const { container, handle, grip, body } = buildLayoutDom()
    expect(isViewportLayoutControlTarget(handle, container)).toBe(true)
    expect(isViewportLayoutControlTarget(grip, container)).toBe(true)
    expect(isViewportLayoutControlTarget(body, container)).toBe(false)
    expect(isViewportLayoutControlTarget(container, container)).toBe(false)
    document.body.innerHTML = ''
  })

  it('wheels stay genuine: no layout exemption for wheel targets (helper is pointer/key only)', () => {
    // The wheel path never consults the layout helper: even a wheel over the
    // handle must declare. The helper itself still recognizes the node (so
    // pointer/key paths can exempt it) — wheel exemption is decided by not
    // calling the helper, asserted in the visual contract below.
    const { container, handle } = buildLayoutDom()
    expect(isViewportLayoutControlTarget(handle, container)).toBe(true)
    document.body.innerHTML = ''
  })

  it('fail-closed on missing testid, missing row owner, disconnected, or outside container', () => {
    const { container, handle, row } = buildLayoutDom()
    // Missing testid spoof.
    handle.removeAttribute('data-testid')
    expect(isViewportLayoutControlTarget(handle, container)).toBe(false)
    handle.setAttribute('data-testid', 'message-editor-resize-handle')
    // Missing row owner.
    row.removeAttribute('data-message-id')
    row.id = 'orphan-row'
    expect(isViewportLayoutControlTarget(handle, container)).toBe(false)
    document.body.innerHTML = ''

    // Disconnected node.
    const orphan = document.createElement('div')
    orphan.setAttribute('data-testid', 'message-editor-resize-handle')
    orphan.setAttribute('data-viewport-layout-control', 'message-editor-resize')
    expect(isViewportLayoutControlTarget(orphan, null)).toBe(false)

    // Outside the container.
    const { container: c2, handle: h2 } = buildLayoutDom()
    const other = document.createElement('div')
    document.body.append(other)
    expect(isViewportLayoutControlTarget(h2, other)).toBe(false)
    expect(isViewportLayoutControlTarget('not-an-element' as unknown, c2)).toBe(false)
    expect(isViewportLayoutControlTarget(null, c2)).toBe(false)
    document.body.innerHTML = ''
  })

  it('layout-resize keys are Arrow/Home/End/PageUp/PageDown only', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
      expect(isViewportLayoutResizeKey(key)).toBe(true)
    }
    for (const key of [' ', 'Spacebar', 'Escape', 'Enter', 'a', '', null, undefined]) {
      expect(isViewportLayoutResizeKey(key)).toBe(false)
    }
  })
})

describe('shared arbiter priority (existing fail-closed)', () => {
  it('a prior genuine wheel session keeps priority: layout capture refuses while user-live', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    // Genuine wheel opens the session first.
    c.declareUserIntent()
    expect(c.hasActiveUserInteraction()).toBe(true)
    expect(
      c.beginInteractionIntent({ topicId: 't1', route: null }, { kind: 'message', id: 'm1' }, 'message-controls', 100)
    ).toBe(false)
    expect(c.activeInteractionIntent).toBeNull()
    // After the gesture ends, the same layout capture arms.
    c.clearUserIntent()
    expect(
      c.beginInteractionIntent({ topicId: 't1', route: null }, { kind: 'message', id: 'm1' }, 'message-controls', 100)
    ).toBe(true)
  })

  it('the existing message-controls hold still arms for the resize scope when idle (bottom baseline)', () => {
    const { container } = buildLayoutDom()
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(captureInteractionIntent(c, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(true)
    // Unified bottom baseline: footer top 100 + height 26 = bottom 126.
    expect(c.activeInteractionIntent).toMatchObject({ scopeId: 'm1', region: 'message-controls', offset: 126 })
    document.body.innerHTML = ''
  })

  it('unmarked press/scroll/end lifecycle is unchanged (declare/takeover/scrollend)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(c.hasActiveUserInteraction()).toBe(false)
    const token = c.declareUserIntent()
    expect(c.hasActiveUserInteraction()).toBe(true)
    const out = c.userTakeover(
      { messageId: 'm1', intraRowOffset: -100, scrollTop: -400, isAtBottom: false },
      undefined,
      token
    )
    expect(out.taken).toBe(true)
    expect(c.noteInteractionScrollEnd(token)).toBe(true)
    expect(c.hasActiveUserInteraction()).toBe(false)
  })
})

describe('resize drag uses the shared discrete hold (no deferred settle)', () => {
  // The unified bottom baseline covers continuous drags with the same
  // discrete path as expand/find/cancel: pointerdown arms a plain
  // message-controls hold at the region bottom, every frame compensates at
  // that bottom, and quiet validation hands off to the stable row below.
  // No deferSettle flag, no release call, no per-gesture settle gate.
  it('a plain controls hold arms at the region bottom and survives as the live intent', () => {
    const { container } = buildLayoutDom()
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(captureInteractionIntent(c, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(true)
    const live = c.activeInteractionIntent
    expect(live).toMatchObject({ scopeId: 'm1', region: 'message-controls', offset: 126 })
    expect((live as unknown as { deferSettle?: unknown }).deferSettle).toBeUndefined()
    document.body.innerHTML = ''
  })

  it('clearing the owned hold is gesture-guarded (stale identity never clears live)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c, 'm1', -100)
    expect(
      c.beginInteractionIntent({ topicId: 't1', route: null }, { kind: 'message', id: 'm1' }, 'message-controls', 126, {
        fingerprint: { scopeH: 300, scopeW: 300 }
      })
    ).toBe(true)
    const live = c.activeInteractionIntent
    expect(live).not.toBeNull()
    if (!live) return
    expect(c.clearInteractionIntent(live.epoch, live.scopeId, live.gestureId + 99, live.region)).toBe(false)
    expect(c.activeInteractionIntent?.gestureId).toBe(live.gestureId)
    expect(c.clearInteractionIntent(live.epoch, live.scopeId, live.gestureId, live.region)).toBe(true)
    expect(c.activeInteractionIntent).toBeNull()
  })
})
