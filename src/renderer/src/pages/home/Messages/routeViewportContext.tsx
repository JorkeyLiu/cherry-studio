/**
 * Route viewport React adapter (scoped provider, no module-global truth).
 *
 * Placement: mounted once per conversation surface at the nearest common
 * ancestor of the top branch selector and the message list (Chat). The top
 * selector freezes the outgoing route and dispatches through
 * `requestTopRoute()`; the message list registers its live container
 * capturer and drives fetch/window/position phases on the same controller
 * instance. No window/global event bus, no module-level singleton.
 *
 * Stable visual anchoring (persistent, not commit-then-stop):
 * while the displayed route is stable, the controller keeps the active
 * visual anchor and `useStableVisualAnchor` holds its screen offset across
 * projection/window/tree/loading changes and DOM content-height changes via
 * a scoped ResizeObserver + MutationObserver (no permanent rAF polling).
 * Genuine user input (wheel/touch/pointer/key) declares user intent first,
 * stops programmatic compensation, and the resulting real scroll becomes the
 * new stable anchor. A programmatic restore itself needs no user input to
 * become stable.
 */

import { COLUMN_REVERSE_BOTTOM_THRESHOLD_PX, isAtBottom } from '@renderer/pages/home/Messages/columnReverseGeometry'
import { handleScrollSnapshotRead, handleScrollSnapshotSaved } from '@renderer/services/scrollSnapshotCache'
import { isScrollSnapshotInvalidated } from '@renderer/services/scrollSnapshotCache'
import { useAppDispatch } from '@renderer/store'
import { activeBranchSet } from '@renderer/store/topicBranch'
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { findViewportTopAnchorWithOffset } from './domVisibility'
import {
  displayedRouteKey,
  type RouteId,
  type RouteRef,
  RouteViewportController,
  type RouteViewportSnapshot,
  type RouteVisualAnchor
} from './routeViewportController'

export type ViewportPhaseAttr = 'idle' | 'positioning' | 'revealed'

export type SnapshotCapturer = () => RouteViewportSnapshot | null

const toStorageKey = (routeKey: string): string => (routeKey.startsWith('scroll:') ? routeKey : `scroll:${routeKey}`)

const normalizeSnapshot = (saved: unknown): RouteViewportSnapshot | null => {
  if (saved && typeof saved === 'object' && 'scrollTop' in (saved as Record<string, unknown>)) {
    const rec = saved as Record<string, unknown>
    const messageId =
      typeof rec.messageId === 'string' && rec.messageId.length > 0
        ? rec.messageId
        : typeof rec.anchorId === 'string' && rec.anchorId.length > 0
          ? rec.anchorId
          : null
    const intraRaw = rec.intraRowOffset
    const intraRowOffset = typeof intraRaw === 'number' && Number.isFinite(intraRaw) ? intraRaw : null
    const scrollTop = typeof rec.scrollTop === 'number' && Number.isFinite(rec.scrollTop) ? rec.scrollTop : 0
    return { scrollTop, messageId, intraRowOffset, isAtBottom: rec.isAtBottom === true }
  }
  if (typeof saved === 'number' && Number.isFinite(saved)) {
    return { scrollTop: saved, messageId: null, intraRowOffset: null, isAtBottom: false }
  }
  return null
}

export const readRouteSnapshot = (routeKey: string): RouteViewportSnapshot | null => {
  const storageKey = toStorageKey(routeKey)
  let saved: unknown
  try {
    saved = window.keyv.get(storageKey)
  } catch {
    return null
  }
  const result = normalizeSnapshot(saved)
  if (result === null) {
    return null
  }
  try {
    if (!handleScrollSnapshotRead(storageKey)) {
      return null
    }
  } catch {
    return null
  }
  return result
}

const writeRouteSnapshot = (routeKey: string, snapshot: RouteViewportSnapshot): boolean => {
  const storageKey = toStorageKey(routeKey)
  try {
    if (isScrollSnapshotInvalidated(storageKey)) {
      try {
        window.keyv.remove(storageKey)
      } catch {}
      return false
    }
  } catch {
    return false
  }
  try {
    window.keyv.set(storageKey, snapshot)
  } catch {
    return false
  }
  try {
    handleScrollSnapshotSaved(storageKey)
  } catch {}
  return true
}

