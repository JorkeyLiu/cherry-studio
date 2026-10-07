/**
 * Route viewport transition controller (single owner).
 *
 * This module is the ONLY owner of route-transition truth:
 * - transition epoch (monotonic; supersession invalidates every older session)
 * - intent (top / divider / generic, with target route + provenance)
 * - phase (fetch-hold / positioning / searching / aligned / stable / terminal)
 * - programmatic ownership (held during a transition, released exactly once)
 * - displayed-route provenance (which route the committed DOM belongs to)
 * - rendered provenance ({topicId, routeId, epoch, windowId}: which route
 *   window the DOM actually shows; null = unknown/dirty)
 * - DOM cleanliness (displayed == rendered) + clean/dirty terminal semantics
 * - active visual anchor (the row + offset that must stay visually still)
 *
 * Non-goals (deliberately outside this module):
 * - fetching windows, message lists, viewport projection (messageViewportReducer
 *   still owns projection/window; Redux still owns the SELECTED activeBranch).
 * - DOM measurement / scroll application (ports live in the React adapter).
 *
 * Supersession rule: every `request()` bumps the epoch. Any late completion
 * carrying an older epoch is inert — it may not commit, reveal, advance the
 * displayed route, or release the new session's ownership.
 *
 * Release rule: ownership is released exactly once per session, either on
 * `commitStable()` or on `terminate()`. `releaseSession(epoch)` is
 * idempotent and epoch-guarded: a stale `finally` can never touch the new
 * session.
 *
 * Snapshot rule (only two legal writers):
 * - displayed-stable real user scroll (identity + offset),
 * - controller completed programmatic positioning (identity + offset).
 * Transition-period scrolls and window reconciliations must never write.
 * See `isSnapshotWriteAllowed()`.
 */

export type RouteId = string | null

export type RouteViewportPhase = 'idle' | 'fetch-hold' | 'positioning' | 'searching' | 'aligned' | 'stable' | 'terminal'

export type RouteViewportIntentKind = 'top' | 'divider' | 'generic'

export type RouteViewportTerminalReason =
  | 'unplaced-fallback'
  | 'oldest-edge'
  | 'load-failed'
  | 'page-cap'
  | 'superseded'
  | 'unmounted'
  | 'missing-window'
  | 'user-intent'
  | 'invalidated'
  | 'fail-visible'

export interface RouteViewportSnapshot {
  scrollTop: number
  messageId: string | null
  intraRowOffset: number | null
  isAtBottom: boolean
}

export type RouteVisualAnchor =
  | { kind: 'message'; messageId: string; offset: number }
  | { kind: 'divider'; dividerKey: string; offset: number }

export interface RouteTransitionRequest {
  kind: RouteViewportIntentKind
  topicId: string
  targetRoute: RouteId
  /** Divider intent only: stable divider identity. Never read from target history. */
  dividerKey?: string
  /** Divider intent only: clicked row's screen offset to preserve. */
  clickOffset?: number | null
  /** Top intent only: target route's own stable snapshot (null = no history). */
  saved?: RouteViewportSnapshot | null
  /** Top intent only: saved snapshot proven invalid for this route (NOT_FOUND). */
  snapshotInvalid?: boolean
}

export interface RouteRef {
  topicId: string
  route: RouteId
}

/**
 * Rendered DOM provenance: which route window the committed DOM actually
 * shows, at which session epoch, under which window identity.
 * - `routeId` mirrors `RouteRef.route` naming for the rendered side.
 * - `windowId` is the Messages window identity
 *   (`oldest::newest::len` via `windowIdentityKey`, `init` for the initial
 *   mount, `legacy-<epoch>` for pre-provenance callers, never empty).
 * - `null` rendered = unknown/dirty (topic switch before rebase, failure
 *   clear, unmount): no snapshot/review/commit may proceed until an explicit
 *   rebase/target success restores clean.
 */
export interface RenderedProvenance {
  topicId: string
  routeId: RouteId
  epoch: number
  windowId: string
}

/** Pure provenance cleanliness: DOM belongs to the displayed route. */
export const isRenderedProvenanceClean = (displayed: RouteRef, rendered: RenderedProvenance | null): boolean => {
  if (!rendered) return false
  if (typeof rendered.windowId !== 'string' || rendered.windowId.length === 0) return false
  return rendered.topicId === displayed.topicId && rendered.routeId === displayed.route
}

export type FirstPositionOutcome = 'placed' | 'searching' | 'unplaced'

/** Snapshot write sources. Only two are ever legal (see module header). */
export type SnapshotWriteSource = 'user-scroll' | 'controller-commit' | 'transition-scroll' | 'window-reconcile'

/**
 * Pure allowlist: which snapshot write sources may persist under a phase.
 * - `user-scroll` only while stable/idle/terminal (real user viewport on the
 *   displayed route; the terminal fallback's visible viewport is real user
 *   state whose next genuine scroll becomes the new stable anchor).
 * - `controller-commit` is the explicit stable-completion commit (the caller
 *   gates it on session currency; the phase gate here is aligned/stable).
 * - `transition-scroll` / `window-reconcile` are never writers.
 */
export const isSnapshotWriteAllowed = (source: SnapshotWriteSource, phase: RouteViewportPhase): boolean => {
  if (source === 'transition-scroll' || source === 'window-reconcile') return false
  if (source === 'user-scroll') return phase === 'stable' || phase === 'idle' || phase === 'terminal'
  return phase === 'aligned' || phase === 'stable'
}

/** Canonical route scroll key (`topic-<id>::<branch|main>`). */
export const routeViewportKey = (topicId: string, route: RouteId): string => `topic-${topicId}::${route ?? 'main'}`

/**
 * Meaningful visible portion for a reconciled fold answer row (px).
 * Matches the E2E 12px anchor budget: avoids a 1px artifact that the
 * capture predicate (`visibleHeight > 0`) would still call visible but a
 * user cannot read. Deterministic existing convention, not a new threshold.
 */
export const FOLD_ANCHOR_MIN_VISIBLE_PX = 12

/**
 * Pure same-group fold offset normalization (tall→short shrink).
 *
 * The held intra-row offset is valid only when the replacement row can still
 * represent it as a visible reading position: `intra ∈ (-h + MIN, vh - MIN)`
 * where `h` is the replacement real-box height and `vh` the viewport height.
 * Feasible offsets preserve the EXACT original (no drift); infeasible offsets
 * clamp to the nearest valid visible in-row position (minimal local
 * adjustment, e.g. a far-above `-2235` on a `159.6px` short answer becomes
 * `-h + MIN`, the nearest surviving bottom segment). Non-finite or
 * non-positive geometry returns the original fail-closed (caller holds
 * nothing new).
 */
export const normalizeFoldAnchorOffset = (
  originalOffset: number,
  replacementHeight: number,
  viewportHeight: number
): number => {
  if (!Number.isFinite(originalOffset)) return originalOffset
  if (!Number.isFinite(replacementHeight) || replacementHeight <= 0) return originalOffset
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return originalOffset
  const lower = -replacementHeight + FOLD_ANCHOR_MIN_VISIBLE_PX
  const upper = viewportHeight - FOLD_ANCHOR_MIN_VISIBLE_PX
  if (originalOffset < lower) return lower
  if (originalOffset > upper) return upper
  return originalOffset
}

export interface RouteViewportIntent {
  kind: RouteViewportIntentKind
  topicId: string
  targetRoute: RouteId
}

export interface StableCommit {
  routeKey: string
  snapshot: RouteViewportSnapshot
}

/**
 * Controller-owned real user interaction token (generation/id + liveness).
 * Opened/refreshed ONLY by genuine wheel/touch/pointer/keyboard/scrollbar
 * input via `declareUserIntent()`; closed by native `scrollend`, by an
 * event-driven no-scroll pointer/touch end, or forcibly by the next
 * programmatic `request()`/supersede and by `invalidateAll()`.
 * Never a boolean guess: `userTakeover()` requires a live session and
 * rejects stale tokens.
 */
export interface UserInteractionToken {
  interactionId: number
  epoch: number
}

export type UserInteractionTokenLike = number | UserInteractionToken

const isFiniteOffset = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Single route viewport transition controller.
 *
 * One instance per conversation surface (provided via React context at the
 * nearest common ancestor of the top selector and the message list).
 * Never a module-level singleton: HMR/unmount calls `invalidateAll()`.
 */
