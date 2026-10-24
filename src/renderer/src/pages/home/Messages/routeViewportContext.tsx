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

import {
  COLUMN_REVERSE_BOTTOM_THRESHOLD_PX,
  isAtBottom,
  LAYOUT_HOLD_TOLERANCE_PX,
  type LayoutHoldSample,
  rebaseLayoutHold,
  resolveLayoutHold
} from '@renderer/pages/home/Messages/columnReverseGeometry'
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
  declareUserIntentSession,
  displayedRouteKey,
  type RouteId,
  type RouteRef,
  RouteViewportController,
  routeViewportKey,
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

/**
 * Stable imperative command surface (route viewport).
 *
 * The full context value carries the versioned projection (`version`,
 * `viewportPhaseAttr`, `connectionGeneration`) and therefore changes identity
 * on every controller notification. That is correct for the few surfaces that
 * RENDER the phase/version, but it is the wrong subscription for the rows:
 * every `Message`/`MessageGroup`/editor row only needs the stable controller
 * and the stable imperative commands. Consuming the versioned value there
 * re-rendered the whole mounted conversation (message subtree + menubars +
 * antd cssinjs style re-registration) on every notify — including repeated
 * native key repeats that change no message, config or window.
 *
 * This context holds exactly the stable members: the controller instance and
 * the `useCallback`-stable commands. Its value identity never changes across
 * notifications, so a row subscribing here re-renders only when its own props
 * change (message/config/window), never because the viewport notified.
 */
export type RouteViewportCommands = Pick<
  RouteViewportContextValue,
  'controller' | 'notifyChanged' | 'freezeDisplayed' | 'readSnapshot' | 'requestTopRoute' | 'registerCapturer'
>

const RouteViewportCommandsContext = createContext<RouteViewportCommands | null>(null)

/** Exported for focused behavior tests (production uses the provider). */
export { RouteViewportCommandsContext, RouteViewportContext }

export const useRouteViewport = (): RouteViewportContextValue => {
  const value = use(RouteViewportContext)
  if (!value) throw new Error('useRouteViewport must be used inside RouteViewportProvider')
  return value
}

/** Optional access for hooks that must keep working outside the provider (tests). */
export const useOptionalRouteViewport = (): RouteViewportContextValue | null => use(RouteViewportContext)

/**
 * Row-level consumption of the route viewport: stable controller + stable
 * imperative commands, no version subscription. A row that only needs to
 * capture an interaction intent or read the controller must use this instead
 * of the versioned context, so a viewport notification (however frequent)
 * never re-renders the mounted conversation.
 */
export const useOptionalRouteViewportCommands = (): RouteViewportCommands | null => use(RouteViewportCommandsContext)

/** Required variant for surfaces that must live inside the provider. */
export const useRouteViewportCommands = (): RouteViewportCommands => {
  const value = use(RouteViewportCommandsContext)
  if (!value) throw new Error('useRouteViewportCommands must be used inside RouteViewportProvider')
  return value
}

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

  // Stable command surface for the rows: identity is pinned to the stable
  // callbacks + controller instance, so it is NOT recreated by the versioned
  // `value` above. Rows subscribe to this, the phase/version readers stay on
  // the full context (Messages/TopicContent).
  const commands = useMemo<RouteViewportCommands>(
    () => ({ controller, notifyChanged, freezeDisplayed, readSnapshot, requestTopRoute, registerCapturer }),
    [controller, notifyChanged, freezeDisplayed, readSnapshot, requestTopRoute, registerCapturer]
  )

  void topicId
  return (
    <RouteViewportContext value={value}>
      <RouteViewportCommandsContext value={commands}>{children}</RouteViewportCommandsContext>
    </RouteViewportContext>
  )
}

// --- Keeper device-pixel geometry unit (fractional-zoom pause hold) ---------
//
// The paused-stream wrapper uses native
// `height: calc-size(auto, round(up, size, var(--messages-pixel-size, 1px)))`
// so its TRUE intrinsic height rounds up to the live device-pixel quantum
// instead of a fixed 1 CSS px (which leaves up to ~0.6px fractional root
// start at 125% zoom). The keeper synchronizes the var to
// `1/window.devicePixelRatio` on the existing firstElementChild wrapper via
// the existing observer/layout path only: no new business state, hooks,
// observers, lifecycle owners, persisted settings, placeholders, transforms,
// timers, or global DPR systems. Geometry-only: never touches controller
// anchor/snapshot/generations, never alters column-reverse/bottom/snapshots.

/** CSS variable carrying the live device-pixel quantum for the messages wrapper. */
export const MESSAGES_PIXEL_VAR = '--messages-pixel-size' as const

/**
 * Sanitize an effective DPR into a finite positive CSS quantum string
 * (`1/dpr` px), or null when the input is unusable. Pure, no DOM work.
 */
export const resolveMessagesPixelQuantum = (dpr: unknown): string | null => {
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0) return null
  const quantum = 1 / dpr
  if (!Number.isFinite(quantum) || quantum <= 0) return null
  return `${quantum}px`
}

/**
 * Synchronize the live quantum onto the existing content wrapper's inline
 * style. Write-only on change (prior-property compare) so the existing
 * ResizeObserver never loops: the var write may resize once, the next
 * observer fire sees the same value and writes nothing. Never alters
 * controller anchor/snapshot/generations. Returns true only when a write
 * landed.
 */
export const syncMessagesPixelQuantum = (content: Element | null, dpr?: unknown): boolean => {
  try {
    if (!content || !(content instanceof HTMLElement)) return false
    let ratio: unknown = dpr
    if (ratio === undefined) {
      try {
        ratio = window.devicePixelRatio
      } catch {
        return false
      }
    }
    const next = resolveMessagesPixelQuantum(ratio)
    if (!next) return false
    let prev = ''
    try {
      prev = content.style.getPropertyValue(MESSAGES_PIXEL_VAR)
    } catch {
      prev = ''
    }
    if (prev === next) return false
    try {
      content.style.setProperty(MESSAGES_PIXEL_VAR, next)
    } catch {
      return false
    }
    return true
  } catch {
    return false
  }
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

export const buildContainerCapturer = (
  containerRef: React.RefObject<HTMLElement | null>,
  getOrderedRows?: () => readonly HTMLElement[]
): SnapshotCapturer => {
  return () => {
    const container = containerRef.current
    if (!container) return null
    if (isCaptureContainerHidden(container)) return null
    const scrollTop = container.scrollTop
    let orderedRows: readonly HTMLElement[] | undefined
    try {
      orderedRows = getOrderedRows?.()
    } catch {
      orderedRows = undefined
    }
    const anchor =
      orderedRows && orderedRows.length > 0
        ? findViewportTopAnchorWithOffset(container, { orderedRows })
        : findViewportTopAnchorWithOffset(container)
    return {
      scrollTop,
      messageId: anchor?.messageId ?? null,
      intraRowOffset: anchor ? anchor.intraRowOffset : null,
      isAtBottom: isAtBottom(scrollTop, COLUMN_REVERSE_BOTTOM_THRESHOLD_PX)
    }
  }
}

// --- Persistent stable anchoring ------------------------------------------------

/**
 * Transactional anchor sample: one anchor row's viewport offset together with
 * the container `scrollTop` read at the SAME instant. Only the component that
 * measures and publishes an anchor can produce a true pair; the keeper uses it
 * as a hold baseline when it has no observation of its own for that row, so the
 * layout metric never pairs a stale offset with a later scroll position (which
 * would charge unknown user movement to layout and rewind it).
 */
export interface ViewportAnchorSample {
  topicId: string
  route: RouteId
  messageId: string
  /** Row top − scroll-container top at the instant `scrollTop` was read. */
  viewportOffset: number
  /** Container `scrollTop` read in the same synchronous block. */
  scrollTop: number
}

export interface StableVisualAnchorMaintainer {
  /** Visual hold plus validated fold-reconciliation snapshot sync (never takeover/release/epoch change). */
  requestHold: (reason: string) => void
  /**
   * Publish the transactional pair for a just-published anchor (offset +
   * scrollTop from the same instant). Purely a baseline source: the keeper owns
   * the hold, the controller owns the anchor, and a null/invalid sample simply
   * leaves the keeper with its own observation.
   */
  publishAnchorSample: (sample: ViewportAnchorSample | null) => void
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

/**
 * Resolve the clicked answer-tab element for a stable message id.
 * Tab-strip selectors carry `data-testid="answer-group-selector"` +
 * `data-message-id`; the first connected candidate inside the container wins.
 */
export const resolveAnswerTabElement = (container: HTMLElement, tabMessageId: string): HTMLElement | null => {
  try {
    if (!tabMessageId) return null
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
    let el: HTMLElement | null = null
    try {
      el =
        (container.querySelector(
          `[data-testid="answer-group-selector"][data-message-id="${esc(tabMessageId)}"]`
        ) as HTMLElement | null) ??
        (document.querySelector(
          `[data-testid="answer-group-selector"][data-message-id="${esc(tabMessageId)}"]`
        ) as HTMLElement | null)
    } catch {
      el = null
    }
    if (el && el.isConnected && (container.contains(el) || el === container)) return el
    if (el && el.isConnected && document.contains(el)) return el
    return null
  } catch {
    return null
  }
}

/**
 * Shared interaction-region semantics (stable layout identities, never button
 * names): `answer-tab` is the clicked answer tab strip; `message-controls`
 * is the message footer ↔ editor action area surviving editor replacement as
 * the same stable interaction area; `fold-controls` is the group-level
 * expand/compress control. Any non-empty region key is structurally
 * resolvable — the resolver accepts no allowlist, so new regions need no
 * code change, only the annotation.
 */
export const INTERACTION_REGION_TAB = 'answer-tab' as const
export const INTERACTION_REGION_CONTROLS = 'message-controls' as const
export const INTERACTION_REGION_FOLD = 'fold-controls' as const

/**
 * Per-region visual baseline edge (VIEWPORT-13/14 visual-baseline rule).
 *
 * The baseline is a geometric point declared by the region, not a direction
 * enum and not a per-feature case list: `start` measures the region TOP
 * (default, existing model-label/FOLD compatible), `end` measures the region
 * BOTTOM (the true change-domain lower bound for message edit controls whose
 * own height changes across the footer ↔ action-bar swap). Missing or illegal
 * values fail to the default existing model (`start`); reference changes use
 * the stable data-identity resolver above so an attribute change mid-gesture
 * never forces two ends. One helper below serves capture/hold/validation and
 * the answer-tab entry with identical semantics and a unified signed delta.
 */
export const VIEWPORT_BASELINE_EDGE_ATTR = 'data-viewport-baseline-edge' as const
export const VIEWPORT_BASELINE_EDGE_START = 'start' as const
export const VIEWPORT_BASELINE_EDGE_END = 'end' as const
export type ViewportBaselineEdge = 'start' | 'end'

/**
 * Resolve the declared visual baseline edge for a region element.
 * Returns `end` only for an explicit `end` declaration; every other state
 * (missing, illegal, helper error) is the default original `start`.
 */
export const resolveViewportBaselineEdge = (el: Element | null | undefined): ViewportBaselineEdge => {
  try {
    if (!el || typeof el.getAttribute !== 'function') return VIEWPORT_BASELINE_EDGE_START
    const raw = el.getAttribute(VIEWPORT_BASELINE_EDGE_ATTR)
    return raw === VIEWPORT_BASELINE_EDGE_END ? VIEWPORT_BASELINE_EDGE_END : VIEWPORT_BASELINE_EDGE_START
  } catch {
    return VIEWPORT_BASELINE_EDGE_START
  }
}

/**
 * Shared visual-baseline measurement: the region's declared edge offset
 * minus the container top (unified signed delta). `start` uses TOP,
 * `end` uses BOTTOM. Returns NaN when unmeasurable (fail-closed by callers).
 * Capture, hold, validation, and the answer-tab entry all share this helper
 * so re-resolution across replacement never changes ends.
 */
export const measureViewportRegionOffset = (regionEl: HTMLElement, container: HTMLElement): number => {
  try {
    if (!regionEl || !container) return NaN
    let containerTop = NaN
    try {
      containerTop = container.getBoundingClientRect().top
    } catch {
      return NaN
    }
    let rect: DOMRect | null = null
    try {
      rect = regionEl.getBoundingClientRect()
    } catch {
      return NaN
    }
    if (!rect) return NaN
    const edge = resolveViewportBaselineEdge(regionEl)
    const base = edge === VIEWPORT_BASELINE_EDGE_END ? rect.bottom : rect.top
    if (!Number.isFinite(base) || !Number.isFinite(containerTop)) return NaN
    const offset = base - containerTop
    return Number.isFinite(offset) ? offset : NaN
  } catch {
    return NaN
  }
}

/**
 * Trusted layout-control marker for the message-editor top-edge resize
 * handle (VIEWPORT-13/14 same-arbiter classification, not a second
 * lifecycle). The handle is a DIV separator owned by a message row; its
 * press/drag and its Arrow/Home/End/PageUp/PageDown keys are layout
 * resizing, never genuine user-scroll intent. Wheels on/near it stay
 * genuine scroll intent; untagged presses stay genuine.
 */
export const VIEWPORT_LAYOUT_CONTROL_ATTR = 'data-viewport-layout-control' as const
export const VIEWPORT_LAYOUT_CONTROL_RESIZE = 'message-editor-resize' as const
export const VIEWPORT_LAYOUT_RESIZE_TESTID = 'message-editor-resize-handle' as const

/** Nav keys the resize handle consumes as layout resizing (editor-owned). */
export const VIEWPORT_LAYOUT_RESIZE_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End'
])

