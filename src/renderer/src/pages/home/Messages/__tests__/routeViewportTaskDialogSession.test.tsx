/**
 * Task-dialog overlay activation handoff (chat base always visible).
 *
 * A secondary task (Files / Knowledge / Settings) renders as a centered in-app
 * modal dialog ABOVE the chat base: the conversation is never unmounted, never
 * hidden and its render/stream effects keep running. The provider therefore
 * owns an explicit open/close activation handoff:
 * - OPEN suspends outstanding activation ownership exactly as the former hidden
 *   lifetime did (ownership released once, epoch advanced so every in-flight /
 *   late completion stays inert, live intent/anchor/rendered cleared) while the
 *   base stays VISIBLE (no armed/idle hidden phase);
 * - CLOSE is the reactivation edge: `detach` arms the guarded reactivation and
 *   the shared connection generation is the sole restore trigger, so the single
 *   existing validated-continuation/read pipeline re-establishes the still
 *   selected route from its own persisted snapshot.
 * The handoff itself writes no snapshot, dispatches no route/branch action and
 * samples no covered geometry: it is not a second restore subsystem.
 */
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { shouldTopPipelineRefuseDividerIntent } from '../routeViewportActivation'
import {
  isTaskDialogPath,
  readRouteSnapshot,
  RouteViewportProvider,
  useRouteViewport,
  writeRouteSnapshot
} from '../routeViewportContext'
import type { RouteViewportController } from '../routeViewportController'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

const dispatchMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: () => null
}))

let keyvStore: Map<string, unknown>
const installKeyv = (): void => {
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (k: string) => keyvStore.get(k),
    set: (k: string, v: unknown) => {
      keyvStore.set(k, v)
    },
    remove: (k: string) => {
      keyvStore.delete(k)
    }
  }
}

const wid = (n: string): string => `oldest::newest::${n}`
const MAIN = { topicId: 't1', route: null }
const ROUTE_KEY = 'topic-t1::main'

beforeEach(() => {
  keyvStore = new Map()
  installKeyv()
  dispatchMock.mockClear()
})

describe('task-dialog path predicate (single location/task signal)', () => {
  it('task surfaces open the handoff; the chat base and redirecting paths never do', () => {
    // Task dialogs.
    expect(isTaskDialogPath('/files')).toBe(true)
    expect(isTaskDialogPath('/knowledge')).toBe(true)
    expect(isTaskDialogPath('/settings')).toBe(true)
    expect(isTaskDialogPath('/settings/provider')).toBe(true)
    // Chat base.
    expect(isTaskDialogPath('/')).toBe(false)
    // Unsupported/deprecated paths redirect to the chat base: a redirect must
    // never look like a task open/close.
    expect(isTaskDialogPath('/notes')).toBe(false)
    expect(isTaskDialogPath('/launchpad')).toBe(false)
    expect(isTaskDialogPath('/unknown')).toBe(false)
    // No prefix confusion with sibling chat paths.
    expect(isTaskDialogPath('/files-export')).toBe(false)
    expect(isTaskDialogPath('/settingsx')).toBe(false)
  })
})

interface ProbeHandles {
  controller: RouteViewportController | null
  phaseAttr: string
  generation: number
  generations: number[]
}

/**
 * Production activation probe: registers the live capturer (as Messages does)
 * and drives the SAME single-entry TOP semantics production uses — the
 * connection generation is the only trigger, no test-only `controller.request`
 * after the handoff.
 */
