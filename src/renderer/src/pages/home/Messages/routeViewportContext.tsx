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
  normalizeFoldAnchorOffset,
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
  isActivationRequired?: boolean,
  isRetainedContinuation?: boolean
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
    // A validated retained continuation never hides: the retained geometry
    // was already proven at its legal target before first paint, so the
    // fetch-hold opens revealed instead of hidden-but-measurable. Every
    // unvalidated activation keeps the existing hidden behavior below.
    if (isRetainedContinuation === true) return 'revealed'
    if (isActivationSession === true) return 'positioning'
    return intentKind === 'divider' || intentKind === 'top' ? 'revealed' : 'positioning'
  }
  if (phase === 'idle') {
    if (isActivationRequired === true) return 'positioning'
    return 'idle'
  }
  // Validated continuation stays revealed through aligned/searching until the
  // synchronous stable commit; unvalidated activation sessions stay hidden.
  if (isActivationSession === true && (phase === 'aligned' || phase === 'searching')) {
    if (isRetainedContinuation === true) return 'revealed'
    return 'positioning'
  }
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
    controller.isActivationRequired,
    controller.isRetainedContinuation
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
  /** Visual hold plus validated fold-reconciliation snapshot sync (never takeover/release/epoch change). */
  requestHold: (reason: string) => void
}

/**
 * Stable visual anchor keeper (persistent, not commit-then-stop).
 *
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
 * - bottom semantic (no row anchor): pins column-reverse bottom (scrollTop 0)
 *   through layout/insertion so an explicit send bottom survives new rows
 *   and stream growth; never fights a live genuine session (gated above).
 * - fold replacement: a hidden/collapsed answer row is never measured; when
 *   the held anchor is the replaced hidden answer, it is reconciled to the
 *   visible same-group sibling (offset preserved) via the controller, then
 *   the visible row is held. Never a takeover, never a release or epoch
 *   change. Ordinary holds never write snapshots; only this validated
 *   same-group reconciliation may synchronize the route-local committed
 *   stable snapshot (explicit same-group visible row, corrected offset,
 *   actual scrollTop, isAtBottom false) after layout-quiet validation via
 *   the existing programmatic adopt + stable writer. The commit never waits
 *   for a later page-departure freeze (detach skips sampling by design).
 */

// --- Keeper hidden-anchor helpers (fold `display:none` replacement) ---
/**
 * Positive hidden proof for a keeper anchor row (fold `display:none`).
 * True only when the row or an ancestor up to (excluding) the container is
 * inline/computed `display:none` or `hidden`. Never infers hidden from zero
 * rects alone (jsdom has no layout), so visible jsdom surfaces keep holding.
 */
export const isKeeperAnchorRowHidden = (row: HTMLElement, container: HTMLElement): boolean => {
  try {
    let el: HTMLElement | null = row
    while (el && el !== container) {
      try {
        const inline = el.style as CSSStyleDeclaration | undefined
        if (inline && inline.display === 'none') return true
      } catch {}
      try {
        if (el.hidden === true) return true
      } catch {}
      try {
        const computed = window.getComputedStyle(el)
        if (computed && computed.display === 'none') return true
      } catch {}
      el = el.parentElement
    }
  } catch {}
  return false
}

const keeperMessageIdFromRow = (row: HTMLElement): string | null => {
  try {
    const id = row.id ?? ''
    if (typeof id === 'string' && id.startsWith('message-') && !id.startsWith('message-group-')) {
      const mid = id.replace(/^message-/, '')
      if (mid.length > 0) return mid
    }
    const attr = typeof row.getAttribute === 'function' ? row.getAttribute('data-message-id') : null
    if (typeof attr === 'string' && attr.length > 0) return attr
  } catch {}
  return null
}

/**
 * Real message content box for a stable message id (fold-safe).
 *
 * The DOM carries duplicate wrappers for the same answer: the outer fold
 * wrapper (`id="message-<id>"`, no `data-message-id`) and the inner content
 * box (`id="message-<id>" + `data-message-id="<id>"`), plus the tab strip
 * selectors (`data-message-id="<id>"` + `data-testid="answer-group-selector"`,
 * no `message-<id>`). Only the inner content box is real reading geometry —
 * never the fold wrapper rectangle and never the tab rectangle. Prefer the
 * element carrying BOTH attributes; fall back fail-closed (null) instead of
 * measuring a tab/wrapper.
 */