/**
 * Narrow trusted check: true only for a real connected resize handle owned
 * by a message row (marker + known testid + message-row ownership +
 * container containment when a container is supplied). Fail-closed on any
 * helper error, disconnected node, missing testid, or missing row owner —
 * spoofed markers outside a row never qualify.
 */
export const isViewportLayoutControlTarget = (target: unknown, container?: HTMLElement | null): boolean => {
  try {
    if (!(target instanceof Element)) return false
    let handle: Element | null = null
    try {
      handle = target.closest?.(
        `[${VIEWPORT_LAYOUT_CONTROL_ATTR}="${VIEWPORT_LAYOUT_CONTROL_RESIZE}"]`
      ) as Element | null
    } catch {
      return false
    }
    if (!handle) return false
    try {
      if (handle.getAttribute('data-testid') !== VIEWPORT_LAYOUT_RESIZE_TESTID) return false
    } catch {
      return false
    }
    try {
      if (!handle.isConnected) return false
    } catch {
      return false
    }
    if (container) {
      try {
        if (!container.contains(handle)) return false
      } catch {
        return false
      }
    }
    try {
      const owner = handle.closest?.('[data-message-id]:not([data-testid="answer-group-selector"])') as Element | null
      if (!owner) return false
      try {
        if (!owner.isConnected) return false
      } catch {
        return false
      }
      if (container) {
        try {
          if (!container.contains(owner)) return false
        } catch {
          return false
        }
      }
    } catch {
      return false
    }
    return true
  } catch {
    return false
  }
}

/** True when a keydown on a layout handle is a layout resize (not a scroll). */
export const isViewportLayoutResizeKey = (key: unknown): boolean => {
  try {
    return typeof key === 'string' && VIEWPORT_LAYOUT_RESIZE_KEYS.has(key)
  } catch {
    return false
  }
}

/**
 * Fail-closed STRUCTURAL correspondence deadline: a lost/hidden/disconnected
 * scope or region that stays unresolvable longer than this after capture is
 * treated as a dead target (deleted route content, never-committing
 * selection) and the intent is dropped with no adopt. Generous wall-clock
 * bound (async selections and slow commits land far inside it); it only ever
 * drops, never certifies. A still-connected, finite, visible region baseline
 * with valid route/provenance/currency/user/ownership is NOT structural loss
 * and never expires on wall time — it is retained event-driven (see the
 * keeper validation below), even with no handoff row below.
 */
export const INTERACTION_PENDING_DEADLINE_MS = 20000
/**
 * Quiet proof for adoption: consecutive agreeing subpixel reads required
 * alongside an observed layout change before handing off. Only gates the
 * fingerprinted path; legacy fingerprint-less intents keep single-frame
 * handoff.
 */
export const INTERACTION_QUIET_READS_FOR_ADOPT = 2
/**
 * Stillness bound for dropping a genuinely no-effect action WITHOUT
 * adopting: consecutive agreeing reads with no observable layout change
 * versus the capture fingerprint. The count only ever gates a
 * snapshot-free drop — stillness alone never certifies success.
 */
export const INTERACTION_QUIET_READS_FOR_DROP = 8

const escapeSelectorValue = (v: string): string => {
  try {
    const api = (globalThis as unknown as { CSS?: { escape?: (x: string) => string } }).CSS
    if (api?.escape) return api.escape(v)
    return v
  } catch {
    return v
  }
}

/**
 * Resolve the structural scope element (the layout owner): a message row's
 * real content box for message scopes, the stable group wrapper for group
 * scopes. Fail-closed (null) when the scope is missing or disconnected.
 */
export const resolveInteractionScopeElement = (
  container: HTMLElement,
  scope: { kind: string; id: string }
): HTMLElement | null => {
  try {
    if (!scope || typeof scope.id !== 'string' || scope.id.length === 0) return null
    if (scope.kind === 'group') {
      let el: HTMLElement | null = null
      try {
        el = container.querySelector(`[data-stable-group-id="${escapeSelectorValue(scope.id)}"]`) as HTMLElement | null
      } catch {
        el = null
      }
      if (el && el.isConnected && container.contains(el)) return el
      return null
    }
    if (scope.kind !== 'message') return null
    return resolveRealMessageBox(container, scope.id)
  } catch {
    return null
  }
}

/**
 * Resolve the live element for a shared interaction region inside the
 * viewport container. The same region key is re-resolved in the same scope
 * after replacement (structural correspondence: footer ↔ action bar,
 * compact ↔ expanded toggle, pre/post-selection tab strip). Tabs resolve
 * through the stable tab-strip selector; every other region resolves to the
 * annotated element within its scope. Fail-closed (null) when the scope or
 * region is missing: disappearance without a legitimate structural mapping
 * must never guess another control.
 */
export const resolveInteractionRegionElement = (
  container: HTMLElement,
  scope: { kind: string; id: string },
  region: string
): HTMLElement | null => {
  try {
    if (!scope || !region) return null
    if (region === INTERACTION_REGION_TAB) {
      if (scope.kind !== 'message') return null
      return resolveAnswerTabElement(container, scope.id)
    }
    const scopeEl = resolveInteractionScopeElement(container, scope)
    if (!scopeEl) return null
    let el: HTMLElement | null = null
    try {
      el = scopeEl.querySelector(`[data-interaction-region="${escapeSelectorValue(region)}"]`) as HTMLElement | null
    } catch {
      el = null
    }
    if (el && el.isConnected && scopeEl.contains(el)) return el
    return null
  } catch {
    return null
  }
}

