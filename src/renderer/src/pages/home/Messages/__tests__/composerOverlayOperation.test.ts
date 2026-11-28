/**
 * Composer overlay settle step (pure decision logic): one logical layout
 * operation owns one composer height episode.
 *
 * - a non-animated height change is one short operation
 *   (begin/advance → settle → end);
 * - animated frames share one operation with a monotonic revision;
 * - after a user declare cancels the operation, remaining frames of the SAME
 *   animation never resume it, while a NEW animation may begin;
 * - unrelated re-runs (same revision, no transition change) settle nothing.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  type ComposerOverlayGeometry,
  type ComposerOverlayLocalState,
  stepComposerOverlayOperation
} from '../composerOverlayGeometry'
import type { LayoutOperationRef } from '../routeViewportController'

interface FakeController {
  isCurrent: (op: LayoutOperationRef) => boolean
  begin: (source: string, routeKey: string) => LayoutOperationRef
  advance: (op: LayoutOperationRef, revision: number) => boolean
  end: (op: LayoutOperationRef) => boolean
}

const makeController = (): FakeController & { live: LayoutOperationRef | null; log: string[] } => {
  let seq = 0
  const state: { live: LayoutOperationRef | null; log: string[] } = { live: null, log: [] }
  const api: FakeController & { live: LayoutOperationRef | null; log: string[] } = {
    get live() {
      return state.live
    },
    log: state.log,
    isCurrent: (op) => state.live !== null && state.live.id === op.id,
    begin: (source, routeKey) => {
      seq += 1
      const op: LayoutOperationRef = { id: seq, source, revision: 0, routeKey }
      state.live = op
      state.log.push(`begin:${op.id}`)
      return op
    },
    advance: (op, revision) => {
      if (!api.isCurrent(op)) return false
      state.live = { ...op, revision }
      state.log.push(`advance:${op.id}:${revision}`)
      return true
    },
    end: (op) => {
      if (!api.isCurrent(op)) return false
      state.live = null
      state.log.push(`end:${op.id}`)
      return true
    }
  }
  return api
}

const freshLocal = (): ComposerOverlayLocalState => ({
  op: null,
  opTransitionId: 0,
  lastSettledRevision: 0
})

const ROUTE_KEY = 'topic-t1::main'

const run = (
  ctrl: FakeController,
  settle: (reason: string, op: LayoutOperationRef) => void,
  local: ComposerOverlayLocalState,
  geometry: ComposerOverlayGeometry
): void => {
  stepComposerOverlayOperation(
    {
      isCurrent: (op) => ctrl.isCurrent(op),
      begin: (source, routeKey) => ctrl.begin(source, routeKey),
      advance: (op, revision) => ctrl.advance(op, revision),
      end: (op) => ctrl.end(op),
      settle
    },
    ROUTE_KEY,
    geometry,
    local
  )
}

describe('composer overlay settle step', () => {
  it('a non-animated height change is one short operation (begin/settle/end)', () => {
    const ctrl = makeController()
    const settle = vi.fn()
    const local = freshLocal()
    run(ctrl, settle, local, { height: 120, revision: 1, transitioning: false, transitionId: 0 })
    expect(ctrl.log).toEqual(['begin:1', 'advance:1:1', 'end:1'])
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith('composer-overlay', expect.objectContaining({ id: 1 }))
    expect(local.op).toBeNull()
  })

  it('animated frames share one operation and settle every new revision', () => {
    const ctrl = makeController()
    const settle = vi.fn()
    const local = freshLocal()
    run(ctrl, settle, local, { height: 96, revision: 1, transitioning: true, transitionId: 7 })
    run(ctrl, settle, local, { height: 120, revision: 2, transitioning: true, transitionId: 7 })
    run(ctrl, settle, local, { height: 144, revision: 3, transitioning: true, transitionId: 7 })
    expect(ctrl.log).toEqual(['begin:1', 'advance:1:1', 'advance:1:2', 'advance:1:3'])
    expect(settle).toHaveBeenCalledTimes(3)
    // The animation end settles nothing new but ends the shared operation.
    run(ctrl, settle, local, { height: 144, revision: 3, transitioning: false, transitionId: 7 })
    expect(ctrl.log).toEqual(['begin:1', 'advance:1:1', 'advance:1:2', 'advance:1:3', 'advance:1:3', 'end:1'])
    expect(settle).toHaveBeenCalledTimes(3)
    expect(local.op).toBeNull()
  })

  it('a cancelled operation never resumes on remaining frames of the same animation', () => {
    const ctrl = makeController()
    const settle = vi.fn()
    const local = freshLocal()
    run(ctrl, settle, local, { height: 96, revision: 1, transitioning: true, transitionId: 7 })
    expect(settle).toHaveBeenCalledTimes(1)
    // Genuine user input cancels the operation mid-animation.
    const live = ctrl.live
    expect(live).not.toBeNull()
    ctrl.end(live as LayoutOperationRef)
    // Simulate the declare-cancel: the controller no longer treats it current.
    run(ctrl, settle, local, { height: 120, revision: 2, transitioning: true, transitionId: 7 })
    run(ctrl, settle, local, { height: 144, revision: 3, transitioning: true, transitionId: 7 })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(ctrl.log.filter((entry) => entry.startsWith('begin:'))).toHaveLength(1)
    // The animation end only clears local state, never settles or ends again.
    run(ctrl, settle, local, { height: 144, revision: 3, transitioning: false, transitionId: 7 })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(local.op).toBeNull()
  })

  it('a new animation may begin after a cancellation', () => {
    const ctrl = makeController()
    const settle = vi.fn()
    const local = freshLocal()
    run(ctrl, settle, local, { height: 96, revision: 1, transitioning: true, transitionId: 7 })
    const live = ctrl.live
    ctrl.end(live as LayoutOperationRef)
    run(ctrl, settle, local, { height: 120, revision: 2, transitioning: true, transitionId: 7 })
    expect(settle).toHaveBeenCalledTimes(1)
    // A new logical animation (new transition id) begins a fresh operation.
    run(ctrl, settle, local, { height: 160, revision: 3, transitioning: true, transitionId: 8 })
    expect(settle).toHaveBeenCalledTimes(2)
    expect(ctrl.log.filter((entry) => entry.startsWith('begin:'))).toHaveLength(2)
    run(ctrl, settle, local, { height: 160, revision: 3, transitioning: false, transitionId: 8 })
    expect(local.op).toBeNull()
  })

  it('unrelated re-runs with no new revision settle nothing and begin nothing', () => {
    const ctrl = makeController()
    const settle = vi.fn()
    const local = freshLocal()
    // Mount-time geometry with no proven change.
    run(ctrl, settle, local, { height: 56, revision: 0, transitioning: false, transitionId: 0 })
    expect(ctrl.log).toEqual([])
    expect(settle).not.toHaveBeenCalled()
    // A re-run with identical geometry (e.g. topic-switch re-render).
    run(ctrl, settle, local, { height: 120, revision: 1, transitioning: false, transitionId: 0 })
    expect(settle).toHaveBeenCalledTimes(1)
    run(ctrl, settle, local, { height: 120, revision: 1, transitioning: false, transitionId: 0 })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(ctrl.log.filter((entry) => entry.startsWith('begin:'))).toHaveLength(1)
  })
})