export const resolveRealMessageBox = (container: HTMLElement, messageId: string): HTMLElement | null => {
  try {
    if (!messageId) return null
    let api: { escape?: (x: string) => string } | undefined
    try {
      api = (globalThis as unknown as { CSS?: { escape?: (x: string) => string } }).CSS
    } catch {
      api = undefined
    }
    const esc = (v: string): string => {
      try {
        if (api?.escape) return api.escape(v)
        return v
      } catch {
        return v
      }
    }
    const sel = `[id="message-${esc(messageId)}"][data-message-id="${esc(messageId)}"]:not([data-testid="answer-group-selector"])`
    let el: HTMLElement | null = null
    try {
      el = container.querySelector(sel) as HTMLElement | null
    } catch {
      el = null
    }
    if (el && el.isConnected && container.contains(el)) return el
    return null
  } catch {
    return null
  }
}

/**
 * Visible same-group sibling for a hidden fold answer row: the nearest
 * `message-group-*` ancestor scopes the group; the first connected,
 * non-hidden sibling row in that scope wins. Returns its stable message id
 * or null when no visible sibling exists (then the keeper must not
 * compensate at all — a hidden row is never measurable stable geometry).
 * Fail-closed when no provable group scope exists: never fall back to an
 * unscoped direct parent whose same-group membership cannot be proven.
 * Tab-strip selectors (`answer-group-selector`) never count as siblings and
 * hidden proof resolves against the real content box, never the tab rectangle.
 */
export const findVisibleFoldSiblingId = (hiddenRow: HTMLElement, container: HTMLElement): string | null => {
  try {
    let scope: HTMLElement | null = null
    let p: HTMLElement | null = hiddenRow.parentElement
    while (p && p !== container) {
      try {
        const pid = p.id ?? ''
        if (typeof pid === 'string' && pid.startsWith('message-group-')) {
          scope = p
          break
        }
      } catch {}
      p = p.parentElement
    }
    if (!scope) return null
    if (!scope || scope === container) return null
    const rows = scope.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')
    for (const cand of rows) {
      if (!(cand instanceof HTMLElement)) continue
      if (cand === hiddenRow) continue
      try {
        if (typeof cand.getAttribute === 'function' && cand.getAttribute('data-testid') === 'answer-group-selector') {
          continue
        }
      } catch {}
      try {
        if (!cand.isConnected || !container.contains(cand)) continue
      } catch {
        continue
      }
      const mid = keeperMessageIdFromRow(cand)
      if (!mid) continue
      // Resolve the real content box for this sibling and prove visibility
      // against it (wrapper/tab rectangles never count).
      const real = resolveRealMessageBox(container, mid) ?? (isKeeperAnchorRowHidden(cand, container) ? null : cand)
      if (!real) continue
      if (isKeeperAnchorRowHidden(real, container)) continue
      return mid
    }
  } catch {}
  return null
}