export class RouteViewportController {
  private epoch = 0
  private phase: RouteViewportPhase = 'idle'
  private intent: RouteViewportIntent | null = null
  private displayed: RouteRef
  private rendered: RenderedProvenance | null
  private anchor: RouteVisualAnchor | null = null
  /**
   * Route provenance of the active visual anchor: which topic+route the
   * anchor was produced for. Null exactly when `anchor` is null (no anchor)
   * or when provenance was cleared (invalidate). Every anchor write sets
   * both fields together via `setAnchorLocked`; every external read of an
   * anchor for a specific target must go through `getAnchorFor()` which
   * returns the anchor only when provenance matches the requested route.
   */
  private anchorRoute: RouteRef | null = null
  /** Ownership held while a transition session is active. */
  private ownershipHeld = false
  /** Epoch whose ownership was already released (exactly-once guard). */
  private releasedEpoch = -1
  private releases = 0
  private terminalReason: RouteViewportTerminalReason | null = null
  /**
   * Real user interaction session (controller-owned, component-scoped token).
   * - `activeInteractionId === null` = no live user gesture: programmatic /
   *   window-reconcile scrolls must never write a snapshot.
   * - Non-null = a genuine input gesture opened/refreshed the session; every
   *   scroll inside it may `userTakeover()` (multi-scroll gestures: wheel
   *   momentum, touch, scrollbar drag). The session survives each takeover —
   *   it closes ONLY on native `scrollend`, on a no-scroll pointer/touch
   *   end, or forcibly on `request()`/supersede and `invalidateAll()`.
   * - `activeInteractionScrolls` counts adopted scrolls in this session (used
   *   by the event-driven fallback: pointer/touch ends close only when no
   *   scroll has landed yet; momentum scrolls stay open for `scrollend`).
   */
  private interactionSeq = 0
  private activeInteractionId: number | null = null
  private activeInteractionScrolls = 0
  /**
   * Monotonic declare generation (controller-owned source of truth).
   * Bumped on EVERY genuine `declareUserIntent()` — including refreshes that
   * reuse the same interaction id for multi-scroll gestures. A new real wheel
   * while a session is live therefore advances the generation even though the
   * id stays identical; id-only comparisons would miss it. `null` exactly
   * when no live session exists.
   */
  private interactionDeclareSeq = 0
  private activeInteractionGeneration: number | null = null
  /**
   * Explicit attach/detach activation requirement (Activity hidden boundary).
   * `detach()` cancels the short-lived transaction (via `invalidateAll`) and
   * arms this flag; the next `request()` consumes it. While armed,
   * `rebaseClean()` refuses — a detached-dirty viewport must reactivate
   * through a guarded own-target restore request BEFORE any geometry can be
   * admitted as stable, never via an incidental projection rebase that would
   * mark fake clean and let the next freeze capture wrong geometry.
   * Topic-switch dirty (via `syncDisplayed`, no flag) still rebases; only the
   * detached lifetime blocks. Never a second truth: epoch/intent/phase/
   * ownership/displayed/anchor all stay in this controller.
   */
  private activationRequired = false
  /**
   * True when the current session started as a detached-lifetime reactivation
   * (the request consumed `activationRequired`). The page-resume gate reads it
   * to keep the reactivated fetch-hold hidden-but-measurable until the retained
   * window is verified/positioned — ordinary top fetch-holds stay visible
   * incremental. Set on every `request()`, cleared by `invalidateAll()`; stale
   * values are harmless (phase stable/terminal maps revealed regardless).
   */
  private activationSession = false
  /**
   * Validated retained continuation for a detached-lifetime reactivation
   * (same-route page return whose retained viewport already shows the legal
   * target). Set ONLY by `validateRetainedContinuation()` for the current
   * fetch-hold activation epoch; cleared by every `request()` and by
   * `invalidateAll()`. While set, the visibility mapping keeps the session
   * revealed (no hidden repositioning) until the synchronous stable commit
   * releases it. Never a second truth: epoch/intent/phase/ownership stay in
   * this controller; this flag only records that the retained geometry was
   * measurably validated before first paint.
   */
  private continuationEpoch: number | null = null
  /**
   * Rendered-window generation (component-scoped event, never DOM work):
   * bumped synchronously on every rendered window identity change
   * (`noteSameRouteWindowUpdate`, `applyTransitionWindow`, `appliedWindow`,
   * `rebaseClean`). The React adapter observes it in the layout phase to
   * re-resolve the container-scoped live anchor and hold its offset. No
   * timers, no polling, no global bus.
   */
  private windowGenerationSeq = 0
  /**
   * Bounded route-local answer-tab switch intent (same-route SWITCHING, not
   * reading-position restoration). Captured synchronously in the tab click
   * handler BEFORE selection/layout change: the clicked tab's viewport offset
   * (tab top − container top) is the geometry to preserve, never a hidden
   * body rect. The keeper holds this tab offset across the async DB-first
   * selection + height swap and hands off to the post-switch visible geometry
   * only after the target answer is actually visible + layout-quiet. Cleared
   * on route change, supersession, detach, user intent, takeover,
   * send-bottom, adopt, commit, or terminate — stale intents never survive.
   * `gestureId` is the per-capture monotonic identity: a newer click
   * overwrites, and a stale failure/completion carrying an older identity
   * must never clear or rebase the newer gesture.
   */
  private answerTabIntent: {
    topicId: string
    route: RouteId
    epoch: number
    tabMessageId: string
    tabOffset: number
    gestureId: number
  } | null = null
  private answerTabGestureSeq = 0
  /**
   * Displayed-route anchor cache across supersession (rapid A→B→A):
   * the outgoing route's stable anchor is stashed before a request to a
   * different target overwrites it, so returning to the displayed route with
   * no fresh anchor restores the live/stable anchor instead of bottom.
   * Keyed by canonical route key; instance-scoped, never module/global.
   */
  private anchorCache = new Map<string, RouteVisualAnchor>()

  constructor(initialDisplayed: RouteRef) {
    this.displayed = { ...initialDisplayed }
    // Initial mount: DOM is assumed to belong to the displayed route until
    // proven otherwise (topic switches explicitly dirty via syncDisplayed).
    this.rendered = {
      topicId: initialDisplayed.topicId,
      routeId: initialDisplayed.route,
      epoch: 0,
      windowId: 'init'
    }
  }

  // --- Read-only views -------------------------------------------------------

  get currentEpoch(): number {
    return this.epoch
  }

  get currentPhase(): RouteViewportPhase {
    return this.phase
  }

  get currentIntent(): RouteViewportIntent | null {
    return this.intent ? { ...this.intent } : null
  }

  get displayedRoute(): RouteRef {
    return { ...this.displayed }
  }

  get renderedProvenance(): RenderedProvenance | null {
    return this.rendered ? { ...this.rendered } : null
  }

  /** DOM provenance clean: displayed == rendered (window identity present). */
  get isDomProvenanceClean(): boolean {
    return isRenderedProvenanceClean(this.displayed, this.rendered)
  }

  /** Dirty terminal: phase terminal while DOM does not belong to displayed. */
  get isDirtyTerminal(): boolean {
    return this.phase === 'terminal' && !this.isDomProvenanceClean
  }

  /** Clean terminal: fallback viewport is real user state on displayed route. */
  get isTerminalClean(): boolean {
    return this.phase === 'terminal' && this.isDomProvenanceClean
  }

  /**
   * Route-qualified anchor read (sole anchor source for route-targeted
   * decisions): returns a copy only when the live anchor's provenance
   * exactly matches the requested topic+route; otherwise null. A foreign
   * live anchor (e.g. B's anchor while requesting A) is never observable
   * through this API.
   */
  getAnchorFor(target: RouteRef): RouteVisualAnchor | null {
    if (!this.anchor || !this.anchorRoute) return null
    if (this.anchorRoute.topicId !== target.topicId || this.anchorRoute.route !== target.route) return null
    return { ...this.anchor }
  }

  /** Monotonic rendered-window generation (see field doc). */
  get windowGeneration(): number {
    return this.windowGenerationSeq
  }

  /**
   * Route-local tab-switch intent read (sole source for the keeper's tab
   * hold). Returns a copy only when still bound to the current displayed
   * route + epoch; otherwise null (stale intents are never observable).
   */
  get activeAnswerTabIntent(): {
    topicId: string
    route: RouteId
    epoch: number
    tabMessageId: string
    tabOffset: number
    gestureId: number
  } | null {
    const it = this.answerTabIntent
    if (!it) return null
    if (it.epoch !== this.epoch) return null
    if (it.topicId !== this.displayed.topicId || it.route !== this.displayed.route) return null
    return { ...it }
  }