export interface RouteViewportContextValue {
  controller: RouteViewportController
  /** Projection/visual notification (every controller progress bump). Never opens restore. */
  version: number
  /** Viewport resource attach/reconnect only (provider lifetime setup). Sole restore trigger. */
  connectionGeneration: number
  notifyChanged: () => void
  /** Synchronously freeze the DISPLAYED route snapshot. Returns true when stored. */
  freezeDisplayed: () => boolean
  /** Read a route snapshot by route key (`topic-<id>::<branch|main>`). */
  readSnapshot: (routeKey: string) => RouteViewportSnapshot | null
  /** Top-selector entry: freeze outgoing + open the transition + dispatch. */
  requestTopRoute: (topicId: string, targetRoute: RouteId) => { epoch: number; fresh: boolean }
  /** Message list registers its live container capturer (scoped, unregistered on unmount). */
  registerCapturer: (capturer: SnapshotCapturer | null) => void
  viewportPhaseAttr: ViewportPhaseAttr
}

const RouteViewportContext = createContext<RouteViewportContextValue | null>(null)

/** Exported for focused behavior tests (production uses the provider). */
export { RouteViewportContext }

export const useRouteViewport = (): RouteViewportContextValue => {
  const value = use(RouteViewportContext)
  if (!value) throw new Error('useRouteViewport must be used inside RouteViewportProvider')
  return value
}

/** Optional access for hooks that must keep working outside the provider (tests). */
export const useOptionalRouteViewport = (): RouteViewportContextValue | null => use(RouteViewportContext)

export const viewportPhaseAttrFor = (
  phase: string,
  intentKind?: string | null,
  isActivationSession?: boolean,
  isActivationRequired?: boolean
): ViewportPhaseAttr => {
  // Divider + top fetch-hold keeps the current displayed/rendered window on
  // screen (revealed, never visibility:hidden): the fetch resolves around an
  // already-visible resident anchor (divider fork anchor or top saved anchor)
  // and the visible rebase commits synchronously into the live list. Every
  // other fetch-hold keeps the existing hidden behavior; only the hidden
  // atomic fallback (`commitRouteWindowAtomic` → `applyTransitionWindow` →
  // positioning) hides when visible eligibility/commit fails. Intent comes
  // from the controller (sole truth); no UI-local route truth is consulted or
  // advanced here.
  //
  // Page-resume gate (Chat→Settings→Chat): a reactivated session's fetch-hold
  // stays hidden-but-measurable (`positioning`) even for top/divider intents.
  // Retained display:none geometry from the hidden interval is not valid until
  // the retained window is verified + positioned pre-paint; the first visible
  // frame must already carry the saved message+offset/bottom. Ordinary
  // transitions keep the incremental visible behavior above.
  //
  // Armed-idle gate (F1): after `detach()` the short-lived transaction is
  // cancelled (phase idle, rendered cleared, epoch advanced) while the
  // reactivation stays armed (`activationRequired`). The retained DOM must not
  // paint unverified before the single TOP pipeline opens its guarded
  // fetch-hold, so armed idle maps hidden (`positioning`, visibility:hidden
  // but measurable) instead of `idle` (visible).
  //
  // Activation settle gate (F2): an activation session stays hidden through
  // `aligned`/`searching` until the hidden settle verifies effective
  // alignment + projection coverage + required layout settle and the deferred
  // reveal/stable commit releases it. Ordinary (non-activation) aligned/
  // searching stay visible incremental; stable/terminal always reveal
  // (terminal fail-visible releases once, preserving the prior snapshot).
  if (phase === 'positioning') return 'positioning'
  if (phase === 'fetch-hold') {
    if (isActivationSession === true) return 'positioning'
    return intentKind === 'divider' || intentKind === 'top' ? 'revealed' : 'positioning'
  }
  if (phase === 'idle') {
    if (isActivationRequired === true) return 'positioning'
    return 'idle'
  }
  if (isActivationSession === true && (phase === 'aligned' || phase === 'searching')) return 'positioning'
  if (phase === 'idle') return 'idle'
  return 'revealed'
}