const Probe = ({
  onSeen,
  onCapturer,
  topicId,
  activeRoute
}: {
  onSeen: (vp: ReturnType<typeof useRouteViewport>) => void
  onCapturer: () => void
  topicId: string
  activeRoute: string | null
}) => {
  const vp = useRouteViewport()
  useEffect(() => {
    vp.registerCapturer(() => {
      onCapturer()
      return { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    return () => vp.registerCapturer(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    onSeen(vp)
  }, [vp, onSeen])
  useEffect(() => {
    try {
      if (!vp.controller.isActivationRequired) return
      if (shouldTopPipelineRefuseDividerIntent(vp.controller, topicId, activeRoute)) return
      const key = `topic-${topicId}::${activeRoute ?? 'main'}`
      const saved = vp.readSnapshot(key) ?? readRouteSnapshot(key)
      vp.controller.request({ kind: 'top', topicId, targetRoute: activeRoute, saved })
      vp.notifyChanged()
    } catch {
      // fail-closed: no activation
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp.controller, topicId, activeRoute, vp.connectionGeneration])
  return null
}

const establishStableSession = (c: RouteViewportController): void => {
  const stable = c.request({
    kind: 'top',
    topicId: 't1',
    targetRoute: null,
    saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
  })
  c.applyTransitionWindow(stable.epoch, MAIN, wid('stable-1'))
  c.firstPositioned(stable.epoch, 'placed')
  c.revealed(stable.epoch)
  const committed = c.commitStable(stable.epoch, {
    messageId: 'm-stable',
    intraRowOffset: -12,
    scrollTop: -400,
    isAtBottom: false
  })
  expect(committed.committed).toBe(true)
  writeRouteSnapshot(ROUTE_KEY, {
    scrollTop: -400,
    messageId: 'm-stable',
    intraRowOffset: -12,
    isAtBottom: false
  })
}

describe('RouteViewportProvider task-dialog open/close handoff', () => {
  it('open suspends the outstanding activation ownership, keeps the base visible and writes nothing', async () => {
    const handles: ProbeHandles = { controller: null, phaseAttr: '', generation: 0, generations: [] }
    const capturerCalls = vi.fn()
    const onSeen = vi.fn((vp: ReturnType<typeof useRouteViewport>) => {
      handles.controller = vp.controller
      handles.phaseAttr = vp.viewportPhaseAttr
      handles.generation = vp.connectionGeneration
      handles.generations.push(vp.connectionGeneration)
    })
    const ui = (taskDialogOpen: boolean) => (
      <RouteViewportProvider topicId="t1" initialRoute={null} taskDialogOpen={taskDialogOpen}>
        <Probe onSeen={onSeen} onCapturer={capturerCalls} topicId="t1" activeRoute={null} />
      </RouteViewportProvider>
    )
    const { rerender } = render(ui(false))
    const c = handles.controller as unknown as RouteViewportController
    expect(c).not.toBeNull()
    establishStableSession(c)
    const snapshotBefore = readRouteSnapshot(ROUTE_KEY)
    const generationWhileOpen0 = handles.generation
    dispatchMock.mockClear()
    capturerCalls.mockClear()

    // A restore is in flight when the task dialog opens.
    const inflight = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -500, messageId: 'mB', intraRowOffset: -30, isAtBottom: false }
    })
    expect(c.programmaticOwned).toBe(true)
    await act(async () => {
      rerender(ui(true))
    })

    // Suspended: ownership released, epoch advanced, live transaction cleared.
    expect(c.currentEpoch).toBeGreaterThan(inflight.epoch)
    expect(c.programmaticOwned).toBe(false)
    expect(c.currentIntent).toBeNull()
    expect(c.renderedProvenance).toBeNull()
    expect(c.currentPhase).toBe('idle')
    expect(c.displayedRoute).toEqual(MAIN)
    // NOT armed: the covered base is not a hidden lifetime, so nothing maps to
    // the hidden-but-measurable `positioning` attr while the dialog is open.
    expect(c.isActivationRequired).toBe(false)
    expect(handles.phaseAttr).toBe('idle')
    // Stale completions of the suspended epoch are inert.
    expect(c.applyTransitionWindow(inflight.epoch, { topicId: 't1', route: 'b1' }, wid('stale'))).toBe(false)
    expect(c.firstPositioned(inflight.epoch, 'placed')).toBe(false)
    expect(c.revealed(inflight.epoch)).toBe(false)
    expect(
      c.commitStable(inflight.epoch, { messageId: 'mB', intraRowOffset: -30, scrollTop: -500, isAtBottom: false })
        .committed
    ).toBe(false)
    expect(c.releaseSession(inflight.epoch)).toBe(false)
    // No snapshot write from covered geometry, no route/branch dispatch, no
    // visible-coordinate rewrite: the handoff owns activation, nothing else.
    expect(readRouteSnapshot(ROUTE_KEY)).toEqual(snapshotBefore)
    expect(capturerCalls).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(handles.generation).toBe(generationWhileOpen0)
  })

  it('close re-arms the existing validated-continuation/read pipeline through the connection generation', async () => {
    const handles: ProbeHandles = { controller: null, phaseAttr: '', generation: 0, generations: [] }
    const onSeen = vi.fn((vp: ReturnType<typeof useRouteViewport>) => {
      handles.controller = vp.controller
      handles.phaseAttr = vp.viewportPhaseAttr
      handles.generation = vp.connectionGeneration
      handles.generations.push(vp.connectionGeneration)
    })
    const ui = (taskDialogOpen: boolean) => (
      <RouteViewportProvider topicId="t1" initialRoute={null} taskDialogOpen={taskDialogOpen}>
        <Probe onSeen={onSeen} onCapturer={vi.fn()} topicId="t1" activeRoute={null} />
      </RouteViewportProvider>
    )
    const { rerender } = render(ui(false))
    const c = handles.controller as unknown as RouteViewportController
    establishStableSession(c)
    const snapshotBefore = readRouteSnapshot(ROUTE_KEY)
    const generationBefore = handles.generation

    await act(async () => {
      rerender(ui(true))
    })
    expect(c.currentPhase).toBe('idle')
    expect(c.isActivationRequired).toBe(false)
    expect(handles.generation).toBe(generationBefore)

    await act(async () => {
      rerender(ui(false))
    })

    // The close advanced the shared connection generation — the sole restore
    // trigger the single TOP pipeline depends on — and the probe (production
    // wiring) consumed the armed reactivation with one guarded own-target
    // request read from the target's OWN persisted snapshot.
    expect(handles.generation).toBeGreaterThan(generationBefore)
    expect(c.isActivationRequired).toBe(false)
    expect(c.programmaticOwned).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')
    const intent = c.currentIntent
    expect(intent?.kind).toBe('top')
    expect(intent?.topicId).toBe('t1')
    expect(intent?.targetRoute).toBeNull()
    expect(c.getAnchorFor(MAIN)).toEqual({ kind: 'message', messageId: 'm-stable', offset: -12 })

    // Driving that same single session through the normal pipeline restores the
    // route's own stable position and leaves the persisted snapshot untouched.
    const epoch = c.currentEpoch
    expect(c.applyTransitionWindow(epoch, MAIN, wid('close-1'))).toBe(true)
    expect(c.firstPositioned(epoch, 'placed')).toBe(true)
    expect(c.revealed(epoch)).toBe(true)
    const committed = c.commitStable(epoch, {
      messageId: 'm-stable',
      intraRowOffset: -12,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(committed.committed).toBe(true)
    expect(committed.commit?.routeKey).toBe(ROUTE_KEY)
    expect(c.isDomProvenanceClean).toBe(true)
    expect(readRouteSnapshot(ROUTE_KEY)).toEqual(snapshotBefore)

    // Repeated open/close keeps handing off (no leaked armed/owned session).
    await act(async () => {
      rerender(ui(true))
    })
    const epochAfterSecondOpen = c.currentEpoch
    expect(c.programmaticOwned).toBe(false)
    expect(c.currentPhase).toBe('idle')
    await act(async () => {
      rerender(ui(false))
    })
    expect(c.currentEpoch).toBeGreaterThan(epochAfterSecondOpen)
    expect(c.currentPhase).toBe('fetch-hold')
    expect(c.currentIntent?.targetRoute).toBeNull()
  })

  it('mounting behind an already-open task dialog is not a handoff; the close still re-arms it', async () => {
    const handles: ProbeHandles = { controller: null, phaseAttr: '', generation: 0, generations: [] }
    const onSeen = vi.fn((vp: ReturnType<typeof useRouteViewport>) => {
      handles.controller = vp.controller
      handles.phaseAttr = vp.viewportPhaseAttr
      handles.generation = vp.connectionGeneration
      handles.generations.push(vp.connectionGeneration)
    })
    const ui = (taskDialogOpen: boolean) => (
      <RouteViewportProvider topicId="t1" initialRoute={null} taskDialogOpen={taskDialogOpen}>
        <Probe onSeen={onSeen} onCapturer={vi.fn()} topicId="t1" activeRoute={null} />
      </RouteViewportProvider>
    )
    // Direct entry into a task path: the base mounts behind the dialog.
    const { rerender } = render(ui(true))
    const c = handles.controller as unknown as RouteViewportController
    establishStableSession(c)
    const generationAtMount = handles.generation
    expect(c.isActivationRequired).toBe(false)

    await act(async () => {
      rerender(ui(false))
    })
    expect(handles.generation).toBeGreaterThan(generationAtMount)
    expect(c.currentPhase).toBe('fetch-hold')
    expect(c.currentIntent?.kind).toBe('top')
    expect(c.getAnchorFor(MAIN)).toEqual({ kind: 'message', messageId: 'm-stable', offset: -12 })
  })
})