  /**
   * Capture a tab-switch intent BEFORE selection/layout change. Fail-closed
   * when a transition owns the viewport, provenance is dirty, a live user
   * gesture exists, the target is not the displayed route, or phases are
   * outside adoptable stable/aligned/idle/terminal. Never opens ownership,
   * never touches anchor/cache/phase/epoch. A newer capture overwrites the
   * pending gesture (new gestureId); stale completions must guard by that
   * identity and never clear the newer gesture.
   */
  beginAnswerTabSwitch(
    target: RouteRef,
    tabMessageId: string,
    tabOffset: number,
    opts?: { expectedEpoch?: number }
  ): boolean {
    if (typeof opts?.expectedEpoch === 'number' && opts.expectedEpoch !== this.epoch) return false
    if (typeof tabMessageId !== 'string' || tabMessageId.length === 0) return false
    if (!Number.isFinite(tabOffset)) return false
    if (this.ownershipHeld) return false
    if (!this.isDomProvenanceClean) return false
    if (this.displayed.topicId !== target.topicId || this.displayed.route !== target.route) return false
    if (this.phase !== 'stable' && this.phase !== 'aligned' && this.phase !== 'idle' && this.phase !== 'terminal') {
      return false
    }
    if (this.hasActiveUserInteraction()) return false
    this.answerTabGestureSeq += 1
    this.answerTabIntent = {
      topicId: target.topicId,
      route: target.route,
      epoch: this.epoch,
      tabMessageId,
      tabOffset,
      gestureId: this.answerTabGestureSeq
    }
    return true
  }

  /**
   * Clear the tab-switch intent (idempotent, gesture-guarded when supplied).
   * A stale failure/completion must pass the gesture it belongs to
   * (epoch + tab id + gestureId); when the live intent carries a newer
   * gesture the clear refuses and the newer interaction survives. Callers
   * without an identity (route/user/detach/send paths that own the viewport)
   * clear unconditionally via the locked path.
   */
  clearAnswerTabSwitch(expectedEpoch?: number, expectedTabMessageId?: string, expectedGestureId?: number): boolean {
    if (!this.answerTabIntent) return false
    if (typeof expectedEpoch === 'number' && this.answerTabIntent.epoch !== expectedEpoch) return false
    if (typeof expectedTabMessageId === 'string' && this.answerTabIntent.tabMessageId !== expectedTabMessageId)
      return false
    if (typeof expectedGestureId === 'number' && this.answerTabIntent.gestureId !== expectedGestureId) return false
    this.answerTabIntent = null
    return true
  }

  private clearAnswerTabLocked(): void {
    this.answerTabIntent = null
  }

  get releaseCount(): number {
    return this.releases
  }

  get lastTerminalReason(): RouteViewportTerminalReason | null {
    return this.terminalReason
  }

  /** True while a programmatic transition owns scroll (writes must be suppressed). */
  get programmaticOwned(): boolean {
    return this.ownershipHeld
  }

  /**
   * User-scroll snapshot writes are accepted only when no transition owns the
   * scroll AND DOM provenance is clean (displayed == rendered):
   * stable/idle display, or the unowned CLEAN terminal fallback (whose
   * visible viewport is real user state — the next genuine scroll becomes the
   * new stable anchor). Owned phases (fetch-hold/positioning/searching/
   * aligned) never accept; dirty terminals (rendered != displayed or unknown)
   * stay no-write until a controller rebase/target success — never opened by
   * ownership release alone.
   */
  canAcceptUserScrollWrite(): boolean {
    if (this.ownershipHeld) return false
    if (!this.isDomProvenanceClean) return false
    return this.phase === 'stable' || this.phase === 'idle' || this.phase === 'terminal'
  }

  /**
   * Controller-owned outgoing-capture decision (freeze gate).
   * Capture the live DOM as the outgoing snapshot ONLY when clean + stable:
   * not owned, DOM belongs to displayed, phase stable/idle/clean-terminal.
   * Transition-owned or dirty states preserve the existing stable snapshot
   * and active anchor — never read live DOM (rapid A→B→A must not capture
   * the intermediate B DOM as A).
   */
  shouldCaptureOutgoing(): boolean {
    if (this.ownershipHeld) return false
    if (!this.isDomProvenanceClean) return false
    return this.phase === 'stable' || this.phase === 'idle' || this.phase === 'terminal'
  }

  /** Freeze gate alias (same rule: controller-owned, provenance-clean). */
  canFreezeDisplayed(): boolean {
    return this.shouldCaptureOutgoing()
  }

  isSessionCurrent(epoch: number): boolean {
    return epoch === this.epoch && this.ownershipHeld
  }

  /**
   * Sync the displayed route when the topic itself changes (not a transition).
   * The new topic's DOM is not yet proven: rendered goes unknown (dirty) so
   * snapshot/keeper/freeze gates stay closed until an explicit rebase with
   * window proof (`rebaseClean`) restores clean. No-op while owned.
   */
  syncDisplayed(displayed: RouteRef): void {
    if (this.ownershipHeld) return
    this.clearAnswerTabLocked()
    this.displayed = { ...displayed }
    this.rendered = null
    if (this.phase === 'terminal' || this.phase === 'stable') {
      this.phase = 'stable'
    }
  }

  /**
   * Explicit bootstrap rebase to clean with rendered proof (topic first-load).
   * Requires a non-empty window identity proving which window the DOM shows.
   * Refused while a transition owns the viewport (that path commits instead).
   * Refused while a detached reactivation is required (Activity hidden
   * boundary): the reconnected lifetime must restore through a guarded
   * own-target `request()` first — never an incidental projection rebase.
   * Sets displayed + rendered to the target, phase stable, keeps the anchor
   * (the caller adopts it via the atomic user path when measured). No snapshot write
   * here — the caller commits explicitly when the viewport is stable.
   */
  rebaseClean(target: RouteRef, windowId: string): boolean {
    if (this.ownershipHeld) return false
    if (this.activationRequired) return false
    if (typeof windowId !== 'string' || windowId.length === 0) return false
    this.clearAnswerTabLocked()
    this.displayed = { ...target }
    this.rendered = { topicId: target.topicId, routeId: target.route, epoch: this.epoch, windowId }
    this.windowGenerationSeq += 1
    this.phase = 'stable'
    // Provenance invariant: a kept anchor is observable only for its own
    // route. A rebase to a different route must not retain a foreign anchor
    // as if it belonged to the new displayed route — clear it fail-closed.
    if (this.anchor !== null) {
      const prov = this.anchorRoute
      if (!prov || prov.topicId !== target.topicId || prov.route !== target.route) {
        this.anchor = null
        this.anchorRoute = null
      }
    }
    return true
  }

  /** Failure clear (empty viewport): DOM no longer belongs to any route. */
  markRenderedUnknown(): void {
    this.rendered = null
  }

  // --- Session lifecycle -----------------------------------------------------