export function RouteViewportProvider({
  topicId,
  initialRoute,
  children
}: {
  topicId: string
  initialRoute: RouteId
  children: ReactNode
}) {
  const dispatch = useAppDispatch()
  const controllerRef = useRef<RouteViewportController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new RouteViewportController({ topicId, route: initialRoute })
  }
  const controller = controllerRef.current
  const [version, setVersion] = useState(0)
  // Viewport resource connection generation: incremented ONLY in the
  // attach/reconnect lifetime setup below (Activity visible, provider
  // re-activation). Ordinary controller progress (request/commit/fail/
  // teardown/user intent) notifies `version` for projection/keeper visuals
  // but never touches this signal, so it can never (re)open restoration.
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  const capturerRef = useRef<SnapshotCapturer | null>(null)
  const lastTopicRef = useRef(topicId)
  if (lastTopicRef.current !== topicId) {
    lastTopicRef.current = topicId
    controller.syncDisplayed({ topicId, route: initialRoute })
  }

  const notifyChanged = useCallback(() => setVersion((v) => v + 1), [])

  // Outgoing freeze (controller-owned decision): capture the live DOM ONLY
  // when the controller says clean-stable (not owned, displayed == rendered,
  // phase stable/idle/clean-terminal). Transition-owned or dirty states
  // preserve the existing stable snapshot/active anchor — never read live DOM
  // (rapid supersede must not capture the intermediate route's DOM as the
  // outgoing route). No module/global truth: decision is the scoped
  // controller instance's `shouldCaptureOutgoing()`.
  const freezeDisplayed = useCallback((): boolean => {
    if (!controller.shouldCaptureOutgoing()) {
      return false
    }
    const capturer = capturerRef.current
    if (!capturer) {
      return false
    }
    let snapshot: RouteViewportSnapshot | null = null
    try {
      snapshot = capturer()
    } catch {
      snapshot = null
    }
    if (!snapshot) {
      return false
    }
    const outKey = displayedRouteKey(controller.displayedRoute)
    return writeRouteSnapshot(outKey, snapshot)
  }, [controller])

  const readSnapshot = useCallback((_routeKey: string) => readRouteSnapshot(_routeKey), [])

  // Top-selector entry (controller-owned freeze): the outgoing capture above
  // runs first under `shouldCaptureOutgoing()` (clean-stable ⇒ capture;
  // owned/dirty ⇒ preserve, no DOM read). The target snapshot is a STORAGE
  // read (never live-DOM geometry), so reading it around the request cannot
  // pollute the outgoing route; freeze correctness rests solely on the
  // controller predicate, never on call order.
  const requestTopRoute = useCallback(
    (forTopicId: string, targetRoute: RouteId): { epoch: number; fresh: boolean } => {
      freezeDisplayed()
      const targetKey = `topic-${forTopicId}::${targetRoute ?? 'main'}`
      const saved = readRouteSnapshot(targetKey)
      const { epoch } = controller.request({
        kind: 'top',
        topicId: forTopicId,
        targetRoute,
        saved,
        snapshotInvalid: false
      })
      notifyChanged()
      dispatch(activeBranchSet({ topicId: forTopicId, branchId: targetRoute }))
      return { epoch, fresh: true }
    },
    [controller, dispatch, freezeDisplayed, notifyChanged]
  )

  const registerCapturer = useCallback((capturer: SnapshotCapturer | null) => {
    capturerRef.current = capturer
  }, [])

  // Detach / attach (Activity hidden boundary, single controller owner):
  // detach cancels the short-lived transaction (released exactly once, epoch
  // advanced so stale completions stay inert, reactivation armed) via the
  // explicit `detach()`, unregisters the live capturer, and preserves the last
  // legal stable snapshot/cache (never sample display:none here). The
  // long-lived route session truth (anchorCache + persisted snapshots)
  // survives. Attach setup below advances the connection generation AND
  // notifies the projection: the generation is the explicit reconnect-
  // activation trigger that retriggers the single Messages top pipeline
  // (connection-generation dep) for the still-selected route — no transaction
  // starts here, so parent/child setup can never open parallel pipelines or
  // double-release. Ordinary `version` bumps (controller progress) only
  // re-render visuals/keeper and never retrigger restore.
  //
  // Pre-paint timing (F1): this is a layout effect so the detached-armed
  // hidden state (idle + activationRequired → `positioning`) is published
  // while still hidden, and the reattached hidden state is committed
  // synchronously before Activity restores first paint. The single TOP
  // pipeline itself stays passive (Messages `useEffect`) and still opens the
  // guarded fetch-hold after first paint — but that first paint is already
  // hidden via the armed-idle mapping, never an unverified visible frame.
  // The detach cleanup notifies once so the hidden render caches the armed
  // hidden attr before the show render; without it the value memo would stay
  // stale-revealed until the passive attach ran after paint.
  useLayoutEffect(() => {
    const owned = controllerRef.current
    // Reconnect setup (Activity visible): the short-lived transaction was
    // cancelled on detach with a fresh epoch + armed reactivation; make the
    // reconnected phase observable via BOTH signals: the connection generation
    // (sole restore trigger) plus the projection version (visuals/keeper).
    // Single increment per activation — no transaction started here.
    try {
      setConnectionGeneration((g) => g + 1)
    } catch {}
    try {
      notifyChanged()
    } catch {}
    return () => {
      try {
        owned?.detach()
      } catch {}
      capturerRef.current = null
      // Publish the armed idle-hidden state while still hidden so the next
      // show's first paint (memo below recomputes from the mutated
      // controller) is already `positioning`, never stale `revealed`/`idle`.
      try {
        notifyChanged()
      } catch {}
    }
  }, [notifyChanged])
  useEffect(() => {
    const hot = (import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot
    if (!hot) return
    return hot.dispose(() => {
      try {
        controllerRef.current?.invalidateAll()
      } catch {}
    }) as unknown as void
  }, [])

  // Fresh per-render mapping (never stale memo): the attr is derived from the
  // live controller fields on every render, so the show's first render already
  // reflects the detached-armed state even before the passive TOP request.
  // The memo below only carries the computed string, never recomputes stale.
  const viewportPhaseAttr = viewportPhaseAttrFor(
    controller.currentPhase,
    controller.currentIntent?.kind ?? null,
    controller.isActivationSession,
    controller.isActivationRequired
  )

  const value = useMemo<RouteViewportContextValue>(
    () => ({
      controller,
      version,
      connectionGeneration,
      notifyChanged,
      freezeDisplayed,
      readSnapshot,
      requestTopRoute,
      registerCapturer,
      viewportPhaseAttr
    }),
    [
      controller,
      version,
      connectionGeneration,
      notifyChanged,
      freezeDisplayed,
      readSnapshot,
      requestTopRoute,
      registerCapturer,
      viewportPhaseAttr
    ]
  )

  void topicId
  return <RouteViewportContext value={value}>{children}</RouteViewportContext>
}