/**
 * First visible message row strictly BELOW the scope row (visual order).
 *
 * The edit baseline is the stable structural boundary BELOW the change
 * domain: the change (editor body growth above the action bar) must rise
 * into the upper space while content below stays still. Adopting the scope
 * row's own TOP would re-anchor to a moving edge (the row top moves when the
 * row grows above a fixed bottom), so the handoff adopts the nearest visible
 * row below whose TOP is adjacent to the scope row's BOTTOM. Holding that
 * TOP stationary across later steps preserves the same bottom baseline.
 * Fail-closed (null) when no visible below row exists — the caller stays
 * pending with the valid baseline retained event-driven (no deadline expiry
 * while the region stays connected/finite/visible and currency holds),
 * never the scope row. The correspondence deadline bounds only lost/hidden/
 * disconnected structural correspondence.
 */
export const resolveBelowVisibleRow = (
  container: HTMLElement,
  scopeId: string
): { id: string; offset: number } | null => {
  try {
    const containerTop = container.getBoundingClientRect().top
    if (!Number.isFinite(containerTop)) return null
    const scopeRow = resolveRealMessageBox(container, scopeId)
    if (!scopeRow) return null
    if (isKeeperAnchorRowHidden(scopeRow, container)) return null
    const scopeBottom = scopeRow.getBoundingClientRect().bottom
    if (!Number.isFinite(scopeBottom)) return null
    let best: { id: string; offset: number; top: number } | null = null
    let rows: NodeListOf<Element> | null = null
    try {
      rows = container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')
    } catch {
      return null
    }
    if (!rows) return null
    for (const cand of rows) {
      if (!(cand instanceof HTMLElement)) continue
      let id: string | null = null
      try {
        id =
          cand.getAttribute('data-message-id') ??
          (typeof cand.id === 'string' && cand.id.startsWith('message-') ? cand.id.replace(/^message-/, '') : null)
      } catch {
        id = null
      }
      if (typeof id !== 'string' || id.length === 0 || id === scopeId) continue
      const real = resolveRealMessageBox(container, id)
      if (!real) continue
      try {
        if (isKeeperAnchorRowHidden(real, container)) continue
      } catch {
        continue
      }
      let top = NaN
      try {
        top = real.getBoundingClientRect().top
      } catch {
        continue
      }
      if (!Number.isFinite(top)) continue
      // Strictly below the scope bottom (1px tolerance for subpixel seams).
      if (!(top >= scopeBottom - 1)) continue
      if (!best || top < best.top) best = { id, offset: top - containerTop, top }
    }
    if (!best) return null
    return { id: best.id, offset: best.offset }
  } catch {
    return null
  }
}

/**
 * Resolve the handoff representative for a settled interaction: the visible
 * message row whose identity + offset the stable snapshot adopts. Tabs hand
 * off to their target answer's real box (hidden pre-commit = mutation still
 * pending); dimensionally-stable message scopes hand off to their own row;
 * a message-controls scope whose owner changed dimensions hands off to the
 * first visible row BELOW the edited row (the stable boundary below the
 * change domain) and otherwise stays pending (null) — never to its own
 * moving TOP and never to a row above with the changing row height between
 * them, both of which re-anchor later steps of the same session to the
 * wrong end; group scopes hand off to the first visible real box in the
 * group. Null when no visible representative exists (pending or
 * fail-closed, decided by the caller).
 */