export function useStableVisualAnchor(containerRef: React.RefObject<HTMLElement | null>): StableVisualAnchorMaintainer {
  const viewport = useOptionalRouteViewport()
  const compensatingRef = useRef<{ expected: number } | null>(null)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const holdRef = useRef<(reason: string) => void>(() => {})
  // Same-route fold-reconciliation pending stable commit (single queued
  // validation per reconciliation, coalesced across observer reruns). Bound
  // to the original displayed topic/route/epoch + reconciled identity/offset
  // + layout basis (row box h/top, container h/top, content scrollHeight,
  // viewport height, window generation). The queued rAF validates layout-quiet
  // (unchanged basis across consecutive observations) + currency before the
  // legal stable programmatic adopt + snapshot write. Ordinary holds never
  // arm this; an ordinary layout/window change resets/drops the quiet
  // validation. Invalid geometry drops (never writes).
  const foldPendingRef = useRef<{
    displayed: RouteRef
    epoch: number
    siblingId: string
    correctedOffset: number
    rowH: number
    rowTop: number
    containerH: number
    containerTop: number
    scrollHeight: number
    viewportHeight: number
    windowGeneration: number
  } | null>(null)
  const foldRafRef = useRef<number | null>(null)
  const cancelFoldCommitLocked = (): void => {
    try {
      const id = foldRafRef.current
      foldRafRef.current = null
      if (id !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
    } catch {}
  }
  useEffect(() => {
    return () => {
      foldPendingRef.current = null
      cancelFoldCommitLocked()
    }
    // Stable identity: pending lifetime is component-scoped, never versioned.
  }, [containerRef])

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
  // `controller.userTakeover()` (single writer → `commitSnapshotForRoute`)
  // plus the single validated fold-reconciliation programmatic adopt below
  // (same single-writer discipline). This keeper never takes over, never
  // releases ownership or bumps the epoch: a no-intent scroll (not a self
  // echo, no live user session, stable/aligned + clean + active anchor)
  // holds once via the same visual compensation. The sole anchor-identity
  // move here is the hidden fold-answer reconciliation (same-group visible
  // sibling, offset preserved, no epoch/release); only that validated path
  // may queue its layout-quiet stable snapshot sync. Self compensation
  // echoes are swallowed by the expected guard so they never recurse.
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
    // Fold-safe: the real content box carries BOTH `id="message-<id>"` and
    // `data-message-id="<id>"`; the fold wrapper carries only the id and the
    // tab strip carries only `data-message-id` + selector testid. The real
    // box wins so hidden proof/geometry never measures a tab rectangle.
    const resolveRow = (anchor: RouteVisualAnchor): HTMLElement | null => {
      try {
        let el: HTMLElement | null = null
        if (anchor.kind === 'message') {
          try {
            el = container.querySelector(
              `[id="message-${escapeId(anchor.messageId)}"][data-message-id="${escapeId(anchor.messageId)}"]:not([data-testid="answer-group-selector"])`
            ) as HTMLElement | null
          } catch {
            el = null
          }
          if (!el) {
            el = resolveRealMessageBox(container, anchor.messageId)
          }
          if (!el) {
            el = container.querySelector(
              `[data-message-id="${escapeId(anchor.messageId)}"]:not([data-testid="answer-group-selector"])`
            ) as HTMLElement | null
          }
          if (!el) {
            el = container.querySelector(`#${escapeId(`message-${anchor.messageId}`)}`) as HTMLElement | null
            try {
              if (el && el.getAttribute('data-testid') === 'answer-group-selector') el = null
            } catch {}
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
    const FOLD_QUIET_EPS_PX = 0.5
    interface FoldLayoutBasis {
      rowH: number
      rowTop: number
      containerH: number
      containerTop: number
      scrollHeight: number
      viewportHeight: number
      windowGeneration: number
    }
    // Real positive finite geometry only: invalid dimensions yield null so the
    // caller drops (never queues, never commits). The helper
    // `normalizeFoldAnchorOffset` returns the original on invalid geometry,
    // which would self-pass — this explicit guard closes that hole.
    const readFoldLayoutBasis = (
      liveContainer: HTMLElement,
      siblingId: string,
      windowGeneration: number
    ): FoldLayoutBasis | null => {
      try {
        const real = resolveRealMessageBox(liveContainer, siblingId)
        if (!real || !real.isConnected || !liveContainer.contains(real)) return null
        let rowRect: { height: number; top: number }
        let containerRect: { height: number; top: number }
        try {
          const r = real.getBoundingClientRect()
          rowRect = { height: r.height, top: r.top }
        } catch {
          return null
        }
        try {
          const c = liveContainer.getBoundingClientRect()
          containerRect = { height: c.height, top: c.top }
        } catch {
          return null
        }
        let viewportHeight = NaN
        try {
          viewportHeight =
            Number.isFinite(liveContainer.clientHeight) && liveContainer.clientHeight > 0
              ? liveContainer.clientHeight
              : containerRect.height
        } catch {
          viewportHeight = NaN
        }
        let scrollHeight = NaN
        try {
          scrollHeight = liveContainer.scrollHeight
        } catch {
          scrollHeight = NaN
        }
        if (!Number.isFinite(rowRect.height) || rowRect.height <= 0) return null
        if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return null
        if (!Number.isFinite(containerRect.height) || containerRect.height <= 0) return null
        if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return null
        if (!Number.isFinite(rowRect.top) || !Number.isFinite(containerRect.top)) return null
        if (!Number.isFinite(windowGeneration)) return null
        return {
          rowH: rowRect.height,
          rowTop: rowRect.top,
          containerH: containerRect.height,
          containerTop: containerRect.top,
          scrollHeight,
          viewportHeight,
          windowGeneration
        }
      } catch {
        return null
      }
    }
    const isSameFoldLayoutBasis = (a: FoldLayoutBasis, b: FoldLayoutBasis): boolean => {
      if (a.windowGeneration !== b.windowGeneration) return false
      if (Math.abs(a.rowH - b.rowH) > FOLD_QUIET_EPS_PX) return false
      if (Math.abs(a.rowTop - b.rowTop) > FOLD_QUIET_EPS_PX) return false
      if (Math.abs(a.containerH - b.containerH) > FOLD_QUIET_EPS_PX) return false
      if (Math.abs(a.containerTop - b.containerTop) > FOLD_QUIET_EPS_PX) return false
      if (Math.abs(a.scrollHeight - b.scrollHeight) > FOLD_QUIET_EPS_PX) return false
      if (Math.abs(a.viewportHeight - b.viewportHeight) > FOLD_QUIET_EPS_PX) return false
      return true
    }
    const runFoldValidation = (): void => {
      foldRafRef.current = null
      const pending = foldPendingRef.current
      if (!pending) return
      const liveContainer = containerRef.current
      if (!liveContainer || !liveContainer.isConnected) {
        foldPendingRef.current = null
        return
      }
      try {
        if (isCaptureContainerHidden(liveContainer)) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      const vpNow = viewportRef.current
      if (!vpNow) {
        foldPendingRef.current = null
        return
      }
      const ctrl = vpNow.controller
      try {
        if (ctrl.programmaticOwned || ctrl.hasActiveUserInteraction()) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      try {
        if (!ctrl.isDomProvenanceClean) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      try {
        if (ctrl.currentEpoch !== pending.epoch) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      try {
        const curDisplayed = ctrl.displayedRoute
        if (curDisplayed.topicId !== pending.displayed.topicId || curDisplayed.route !== pending.displayed.route) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      try {
        const liveAnchor = ctrl.getAnchorFor(pending.displayed)
        if (!liveAnchor || liveAnchor.kind !== 'message') {
          foldPendingRef.current = null
          return
        }
        if (liveAnchor.messageId !== pending.siblingId) {
          foldPendingRef.current = null
          return
        }
        // Original vs corrected meaning stays consistent: the live anchor must
        // still carry the queued corrected offset. Never re-normalize the
        // user's stable intent here.
        if (liveAnchor.offset !== pending.correctedOffset) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      let real: HTMLElement | null = null
      try {
        real = resolveRealMessageBox(liveContainer, pending.siblingId)
      } catch {
        foldPendingRef.current = null
        return
      }
      if (!real) {
        foldPendingRef.current = null
        return
      }
      try {
        if (isKeeperAnchorRowHidden(real, liveContainer)) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      // Layout-quiet proof: the layout basis must be unchanged across
      // consecutive observations (queue basis vs this frame). A row/container
      // shift, scrollHeight growth, viewport-height change, or window
      // generation bump re-arms one more quiet frame instead of
      // committing intermediate geometry; the single pending coalesces until
      // layout-quiet or real epoch/route/anchor/user/detach invalidation.
      let liveGen = NaN
      try {
        liveGen = ctrl.windowGeneration
      } catch {
        liveGen = NaN
      }
      const basisNow = readFoldLayoutBasis(liveContainer, pending.siblingId, liveGen)
      if (!basisNow) {
        foldPendingRef.current = null
        return
      }
      const prevBasis: FoldLayoutBasis = {
        rowH: pending.rowH,
        rowTop: pending.rowTop,
        containerH: pending.containerH,
        containerTop: pending.containerTop,
        scrollHeight: pending.scrollHeight,
        viewportHeight: pending.viewportHeight,
        windowGeneration: pending.windowGeneration
      }
      if (!isSameFoldLayoutBasis(prevBasis, basisNow)) {
        foldPendingRef.current = {
          ...pending,
          rowH: basisNow.rowH,
          rowTop: basisNow.rowTop,
          containerH: basisNow.containerH,
          containerTop: basisNow.containerTop,
          scrollHeight: basisNow.scrollHeight,
          viewportHeight: basisNow.viewportHeight,
          windowGeneration: basisNow.windowGeneration
        }
        try {
          scheduleFoldValidation()
        } catch {
          foldPendingRef.current = null
        }
        return
      }
      // Target real-box identity + offset revalidation (frame-quiet):
      // the queued corrected offset must still be representable. A shift that
      // changes the representable range invalidates this pending commit (no
      // write; the live anchor already holds the visual position and a later
      // genuine user scroll or stable commit owns the snapshot).
      try {
        const rechecked = normalizeFoldAnchorOffset(pending.correctedOffset, basisNow.rowH, basisNow.viewportHeight)
        if (!Number.isFinite(rechecked) || rechecked !== pending.correctedOffset) {
          foldPendingRef.current = null
          return
        }
      } catch {
        foldPendingRef.current = null
        return
      }
      let liveScrollTop = NaN
      try {
        liveScrollTop = liveContainer.scrollTop
      } catch {
        foldPendingRef.current = null
        return
      }
      if (!Number.isFinite(liveScrollTop)) {
        foldPendingRef.current = null
        return
      }
      // Consume before the adopt so a re-entrant notify cannot double-commit.
      foldPendingRef.current = null
      let adopted: unknown = null
      try {
        adopted = ctrl.adoptProgrammaticViewport(
          pending.displayed,
          {
            messageId: pending.siblingId,
            intraRowOffset: pending.correctedOffset,
            scrollTop: liveScrollTop,
            isAtBottom: false
          },
          { expectedEpoch: pending.epoch }
        )
      } catch {
        return
      }
      if (!adopted || typeof adopted !== 'object' || (adopted as { taken: unknown }).taken !== true) return
      const taken = adopted as {
        taken: true
        routeKey: string
        snapshot: { scrollTop: number; messageId: string | null; intraRowOffset: number | null; isAtBottom: boolean }
      }
      try {
        writeRouteSnapshot(taken.routeKey, {
          scrollTop: taken.snapshot.scrollTop,
          messageId: taken.snapshot.messageId,
          intraRowOffset: taken.snapshot.intraRowOffset,
          isAtBottom: false
        })
      } catch {
        return
      }
      try {
        vpNow.notifyChanged()
      } catch {}
    }
    const scheduleFoldValidation = (): void => {
      cancelFoldCommitLocked()
      const schedule =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (cb: FrameRequestCallback): number => {
              try {
                cb(0)
              } catch {}
              return 0
            }
      try {
        foldRafRef.current = schedule(() => {
          runFoldValidation()
        })
      } catch {
        foldPendingRef.current = null
        foldRafRef.current = null
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
      // Bottom semantic (no row anchor): pin the column-reverse bottom
      // (scrollTop 0) through layout/insertion so true bottom survives new
      // user/assistant rows and stream growth. Gated above on unowned +
      // no live user session, so a subsequent genuine wheel scroll-away is
      // never fought here (its takeover owns the new anchor instead).
      const displayed = vp.controller.displayedRoute
      let anchor = vp.controller.getAnchorFor(displayed)
      if (!anchor) {
        try {
          if (Math.abs(container.scrollTop) > 1) {
            container.scrollTop = 0
            compensatingRef.current = { expected: container.scrollTop }
          }
        } catch {}
        return
      }
      let el = resolveRow(anchor)
      if (!el) return
      // Fold answer replacement: a hidden/collapsed selected answer is not
      // measurable stable geometry — never compensate using it. When the held
      // reading anchor is the replaced (now hidden) answer, reconcile it to
      // the visible answer in the SAME group (shared group scope). The
      // original offset is preserved EXACTLY when the replacement real box can
      // still represent it as visible; otherwise it clamps to the nearest
      // valid visible in-row position (minimal local adjustment, same group,
      // never global bottom/unrelated message). A held anchor that is a
      // different visible message is preserved normally below. No restore, no
      // epoch change. The reconciled live anchor is held below; its
      // route-local committed stable snapshot is synchronized by the queued
      // layout-quiet validation at the end of this hold (same-group visible
      // row only, never crossing-first) so a later page reactivation never
      // reselects the hidden old answer. Detach skips outgoing sampling by
      // design, so this sync must not wait for a later departure freeze.
      let reconciledFold: { siblingId: string; correctedOffset: number } | null = null
      if (anchor.kind === 'message' && isKeeperAnchorRowHidden(el, container)) {
        const siblingId = findVisibleFoldSiblingId(el, container)
        if (!siblingId) return
        const siblingEl =
          resolveRealMessageBox(container, siblingId) ??
          resolveRow({ kind: 'message', messageId: siblingId, offset: 0 })
        if (!siblingEl) return
        if (isKeeperAnchorRowHidden(siblingEl, container)) return
        let corrected = anchor.offset
        try {
          const siblingRect = siblingEl.getBoundingClientRect()
          const containerRectForViewport = container.getBoundingClientRect()
          const viewportHeight =
            Number.isFinite(container.clientHeight) && container.clientHeight > 0
              ? container.clientHeight
              : containerRectForViewport.height
          corrected = normalizeFoldAnchorOffset(anchor.offset, siblingRect.height, viewportHeight)
        } catch {
          corrected = anchor.offset
        }
        let transferred = false
        try {
          transferred = vp.controller.reconcileAnchorToVisibleMessage(displayed, siblingId, {
            correctedOffset: corrected
          })
        } catch {
          transferred = false
        }
        if (!transferred) return
        const next = vp.controller.getAnchorFor(displayed)
        if (!next) return
        const nextEl = resolveRow(next)
        if (!nextEl) return
        if (isKeeperAnchorRowHidden(nextEl, container)) return
        anchor = next
        el = nextEl
        reconciledFold = { siblingId, correctedOffset: corrected }
      }
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
      if (Math.abs(delta) > 1) {
        try {
          container.scrollTop += delta
          compensatingRef.current = { expected: container.scrollTop }
        } catch {}
      }
      // Validated fold sync: queue a single layout-quiet check for THIS
      // reconciliation only. The rAF re-proves target real-box identity +
      // offset, layout-basis quiet, and currency before the legal stable
      // programmatic adopt + snapshot write. Coalesced: a newer
      // reconciliation replaces the pending payload and its frame; ordinary
      // holds never arm.
      if (!reconciledFold) {
        // Ordinary hold notifies the pending quiet validation: a layout or
        // window-generation change while pending re-arms the single pending
        // quiet check so a stale snapshot never survives. Quiet
        // continuations leave the scheduled frame alone.
        const pendingOrd = foldPendingRef.current
        if (pendingOrd) {
          let curGen = NaN
          try {
            curGen = vp.controller.windowGeneration
          } catch {
            curGen = NaN
          }
          const basisNow = readFoldLayoutBasis(container, pendingOrd.siblingId, curGen)
          if (!basisNow) {
            foldPendingRef.current = null
            cancelFoldCommitLocked()
          } else {
            const prevBasis: FoldLayoutBasis = {
              rowH: pendingOrd.rowH,
              rowTop: pendingOrd.rowTop,
              containerH: pendingOrd.containerH,
              containerTop: pendingOrd.containerTop,
              scrollHeight: pendingOrd.scrollHeight,
              viewportHeight: pendingOrd.viewportHeight,
              windowGeneration: pendingOrd.windowGeneration
            }
            if (!isSameFoldLayoutBasis(prevBasis, basisNow)) {
              foldPendingRef.current = {
                ...pendingOrd,
                rowH: basisNow.rowH,
                rowTop: basisNow.rowTop,
                containerH: basisNow.containerH,
                containerTop: basisNow.containerTop,
                scrollHeight: basisNow.scrollHeight,
                viewportHeight: basisNow.viewportHeight,
                windowGeneration: basisNow.windowGeneration
              }
              try {
                scheduleFoldValidation()
              } catch {
                foldPendingRef.current = null
              }
            }
          }
        }
        return
      }
      const pendingDisplayed: RouteRef = { ...displayed }
      const pendingEpoch = vp.controller.currentEpoch
      const pendingSiblingId = reconciledFold.siblingId
      const pendingCorrected = reconciledFold.correctedOffset
      // Queue-time geometry must be real positive finite; invalid geometry
      // drops (never queues, never writes).
      let queueGen = NaN
      try {
        queueGen = vp.controller.windowGeneration
      } catch {
        queueGen = NaN
      }
      const queueBasis = readFoldLayoutBasis(container, pendingSiblingId, queueGen)
      if (!queueBasis) {
        foldPendingRef.current = null
        cancelFoldCommitLocked()
        return
      }
      foldPendingRef.current = {
        displayed: pendingDisplayed,
        epoch: pendingEpoch,
        siblingId: pendingSiblingId,
        correctedOffset: pendingCorrected,
        rowH: queueBasis.rowH,
        rowTop: queueBasis.rowTop,
        containerH: queueBasis.containerH,
        containerTop: queueBasis.containerTop,
        scrollHeight: queueBasis.scrollHeight,
        viewportHeight: queueBasis.viewportHeight,
        windowGeneration: queueBasis.windowGeneration
      }
      try {
        scheduleFoldValidation()
      } catch {
        foldPendingRef.current = null
        foldRafRef.current = null
      }
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