// --- Live container snapshot ---------------------------------------------------

/**
 * Build a live capturer for a scroll container (registered by the message list).
 *
 * Hidden-geometry guard: while the Chat workspace is detached inside
 * `Activity hidden` (`display:none`) the container has no measurable rects —
 * sampling then would publish invalid geometry as a stable snapshot. Return
 * null so the caller preserves the last legal stable snapshot/cache instead.
 */
/**
 * Positive hidden proof for capture gating (Activity `display:none` detach).
 * True only when the container is disconnected or an inline `display:none` /
 * `hidden` ancestor proves the subtree is detached-hidden. Never infers
 * hidden from zero rects alone (jsdom has no layout), so visible jsdom
 * surfaces keep capturing.
 */
export const isCaptureContainerHidden = (container: HTMLElement | null): boolean => {
  if (!container) return true
  try {
    if (!container.isConnected) return true
  } catch {
    return true
  }
  try {
    let el: HTMLElement | null = container
    while (el) {
      try {
        const style = el.style as CSSStyleDeclaration | undefined
        if (style && style.display === 'none') return true
        if (el.hidden === true) return true
      } catch {}
      el = el.parentElement
    }
  } catch {}
  // Real-browser measurable proof only when the API exists AND the ancestor
  // walk above already proved hidden — never standalone (see doc above).
  return false
}

export const buildContainerCapturer = (containerRef: React.RefObject<HTMLElement | null>): SnapshotCapturer => {
  return () => {
    const container = containerRef.current
    if (!container) return null
    if (isCaptureContainerHidden(container)) return null
    const scrollTop = container.scrollTop
    const anchor = findViewportTopAnchorWithOffset(container)
    return {
      scrollTop,
      messageId: anchor?.messageId ?? null,
      intraRowOffset: anchor ? anchor.intraRowOffset : null,
      isAtBottom: isAtBottom(scrollTop, COLUMN_REVERSE_BOTTOM_THRESHOLD_PX)
    }
  }
}