  /**
   * Start a new route transition. Supersedes any in-flight session: the old
   * session's ownership is released exactly once (if still held) and every
   * late completion carrying the old epoch becomes inert.
   *
   * Outgoing freeze must be performed by the caller BEFORE this call using
   * `displayedRoute` (still the old route at that point).
   */
  request(req: RouteTransitionRequest): { epoch: number; phase: RouteViewportPhase } {
    // A new route transition supersedes any pending same-route tab hold.
    this.clearAnswerTabLocked()
    // A fresh guarded transaction consumes a pending detached reactivation:
    // the renewed connected lifetime owns its restore BEFORE any geometry is
    // admitted as stable. Single owner: this request is the activation.
    // The page-resume gate remembers whether THIS session is such an
    // activation (ordinary transitions reset it to false).
    this.activationSession = this.activationRequired
    this.activationRequired = false
    // A new session is never a validated continuation until the caller proves
    // retained geometry synchronously via `validateRetainedContinuation()`.
    this.continuationEpoch = null
    // Any programmatic transition start forcibly closes a live user gesture
    // session: post-request scrolls without a fresh declare are programmatic
    // (window apply / first position / reconcile) and must never take over.
    this.closeInteractionLocked()
    // Capture previous intent/provenance BEFORE overwriting intent: the
    // comparison below must test the PREVIOUS session's target, never the
    // just-written current intent (which would be tautologically true).
    const prevAnchor = this.anchor ? { ...this.anchor } : null
    const prevAnchorRoute = this.anchorRoute ? { ...this.anchorRoute } : null
    const prevDisplayed = { ...this.displayed }
    const prevIntent: RouteViewportIntent | null = this.intent ? { ...this.intent } : null
    // Stash the outgoing displayed anchor before it is overwritten, so a
    // rapid return to the same route restores it (A→B→A where B never
    // displayed must restart from the live/stable A anchor). Provenance
    // guard: stash ONLY when the live anchor was actually produced for the
    // still-displayed route. A foreign live anchor (e.g. B's b1 while
    // displayed is still A) must never corrupt cache A.
    if (prevAnchor !== null && prevAnchorRoute !== null) {
      if (prevAnchorRoute.topicId === prevDisplayed.topicId && prevAnchorRoute.route === prevDisplayed.route) {
        try {
          this.anchorCache.set(routeViewportKey(prevDisplayed.topicId, prevDisplayed.route), prevAnchor)
        } catch {
          // fail-closed: cache is best-effort, anchor fallback below still holds
        }
      }
    }
    if (this.ownershipHeld) {
      this.releaseOwnershipLocked(this.epoch)
      this.terminalReason = 'superseded'
    }
    this.epoch += 1
    this.phase = 'fetch-hold'
    this.intent = { kind: req.kind, topicId: req.topicId, targetRoute: req.targetRoute }
    this.ownershipHeld = true
    this.terminalReason = null
    // request() starts the TARGET session but never claims rendered: the DOM
    // still shows the outgoing route until the atomic window apply records it.
    // Rapid-return priority (A→B→A where B never displayed): when the
    // target re-equals the still-displayed route, the RETAINED A anchor
    // (proven same-route live anchor, else the stashed stable anchor) starts
    // the session — it is provably fresher than the persisted snapshot
    // (storage freezes while owned/dirty, live tracks the last retained
    // anchor). Divider intents always carry their own clicked anchor and win.
    // Retained anchor resolution (only when the target re-equals the
    // still-displayed route): the previous live anchor is reusable ONLY when
    // the PREVIOUS session already targeted this same route AND the live
    // anchor's provenance matches it; otherwise it belongs to a different
    // target's session (e.g. the intermediate B intent) and must NOT leak
    // across routes — the per-route stash (provenance-guarded above) is the
    // cross-session source.
    const targetIsDisplayed = prevDisplayed.topicId === req.topicId && prevDisplayed.route === req.targetRoute
    const prevSessionForTarget =
      prevIntent !== null && prevIntent.topicId === req.topicId && prevIntent.targetRoute === req.targetRoute
    const prevLiveProvenForTarget =
      prevAnchorRoute !== null && prevAnchorRoute.topicId === req.topicId && prevAnchorRoute.route === req.targetRoute
    let retained: RouteVisualAnchor | null = null
    if (targetIsDisplayed) {
      if (prevSessionForTarget && prevLiveProvenForTarget && prevAnchor?.kind === 'message') {
        retained = prevAnchor
      } else if (
        prevSessionForTarget &&
        prevLiveProvenForTarget &&
        prevAnchor?.kind === 'divider' &&
        req.kind !== 'divider'
      ) {
        retained = prevAnchor
      } else {
        try {
          const hit = this.anchorCache.get(routeViewportKey(req.topicId, req.targetRoute)) ?? null
          retained = hit ? { ...hit } : null
        } catch {
          retained = null
        }
      }
    }
    const fresh = RouteViewportController.initialAnchorFor(req)
    let next: RouteVisualAnchor | null = null
    if (req.kind === 'divider') {
      next = fresh ?? retained
    } else if (retained?.kind === 'message') {
      next = retained
    } else if (fresh !== null) {
      next = fresh
    } else {
      next = retained
    }
    // Provenance write: a non-null session anchor always belongs to the
    // incoming target; null clears provenance. No other route truth exists.
    this.setAnchorLocked(next, next ? { topicId: req.topicId, route: req.targetRoute } : null)
    return { epoch: this.epoch, phase: this.phase }
  }

  /** Single anchor writer: anchor + provenance always move together. */
  private setAnchorLocked(anchor: RouteVisualAnchor | null, route: RouteRef | null): void {
    if (anchor && route) {
      this.anchor = { ...anchor }
      this.anchorRoute = { ...route }
      return
    }
    this.anchor = null
    this.anchorRoute = null
  }

  private static initialAnchorFor(req: RouteTransitionRequest): RouteVisualAnchor | null {
    if (req.kind === 'divider') {
      if (!req.dividerKey) return null
      const offset = isFiniteOffset(req.clickOffset) ? req.clickOffset : 0
      return { kind: 'divider', dividerKey: req.dividerKey, offset }
    }
    if (req.kind === 'top') {
      if (req.snapshotInvalid) return null
      const saved = req.saved
      if (saved && typeof saved.messageId === 'string' && saved.messageId.length > 0) {
        const offset = isFiniteOffset(saved.intraRowOffset) ? saved.intraRowOffset : 0
        return { kind: 'message', messageId: saved.messageId, offset }
      }
      return null
    }
    return null
  }