export const resolveInteractionRepresentative = (
  container: HTMLElement,
  scope: { kind: string; id: string },
  region: string,
  opts?: { avoidScopeRow?: boolean }
): { id: string; offset: number } | null => {
  try {
    const containerTop = container.getBoundingClientRect().top
    if (!Number.isFinite(containerTop)) return null
    if (region === INTERACTION_REGION_TAB || scope.kind === 'message') {
      if (scope.kind !== 'message') return null
      // Edit controls hand off below the change domain (see helper above).
      // Tabs keep their target-answer handoff: the tab strip height is stable
      // so its bottom delta equals its top delta, and the answer TOP below the
      // strip is the adjacent stable reading row.
      if (region === INTERACTION_REGION_CONTROLS && opts?.avoidScopeRow === true) {
        // The scope row itself changed height (edit growth/shrink): its
        // own TOP is a moving edge, and adopting it would re-anchor later
        // steps to the wrong end. The only valid handoff is the first
        // visible row BELOW (adjacent to the bottom baseline — nothing
        // changing lies between them). A row above is NOT a substitute: the
        // changing row height lies between it and the baseline, so holding
        // it lets continued motion drift the region. With no visible row
        // below (bottommost), stay pending (null) with the valid baseline
        // retained event-driven (no deadline expiry while the region stays
        // connected/finite/visible and currency holds; the keeper hold
        // keeps compensating the captured bottom on layout events and
        // persistence is covered by the departure freeze, which captures
        // the converged live DOM). The correspondence deadline bounds only
        // lost/hidden/disconnected structural correspondence, never a valid
        // measurable baseline. Tabs keep their target-answer
        // handoff below via the shared branch above.
        try {
          const below = resolveBelowVisibleRow(container, scope.id)
          if (below) return below
        } catch {
          // fall through to pending (null) below
        }
        return null
      }
      const row = resolveRealMessageBox(container, scope.id)
      if (!row) return null
      if (isKeeperAnchorRowHidden(row, container)) return null
      const top = row.getBoundingClientRect().top
      if (!Number.isFinite(top)) return null
      return { id: scope.id, offset: top - containerTop }
    }
    if (scope.kind !== 'group') return null
    const scopeEl = resolveInteractionScopeElement(container, scope)
    if (!scopeEl) return null
    const rows = scopeEl.querySelectorAll('[data-message-id]:not([data-testid="answer-group-selector"])')
    for (const cand of rows) {
      if (!(cand instanceof HTMLElement)) continue
      let id: string | null = null
      try {
        id = cand.getAttribute('data-message-id')
      } catch {
        id = null
      }
      if (typeof id !== 'string' || id.length === 0) continue
      const real = resolveRealMessageBox(container, id)
      if (!real) continue
      try {
        if (isKeeperAnchorRowHidden(real, container)) continue
      } catch {
        continue
      }
      const top = real.getBoundingClientRect().top
      if (!Number.isFinite(top)) continue
      return { id, offset: top - containerTop }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Record the layout-owner fingerprint BEFORE the mutation: the scope
 * element's own dimensions. Null when unmeasurable (the intent is still
 * armed; the keeper then completes on quiet + visible representative without
 * the layout-change proof — the pre-existing legacy semantic).
 */
export const captureLayoutFingerprint = (
  container: HTMLElement,
  scope: { kind: string; id: string }
): { scopeH: number; scopeW: number } | null => {
  try {
    const scopeEl = resolveInteractionScopeElement(container, scope)
    if (!scopeEl) return null
    const rect = scopeEl.getBoundingClientRect()
    if (!Number.isFinite(rect.height) || !Number.isFinite(rect.width)) return null
    return { scopeH: rect.height, scopeW: rect.width }
  } catch {
    return null
  }
}

/**
 * Capture a shared interaction intent BEFORE the layout-changing mutation.
 * Measures the region's declared visual-baseline viewport offset (shared
 * helper: default TOP, message-controls declares BOTTOM as the true
 * change-domain lower bound) plus the scope owner's fingerprint synchronously
 * and arms both on the existing viewport owner. Stable-height regions
 * (tabs, fold) keep their TOP holds unchanged; the edit footer↔action-bar
 * swap (whose own heights differ) holds its BOTTOM invariant while the height
 * delta rises into the upper space and content below stays still.
 * Fail-closed (false) when the container/scope/region is missing, geometry
 * is non-finite, or the controller refuses (owned/dirty/user-live/bottom for
 * non-tab regions). Never opens ownership, never writes snapshots.
 */
export const captureInteractionIntent = (
  controller: {
    beginInteractionIntent: (
      t: RouteRef,
      scope: { kind: 'message' | 'group'; id: string },
      region: string,
      off: number,
      opts?: { fingerprint?: { scopeH: number; scopeW: number } }
    ) => boolean
    displayedRoute: RouteRef
  },
  scope: { kind: 'message' | 'group'; id: string },
  region: string,
  container?: HTMLElement | null
): boolean => {
  try {
    const liveContainer = container ?? document.getElementById('messages')
    if (!liveContainer || !liveContainer.isConnected) return false
    const el = resolveInteractionRegionElement(liveContainer, scope, region)
    if (!el) return false
    let offset = NaN
    try {
      offset = measureViewportRegionOffset(el, liveContainer)
    } catch {
      return false
    }
    if (!Number.isFinite(offset)) return false
    const target: RouteRef = { ...controller.displayedRoute }
    const fingerprint = captureLayoutFingerprint(liveContainer, scope)
    return controller.beginInteractionIntent(target, scope, region, offset, fingerprint ? { fingerprint } : undefined)
  } catch {
    return false
  }
}

/**
 * Shared structural click boundary: derive the structural scope plus the
 * interaction region from the event target's annotations and capture
 * synchronously before the mutation. Region keys are arbitrary stable layout
 * identities, never button names; scope prefers the message row and falls
 * back to the stable group wrapper (group-level controls such as fold
 * expand/compress live outside any single row). Non-region clicks (message
 * body, textarea focus, content selection) arm nothing. Fail-closed on any
 * helper error. Never prevents, stops, or rewrites the native control
 * action; never declares a scroll session.
 */
export const captureInteractionFromEvent = (
  controller: {
    beginInteractionIntent: (
      t: RouteRef,
      scope: { kind: 'message' | 'group'; id: string },
      region: string,
      off: number,
      opts?: { fingerprint?: { scopeH: number; scopeW: number } }
    ) => boolean
    displayedRoute: RouteRef
  },
  event: { target?: unknown } | null | undefined,
  container?: HTMLElement | null
): boolean => {
  try {
    if (!event || typeof event !== 'object') return false
    const target = (event as { target?: unknown }).target
    // Control buttons render lucide SVG icons: the click target is commonly
    // an SVGElement (`svg`/`path`), never an HTMLElement — accept any Element.
    if (!(target instanceof Element)) return false
    let regionEl: HTMLElement | null = null
    try {
      regionEl = target.closest?.('[data-interaction-region]') as HTMLElement | null
    } catch {
      regionEl = null
    }
    if (!regionEl) return false
    let region: string | null = null
    try {
      region = regionEl.getAttribute('data-interaction-region')
    } catch {
      region = null
    }
    if (typeof region !== 'string' || region.length === 0) return false
    let scope: { kind: 'message' | 'group'; id: string } | null = null
    try {
      const rowId =
        regionEl.getAttribute('data-message-id') ??
        target
          .closest?.('[data-message-id]:not([data-testid="answer-group-selector"])')
          ?.getAttribute('data-message-id') ??
        null
      if (typeof rowId === 'string' && rowId.length > 0) {
        scope = { kind: 'message', id: rowId }
      }
    } catch {
      scope = null
    }
    if (!scope) {
      try {
        const groupEl = target.closest?.('[data-stable-group-id]') as HTMLElement | null
        const groupId = groupEl?.getAttribute('data-stable-group-id') ?? null
        if (typeof groupId === 'string' && groupId.length > 0) {
          scope = { kind: 'group', id: groupId }
        }
      } catch {
        scope = null
      }
    }
    if (!scope) return false
    return captureInteractionIntent(controller, scope, region, container)
  } catch {
    return false
  }
}

/**
 * Capture a bounded route-local tab-switch intent BEFORE selection/layout
 * change. Compatibility entry over the shared interaction intent
 * (`answer-tab` region in the target answer's message scope, fingerprint of
 * the target row included); the same fail-closed ownership/provenance rules
 * apply. The clicked tab uses the shared visual-baseline helper with its
 * default TOP (no `end` declaration on the tab strip), distinct from the
 * follow/body-row TOP — same edge value, different region identity.
 */
export const captureAnswerTabSwitchIntent = (
  controller: {
    beginAnswerTabSwitch: (
      t: RouteRef,
      id: string,
      off: number,
      opts?: { fingerprint?: { scopeH: number; scopeW: number } }
    ) => boolean
    displayedRoute: RouteRef
  },
  tabMessageId: string,
  container?: HTMLElement | null
): boolean => {
  try {
    const liveContainer = container ?? document.getElementById('messages')
    if (!liveContainer || !liveContainer.isConnected) return false
    const tab = resolveAnswerTabElement(liveContainer, tabMessageId)
    if (!tab) return false
    let offset = NaN
    try {
      offset = measureViewportRegionOffset(tab, liveContainer)
    } catch {
      return false
    }
    if (!Number.isFinite(offset)) return false
    const target: RouteRef = { ...controller.displayedRoute }
    const fingerprint = captureLayoutFingerprint(liveContainer, { kind: 'message', id: tabMessageId })
    return controller.beginAnswerTabSwitch(target, tabMessageId, offset, fingerprint ? { fingerprint } : undefined)
  } catch {
    return false
  }
}

/**
 * Gesture identity returned by `markInteractionLayoutDeferred`: the armed
 * shared interaction gesture the caller must settle when its asynchronous
 * command resolves. Purely a handle — never geometry, never a snapshot.
 */
export type DeferredLayoutGestureToken = number

/**
 * Declaration entry for a gesture whose layout effect is ASYNCHRONOUS: the
 * command dispatched by the clicked control commits its rows only after an
 * authority round-trip, so the DOM is still unchanged while the command is in
 * flight. Identifies the already-armed shared gesture by scope + region (the
 * same structural keys the capture used) and flags it as deferred on the
 * shared owner, so the keeper keeps arbitration: the captured region stays the
 * hold baseline, an unchanged DOM is no longer mistaken for a no-effect click,
 * and the arriving rows are compensated into the same in-place hold. Only
 * flags an existing gesture — it never arms, re-measures, or invents one, so a
 * refused capture (e.g. true bottom, where the bottom pin owns geometry) stays
 * refused. Returns null when no gesture is armed for this scope + region.
 */
export const markInteractionLayoutDeferred = (
  controller:
    | {
        activeInteractionIntent: {
          scopeKind: 'message' | 'group'
          scopeId: string
          region: string
          gestureId: number
        } | null
        declareDeferredLayoutMutation: (gestureId: number) => boolean
      }
    | null
    | undefined,
  scope: { kind: 'message' | 'group'; id: string },
  region: string
): DeferredLayoutGestureToken | null => {
  try {
    if (!controller) return null
    const live = controller.activeInteractionIntent
    if (!live) return null
    if (live.scopeKind !== scope.kind || live.scopeId !== scope.id || live.region !== region) return null
    return controller.declareDeferredLayoutMutation(live.gestureId) ? live.gestureId : null
  } catch {
    return null
  }
}

/**
 * Settle a deferred-layout gesture when its asynchronous command resolves.
 * `applied`: the rows landed (or are landing), so the ordinary quiet-verified
 * handoff completes on the live gesture. `failed`: nothing will land, so the
 * gesture is dropped fail-closed with no adopt and no snapshot. Stale tokens
 * never touch a newer gesture.
 */
export const settleInteractionLayoutDeferred = (
  controller:
    | { settleDeferredLayoutMutation: (gestureId: number, outcome: 'applied' | 'failed') => boolean }
    | null
    | undefined,
  token: DeferredLayoutGestureToken | null,
  outcome: 'applied' | 'failed'
): boolean => {
  try {
    if (!controller || typeof token !== 'number' || !Number.isFinite(token)) return false
    return controller.settleDeferredLayoutMutation(token, outcome)
  } catch {
    return false
  }
}

/**
 * The message row the shared viewport currently holds and a bounded window
 * reconcile must therefore keep resident.
 *
 * Priority: the armed interaction intent's message scope (the row whose region
 * is being held stationary through a control mutation) first, then the live
 * reading anchor row (what the user is visually reading). Reading it is a
 * renderer-local projection read: it never declares ownership, never writes a
 * snapshot and never invents an anchor. At the true bottom neither exists (the
 * bottom pin owns geometry), so the derivation stays the plain latest window.
 */
export const resolveRetainedViewportMessageId = (
  controller:
    | {
        activeInteractionIntent: { scopeKind: 'message' | 'group'; scopeId: string } | null
        getAnchorFor: (target: RouteRef) => { kind: string; messageId?: string } | null
        displayedRoute: RouteRef
      }
    | null
    | undefined
): string | null => {
  try {
    if (!controller) return null
    const intent = controller.activeInteractionIntent
    if (intent && intent.scopeKind === 'message' && typeof intent.scopeId === 'string' && intent.scopeId.length > 0) {
      return intent.scopeId
    }
    const anchor = controller.getAnchorFor(controller.displayedRoute)
    if (anchor && anchor.kind === 'message' && typeof anchor.messageId === 'string' && anchor.messageId.length > 0) {
      return anchor.messageId
    }
    return null
  } catch {
    return null
  }
}

/**
 * Layout-hold baseline provenance: one row's `viewportOffset` + `scrollTop`
 * pair together with the route key and anchor identity it belongs to. A pair is
 * only ever usable for the identity it was measured on.
 */
interface LayoutHoldBaseline {
  routeKey: string
  anchorKey: string
  viewportOffset: number
  scrollTop: number
}

export function useStableVisualAnchor(containerRef: React.RefObject<HTMLElement | null>): StableVisualAnchorMaintainer {
  const viewport = useOptionalRouteViewport()
  const compensatingRef = useRef<{ expected: number } | null>(null)
  // Layout-space hold baseline for the live anchor row (route + anchor identity
  // provenance). The keeper's OWN observation is always a true pair (offset +
  // scrollTop read in one synchronous block), so it is the preferred baseline;
  // a refused/cold observation drops it and the next observation re-seeds.
  const layoutHoldRef = useRef<LayoutHoldBaseline | null>(null)
  // The pair dropped when the live anchor row's own geometry became unreadable
  // (row detached or hidden — a window rebuild in flight). The row usually
  // returns one frame later with the reflowed geometry, and the dropped pair
  // still describes the reading position while the container's OWN scroll
  // position has not moved: that position is the witness that no user input
  // happened in between, so it is what makes the pair usable again (fail-closed
  // as soon as it moved). Never used across an anchor identity change, and
  // cleared by the next concluded observation.
  const droppedLayoutHoldRef = useRef<LayoutHoldBaseline | null>(null)
  // Transactional pair published by the anchor owner at its measurement instant
  // (see `publishAnchorSample`). Used as a baseline only when the keeper has no
  // observation of its own for that route + row; never paired with a scroll
  // position read at a different time.
  const publishedSampleRef = useRef<LayoutHoldBaseline | null>(null)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const holdRef = useRef<(reason: string) => void>(() => {})
  // Bounded tab-switch quiet validation (single coalesced rAF, no polling).
  // While a tab-switch intent is armed the keeper compensates the clicked
  // tab offset on every observer trigger; the queued rAF re-proves the tab
  // still sits at its captured offset + currency, then clears the intent so
  // ordinary body anchoring resumes. No snapshot write here — the departure
  // freeze captures the converged tab-stable geometry. Invalid geometry,
  // route/epoch drift, user intent, or a missing tab drops the intent.
  const tabRafRef = useRef<number | null>(null)
  // Bounded quiet agreement plus effect evidence per pending interaction (no
  // timers, no polling loops): consecutive validation reads agreeing within
  // subpixel tolerance prove layout-quiet. The count only ever gates
  // DROPPING a genuinely no-effect action (never adopting): adoption
  // additionally requires proven effect — an observed scope-dimension change
  // versus the capture fingerprint, actual observed region displacement
  // before compensation, or a legitimate structural replacement under the
  // same scope + region key (or a legacy fingerprint-less arming, which
  // keeps the pre-existing assume-effect semantic) — plus a visible handoff
  // representative and currency throughout. Effect evidence is keyed to the
  // same gesture identity as the intent (epoch/route/scope/region/gesture):
  // a newer overwrite starts clean, and resets ride the intent clears, so
  // evidence never leaks across gestures or epochs.
  const interactionQuietRef = useRef<{
    gestureId: number
    offset: number
    scopeH: number
    scopeW: number
    quiet: number
    effect: boolean
    replaced: boolean
    node: Element | null
  } | null>(null)
  // Scheduler bridge for the capture-phase click boundary below (defined in
  // the layout effect; read at event time, never re-registered per version).
  const scheduleValidationRef = useRef<() => void>(() => {})
  const cancelTabValidationLocked = (): void => {
    try {
      const id = tabRafRef.current
      tabRafRef.current = null
      if (id !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
    } catch {}
  }
  useEffect(() => {
    return () => {
      cancelTabValidationLocked()
    }
    // Stable identity: pending lifetime is component-scoped, never versioned.
  }, [containerRef])

  // Real user interaction session (controller-owned token, component-scoped).
  // Genuine input opens/refreshes the session BEFORE its scroll effect lands;
  // only scrolls inside the live session may `userTakeover()` (Messages owns
  // the scroll). The session survives multi-scroll gestures (wheel momentum /
  // touch / scrollbar drag / native keyboard paging: each scroll updates the
  // stable snapshot) and closes ONLY on native `scrollend`, on a no-scroll
  // pointer/touch end (event-driven fallback when `scrollend` never fires),
  // or forcibly on the next programmatic `request()`/supersede and
  // `invalidateAll()`. Keyboard has no keyup idle fallback: native PageUp/
  // PageDown paging is asynchronous (the scroll lands after keyup), so the
  // declaration stays pending for the forthcoming `scrollend` like wheel. No
  // timers, no fences, no global bus. Never terminates/releases the transition.
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
    // Shared input adapter (single owner of the capture-phase declaration):
    // genuine input opens/refreshes the controller's user-interaction session.
    // ONLY the session-open transition (idle → live) is an observable state
    // change for the projection: it is the one declaration that publishes a
    // viewport notification. A repeat inside the same live session refreshes
    // counters the rendered projection does not read, so it publishes nothing —
    // otherwise every native key/wheel repeat re-rendered the whole mounted
    // conversation. The session itself is still opened/refreshed/superseding
    // exactly as before (no gate, no timer, no input interception).
    const declare = () => {
      const openedSession = declareUserIntentSession(controller)
      compensatingRef.current = null
      if (openedSession) notify()
    }
    // Layout-control press (resize handle): same-arbiter LAYOUTCONTROL, not
    // user-scroll — never opens/refreshes the genuine session and never
    // clears the pending shared hold. Wheels stay genuine (separate path).
    const declareForEvent = (e: Event | null | undefined): void => {
      try {
        const t = (e as { target?: unknown } | null | undefined)?.target ?? null
        if (isViewportLayoutControlTarget(t, container)) return
      } catch {
        // fail-closed to declare-only on helper errors
      }
      declare()
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
    const onTouchStartCapture = (e: Event): void => declareForEvent(e)
    const onPointerDownCapture = (e: Event): void => declareForEvent(e)
    container.addEventListener('touchstart', onTouchStartCapture, { capture: true, passive: true })
    container.addEventListener('pointerdown', onPointerDownCapture, { capture: true, passive: true })
    // Shared structural interaction boundary (capture-phase, before the
    // mutation): derive the structural scope + interaction region from
    // annotations and arm the shared intent synchronously, then queue one
    // quiet validation so a genuinely no-effect action is dropped promptly
    // instead of lingering. Runs after the streaming pause's pointerdown
    // handoff (pause first, region second) and before React's click
    // mutation. Never prevents/stops input, never declares a scroll
    // session, never writes snapshots — arming only.
    const onClickCapture = (e: MouseEvent) => {
      try {
        if (captureInteractionFromEvent(controller, e, container)) {
          try {
            scheduleValidationRef.current()
          } catch {}
        }
      } catch {}
    }
    container.addEventListener('click', onClickCapture, { capture: true })
    const onKey = (e: KeyboardEvent) => {
      const keys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])
      if (!keys.has(e.key)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toUpperCase() ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
      // Layout-resize keys on the trusted handle are layout, not scroll.
      try {
        if (isViewportLayoutResizeKey(e.key) && isViewportLayoutControlTarget(e.target, container)) return
      } catch {
        // fail-closed to declare-only on helper errors
      }
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
    // pointer/touch ends close ONLY idle sessions (no scroll landed yet).
    // Sessions with adopted scrolls stay open for `scrollend`; the next
    // programmatic `request()`/supersede or `invalidateAll()` force-closes.
    // Wheel and keyboard only refresh (never close here): wheel momentum and
    // native keyboard paging need the session past keyup until `scrollend`.
    const onPointerUp: EventListener = () => cancelWhenIdle()
    const onTouchEnd: EventListener = () => cancelWhenIdle()
    addTyped(container, 'pointerup', onPointerUp, { passive: true } as AddEventListenerOptions)
    addTyped(container, 'pointercancel', onPointerUp, { passive: true } as AddEventListenerOptions)
    addTyped(container, 'touchend', onTouchEnd, { passive: true } as AddEventListenerOptions)
    addTyped(container, 'touchcancel', onTouchEnd, { passive: true } as AddEventListenerOptions)
    return () => {
      container.removeEventListener('wheel', declare, { capture: true } as AddEventListenerOptions)
      container.removeEventListener('touchstart', onTouchStartCapture, { capture: true } as AddEventListenerOptions)
      container.removeEventListener('pointerdown', onPointerDownCapture, { capture: true } as AddEventListenerOptions)
      container.removeEventListener('click', onClickCapture, { capture: true } as AddEventListenerOptions)
      container.removeEventListener('keydown', onKey, { capture: true } as AddEventListenerOptions)
      removeTyped(container, 'scrollend', onScrollEnd)
      removeTyped(container, 'pointerup', onPointerUp)
      removeTyped(container, 'pointercancel', onPointerUp)
      removeTyped(container, 'touchend', onTouchEnd)
      removeTyped(container, 'touchcancel', onTouchEnd)
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
      // Geometry-only quantum sync on the live wrapper (existing node, no
      // anchor/snapshot/generation touch). Write-only on change so the RO
      // never loops. Runs even when the node identity is unchanged so a DPR
      // change without DOM replacement still converges via the existing
      // RO/layout fires; no new matchMedia/window listeners or React state.
      try {
        const live = container.firstElementChild
        if (live instanceof Element) syncMessagesPixelQuantum(live)
      } catch {}
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
      // The previous wrapper keeps its inline quantum (logically the same
      // wrapper retains the live coordinate; a detached node discards its
      // local geometry on unmount, so no leak and no per-teardown removal
      // that would flash transient layout on the next stream generation).
      observedContent = content
      if (observedContent) {
        try {
          ro?.observe(observedContent)
        } catch {}
      }
    }
    // Bounded shared-interaction validation: the pending interaction stays
    // valid through its mutation (async DB-first tab selection, editor
    // replacement, fold expand/compress) and settles ONLY after an observed
    // layout change versus the capture fingerprint plus a visible handoff
    // representative plus layout-quiet, with the clicked region back at its
    // captured offset. Drift re-arms via hold(); a still-hidden handoff
    // target (selection not yet committed) re-arms as pending without
    // clearing so an unrelated layout/observer before the commit can never
    // end the intent. On completion the keeper hands off to the current
    // post-mutation visible geometry via the existing same-route
    // programmatic adopt + snapshot write (measured representative offset +
    // scrollTop, never the old hidden body anchor and never intermediate
    // geometry); a genuinely no-effect action drops with no adopt and no
    // write. Then ordinary anchoring resumes. Currency loss drops the
    // intent; all clears are gesture-guarded so a stale frame never clears a
    // newer gesture.
    const runTabValidation = (): void => {
      tabRafRef.current = null
      const liveContainer = containerRef.current
      if (!liveContainer || !liveContainer.isConnected) return
      const vpNow = viewportRef.current
      if (!vpNow) return
      const ctrl = vpNow.controller
      // Unified interaction validation: EVERY region (answer tabs, message
      // controls, fold controls, …) completes through the same single-owner
      // gate — an observed layout change versus the capture fingerprint,
      // plus a visible handoff representative, plus layout-quiet, plus
      // currency throughout. Intermediate frames never commit; a genuinely
      // no-effect action is dropped WITHOUT adopting (no snapshot write,
      // never a false success). A target that is still hidden (async tab
      // selection mid IPC round-trip, uncommitted render) re-arms as
      // pending — bounded by the fail-closed correspondence deadline, never
      // forever. Fingerprint-less intents (legacy/test-armed) keep the
      // assume-effect semantic.
      try {
        const intent = ctrl.activeInteractionIntent as {
          topicId: string
          route: string | null
          epoch: number
          scopeKind: 'message' | 'group'
          scopeId: string
          region: string
          offset: number
          gestureId: number
          fingerprint?: { scopeH: number; scopeW: number }
          capturedAt: number
          pendingLayoutMutation?: boolean
        } | null
        if (!intent) return
        const clearGuarded = (): void => {
          try {
            ctrl.clearInteractionIntent(intent.epoch, intent.scopeId, intent.gestureId, intent.region)
          } catch {}
          try {
            if (interactionQuietRef.current?.gestureId === intent.gestureId) interactionQuietRef.current = null
          } catch {}
        }
        try {
          if (ctrl.programmaticOwned || ctrl.hasActiveUserInteraction()) {
            clearGuarded()
            return
          }
        } catch {
          clearGuarded()
          return
        }
        try {
          if (!ctrl.isDomProvenanceClean || ctrl.currentEpoch !== intent.epoch) {
            clearGuarded()
            return
          }
          const cur = ctrl.displayedRoute
          if (cur.topicId !== intent.topicId || cur.route !== intent.route) {
            clearGuarded()
            return
          }
        } catch {
          return
        }
        const scope = { kind: intent.scopeKind, id: intent.scopeId }
        const scopeEl = resolveInteractionScopeElement(liveContainer, scope)
        if (!scopeEl) {
          // Scope gone with no valid correspondence: fail closed.
          clearGuarded()
          return
        }
        let regionEl: HTMLElement | null = null
        try {
          regionEl = resolveInteractionRegionElement(liveContainer, scope, intent.region)
        } catch {
          regionEl = null
        }
        if (!regionEl) {
          clearGuarded()
          return
        }
        let containerTop = NaN
        try {
          containerTop = liveContainer.getBoundingClientRect().top
        } catch {
          containerTop = NaN
        }
        let current = NaN
        try {
          current = measureViewportRegionOffset(regionEl, liveContainer)
        } catch {
          clearGuarded()
          return
        }
        if (!Number.isFinite(current) || !Number.isFinite(containerTop)) {
          clearGuarded()
          return
        }
        let scopeH = NaN
        let scopeW = NaN
        try {
          const rect = scopeEl.getBoundingClientRect()
          scopeH = rect.height
          scopeW = rect.width
        } catch {
          scopeH = NaN
          scopeW = NaN
        }
        // A hidden region is never measurable stable geometry: hold nothing
        // yet, re-arm as pending — bounded by the fail-closed correspondence
        // deadline, so a dead target can never trap the hold. The tab strip
        // itself stays visible across selection swaps, so async tab drift
        // still compensates below while its hidden target pends.
        // Pending helper for an unlanded mutation: re-arm, fail-closed past
        // the correspondence deadline (a dead target never traps the hold,
        // and nothing is ever adopted from an unproven target).
        const rearmPending = (): void => {
          let expired = false
          try {
            expired =
              typeof intent.capturedAt === 'number' &&
              intent.capturedAt > 0 &&
              Date.now() - intent.capturedAt > INTERACTION_PENDING_DEADLINE_MS
          } catch {
            expired = false
          }
          if (expired) {
            clearGuarded()
            return
          }
          try {
            scheduleTabValidation()
          } catch {}
        }
        try {
          if (isKeeperAnchorRowHidden(regionEl, liveContainer)) {
            rearmPending()
            return
          }
        } catch {
          clearGuarded()
          return
        }
        // Observed layout change versus the capture fingerprint (scope-owner
        // dimensions only — never scroll metrics, which compensation writes
        // and passive stream growth move).
        const fp = intent.fingerprint
        const hasFingerprint =
          !!fp &&
          Number.isFinite(fp.scopeH) &&
          Number.isFinite(fp.scopeW) &&
          Number.isFinite(scopeH) &&
          Number.isFinite(scopeW)
        const layoutChanged =
          !hasFingerprint ||
          (fp !== undefined && (Math.abs(scopeH - fp.scopeH) > 1 || Math.abs(scopeW - fp.scopeW) > 1))
        // Height-only gate for the below-row handoff: a width-only reflow
        // leaves the row TOP stationary, so the scope keeps its own row.
        // Width stays only generic structural/convergence evidence above.
        const heightChanged = !hasFingerprint || (fp !== undefined && Math.abs(scopeH - fp.scopeH) > 1)
        // Consecutive-agreement quiet proof (subpixel reads) plus same-gesture
        // effect evidence. The count only ever gates DROPPING a no-effect
        // action; adoption additionally needs proven effect (layoutChanged,
        // observed displacement, or structural replacement below — or the
        // legacy assume-effect) plus the gates below — stillness alone never
        // certifies success. Displacement is the region's own measured offset
        // versus its captured offset BEFORE this frame's compensation:
        // keeper-induced scroll is never counted as a layout effect.
        // Replacement is a different connected node under the same scope +
        // region key (editor swap, expanded layout); the resolver already
        // guarantees scope/key/connected/contained, so only identity is
        // compared here. Both latch only for the live gesture — a newer
        // overwrite starts clean and every intent clear resets the record.
        let quiet = 0
        let effect = false
        let replaced = false
        try {
          const tracked = interactionQuietRef.current
          const same = tracked && tracked.gestureId === intent.gestureId ? tracked : null
          if (same && same.effect === true) effect = true
          if (same && (same as { replaced?: unknown }).replaced === true) replaced = true
          let agrees = false
          try {
            agrees =
              same !== null &&
              Number.isFinite(current) &&
              Number.isFinite(same.offset) &&
              Math.abs(current - same.offset) <= 0.5 &&
              Number.isFinite(scopeH) &&
              Number.isFinite(scopeW) &&
              Number.isFinite(same.scopeH) &&
              Number.isFinite(same.scopeW) &&
              Math.abs(scopeH - same.scopeH) <= 0.5 &&
              Math.abs(scopeW - same.scopeW) <= 0.5
          } catch {
            agrees = false
          }
          quiet = agrees && same !== null ? same.quiet + 1 : 0
          try {
            if (Math.abs(current - intent.offset) > 1) effect = true
          } catch {
            // keep prior evidence on measure errors
          }
          try {
            const priorNode = same !== null ? same.node : null
            if (priorNode && priorNode !== regionEl) {
              effect = true
              replaced = true
            }
          } catch {
            // keep prior evidence on compare errors
          }
          interactionQuietRef.current = {
            gestureId: intent.gestureId,
            offset: current,
            scopeH,
            scopeW,
            quiet,
            effect,
            replaced,
            node: regionEl
          }
        } catch {
          quiet = 0
          effect = false
          replaced = false
        }
        // Stillness is evidence only for gestures whose effect is already
        // decided: a gesture whose layout mutation is produced by an
        // asynchronous authority round-trip (declared by its dispatching call
        // site) has an unchanged DOM precisely BECAUSE the mutation has not
        // landed. Dropping it here would strand the pre-click geometry and let
        // the arriving rows displace the clicked region. It therefore stays
        // armed through the existing pending path — the same bounded
        // correspondence deadline a hidden/unlanded target already uses — and
        // ordinary completion resumes once the layout change is observed.
        const deferredUnsettled = intent.pendingLayoutMutation === true
        const pendingOrDrop = (): void => {
          if (deferredUnsettled) {
            rearmPending()
            return
          }
          if (quiet >= INTERACTION_QUIET_READS_FOR_DROP) {
            clearGuarded()
            return
          }
          try {
            scheduleTabValidation()
          } catch {}
        }
        const proven = layoutChanged || effect || !hasFingerprint
        // Structural proof for rebasing away from the live reading row:
        // scope-owner dimension change or a replaced region node under the
        // same scope + region key (editor swap, expanded layout). Passive
        // stream displacement of a static row (no dims, same node) never
        // proves a click effect — it must not rebase a pause/reading anchor
        // to another row. Same-row holds keep the displacement-inclusive
        // `proven` above (F1 same-size reflow still hands off to its own
        // row); cross-row rebases require structural proof below.
        const structuralProven = layoutChanged || replaced || !hasFingerprint
        let liveAnchorId: string | null = null
        try {
          const live = ctrl.getAnchorFor({ topicId: intent.topicId, route: intent.route })
          if (live && live.kind === 'message' && typeof live.messageId === 'string') {
            liveAnchorId = live.messageId
          }
        } catch {
          liveAnchorId = null
        }
        // Handoff representative (structural correspondence under the same
        // semantic key): tabs hand off to the target answer, stable message
        // scopes to their own row, group scopes to the first visible row in
        // the group. A message-controls scope whose owner changed height
        // (edit growth/shrink) never hands off to its own moving TOP: it
        // takes the first visible row below, else pending, so later steps
        // keep holding the same bottom baseline. A hidden target means the mutation has not landed yet
        // (async selection, uncommitted render) — drift below still
        // compensates so churn during the gap never moves the region, but
        // nothing completes until the target resolves.
        let rep: { id: string; offset: number } | null = null
        try {
          const avoidScopeRow =
            intent.region === INTERACTION_REGION_CONTROLS && intent.scopeKind === 'message' && heightChanged === true
          rep = resolveInteractionRepresentative(liveContainer, scope, intent.region, { avoidScopeRow })
        } catch {
          rep = null
        }
        const drift = current - intent.offset
        // Cross-row rebase guard: when the handoff representative names a
        // different reading row than the live pause/reading anchor, passive
        // displacement alone (static scope dims, same region node, e.g. stream
        // growth pushing an unrelated footer) must never rebase the anchor.
        // Same-row holds keep the displacement-inclusive `proven` (F1
        // same-size reflow still hands off to its own row); cross-row rebases
        // require structural proof (scope dims or replaced node) or legacy
        // fingerprint-less assume-effect.
        const crossRow =
          rep !== null && liveAnchorId !== null && rep.id !== liveAnchorId
            ? true
            : rep !== null && liveAnchorId === null
              ? true
              : false
        const provenForHandoff = crossRow ? structuralProven : proven
        if (Math.abs(drift) > 1) {
          // Honest boundary clamp: at the true scroll limit the region
          // cannot be held further. Early-fit short viewports sit at this
          // limit (scrollTop 0, no overflow), so passive stream growth
          // displacing a static footer would previously fall through and
          // hand off with a vicinity-follow clear — undoing the pointerdown
          // pause. Require structural proof + quiet here too: passive
          // displacement alone re-arms (preserving the ORIGINAL pause
          // anchor) until sustained stillness drops it with no adopt and no
          // snapshot. A hidden target still pends (no provable geometry).
          let atLimit = false
          try {
            const st = liveContainer.scrollTop
            const sh = liveContainer.scrollHeight
            const ch = liveContainer.clientHeight
            const extreme = -(sh - ch)
            atLimit = st >= -1 || st <= extreme + 1
          } catch {
            atLimit = false
          }
          if (!atLimit) {
            try {
              holdRef.current('interaction-validate')
            } catch {}
            try {
              scheduleTabValidation()
            } catch {}
            return
          }
          if (!rep) {
            // Valid-baseline retain at the honest clamp (no below row, region
            // still connected/finite/visible with valid currency): stay armed
            // with NO polling — later layout retries via the event path.
            // Without structural proof, sustained stillness drops with no
            // adopt instead (same as the below-row path underneath).
            if (!structuralProven) {
              pendingOrDrop()
              return
            }
            return
          }
          if (!structuralProven) {
            pendingOrDrop()
            return
          }
          if (hasFingerprint && quiet < INTERACTION_QUIET_READS_FOR_ADOPT) {
            try {
              scheduleTabValidation()
            } catch {}
            return
          }
        } else if (!rep) {
          // Valid-baseline retain (bottommost, no visible row below): the
          // region baseline is still connected, finite, visible and
          // currency-valid, so it never expires on wall time — stay armed
          // and STOP validation polling (no infinite pending rAF). Future
          // layout events re-drive through the keeper hold path, which
          // compensates drift and schedules one validation only when an
          // update/adopt may be due; a later-appearing below row then hands
          // off through the original quiet-verified path. Only a genuinely
          // no-effect gesture (sustained stillness, no proven effect) drops
          // here with no adopt and no snapshot. Lost/hidden/disconnected
          // structural correspondence never reaches here (pending with the
          // correspondence deadline above).
          if (!provenForHandoff) {
            pendingOrDrop()
            return
          }
          return
        } else if (!provenForHandoff) {
          // No proven effect of this gesture with its handoff target
          // visible (scope dims unchanged, no observed displacement, no
          // structural replacement; cross-row additionally excludes passive
          // displacement): after sustained provable stillness drop
          // it WITHOUT adopting, so an accompanied pause or reading anchor
          // is never rebased and no stale snapshot is written. A hidden
          // target never reaches here (pending above), so a deliberately
          // delayed async mutation is never mistaken for a no-effect click.
          pendingOrDrop()
          return
        } else if (hasFingerprint && quiet < INTERACTION_QUIET_READS_FOR_ADOPT) {
          // Effect observed but not yet provably quiet: one more frame.
          try {
            scheduleTabValidation()
          } catch {}
          return
        }
        let st = NaN
        try {
          st = liveContainer.scrollTop
        } catch {
          st = NaN
        }
        if (!Number.isFinite(st)) {
          try {
            scheduleTabValidation()
          } catch {}
          return
        }
        let adopted: unknown = null
        try {
          // Interaction handoff never follows on vicinity: the row is kept
          // even when truthfully at the bottom (short content, physical
          // bottom). Only true scroll to the exact bottom or explicit
          // send/bottom resumes follow — never a control press.
          adopted = (
            ctrl as unknown as Pick<RouteViewportController, 'adoptInteractionViewport'>
          ).adoptInteractionViewport(
            { topicId: intent.topicId, route: intent.route },
            {
              messageId: rep.id,
              intraRowOffset: rep.offset,
              scrollTop: st,
              isAtBottom: isAtBottom(st, COLUMN_REVERSE_BOTTOM_THRESHOLD_PX)
            },
            { expectedEpoch: intent.epoch }
          )
        } catch {
          adopted = null
        }
        if (adopted && typeof adopted === 'object' && (adopted as { taken: unknown }).taken === true) {
          const taken = adopted as {
            taken: true
            routeKey: string
            snapshot: {
              scrollTop: number
              messageId: string | null
              intraRowOffset: number | null
              isAtBottom: boolean
            }
          }
          // Adopt succeeded synchronously for the live-validated gesture
          // above (validation always acts on the CURRENT live intent, and
          // adopt is epoch-guarded, so a stale frame can never reach here
          // for an older gesture). Adopt itself cleared the intent; persist
          // the handoff snapshot for this same gesture and notify.
          try {
            writeRouteSnapshot(taken.routeKey, {
              scrollTop: taken.snapshot.scrollTop,
              messageId: taken.snapshot.messageId,
              intraRowOffset: taken.snapshot.intraRowOffset,
              isAtBottom: taken.snapshot.isAtBottom
            })
          } catch {}
          try {
            vpNow.notifyChanged()
          } catch {}
          return
        }
        // Adopt rejected on currency (route/epoch drift handled above) or on
        // a transient phase: re-arm once more when still current, otherwise
        // drop the stale gesture only.
        try {
          const live = ctrl.activeInteractionIntent
          if (
            live &&
            live.epoch === intent.epoch &&
            live.scopeId === intent.scopeId &&
            live.gestureId === intent.gestureId &&
            live.region === intent.region
          ) {
            try {
              scheduleTabValidation()
            } catch {}
            return
          }
        } catch {}
        clearGuarded()
      } catch {
        // Fail-closed: helper errors never adopt and never disturb a newer
        // gesture.
      }
    }
    const scheduleTabValidation = (): void => {
      cancelTabValidationLocked()
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
        tabRafRef.current = schedule(() => {
          runTabValidation()
        })
      } catch {
        tabRafRef.current = null
      }
    }
    // Bridge the capture-phase click boundary (registered in the listener
    // effect above, outside this closure): after a successful arm it queues
    // one quiet validation so genuinely no-effect actions drop promptly.
    // Same single scheduler — never a second rAF site.
    try {
      scheduleValidationRef.current = scheduleTabValidation
    } catch {}
    // A baseline dropped because the live anchor row's geometry itself became
    // unreadable (row absent/hidden) is REMEMBERED rather than forgotten: the
    // row usually returns one frame later with the reflowed geometry, and the
    // dropped pair still describes the reading position as long as the
    // container's own scroll position is unchanged (see
    // `droppedLayoutHoldRef`). Every other refusal (phase, programmatic
    // ownership, foreign provenance, intent-owned frame) drops it for good.
    const rememberUnreadableHold = (): void => {
      if (layoutHoldRef.current !== null) droppedLayoutHoldRef.current = layoutHoldRef.current
      layoutHoldRef.current = null
    }
    const hold = (reason: string): void => {
      void reason
      // Geometry-only quantum sync BEFORE every guard: a DPR change inside
      // owned/user/unaligned positioning still sets geometry before first
      // paint/reveal, and readonly layout checks below stay correct. No
      // anchor/snapshot/generation touch; write-only on change so no RO loop.
      try {
        const live = container.firstElementChild
        if (live instanceof Element) syncMessagesPixelQuantum(live)
      } catch {}
      const vp = viewportRef.current
      if (!vp) {
        layoutHoldRef.current = null
        return
      }
      const phase = vp.controller.currentPhase
      if (phase !== 'stable' && phase !== 'aligned') {
        layoutHoldRef.current = null
        return
      }
      if (vp.controller.programmaticOwned) {
        layoutHoldRef.current = null
        return
      }
      // A live user gesture no longer vetoes the anchor hold. The hold below
      // measures the row's LAYOUT displacement (content growth) with the
      // container's own scrolling removed (`resolveLayoutHold`), so it can never
      // cancel the user's movement — the only reason the previous gate refused
      // every non-armed observation. Continuous paging across fetch flight and
      // any later row growth during the same browse session therefore hold on
      // the one live anchor, at any observer trigger (layout commit, RO, MO,
      // scroll), instead of a single generation-bound hold followed by vetoes.
      // The pagination commit's arm is left to the controller (it publishes the
      // precommit reading identity as the live anchor); the keeper no longer
      // needs a per-generation permission to hold it.
      if (!vp.controller.isDomProvenanceClean) {
        layoutHoldRef.current = null
        return
      }
      // Shared interaction hold: a pending interaction intent (answer tab,
      // message controls, fold controls, …) owns same-route geometry. Hold
      // the captured region at its declared visual baseline — re-resolved by
      // structural scope + region key so replacement elements (editor action
      // bar, expanded layout) are held, not the stale node — at its captured
      // baseline viewport offset; the competing body-anchor hold must not
      // fight it. Default TOP keeps model-label/FOLD holds unchanged; the
      // message-controls `end` declaration holds the true change-domain lower
      // bound while the height delta rises into the upper space and content
      // below stays still. Converge via the quiet validation (observed layout
      // change + visible representative + quiet), then ordinary anchoring
      // resumes. Disappearance without a legitimate mapping holds nothing
      // (fail-closed, no sibling transfer).
      try {
        const pending = vp.controller.activeInteractionIntent as {
          topicId: string
          route: string | null
          epoch: number
          scopeKind: 'message' | 'group'
          scopeId: string
          region: string
          offset: number
          gestureId: number
        } | null
        if (pending) {
          const clearHoldGuarded = (): void => {
            try {
              vp.controller.clearInteractionIntent(pending.epoch, pending.scopeId, pending.gestureId, pending.region)
            } catch {}
          }
          const curDisplayed = vp.controller.displayedRoute
          if (
            curDisplayed.topicId !== pending.topicId ||
            curDisplayed.route !== pending.route ||
            vp.controller.currentEpoch !== pending.epoch
          ) {
            clearHoldGuarded()
          } else {
            const regionEl = resolveInteractionRegionElement(
              container,
              { kind: pending.scopeKind, id: pending.scopeId },
              pending.region
            )
            if (!regionEl) {
              clearHoldGuarded()
            } else {
              let regionCurrent = NaN
              try {
                regionCurrent = measureViewportRegionOffset(regionEl, container)
              } catch {
                regionCurrent = NaN
              }
              if (!Number.isFinite(regionCurrent)) {
                clearHoldGuarded()
              } else {
                const regionDelta = regionCurrent - pending.offset
                if (Math.abs(regionDelta) > 1) {
                  // Effect evidence for the same gesture: the region really
                  // displaced before this compensation (a same-size
                  // intra-scope reflow may leave scope dims unchanged, so the
                  // fingerprint alone cannot prove it). Latched here because
                  // the hold can compensate before any validation frame
                  // observes the displacement — without this, the later
                  // stillness would be mistaken for a no-effect click and
                  // the handoff missed. Keyed to the live gesture only; a
                  // newer overwrite starts clean.
                  try {
                    const tracked = interactionQuietRef.current
                    if (!tracked || tracked.gestureId !== pending.gestureId) {
                      interactionQuietRef.current = {
                        gestureId: pending.gestureId,
                        offset: NaN,
                        scopeH: NaN,
                        scopeW: NaN,
                        quiet: 0,
                        effect: true,
                        replaced: false,
                        node: regionEl
                      }
                    } else {
                      const wasReplaced =
                        (tracked as { replaced?: unknown }).replaced === true ||
                        (tracked.node !== null && tracked.node !== regionEl)
                      interactionQuietRef.current = {
                        ...tracked,
                        effect: true,
                        replaced: wasReplaced,
                        node: regionEl
                      }
                    }
                  } catch {
                    // compensation below still holds the frame
                  }
                  try {
                    container.scrollTop += regionDelta
                    compensatingRef.current = { expected: container.scrollTop }
                  } catch {}
                }
                try {
                  scheduleTabValidation()
                } catch {}
                // The region hold owns this frame's geometry: the next ordinary
                // observation re-seeds the layout baseline from the live anchor.
                // Every competing baseline is dropped with it — a pair measured
                // BEFORE this compensation describes the pre-compensation scroll
                // position, so adopting it would charge the region hold's own
                // scroll write to layout and immediately undo the compensation
                // (the ordinary hold would fight the region hold forever).
                layoutHoldRef.current = null
                publishedSampleRef.current = null
                droppedLayoutHoldRef.current = null
                return
              }
            }
          }
        }
      } catch {
        // Fail-closed to the ordinary hold below on helper errors.
      }
      // Provenance-guarded hold: the keeper may hold only the displayed
      // route's own anchor. A foreign live anchor (provenance != displayed)
      // is inert here — never compensated as if it belonged to this route.
      // Bottom semantic (no row anchor): pin the column-reverse bottom
      // (scrollTop 0) through layout/insertion so true bottom survives new
      // user/assistant rows and stream growth. Gated above on unowned +
      // no live user session, so a subsequent genuine wheel scroll-away is
      // never fought here (its takeover owns the new anchor instead).
      const displayed = vp.controller.displayedRoute
      const anchor = vp.controller.getAnchorFor(displayed)
      if (!anchor) {
        // Bottom semantic: pin the column-reverse bottom through layout growth.
        // During a live gesture the pin only applies while the viewport is STILL
        // at the genuine bottom (a gesture that left the bottom published its own
        // row anchor/offset through its takeover); an absolute scrollTop write
        // must never pull a scrolling user back.
        layoutHoldRef.current = null
        if (vp.controller.hasActiveUserInteraction() && Math.abs(container.scrollTop) > 1) return
        try {
          if (Math.abs(container.scrollTop) > 1) {
            container.scrollTop = 0
            compensatingRef.current = { expected: container.scrollTop }
          }
        } catch {}
        return
      }
      const el = resolveRow(anchor)
      if (!el) {
        rememberUnreadableHold()
        return
      }
      // A hidden/collapsed row is never measurable stable geometry: hold
      // nothing (fail-closed). Same-route answer-tab switches are owned by
      // the tab-switch intent above — never by a body-anchor transfer to a
      // sibling row. A later genuine scroll or stable commit owns the new
      // snapshot; the departure freeze captures the converged tab-stable
      // geometry.
      try {
        if (isKeeperAnchorRowHidden(el, container)) {
          rememberUnreadableHold()
          return
        }
      } catch {
        rememberUnreadableHold()
        return
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
      let currentScrollTop = 0
      try {
        // ONE synchronous read: the row's viewport offset and the container's
        // own scroll position must describe the same instant, otherwise the
        // layout/scroll separation below mixes two frames.
        current = el.getBoundingClientRect().top - container.getBoundingClientRect().top
        currentScrollTop = container.scrollTop
      } catch {
        rememberUnreadableHold()
        return
      }
      const sample: LayoutHoldSample = { viewportOffset: current, scrollTop: currentScrollTop }
      // Layout-space hold: the keeper owns the LIVE anchor row's layout
      // displacement (content growth above/below it) and nothing else. Every
      // trigger is admissible — pagination commit, later RO/MO growth, scroll
      // echo — because the user's own scroll is subtracted out, so the hold can
      // never cancel the movement and needs no per-generation permission.
      const routeKey = displayedRouteKey(displayed)
      const anchorKey = anchor.kind === 'message' ? `message:${anchor.messageId}` : `divider:${anchor.dividerKey}`
      const base = layoutHoldRef.current
      const baseMatches = base !== null && base.routeKey === routeKey && base.anchorKey === anchorKey
      const published = publishedSampleRef.current
      const publishedMatches =
        published !== null && published.routeKey === routeKey && published.anchorKey === anchorKey
      const dropped = droppedLayoutHoldRef.current
      // A pair remembered from a frame whose row geometry was unreadable is
      // admissible only for the SAME route + row and only while the container's
      // own scroll position still matches the one it was measured with: that
      // unchanged position is the witness that no input moved the viewport in
      // between, so the offset difference is layout and nothing else.
      const droppedUsable =
        dropped !== null &&
        dropped.routeKey === routeKey &&
        dropped.anchorKey === anchorKey &&
        Math.abs(sample.scrollTop - dropped.scrollTop) <= LAYOUT_HOLD_TOLERANCE_PX
      // Baseline resolution — only TRUE pairs are admissible:
      // 1. the keeper's own last observation of this route + row (offset and
      //    scrollTop measured together, re-based by the write it authorized);
      // 2. else the pair the anchor owner published at its measurement instant;
      // 3. else the pair remembered from an unreadable-geometry frame while its
      //    scroll position witness still holds (see `droppedLayoutHoldRef`);
      // 4. else NOTHING is provable, so this observation holds nothing and only
      //    seeds the baseline. Pairing the published `anchor.offset` with a
      //    later `scrollTop` would charge every pixel the user scrolled in
      //    between to layout and write it back — a rewind of genuine input.
      const baseline: LayoutHoldSample | null = baseMatches
        ? { viewportOffset: base.viewportOffset, scrollTop: base.scrollTop }
        : publishedMatches
          ? { viewportOffset: published.viewportOffset, scrollTop: published.scrollTop }
          : droppedUsable
            ? { viewportOffset: dropped.viewportOffset, scrollTop: sample.scrollTop }
            : null
      const displacement = baseline === null ? null : resolveLayoutHold(baseline, sample)
      // The remembered pair is a one-shot recovery: this observation — held or
      // merely seeding — concludes it.
      droppedLayoutHoldRef.current = null
      if (displacement === null) {
        layoutHoldRef.current = { routeKey, anchorKey, ...sample }
        return
      }
      try {
        container.scrollTop += displacement
        compensatingRef.current = { expected: container.scrollTop }
      } catch {}
      // Ordinary layout hold converges here: no snapshot write, no pending
      // queue, no anchor/token/phase change. A hidden row above already returned
      // fail-closed; the tab-switch intent above owns switch geometry.
      layoutHoldRef.current = { routeKey, anchorKey, ...rebaseLayoutHold(sample, displacement) }
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
      // Intentionally no CSS-var removal: the wrapper logically retains its
      // live coordinate across effect re-subscriptions (same node, stream
      // windowGeneration churn), and a detached node's inline geometry dies
      // with the node. Removing then re-setting every teardown would flash
      // transient layout/jitter.
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
  // Transactional baseline source (see `ViewportAnchorSample`): validated, then
  // stored as-is. Invalid/empty samples are ignored so the keeper keeps its own
  // observation instead of adopting a fabricated pair.
  const publishAnchorSample = useCallback((sample: ViewportAnchorSample | null): void => {
    try {
      if (!sample) return
      if (typeof sample.messageId !== 'string' || sample.messageId.length === 0) return
      if (!Number.isFinite(sample.viewportOffset) || !Number.isFinite(sample.scrollTop)) return
      publishedSampleRef.current = {
        routeKey: routeViewportKey(sample.topicId, sample.route),
        anchorKey: `message:${sample.messageId}`,
        viewportOffset: sample.viewportOffset,
        scrollTop: sample.scrollTop
      }
    } catch {}
  }, [])
  return useMemo<StableVisualAnchorMaintainer>(
    () => ({ requestHold, publishAnchorSample }),
    [requestHold, publishAnchorSample]
  )
}

export type { RouteRef, RouteViewportSnapshot, RouteVisualAnchor }
export { writeRouteSnapshot }