// --- Persistent stable anchoring ------------------------------------------------

export interface StableVisualAnchorMaintainer {
  /** Visual-only compensation (never takeover/snapshot/anchor change). */
  requestHold: (reason: string) => void
}

/**
 * Hold the controller's active visual anchor at its offset while the displayed
 * route is stable (or aligned): scoped ResizeObserver + MutationObserver on
 * the container compensate `scrollTop` synchronously on layout/content change.
 * No permanent rAF polling. Genuine user input declares user intent first via
 * capture-phase listeners, stops compensation, and the real scroll result
 * becomes the new stable anchor.
 *
 * Complete keeper event model (component-scoped, no controller DOM work):
 * - window identity: the controller bumps `windowGeneration` on every
 *   rendered window change; this hook re-resolves the container-scoped live
 *   anchor in a layout effect on that generation and holds immediately;
 * - layout/content: ResizeObserver on container + content wrapper + live
 *   anchor row re-measures and compensates synchronously;
 * - structure: MutationObserver (childList/subtree/characterData) re-resolves
 *   a replaced same-id row and holds;
 * - no-intent scroll: a scroll with no live user session holds once (visual
 *   compensation only); self compensation echoes are swallowed via the
 *   expected guard so they never recurse.
 */
export function useStableVisualAnchor(containerRef: React.RefObject<HTMLElement | null>): StableVisualAnchorMaintainer {
  const viewport = useOptionalRouteViewport()
  const compensatingRef = useRef<{ expected: number } | null>(null)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const holdRef = useRef<(reason: string) => void>(() => {})

  // Real user interaction session (controller-owned token, component-scoped).
  // Genuine input opens/refreshes the session BEFORE its scroll effect lands;
  // only scrolls inside the live session may `userTakeover()` (Messages owns
  // the scroll). The session survives multi-scroll gestures (wheel momentum /
  // touch / scrollbar drag: each scroll updates the stable snapshot) and
  // closes ONLY on native `scrollend`, on a no-scroll pointer/touch/key end
  // (event-driven fallback when `scrollend` never fires), or forcibly on the
  // next programmatic `request()`/supersede and `invalidateAll()`. No timers,
  // no fences, no global bus. Never terminates/releases the transition.
  const stableController = viewport?.controller ?? null
  useEffect(() => {
    const container = containerRef.current
    const controller = stableController
    if (!container || !controller) return
    const notify = (): void => {
      try {
        viewportRef.current?.notifyChanged()
      } catch {}
    }
    const declare = () => {
      try {
        controller.declareUserIntent()
      } catch {}
      compensatingRef.current = null
      notify()
    }
    const endOnScrollEnd = () => {
      try {
        if (controller.noteInteractionScrollEnd()) notify()
      } catch {}
    }
    const cancelWhenIdle = () => {
      try {
        if (controller.noteInteractionPointerEnd()) notify()
      } catch {}
    }
    container.addEventListener('wheel', declare, { capture: true, passive: true })
    container.addEventListener('touchstart', declare, { capture: true, passive: true })
    container.addEventListener('pointerdown', declare, { capture: true, passive: true })
    const onKey = (e: KeyboardEvent) => {
      const keys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])
      if (!keys.has(e.key)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toUpperCase() ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
      declare()
    }
    container.addEventListener('keydown', onKey, { capture: true })
    // Native gesture end: prefer `scrollend` (Chromium). The DOM lib may not
    // know the type yet, so narrow through a string registration without
    // touching global state.
    type ScrollEndTarget = Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>
    const addTyped = (
      target: ScrollEndTarget,
      type: string,
      listener: EventListener,
      opts?: AddEventListenerOptions
    ): void => {
      try {
        ;(target.addEventListener as (t: string, l: EventListener, o?: AddEventListenerOptions) => void)(
          type,
          listener,
          opts
        )
      } catch {}
    }
    const removeTyped = (
      target: ScrollEndTarget,
      type: string,
      listener: EventListener,
      opts?: EventListenerOptions
    ): void => {
      try {
        ;(target.removeEventListener as (t: string, l: EventListener, o?: EventListenerOptions) => void)(
          type,
          listener,
          opts
        )
      } catch {}
    }
    const onScrollEnd: EventListener = () => endOnScrollEnd()
    addTyped(container, 'scrollend', onScrollEnd, { passive: true } as AddEventListenerOptions)
    // Event-driven fallback when `scrollend` is unsupported/never fires:
    // pointer/touch/key ends close ONLY idle sessions (no scroll landed yet).
    // Sessions with adopted scrolls stay open for `scrollend`; the next
    // programmatic `request()`/supersede or `invalidateAll()` force-closes.
    // Wheel only refreshes (never closes here): momentum needs the session.
    const onPointerUp: EventListener = () => cancelWhenIdle()
    const onTouchEnd: EventListener = () => cancelWhenIdle()
    const onKeyUp: EventListener = () => cancelWhenIdle()
    addTyped(container, 'pointerup', onPointerUp, { passive: true } as AddEventListenerOptions)
    addTyped(container, 'pointercancel', onPointerUp, { passive: true } as AddEventListenerOptions)
    addTyped(container, 'touchend', onTouchEnd, { passive: true } as AddEventListenerOptions)
    addTyped(container, 'touchcancel', onTouchEnd, { passive: true } as AddEventListenerOptions)
    addTyped(container, 'keyup', onKeyUp, { capture: true } as AddEventListenerOptions)
    return () => {
      container.removeEventListener('wheel', declare, { capture: true } as AddEventListenerOptions)
      container.removeEventListener('touchstart', declare, { capture: true } as AddEventListenerOptions)
      container.removeEventListener('pointerdown', declare, { capture: true } as AddEventListenerOptions)
      container.removeEventListener('keydown', onKey, { capture: true } as AddEventListenerOptions)
      removeTyped(container, 'scrollend', onScrollEnd)
      removeTyped(container, 'pointerup', onPointerUp)
      removeTyped(container, 'pointercancel', onPointerUp)
      removeTyped(container, 'touchend', onTouchEnd)
      removeTyped(container, 'touchcancel', onTouchEnd)
      removeTyped(container, 'keyup', onKeyUp)
    }
    // Stable identity: listeners must never churn on viewport version bumps
    // (every declare/takeover/commit notifies). Re-registration would briefly
    // detach `scrollend` and could miss the gesture end, leaving a stale
    // session live across the next programmatic transition.
  }, [containerRef, stableController])

  // Scroll ownership stays SOLELY in Messages via the atomic
  // `controller.userTakeover()` (single writer → `commitSnapshotForRoute`).
  // This keeper never takes over, never writes a snapshot, never changes the
  // anchor: a no-intent scroll (not a self echo, no live user session,
  // stable/aligned + clean + active anchor) holds once via the same visual
  // compensation. Self compensation echoes are swallowed by the expected
  // guard so they never recurse.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onScroll = () => {
      const pending = compensatingRef.current
      try {
        if (pending && Math.abs(container.scrollTop - pending.expected) < 0.5) {
          compensatingRef.current = null
          return
        }
      } catch {
        compensatingRef.current = null
        return
      }
      compensatingRef.current = null
      try {
        holdRef.current('scroll')
      } catch {}
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
    // Stable identity: compensation accounting never depends on the versioned
    // viewport object (see above).
  }, [containerRef])

  // Window generation drives synchronous re-resolution in the layout phase:
  // same-route pagination/reconcile bumps the controller generation and
  // notifies (provider version), so this effect re-runs after the DOM commit
  // and reads the new committed DOM. Route-transition windows stay owned and
  // programmatic — the hold gates below refuse while owned.
  const windowGeneration = viewport?.controller.windowGeneration ?? 0
  const viewportVersion = viewport?.version ?? 0
  // Keep the anchor offset across layout/content changes (stable/aligned only).
  // Content-size signals (scoped, no polling): the container's own box, the
  // scroll content wrapper's box (content height grows even when the
  // scrollable container box is fixed — e.g. above-fold image/markdown
  // settling), and the current live anchor row's box. Any of them changing
  // re-measures and compensates synchronously; structural changes are
  // covered by the MutationObserver backup.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !viewport) {
      holdRef.current = () => {}
      return
    }
    let observedContent: Element | null = null
    let observedRow: Element | null = null
    let ro: ResizeObserver | null = null
    let mo: MutationObserver | null = null
    const escapeId = (v: string): string => {
      try {
        const api = (globalThis as unknown as { CSS?: { escape?: (x: string) => string } }).CSS
        if (api?.escape) return api.escape(v)
        return v
      } catch {
        return v
      }
    }
    // Container-scoped live anchor resolution only (never global document):
    // React may replace the row element for the same id across
    // reconciliations, so the observer must rebind the new connected node.
    const resolveRow = (anchor: RouteVisualAnchor): HTMLElement | null => {
      try {
        let el: HTMLElement | null = null
        if (anchor.kind === 'message') {
          el = container.querySelector(`[data-message-id="${escapeId(anchor.messageId)}"]`) as HTMLElement | null
          if (!el) {
            el = container.querySelector(`#${escapeId(`message-${anchor.messageId}`)}`) as HTMLElement | null
          }
          if (el && !container.contains(el)) return null
        } else {
          el = container.querySelector(`[data-divider-key="${escapeId(anchor.dividerKey)}"]`) as HTMLElement | null
        }
        return el && el.isConnected ? el : null
      } catch {
        return null
      }
    }
    const rebindContent = (): void => {
      let content: Element | null = null
      try {
        const first = container.firstElementChild
        content = first instanceof Element ? first : null
      } catch {
        content = null
      }
      if (content === observedContent) return
      try {
        if (observedContent && ro) ro.unobserve(observedContent)
      } catch {}
      observedContent = content
      if (observedContent) {
        try {
          ro?.observe(observedContent)
        } catch {}
      }
    }
    const hold = (reason: string): void => {
      void reason
      const vp = viewportRef.current
      if (!vp) return
      const phase = vp.controller.currentPhase
      if (phase !== 'stable' && phase !== 'aligned') return
      if (vp.controller.programmaticOwned || vp.controller.hasActiveUserInteraction()) return
      if (!vp.controller.isDomProvenanceClean) return
      // Provenance-guarded hold: the keeper may hold only the displayed
      // route's own anchor. A foreign live anchor (provenance != displayed)
      // is inert here — never compensated as if it belonged to this route.
      const displayed = vp.controller.displayedRoute
      const anchor = vp.controller.getAnchorFor(displayed)
      if (!anchor) return
      const el = resolveRow(anchor)
      if (!el) return
      // Rebind the row observation to the live anchor element (React may
      // replace rows across reconciliations; same id must bind the new node).
      if (observedRow !== el) {
        try {
          if (observedRow && ro) ro.unobserve(observedRow)
        } catch {}
        observedRow = el
        try {
          ro?.observe(el)
        } catch {}
      }
      let current = 0
      try {
        current = el.getBoundingClientRect().top - container.getBoundingClientRect().top
      } catch {
        return
      }
      const delta = current - anchor.offset
      if (Math.abs(delta) <= 1) return
      try {
        container.scrollTop += delta
        compensatingRef.current = { expected: container.scrollTop }
      } catch {}
    }
    holdRef.current = hold
    // Observer creation precedes the first rebind/hold (no TDZ swallow):
    // even when observers are unavailable the hold below still runs, so a
    // window-generation notify compensates without RO/MO.
    try {
      ro = new ResizeObserver(() => {
        rebindContent()
        hold('resize')
      })
      ro.observe(container)
    } catch {
      ro = null
    }
    try {
      mo = new MutationObserver(() => {
        rebindContent()
        hold('mutate')
      })
      mo.observe(container, { childList: true, subtree: true, characterData: true })
    } catch {
      mo = null
    }
    // Bind the real content wrapper and the live anchor row, then compensate
    // immediately on the freshly committed DOM.
    rebindContent()
    hold('generation')
    return () => {
      holdRef.current = () => {}
      observedContent = null
      observedRow = null
      try {
        ro?.disconnect()
      } catch {}
      try {
        mo?.disconnect()
      } catch {}
    }
    // Generation (not full provider state) is the layout-phase trigger; the
    // version pin keeps the closure fresh with the committed controller.
  }, [containerRef, viewport, viewportVersion, windowGeneration])

  const requestHold = useCallback((reason: string): void => {
    try {
      holdRef.current(reason)
    } catch {}
  }, [])
  return useMemo<StableVisualAnchorMaintainer>(() => ({ requestHold }), [requestHold])
}

export type { RouteRef, RouteViewportSnapshot, RouteVisualAnchor }
export { writeRouteSnapshot }