  /**
   * Atomic route-window bind: record session epoch + target route + window
   * identity as rendered, move fetch-hold → positioning (still hidden).
   * The ONLY route-switch window path — Messages calls it in the same sync
   * call as the reducer dispatch + plan ref; stale epochs refuse (no apply).
   * Ordinary pagination/reconcile must use `noteSameRouteWindowUpdate` (same
   * route windowId refresh, never a provenance switch).
   */
  applyTransitionWindow(epoch: number, target: RouteRef, windowId: string): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'fetch-hold') return false
    const intent = this.intent
    if (!intent) return false
    if (intent.topicId !== target.topicId || intent.targetRoute !== target.route) return false
    if (typeof windowId !== 'string' || windowId.length === 0) return false
    this.rendered = { topicId: target.topicId, routeId: target.route, epoch, windowId }
    this.windowGenerationSeq += 1
    this.phase = 'positioning'
    return true
  }

  /**
   * Validated retained continuation (same-route page return, TOP-only): the
   * caller proved synchronously — before first paint — that the retained
   * window covers the requested stable anchor, the anchor row is connected
   * AND measurably at its saved offset (or true bottom), using the target's
   * own snapshot (never hidden geometry, never outgoing position).
   * Records session epoch + target route + retained window identity as
   * rendered and enters `aligned` directly with NO window redispatch, NO
   * placement plan, NO scroll write, and NO generation bump (the retained
   * DOM is already correct; the keeper re-resolves via the version notify).
   * Ownership stays held until the caller's synchronous `revealed()` +
   * stable commit releases it exactly once. Divider intents, non-activation
   * sessions, non-fetch-hold phases, mismatched targets, empty window
   * identities, and stale epochs refuse with no effect.
   */
  validateRetainedContinuation(epoch: number, target: RouteRef, windowId: string): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'fetch-hold') return false
    if (!this.activationSession) return false
    const intent = this.intent
    if (!intent) return false
    if (intent.kind === 'divider') return false
    if (intent.topicId !== target.topicId || intent.targetRoute !== target.route) return false
    if (typeof windowId !== 'string' || windowId.length === 0) return false
    this.rendered = { topicId: target.topicId, routeId: target.route, epoch, windowId }
    this.phase = 'aligned'
    this.continuationEpoch = epoch
    return true
  }

  /**
   * Visible incremental rebase: record session epoch + target route + window
   * identity as rendered and enter `aligned` directly, without any
   * positioning/hidden phase. Accepted ONLY for the current divider or top
   * intent in fetch-hold with matching topic/route/window identity. Top uses
   * the target route's own saved message anchor + exact offset (never the
   * divider click offset); divider keeps its clicked offset. Rendered
   * provenance and the window generation advance synchronously; ownership
   * stays held until the existing offset alignment + stable commit releases
   * it. Displayed provenance is NOT advanced here (the stable commit does
   * that). Stale epochs refuse with no dispatch and never disturb a newer
   * session.
   */
  applyVisibleRebaseWindow(epoch: number, target: RouteRef, windowId: string): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'fetch-hold') return false
    const intent = this.intent
    if (!intent) return false
    if (intent.kind !== 'divider' && intent.kind !== 'top') return false
    if (intent.topicId !== target.topicId || intent.targetRoute !== target.route) return false
    if (typeof windowId !== 'string' || windowId.length === 0) return false
    this.rendered = { topicId: target.topicId, routeId: target.route, epoch, windowId }
    this.windowGenerationSeq += 1
    this.phase = 'aligned'
    return true
  }

  /**
   * Post-apply lost-residency fallback: the visible rebase already bound this
   * epoch's rendered provenance (aligned), but the divider row AND the
   * explicit shared fallback are both absent/unmeasurable at layout alignment.
   * Move the SAME session `aligned` → `searching` so the existing hidden
   * restore-owned pagination path owns the remainder — same epoch, same
   * divider intent, same ownership, same rendered provenance, no displayed
   * advance, no snapshot write. Stale epochs or non-divider/non-aligned
   * sessions refuse with no effect. The caller arms the existing
   * divider-search progress under the same epoch and steps it explicitly;
   * `paginationSettled` + the existing stable commit still own completion.
   */
  fallbackVisibleToSearch(epoch: number): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'aligned') return false
    const intent = this.intent
    if (!intent) return false
    if (intent.kind !== 'divider') return false
    this.phase = 'searching'
    return true
  }

  /**
   * Same-epoch top visible → hidden fallback: the top visible rebase already
   * bound this epoch's rendered provenance (aligned), but post-apply proof
   * disappeared (saved-anchor coverage/residency/alignment lost). Rewind the
   * SAME session `aligned` → `fetch-hold` so the existing hidden atomic entry
   * (`applyTransitionWindow` via `commitRouteWindowAtomic`) can commit the
   * already-materialized authoritative target window + first-position plan.
   * Same epoch, same top intent, same ownership, same displayed provenance
   * (still outgoing — displayed never advanced on the visible path), no
   * snapshot write, no rendered rebind here (the hidden commit rebinds).
   * Stale epochs, non-top intents, and non-aligned phases refuse with no
   * effect. Divider sessions keep `fallbackVisibleToSearch` untouched.
   */
  fallbackTopVisibleToHidden(epoch: number): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'aligned') return false
    const intent = this.intent
    if (!intent) return false
    if (intent.kind !== 'top') return false
    this.phase = 'fetch-hold'
    return true
  }

  /**
   * Legacy target-window commit (pre-provenance callers/tests): records a
   * synthetic window identity so reveal/commit provenance checks still hold.
   * When the atomic path already bound this epoch, it keeps that identity.
   * New route-switch production code must call `applyTransitionWindow`.
   */
  appliedWindow(epoch: number): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'fetch-hold') return false
    const intent = this.intent
    if (!intent) return false
    const cur = this.rendered
    if (cur && cur.epoch === epoch && cur.topicId === intent.topicId && cur.routeId === intent.targetRoute) {
      this.phase = 'positioning'
      return true
    }
    this.rendered = {
      topicId: intent.topicId,
      routeId: intent.targetRoute,
      epoch,
      windowId: `legacy-${epoch}`
    }
    this.windowGenerationSeq += 1
    this.phase = 'positioning'
    return true
  }

  /**
   * Same-route window refresh for ordinary pagination/reconcile: updates only
   * the windowId of the CURRENT rendered route. Refuses any route switch
   * (use `applyTransitionWindow`) and refuses unknown rendered (rebase first).
   * Never touches displayed/phase/ownership — clearly distinct from a route
   * transition.
   */
  noteSameRouteWindowUpdate(target: RouteRef, windowId: string): boolean {
    const cur = this.rendered
    if (!cur) return false
    if (cur.topicId !== target.topicId || cur.routeId !== target.route) return false
    if (typeof windowId !== 'string' || windowId.length === 0) return false
    if (cur.windowId === windowId) return true
    this.rendered = { ...cur, windowId }
    // Same-route generation event (no phase/ownership/displayed touch):
    // the React adapter notifies the component-scoped maintainer in the
    // layout phase so it re-resolves the live anchor and holds. The
    // controller itself never touches the DOM.
    this.windowGenerationSeq += 1
    return true
  }

  /**
   * Pre-paint first position applied.
   * - `placed`: requested identity resident and aligned → `aligned` candidate.
   * - `searching`: intermediate edge parking → stays `searching` (must paginate).
   * - `unplaced`: nothing applied → terminal visible fallback, no commit.
   */
  firstPositioned(epoch: number, outcome: FirstPositionOutcome): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'positioning') return false
    if (outcome === 'placed') {
      this.phase = 'aligned'
      return true
    }
    if (outcome === 'searching') {
      this.phase = 'searching'
      return true
    }
    this.toTerminalLocked('unplaced-fallback')
    return true
  }

  /** Restore-owned pagination finished with the identity resident → aligned. */
  paginationSettled(epoch: number): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'searching') return false
    this.phase = 'aligned'
    return true
  }

  /**
   * Target positioned and visible: advance the displayed route.
   * Displayed NEVER advances while hidden, for a stale epoch, or when the
   * rendered provenance disagrees with the intent target (topic/route/epoch;
   * optional windowId must match when supplied). Dirty renders never reveal.
   */
  revealed(epoch: number, windowId?: string): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'aligned' && this.phase !== 'searching') return false
    const intent = this.intent
    if (!intent) return false
    const cur = this.rendered
    if (!cur) return false
    if (cur.epoch !== epoch) return false
    if (cur.topicId !== intent.topicId || cur.routeId !== intent.targetRoute) return false
    if (typeof windowId === 'string' && windowId.length > 0 && cur.windowId !== windowId) return false
    this.displayed = { topicId: intent.topicId, route: intent.targetRoute }
    return true
  }

  /**
   * Stable completion: commit the target route's stable snapshot, advance the
   * displayed route (if not yet), enter `stable`, release ownership exactly
   * once. Only from `aligned`. A programmatic restore needs no user input to
   * be stable — currency + alignment + quiet (verified by the caller) suffice.
   */
  commitStable(
    epoch: number,
    measured: { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean },
    windowId?: string
  ): { committed: boolean; commit: StableCommit | null; didRelease: boolean } {
    if (!this.checkSession(epoch)) return { committed: false, commit: null, didRelease: false }
    if (this.phase !== 'aligned') return { committed: false, commit: null, didRelease: false }
    const intent = this.intent
    if (!intent) return { committed: false, commit: null, didRelease: false }
    // Rendered provenance must agree with the intent target (topic/route/
    // epoch/window): a foreign or stale window never commits.
    const cur = this.rendered
    if (!cur) return { committed: false, commit: null, didRelease: false }
    if (cur.epoch !== epoch) return { committed: false, commit: null, didRelease: false }
    if (cur.topicId !== intent.topicId || cur.routeId !== intent.targetRoute) {
      return { committed: false, commit: null, didRelease: false }
    }
    if (typeof windowId === 'string' && windowId.length > 0 && cur.windowId !== windowId) {
      return { committed: false, commit: null, didRelease: false }
    }
    // Valid unresolved top anchor must never commit a fallback: the caller
    // proves residency before calling; a null identity with a live requested
    // anchor means unresolved → refuse.
    if (intent.kind === 'top' && this.anchor?.kind === 'message' && !measured.messageId) {
      return { committed: false, commit: null, didRelease: false }
    }
    const snapshot: RouteViewportSnapshot = {
      scrollTop: measured.scrollTop,
      messageId: measured.messageId,
      intraRowOffset: measured.intraRowOffset,
      isAtBottom: measured.isAtBottom
    }
    this.displayed = { topicId: intent.topicId, route: intent.targetRoute }
    const commitRoute: RouteRef = { topicId: intent.topicId, route: intent.targetRoute }
    if (snapshot.messageId) {
      this.setAnchorLocked(
        { kind: 'message', messageId: snapshot.messageId, offset: snapshot.intraRowOffset ?? 0 },
        commitRoute
      )
    } else if (!snapshot.isAtBottom && this.anchor) {
      // keep existing anchor identity (divider restores carry their own
      // clicked identity from request(); terminal paths commit nothing)
      // Provenance invariant: the kept anchor must already belong to the
      // commit target; a foreign kept anchor is cleared fail-closed.
      const prov = this.anchorRoute
      if (!prov || prov.topicId !== commitRoute.topicId || prov.route !== commitRoute.route) {
        this.setAnchorLocked(null, null)
      }
    } else if (snapshot.isAtBottom) {
      this.setAnchorLocked(null, null)
    }
    // Refresh the committed route's cache entry so a rapid return restores it.
    try {
      const key = routeViewportKey(intent.topicId, intent.targetRoute)
      if (this.anchor) this.anchorCache.set(key, { ...this.anchor })
      else this.anchorCache.delete(key)
    } catch {
      // best-effort
    }
    this.phase = 'stable'
    // A live user gesture survives the programmatic commit: a wheel declared
    // before completion still owns its forthcoming scroll (adopted via the
    // same session). Completion never closes the interaction session.
    const didRelease = this.releaseOwnershipLocked(epoch)
    return {
      committed: true,
      commit: { routeKey: routeViewportKey(intent.topicId, intent.targetRoute), snapshot },
      didRelease
    }
  }

  /**
   * Terminal fallback: visible failure, NO snapshot commit, release exactly
   * once. The pre-existing target snapshot (if any) is preserved.
   * A live user gesture survives the terminal: momentum scrolls in the same
   * session still adopt (dirty terminals refuse on provenance, clean
   * terminals adopt). Only `request()`/supersede and `invalidateAll()` force
   * a close.
   */
  terminate(epoch: number, reason: RouteViewportTerminalReason): { terminated: boolean; didRelease: boolean } {
    if (epoch !== this.epoch) return { terminated: false, didRelease: false }
    if (!this.ownershipHeld) return { terminated: false, didRelease: false }
    this.toTerminalLocked(reason)
    return { terminated: true, didRelease: true }
  }

  /**
   * Fail-visible provenance adoption (deterministic own-target fallback).
   *
   * After `terminate()` released the session, advance displayed to the
   * committed rendered target so a valid visible fallback viewport becomes
   * clean (displayed == rendered) instead of staying dirty-visible
   * indefinitely. Guards (stale no-op, never disturbs a newer transaction):
   * same latest epoch, phase terminal (never adopts an owned in-flight
   * session), rendered bound to this epoch with a real window identity
   * (pre-commit failures adopt nothing — the prior snapshot and dirty state
   * stand). No snapshot write, no anchor change, no release (`terminate()`
   * already released exactly once): the pre-existing target snapshot is
   * preserved and the next genuine user scroll forms the new stable snapshot
   * under the displayed provenance. The caller additionally gates on the
   * rendered target matching the current selection (same-current target) —
   * this method never infers selection, and never papers over an arbitrary
   * old DOM (only the session's own committed render).
   */
  adoptRenderedAsDisplayed(epoch: number): boolean {
    if (epoch !== this.epoch) return false
    if (this.phase !== 'terminal') return false
    const cur = this.rendered
    if (!cur) return false
    if (cur.epoch !== epoch) return false
    if (typeof cur.windowId !== 'string' || cur.windowId.length === 0) return false
    this.displayed = { topicId: cur.topicId, route: cur.routeId }
    return true
  }

  /**
   * Capture-phase declaration: genuine user input (wheel/touch/pointer/key,
   * scrollbar drag via pointerdown) arrived before its scroll effect lands.
   * Opens a new interaction session when none is live, otherwise refreshes
   * the live session (same id, scroll count preserved) so multi-scroll
   * gestures (wheel momentum / touch / scrollbar drag) stay in one session.
   * Stops persistent programmatic compensation (the keeper checks the live
   * session) without terminating/releasing/touching
   * displayed/rendered/anchor/epoch. Every scroll in the session must go
   * through `userTakeover()` with the live token; the session closes ONLY on
   * native `scrollend`, on a no-scroll pointer/touch end, or forcibly on
   * `request()`/supersede and `invalidateAll()`. No timers, no fences.
   */
  declareUserIntent(): UserInteractionToken {
    // Genuine input cancels a pending tab hold: the user's own scroll owns
    // the viewport from here, never the click-captured tab geometry.
    this.clearAnswerTabLocked()
    if (this.activeInteractionId === null) {
      this.interactionSeq += 1
      this.activeInteractionId = this.interactionSeq
      this.activeInteractionScrolls = 0
    }
    this.interactionDeclareSeq += 1
    this.activeInteractionGeneration = this.interactionDeclareSeq
    return { interactionId: this.activeInteractionId, epoch: this.epoch }
  }

  /**
   * Legacy alias kept for staged migration: same open/refresh semantics as
   * `declareUserIntent()` (never terminates, never releases). New code must
   * call `declareUserIntent()` directly.
   */
  noteUserIntent(): { endedTransition: boolean; epoch: number } {
    this.declareUserIntent()
    return { endedTransition: false, epoch: this.epoch }
  }

  /** Live user gesture present (keeper stops compensation while true). */
  get userIntentPending(): boolean {
    return this.activeInteractionId !== null
  }

  /** Alias for the token model (same liveness). */
  hasActiveUserInteraction(): boolean {
    return this.activeInteractionId !== null
  }

  /** Current live token, or null when no gesture is active. */
  get activeInteractionToken(): UserInteractionToken | null {
    if (this.activeInteractionId === null) return null
    return { interactionId: this.activeInteractionId, epoch: this.epoch }
  }

  /** Adopted scroll count in the live session (fallback close rule). */
  get activeInteractionScrollCount(): number {
    return this.activeInteractionScrolls
  }

  /**
   * Monotonic declare generation of the live user session, or null when no
   * session is live. Advances on every `declareUserIntent()` even when the
   * interaction id is reused (wheel momentum refresh). Send-bottom gates
   * compare this alongside the id so a new real wheel during an entry-live
   * session aborts instead of being mistaken for the same input.
   */
  get activeInteractionDeclareGeneration(): number | null {
    return this.activeInteractionGeneration
  }

  /** Explicit end (event-driven `scrollend` path and compatibility). */
  clearUserIntent(): void {
    this.closeInteractionLocked()
  }

  /**
   * Native `scrollend` path: close the live session when the gesture's
   * scroll sequence ends. Token-guarded: a stale `scrollend` for an older
   * session never touches the new one. Untokened calls close any live
   * session (single component-scoped session per controller).
   */
  noteInteractionScrollEnd(token?: UserInteractionTokenLike): boolean {
    if (this.activeInteractionId === null) return false
    if (token !== undefined) {
      const id = typeof token === 'number' ? token : token.interactionId
      if (id !== this.activeInteractionId) return false
    }
    this.closeInteractionLocked()
    return true
  }

  /**
   * Event-driven fallback for pointer/touch ends WITHOUT `scrollend`:
   * close only when no scroll has landed in this session yet (a press that
   * never scrolled). When at least one scroll adopted, the session stays
   * open for the forthcoming native `scrollend` (momentum / drag); the next
   * programmatic `request()`/supersede or `invalidateAll()` still force a
   * close. Never timer-based.
   */
  noteInteractionPointerEnd(token?: UserInteractionTokenLike): boolean {
    if (this.activeInteractionId === null) return false
    if (token !== undefined) {
      const id = typeof token === 'number' ? token : token.interactionId
      if (id !== this.activeInteractionId) return false
    }
    if (this.activeInteractionScrolls > 0) return false
    this.closeInteractionLocked()
    return true
  }

  private closeInteractionLocked(): void {
    this.activeInteractionId = null
    this.activeInteractionScrolls = 0
    this.activeInteractionGeneration = null
  }

  /**
   * Controller-owned atomic user takeover (one scroll inside a live user
   * interaction session; multi-scroll gestures call once per scroll).
   *
   * Interaction gating (no boolean guess): a live session opened/refreshed
   * by `declareUserIntent()` is REQUIRED. No session → `no-user-intent`;
   * a supplied token whose id differs from the live session →
   * `stale-interaction`. Direct calls without a preceding declare are
   * rejected — tests must open a real session first (no test-only bypass).
   * The session SURVIVES each takeover (scroll count grows) so wheel
   * momentum / touch / scrollbar-drag sequences keep updating the stable
   * snapshot; it closes only on `scrollend`, on a no-scroll pointer/touch
   * end, or forcibly on `request()`/supersede and `invalidateAll()`.
   *
   * - Owned with rendered provenance (positioning/searching/aligned, or
   *   fetch-hold whose rendered is still the outgoing route): the rendered
   *   route is the takeover route (never the selected/incoming key).
   *   Displayed := rendered, phase := stable, anchor := measured
   *   identity/offset (bottom without identity clears), cache refreshed,
   *   ownership released exactly once, epoch bumped so every old async
   *   continuation (epoch-equality or session-currency checks) is inert.
   *   The interaction session survives the epoch bump (same gesture).
   * - Unowned clean stable/idle/clean-terminal: atomically adopts the
   *   measured viewport as the stable anchor for the displayed route.
   * - Rendered unknown, or dirty without provable DOM route, or live window
   *   mismatch: fail-closed, no write, no fake stable (scroll count NOT
   *   incremented — a rejected scroll is not a gesture scroll).
   *
   * Only the returned `{taken:true, routeKey, snapshot}` authorizes a
   * `commitSnapshotForRoute(routeKey, snapshot)` user-source write.
   */
  userTakeover(
    measured: { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean },
    liveWindowId?: string,
    interactionToken?: UserInteractionTokenLike
  ):
    | {
        taken: true
        routeKey: string
        snapshot: RouteViewportSnapshot
        reason: 'owned-takeover' | 'stable-update'
        epoch: number
      }
    | {
        taken: false
        reason:
          | 'no-user-intent'
          | 'stale-interaction'
          | 'unknown-rendered'
          | 'window-mismatch'
          | 'not-owned-dirty'
          | 'nonbottom-null'
        epoch: number
      } {
    if (this.activeInteractionId === null) {
      if (interactionToken !== undefined) return { taken: false, reason: 'stale-interaction', epoch: this.epoch }
      return { taken: false, reason: 'no-user-intent', epoch: this.epoch }
    }
    if (interactionToken !== undefined) {
      const id = typeof interactionToken === 'number' ? interactionToken : interactionToken.interactionId
      if (id !== this.activeInteractionId) return { taken: false, reason: 'stale-interaction', epoch: this.epoch }
    }
    // Bottom/non-bottom separation (shared with the programmatic path): a
    // missing/null identity without proven bottom is unmeasurable, never
    // bottom. Refuse before any anchor/provenance mutation.
    if (!measured.messageId && measured.isAtBottom !== true) {
      return { taken: false, reason: 'nonbottom-null', epoch: this.epoch }
    }
    const live = typeof liveWindowId === 'string' && liveWindowId.length > 0 ? liveWindowId : null
    const isSyntheticWindow = (w: string): boolean => w === 'init' || w.startsWith('legacy-')
    if (this.ownershipHeld) {
      const cur = this.rendered
      if (!cur) return { taken: false, reason: 'unknown-rendered', epoch: this.epoch }
      if (typeof cur.windowId !== 'string' || cur.windowId.length === 0) {
        return { taken: false, reason: 'unknown-rendered', epoch: this.epoch }
      }
      if (live && !isSyntheticWindow(cur.windowId) && live !== cur.windowId) {
        return { taken: false, reason: 'window-mismatch', epoch: this.epoch }
      }
      const takeover: RouteRef = { topicId: cur.topicId, route: cur.routeId }
      const snapshot: RouteViewportSnapshot = {
        scrollTop: measured.scrollTop,
        messageId: measured.messageId,
        intraRowOffset: measured.intraRowOffset,
        isAtBottom: measured.isAtBottom
      }
      const nextAnchor: RouteVisualAnchor | null = snapshot.messageId
        ? { kind: 'message', messageId: snapshot.messageId, offset: snapshot.intraRowOffset ?? 0 }
        : null
      const oldEpoch = this.epoch
      this.displayed = { ...takeover }
      // Owned takeover provenance: the measured viewport belongs to the
      // rendered route (never selected/incoming inference).
      this.setAnchorLocked(nextAnchor, nextAnchor ? { ...takeover } : null)
      try {
        const key = routeViewportKey(takeover.topicId, takeover.route)
        if (this.anchor) this.anchorCache.set(key, { ...this.anchor })
        else this.anchorCache.delete(key)
      } catch {
        // best-effort
      }
      this.phase = 'stable'
      this.terminalReason = null
      this.activeInteractionScrolls += 1
      this.clearAnswerTabLocked()
      this.releaseOwnershipLocked(oldEpoch)
      // Monotonic bump: stale epoch-equality continuations (stillTarget /
      // armedEpoch checks) can never touch the new stable state; stale
      // `finally` blocks are inert via epoch mismatch.
      this.epoch += 1
      return {
        taken: true,
        routeKey: routeViewportKey(takeover.topicId, takeover.route),
        snapshot,
        reason: 'owned-takeover',
        epoch: this.epoch
      }
    }
    // Unowned: only clean stable/idle/clean-terminal may adopt.
    if (!this.isDomProvenanceClean) {
      return { taken: false, reason: this.rendered ? 'not-owned-dirty' : 'unknown-rendered', epoch: this.epoch }
    }
    if (this.phase !== 'stable' && this.phase !== 'idle' && this.phase !== 'terminal') {
      return { taken: false, reason: 'not-owned-dirty', epoch: this.epoch }
    }
    const cur = this.rendered
    if (!cur) return { taken: false, reason: 'unknown-rendered', epoch: this.epoch }
    // Stable-update route is already proven clean (displayed == rendered):
    // window length/identity may lag one commit behind pagination/reconcile
    // (rendered updates synchronously, the measured live id trails), but the
    // route is identical, so a mismatch must never drop the genuine exclusive
    // scroll (journey A-exclusive would otherwise never become stable and the
    // return would restore the old prefix). Owned takeovers above keep the
    // strict window check (route switch provenance).
    void live
    void isSyntheticWindow
    const snapshot: RouteViewportSnapshot = {
      scrollTop: measured.scrollTop,
      messageId: measured.messageId,
      intraRowOffset: measured.intraRowOffset,
      isAtBottom: measured.isAtBottom
    }
    const nextAnchor: RouteVisualAnchor | null = snapshot.messageId
      ? { kind: 'message', messageId: snapshot.messageId, offset: snapshot.intraRowOffset ?? 0 }
      : null
    // Stable takeover provenance: clean displayed == rendered, so the
    // measured viewport belongs to the displayed route. (Non-bottom null was
    // already refused above: null here is proven bottom only.)
    this.clearAnswerTabLocked()
    this.setAnchorLocked(nextAnchor, nextAnchor ? { ...this.displayed } : null)
    try {
      const key = routeViewportKey(this.displayed.topicId, this.displayed.route)
      if (this.anchor) this.anchorCache.set(key, { ...this.anchor })
      else this.anchorCache.delete(key)
    } catch {
      // best-effort
    }
    this.phase = 'stable'
    this.activeInteractionScrolls += 1
    return {
      taken: true,
      routeKey: routeViewportKey(this.displayed.topicId, this.displayed.route),
      snapshot,
      reason: 'stable-update',
      epoch: this.epoch
    }
  }

  /**
   * Same-route hidden-anchor reconciliation (fold answer replacement).
   *
   * When the held reading anchor is the replaced (now hidden/collapsed)
   * selected answer, transfer it to the visible answer representing the SAME
   * answer group, preserving the intended reading offset when the replacement
   * can still represent it, otherwise clamping to the nearest valid visible
   * in-row position (caller-computed via `normalizeFoldAnchorOffset` from the
   * replacement real-box height + viewport height). The caller proves
   * same-group membership (shared group scope in the DOM) and hidden state;
   * this method only moves anchor identity + cache. No epoch bump, no phase
   * change, no ownership release, no snapshot write, no interaction touch —
   * it is never a takeover and never opens a restore. Fail-closed on
   * owned/dirty/unadoptable states. A no-op `true` when already there.
   */
  reconcileAnchorToVisibleMessage(
    target: RouteRef,
    visibleMessageId: string,
    opts?: { correctedOffset?: number }
  ): boolean {
    if (typeof visibleMessageId !== 'string' || visibleMessageId.length === 0) return false
    // A pending tab-switch hold owns same-route geometry: the body-anchor
    // transfer must not fight the clicked-tab hold.
    if (this.answerTabIntent) return false
    if (this.ownershipHeld) return false
    if (!this.isDomProvenanceClean) return false
    if (this.phase !== 'stable' && this.phase !== 'aligned' && this.phase !== 'idle' && this.phase !== 'terminal') {
      return false
    }
    if (this.displayed.topicId !== target.topicId || this.displayed.route !== target.route) return false
    const cur = this.anchor
    const prov = this.anchorRoute
    if (!cur || cur.kind !== 'message' || !prov) return false
    if (prov.topicId !== target.topicId || prov.route !== target.route) return false
    const nextOffset =
      typeof opts?.correctedOffset === 'number' && Number.isFinite(opts.correctedOffset)
        ? opts.correctedOffset
        : cur.offset
    if (cur.messageId === visibleMessageId) {
      if (nextOffset !== cur.offset) {
        this.setAnchorLocked({ kind: 'message', messageId: visibleMessageId, offset: nextOffset }, { ...target })
        try {
          const key = routeViewportKey(target.topicId, target.route)
          if (this.anchor) this.anchorCache.set(key, { ...this.anchor })
        } catch {
          // best-effort
        }
      }
      return true
    }
    this.setAnchorLocked({ kind: 'message', messageId: visibleMessageId, offset: nextOffset }, { ...target })
    try {
      const key = routeViewportKey(target.topicId, target.route)
      if (this.anchor) this.anchorCache.set(key, { ...this.anchor })
      else this.anchorCache.delete(key)
    } catch {
      // best-effort
    }
    return true
  }

  /**
   * Explicit same-route programmatic viewport adoption (send-to-bottom).
   *
   * Adopts a measured programmatic viewport as the new stable anchor for the
   * displayed route WITHOUT requiring or creating a user-gesture session.
   * Unlike `userTakeover`, it never opens/refreshes/closes the genuine
   * interaction session (co-active wheel momentum and its scroll count are
   * untouched) and never releases ownership or bumps the epoch — so it can
   * neither steal nor release a live restore. Fail-closed when a transition
   * owns the viewport, when provenance is dirty, when the target is not the
   * displayed route, on epoch supersession, or outside adoptable phases.
   * Bottom takes priority over top-row identity for this bottom intent: a
   * measured `isAtBottom` viewport clears the row keeper (live anchor null)
   * so the keeper bottom-holds through insertion/stream instead of pulling
   * back to the old reading row. The returned snapshot still carries the
   * measured identity for ADR-governed resume; only the live anchor is
   * bottom. Only the returned `{taken:true}` authorizes a snapshot commit.
   */
  beginSendBottom(target: RouteRef, opts?: { expectedEpoch?: number }): boolean {
    if (typeof opts?.expectedEpoch === 'number' && opts.expectedEpoch !== this.epoch) return false
    // A send supersedes any pending tab hold on this route.
    this.clearAnswerTabLocked()
    if (this.ownershipHeld) return false
    if (!this.rendered) return false
    if (!this.isDomProvenanceClean) return false
    if (this.displayed.topicId !== target.topicId || this.displayed.route !== target.route) return false
    if (this.phase !== 'stable' && this.phase !== 'idle' && this.phase !== 'terminal') return false
    // Pre-scroll suspension: replace the incompatible prior row keeper with
    // the bottom semantic BEFORE the navigation scroll runs, so keeper
    // layout/mutation holds pin the bottom through insertion instead of
    // pulling back to the old reading row. No snapshot write, no ownership
    // release, no epoch change, no interaction touch.
    this.setAnchorLocked(null, null)
    return true
  }

  adoptProgrammaticViewport(
    target: RouteRef,
    measured: { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean },
    opts?: { expectedEpoch?: number }
  ):
    | { taken: true; routeKey: string; snapshot: RouteViewportSnapshot; epoch: number }
    | {
        taken: false
        reason:
          | 'owned-active'
          | 'unknown-rendered'
          | 'not-owned-dirty'
          | 'route-mismatch'
          | 'stale-epoch'
          | 'phase-not-adoptable'
          | 'nonbottom-null'
        epoch: number
      } {
    if (typeof opts?.expectedEpoch === 'number' && opts.expectedEpoch !== this.epoch) {
      return { taken: false, reason: 'stale-epoch', epoch: this.epoch }
    }
    if (this.ownershipHeld) {
      return { taken: false, reason: 'owned-active', epoch: this.epoch }
    }
    if (!this.rendered) {
      return { taken: false, reason: 'unknown-rendered', epoch: this.epoch }
    }
    if (!this.isDomProvenanceClean) {
      return { taken: false, reason: 'not-owned-dirty', epoch: this.epoch }
    }
    if (this.displayed.topicId !== target.topicId || this.displayed.route !== target.route) {
      return { taken: false, reason: 'route-mismatch', epoch: this.epoch }
    }
    if (this.phase !== 'stable' && this.phase !== 'idle' && this.phase !== 'terminal') {
      return { taken: false, reason: 'phase-not-adoptable', epoch: this.epoch }
    }
    // Bottom/non-bottom separation: a missing/null identity WITHOUT proven
    // bottom is unmeasurable, never bottom. Refuse fail-closed so the keeper
    // never pins bottom on a ghost measurement (null anchor always means
    // proven bottom or an explicit bottom intent).
    if (!measured.messageId && measured.isAtBottom !== true) {
      return { taken: false, reason: 'nonbottom-null', epoch: this.epoch }
    }
    const snapshot: RouteViewportSnapshot = {
      scrollTop: measured.scrollTop,
      messageId: measured.messageId,
      intraRowOffset: measured.intraRowOffset,
      isAtBottom: measured.isAtBottom
    }
    const nextAnchor: RouteVisualAnchor | null =
      snapshot.isAtBottom === true
        ? null
        : snapshot.messageId
          ? { kind: 'message', messageId: snapshot.messageId, offset: snapshot.intraRowOffset ?? 0 }
          : null
    this.clearAnswerTabLocked()
    this.setAnchorLocked(nextAnchor, nextAnchor ? { ...this.displayed } : null)
    try {
      const key = routeViewportKey(this.displayed.topicId, this.displayed.route)
      if (this.anchor) this.anchorCache.set(key, { ...this.anchor })
      else this.anchorCache.delete(key)
    } catch {
      // best-effort
    }
    this.phase = 'stable'
    return {
      taken: true,
      routeKey: routeViewportKey(this.displayed.topicId, this.displayed.route),
      snapshot,
      epoch: this.epoch
    }
  }

  /**
   * Epoch-guarded idempotent release for `finally` blocks. Only the current
   * epoch can release, and only once. Stale sessions return false and touch
   * nothing — old `finally` blocks can never disturb the new session.
   */
  releaseSession(epoch: number): boolean {
    if (epoch !== this.epoch) return false
    return this.releaseOwnershipLocked(epoch)
  }

  /**
   * Explicit Activity detach: cancel the short-lived activation/restore
   * transaction (released exactly once via `invalidateAll`, epoch advanced so
   * stale completions stay inert) and arm the reactivation requirement. The
   * long-lived route session truth (displayed + anchorCache + persisted
   * snapshots owned outside) survives; hidden never samples. The next
   * `request()` is the sole activation that consumes this flag.
   */
  detach(reason: RouteViewportTerminalReason = 'invalidated'): boolean {
    const out = this.invalidateAll(reason)
    this.activationRequired = true
    return out
  }

  /** True when a detached lifetime awaits its guarded own-target activation. */
  get isActivationRequired(): boolean {
    return this.activationRequired
  }

  /** True when the current session started as a detached-lifetime reactivation. */
  get isActivationSession(): boolean {
    return this.activationSession
  }

  /**
   * True when the current activation session was validated as an already-
   * correct retained continuation (same epoch, still the activation session).
   * The visibility mapping reads this to keep the validated return revealed
   * instead of hidden-but-measurable. False for every ordinary transition,
   * every unvalidated activation, and every stale epoch.
   */
  get isRetainedContinuation(): boolean {
    return this.continuationEpoch !== null && this.continuationEpoch === this.epoch && this.activationSession
  }

  /**
   * Unmount / HMR / topic disposal / Activity detach: invalidate everything,
   * release once, force-close any live user session.
   *
   * Detach invalidates the short-lived activation/restore transaction while
   * the long-lived route stable viewport session survives in `anchorCache`
   * (+ persisted storage, owned outside): displayed + cache are preserved,
   * live intent/anchor/rendered/phase are cleared. The epoch always advances
   * so every older epoch-equality-only continuation is inert on reactivation —
   * reactivation renews lifetime with a fresh transaction identity instead of
   * reusing the detached epoch.
   *
   * Prefer `detach()` for the Activity hidden boundary (arms reactivation);
   * direct `invalidateAll()` stays for terminal paths (deletion/HMR) that
   * never reactivate and must not arm the flag.
   */
  invalidateAll(reason: RouteViewportTerminalReason = 'invalidated'): boolean {
    this.closeInteractionLocked()
    this.clearAnswerTabLocked()
    this.activationSession = false
    this.continuationEpoch = null
    if (!this.ownershipHeld) {
      this.intent = null
      this.setAnchorLocked(null, null)
      this.rendered = null
      this.phase = 'idle'
      this.terminalReason = null
      // Fresh identity even for the idle detach: stale epoch-equality checks
      // (stillTarget / armedEpoch) must not revive after reactivation.
      this.epoch += 1
      return false
    }
    this.toTerminalLocked(reason)
    this.intent = null
    this.setAnchorLocked(null, null)
    this.rendered = null
    this.phase = 'idle'
    // Owned detach released exactly once above; advance past it so the old
    // epoch can never be reused by a reactivated session.
    this.epoch += 1
    return true
  }

  // --- Internal guards ---------------------------------------------------------

  private checkSession(epoch: number): boolean {
    return epoch === this.epoch && this.ownershipHeld
  }

  private releaseOwnershipLocked(epoch: number): boolean {
    if (epoch !== this.epoch) return false
    if (this.releasedEpoch === epoch) return false
    if (!this.ownershipHeld) return false
    this.ownershipHeld = false
    this.releasedEpoch = epoch
    this.releases += 1
    return true
  }

  private toTerminalLocked(reason: RouteViewportTerminalReason): void {
    this.phase = 'terminal'
    this.terminalReason = reason
    this.releaseOwnershipLocked(this.epoch)
  }
}

/** Displayed-route key helper for outgoing freeze (always the DISPLAYED route). */
export const displayedRouteKey = (displayed: RouteRef): string => routeViewportKey(displayed.topicId, displayed.route)
