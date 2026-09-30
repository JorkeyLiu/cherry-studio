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
 * event-driven no-scroll pointer/touch/key end, or forcibly by the next
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
   *   it closes ONLY on native `scrollend`, on a no-scroll pointer/touch/key
   *   end, or forcibly on `request()`/supersede and `invalidateAll()`.
   * - `activeInteractionScrolls` counts adopted scrolls in this session (used
   *   by the event-driven fallback: pointer/touch/key ends close only when no
   *   scroll has landed yet; momentum scrolls stay open for `scrollend`).
   */
  private interactionSeq = 0
  private activeInteractionId: number | null = null
  private activeInteractionScrolls = 0
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
   * Sets displayed + rendered to the target, phase stable, keeps the anchor
   * (the caller adopts it via the atomic user path when measured). No snapshot write
   * here — the caller commits explicitly when the viewport is stable.
   */
  rebaseClean(target: RouteRef, windowId: string): boolean {
    if (this.ownershipHeld) return false
    if (typeof windowId !== 'string' || windowId.length === 0) return false
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
   * Divider-only visible incremental rebase: record session epoch + target
   * route + window identity as rendered and enter `aligned` directly, without
   * any positioning/hidden phase. Accepted ONLY for the current divider intent
   * in fetch-hold with matching topic/route/window identity. Rendered
   * provenance and the window generation advance synchronously; ownership
   * stays held until the existing divider offset alignment + stable commit
   * releases it. Displayed provenance is NOT advanced here (the stable commit
   * does that). Stale epochs refuse with no effect and can never disturb a
   * newer session.
   */
  applyVisibleRebaseWindow(epoch: number, target: RouteRef, windowId: string): boolean {
    if (!this.checkSession(epoch)) return false
    if (this.phase !== 'fetch-hold') return false
    const intent = this.intent
    if (!intent) return false
    if (intent.kind !== 'divider') return false
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
   * Capture-phase declaration: genuine user input (wheel/touch/pointer/key,
   * scrollbar drag via pointerdown) arrived before its scroll effect lands.
   * Opens a new interaction session when none is live, otherwise refreshes
   * the live session (same id, scroll count preserved) so multi-scroll
   * gestures (wheel momentum / touch / scrollbar drag) stay in one session.
   * Stops persistent programmatic compensation (the keeper checks the live
   * session) without terminating/releasing/touching
   * displayed/rendered/anchor/epoch. Every scroll in the session must go
   * through `userTakeover()` with the live token; the session closes ONLY on
   * native `scrollend`, on a no-scroll pointer/touch/key end, or forcibly on
   * `request()`/supersede and `invalidateAll()`. No timers, no fences.
   */
  declareUserIntent(): UserInteractionToken {
    if (this.activeInteractionId === null) {
      this.interactionSeq += 1
      this.activeInteractionId = this.interactionSeq
      this.activeInteractionScrolls = 0
    }
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
   * Event-driven fallback for pointer/touch/key ends WITHOUT `scrollend`:
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
   * snapshot; it closes only on `scrollend`, on a no-scroll pointer/touch/
   * key end, or forcibly on `request()`/supersede and `invalidateAll()`.
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
        reason: 'no-user-intent' | 'stale-interaction' | 'unknown-rendered' | 'window-mismatch' | 'not-owned-dirty'
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
    // measured viewport belongs to the displayed route.
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
   * Epoch-guarded idempotent release for `finally` blocks. Only the current
   * epoch can release, and only once. Stale sessions return false and touch
   * nothing — old `finally` blocks can never disturb the new session.
   */
  releaseSession(epoch: number): boolean {
    if (epoch !== this.epoch) return false
    return this.releaseOwnershipLocked(epoch)
  }

  /** Unmount / HMR / topic disposal: invalidate everything, release once, force-close any live user session. */
  invalidateAll(reason: RouteViewportTerminalReason = 'invalidated'): boolean {
    this.closeInteractionLocked()
    if (!this.ownershipHeld) {
      this.intent = null
      this.setAnchorLocked(null, null)
      this.rendered = null
      this.phase = 'idle'
      this.terminalReason = null
      return false
    }
    this.toTerminalLocked(reason)
    this.intent = null
    this.setAnchorLocked(null, null)
    this.rendered = null
    this.phase = 'idle'
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
