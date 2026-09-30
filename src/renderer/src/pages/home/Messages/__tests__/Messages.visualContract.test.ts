/**
 * Visual position contracts (source-level guards for the single-controller
 * architecture):
 * (1) new true branch lands at latest/bottom via windowed read,
 * (2) divider switch restores the same divider row offset (not nearest msg),
 * (3) top selector freezes outgoing + restores with precise offset through
 *     the single controller (no module-global saver/ownership),
 * (5) persistent stable anchoring via scoped observers (no rAF polling) plus
 *     pure frame-step primitives, (6) anchor namespaces.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

const messagesSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
const dividersSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/BranchDividers.tsx', 'utf8')
const hookSrc = () => fs.readFileSync('src/renderer/src/hooks/useScrollPosition.ts', 'utf8')
const topicContentSrc = () =>
  fs.readFileSync('src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/TopicContent.tsx', 'utf8')
const controllerSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/routeViewportController.ts', 'utf8')
const contextSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/routeViewportContext.tsx', 'utf8')

describe('visual position contracts', () => {
  it('(1) new true branch explicitly lands at latest/bottom via a windowed latest read', () => {
    const src = messagesSrc()
    const idx = src.indexOf('EVENT_NAMES.NEW_TRUE_BRANCH')
    const slice = src.slice(idx, idx + 4500)
    expect(slice).toMatch(/kind:\s*'latest'/)
    expect(slice).toMatch(/createLatestMessageWindow/)
    expect(slice).toMatch(/kind:\s*'bottom'/)
    expect(slice).not.toMatch(/setActiveTopic/)
  })

  it('(2) divider switch captures/restores the divider row pixel offset as primary', () => {
    const src = messagesSrc()
    // The restore-owned search driver is defined just before the switch.
    const idx = src.indexOf('Divider restore search driver')
    const end = src.indexOf('Top-selector route switch', idx)
    const slice = src.slice(idx, end > idx ? end : idx + 20000)
    expect(slice).toMatch(/dividerVisualAnchorOffset/)
    expect(slice).toMatch(/data-divider-key/)
    expect(slice).toMatch(/buildRouteViewport/)
    expect(slice).toMatch(/stepDividerSearch/)
    // No second stabilizer loop: the persistent keeper holds post-reveal
    // drift; no competing session may exist.
    expect(slice).not.toMatch(/runBoundedPositionStabilizer/)
    expect(slice).not.toMatch(/setPendingAnchorNavigate/)
  })

  it('(2d) divider restore search: edge parking is intermediate, stable commits only after resident/aligned/quiet', () => {
    const src = messagesSrc()
    // Single controller owns the session; progress carries only the owner
    // epoch (re-gated every step) — no second epoch truth.
    expect(src).toMatch(/dividerProgressRef/)
    expect(src).toMatch(/ownerEpoch/)
    expect(src).toMatch(/decideDividerRestoreSearchStep/)
    expect(src).toMatch(/stepDividerSearch/)
    expect(src).toMatch(/alignAndCommitDividerSearch/)
    expect(src).toMatch(/endDividerSearchTerminal/)
    // Restore identity + captured offset survive every older-window expansion;
    // expansion compensation prefers the controller anchor while current.
    // Route-qualified only: a foreign live anchor must never snapshot.
    // (Behavioral coverage lives in the routeRestoreAnchor smoke + controller
    // provenance unit; no duplicated spelling assertion here.)
    expect(src).toMatch(/snapshotPreferredAnchor/)
    expect(src).not.toMatch(/activeRestoreAnchorRef/)
    expect(src).not.toMatch(/snapshotRestoreAnchor\(/)
    // Terminal paths release exactly once with NO divider-position commit:
    // the pre-existing target snapshot stands (a false edge commit would
    // poison the next restore of the route).
    const terminalIdx = src.indexOf('const endDividerSearchTerminal')
    expect(terminalIdx).toBeGreaterThan(-1)
    const terminalSlice = src.slice(terminalIdx, terminalIdx + 1500)
    expect(terminalSlice).toMatch(/failVisibleTransition/)
    expect(terminalSlice).not.toMatch(/commitDisplayedStable/)
    // The only divider stable commit lives in the align path (resident +
    // aligned + quiet); intermediate/searching steps never commit.
    const alignIdx = src.indexOf('const alignAndCommitDividerSearch')
    expect(alignIdx).toBeGreaterThan(-1)
    const alignSlice = src.slice(alignIdx, alignIdx + 9000)
    expect(alignSlice).toMatch(/commitDisplayedStable/)
    expect(alignSlice).not.toMatch(/runBoundedPositionStabilizer/)
    // Restore-owned pages are driven explicitly from window state (short
    // windows at edge=0 may never fire InfiniteScroll); the manual path
    // cannot race while a search is active.
    expect(src).toMatch(/Restore-owned search guard/)
    expect(src).toMatch(/drivenWindowKey/)
    // No diagnostic probes, no fence/user-input gating, no wheel dependence.
    expect(src).not.toMatch(/TEMP-DIAG/)
    expect(src).not.toMatch(/diag867/)
    expect(src).not.toMatch(/__diag867/)
    expect(src).not.toMatch(/fenceRouteScrollKey/)
    expect(src).not.toMatch(/fencedRouteKeys/)
  })

  it('(2b) dividers expose a stable anchor+parent identity and pass switch info', () => {
    const src = dividersSrc()
    expect(src).toMatch(/buildDividerKey/)
    expect(src).toMatch(/DividerSwitchInfo/)
    expect(src).toMatch(/dividerOffset/)
    expect(src).toMatch(/data-divider-key/)
  })

  it('(3) top selector freezes outgoing + dispatches through the single controller (no module globals)', () => {
    expect(topicContentSrc()).toMatch(/requestTopRoute/)
    expect(topicContentSrc()).not.toMatch(/saveRouteScrollSync/)
    expect(topicContentSrc()).not.toMatch(/activeBranchSet/)
    expect(topicContentSrc()).not.toMatch(/fenceRouteScrollKey/)
    expect(hookSrc()).not.toMatch(/saveRouteScrollSync/)
    expect(hookSrc()).not.toMatch(/holdProgrammaticScrollOwnership/)
    expect(hookSrc()).not.toMatch(/registerRouteScrollSaver/)
    expect(hookSrc()).not.toMatch(/syncRouteSaver/)
    expect(hookSrc()).not.toMatch(/programmaticScrollDepth/)
    expect(hookSrc()).not.toMatch(/fenceRouteScrollKey/)
    expect(hookSrc()).not.toMatch(/noteRouteUserScrollInteraction/)
    expect(hookSrc()).not.toMatch(/fencedRouteKeys/)
    // Gate + trusted commit instead of globals: ordinary writes gated,
    // stable completions commit explicitly.
    expect(hookSrc()).toMatch(/canWrite/)
    expect(hookSrc()).toMatch(/commitSnapshotForRoute/)
    expect(hookSrc()).toMatch(/intraRowOffset/)
    const src = messagesSrc()
    expect(src).toMatch(/routeSavedRowAnchor/)
    expect(src).toMatch(/isAtBottom/)
    expect(src).toMatch(/adoptFetchHold/)
    // Target route snapshot is never overwritten in either switch path.
    const idx = src.indexOf('const handleSelectRoute')
    expect(src.slice(idx, idx + 12000)).not.toMatch(/clearSavedPosition/)
  })

  it('(3b) displayed-route/stable-commit protocol: transients never persist, stable restores commit once', () => {
    const hook = hookSrc()
    // Ordinary writes drop while the controller gate is closed (transient);
    // the existing stable snapshot stands. Stable completion commits
    // explicitly — no user input required to earn the snapshot.
    expect(hook).toMatch(/canWrite/)
    expect(hook).toMatch(/commitSnapshotForRoute/)
    // Outgoing freeze runs before the identity change in both switch entries.
    expect(topicContentSrc()).toMatch(/requestTopRoute/)
    const src = messagesSrc()
    expect(src).toMatch(/saveDisplayedSnapshot/)
    expect(src).toMatch(/beginFetchHold/)
    expect(src).toMatch(/commitDisplayedStable/)
    expect(src).toMatch(/invalidateAll/)
    expect(src).toMatch(/isSessionCurrent/)
    // Release lives inside the controller's commit/terminate (exactly once
    // per session); callers never release directly anymore.
    expect(src).not.toMatch(/\.release\(\)/)
    expect(src).not.toMatch(/Incoming-route fence BEFORE the identity change/)
    // Supersession terminates the previous session (release exactly once).
    expect(src).toMatch(/tearDownViewportTransition/)
    // No module-global saver or ownership depth may exist anywhere.
    expect(src).not.toMatch(/holdProgrammaticScrollOwnership/)
    expect(src).not.toMatch(/registerRouteScrollSaver/)
    expect(src).not.toMatch(/restoreEpochRef/)
    expect(src).not.toMatch(/viewportTransitionRef/)
    expect(src).not.toMatch(/activeStabilizerRef/)
  })

  it('(3c) single controller owns epoch/intent/phase/ownership/displayed/anchor with exactly-once release', () => {
    const src = controllerSrc()
    expect(src).toMatch(/class RouteViewportController/)
    expect(src).toMatch(/releaseSession/)
    expect(src).toMatch(/invalidateAll/)
    expect(src).toMatch(/isSnapshotWriteAllowed/)
    // No second decision truth: unwired intent resolvers were removed; the
    // controller request path owns anchor semantics.
    expect(src).not.toMatch(/resolveTopTarget/)
    expect(src).not.toMatch(/resolveDividerTarget/)
    // Epoch-guarded idempotent release: stale sessions touch nothing.
    expect(src).toMatch(/releasedEpoch/)
    expect(src).toMatch(/releaseOwnershipLocked/)
    const context = contextSrc()
    // Scoped provider at the nearest common ancestor — never window/global
    // bus, never a module-level singleton.
    expect(context).toMatch(/RouteViewportProvider/)
    expect(context).toMatch(/registerCapturer/)
    expect(context).toMatch(/requestTopRoute/)
    expect(context).not.toMatch(/window\.addEventListener/)
    expect(context).not.toMatch(/globalThis.*emitter|EventEmitter/)
  })

  it('(5) persistent stable anchoring via scoped observers (no rAF polling) plus pure frame steps', () => {
    const context = contextSrc()
    expect(context).toMatch(/useStableVisualAnchor/)
    expect(context).toMatch(/ResizeObserver/)
    expect(context).toMatch(/MutationObserver/)
    expect(context).not.toMatch(/requestAnimationFrame/)
    expect(context).not.toMatch(/setInterval/)
    // User input declares intent first (wheel/touch/pointer/key, inputs
    // excluded by the shared key guard). Pending-only, never terminates.
    expect(context).toMatch(/declareUserIntent/)
    expect(context).not.toMatch(/\.noteUserIntent\(\)/)
    expect(context).toMatch(/wheel/)
    expect(context).toMatch(/touchstart/)
    expect(context).toMatch(/pointerdown/)
    const stab = fs.readFileSync('src/renderer/src/pages/home/Messages/positionStabilizer.ts', 'utf8')
    // Pure primitives only: no rAF loop, no layout-signature commit gate,
    // no experimental second stabilizer model.
    expect(stab).not.toMatch(/runBoundedPositionStabilizer/)
    expect(stab).not.toMatch(/buildStabilizerLayoutSignature/)
    expect(stab).not.toMatch(/isTopFinalCommitReady/)
    expect(stab).not.toMatch(/OffsetStabilizerController/)
    expect(stab).not.toMatch(/computeRestoreDelta/)
    expect(stab).not.toMatch(/shouldCompensate/)
    expect(stab).not.toMatch(/armStabilizerSuppress/)
    expect(stab).not.toMatch(/isSelfInducedStabilizerScroll/)
    expect(stab).toMatch(/isRestoreTargetValid/)
    expect(stab).toMatch(/shouldCancelStabilizerForKeyDown/)
    // Ordinary pagination compensates once under its own token; the keeper
    // holds afterwards.
    const src = messagesSrc()
    expect(src).toMatch(/beginScroll\('anchoring'/)
    expect(src).toMatch(/scroll\/end/)
    expect(src).not.toMatch(/maxMs:\s*1500/)
    expect(src).not.toMatch(/quietMs/)
  })

  it('(1b) divider/top restore validity never consults canHandleUserViewportScroll (no self-cancel)', () => {
    const src = messagesSrc()
    expect(src).toMatch(/isRestoreTargetValid/)
    expect(src).toMatch(/controller\.isSessionCurrent/)
    // Scope to each restore body only (never spill into pagination gates that
    // legitimately use canHandleUserViewportScroll). Prose comments may name
    // the forbidden call to explain why it is absent, so strip `//` comment
    // lines before asserting the code itself never calls it.
    const stripLineComments = (code: string): string =>
      code
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
    // Divider validity lives in the restore-owned search driver (defined
    // just before the switch) plus the switch coordinator that steps it.
    const dividerIdx = src.indexOf('Divider restore search driver')
    const dividerEnd = src.indexOf('Top-selector route switch', dividerIdx)
    const dividerSlice = src.slice(dividerIdx, dividerEnd > dividerIdx ? dividerEnd : dividerIdx + 26000)
    expect(dividerSlice).toMatch(/stepDividerSearch/)
    expect(dividerSlice).toMatch(/stillTarget/)
    expect(stripLineComments(dividerSlice)).not.toMatch(/canHandleUserViewportScroll/)
    // stillTarget itself is the session predicate (topic/route/mounted/epoch).
    const stillIdx = dividerSlice.indexOf('const stillTarget')
    expect(dividerSlice.slice(stillIdx, stillIdx + 500)).toMatch(/isRestoreTargetValid/)
    const topIdx = src.indexOf('Top-selector route switch')
    const topEnd = src.indexOf('return (', topIdx)
    const topSlice = src.slice(topIdx, topEnd > topIdx ? topEnd : topIdx + 12000)
    expect(topSlice).toMatch(/stillTopTarget/)
    expect(topSlice).toMatch(/isRestoreTargetValid/)
    expect(stripLineComments(topSlice)).not.toMatch(/canHandleUserViewportScroll/)
  })

  it('(2c) genuine user input declares first; the atomic takeover owns the scroll', () => {
    const src = messagesSrc()
    expect(src).not.toMatch(/activeStabilizerRef/)
    expect(src).not.toMatch(/stabilizerSuppressRef/)
    expect(src).not.toMatch(/isSelfInducedStabilizerScroll/)
    expect(src).not.toMatch(/armStabilizerSuppress/)
    expect(src).not.toMatch(/applyingStabilizerDeltaRef/)
    expect(src).not.toMatch(/lastStabilizerApplyAtRef/)
    expect(src).not.toMatch(/<\s*80/)
    expect(src).toMatch(/cancelActiveStabilizerForUser/)
    expect(src).toMatch(/declareUserIntent/)
    expect(src).not.toMatch(/userCancelledScroll/)
    expect(src).toMatch(/handleStabilizerUserInput/)
    expect(src).toMatch(/handleStabilizerKeyDown/)
    expect(src).toMatch(/shouldCancelStabilizerForKeyDown/)
    // Single atomic path: capture opens/refreshes the interaction session,
    // scroll measures then calls userTakeover with the live token; only the
    // returned key authorizes the snapshot write. Scrolls with no live
    // session never take over (programmatic / window-reconcile).
    const scrollIdx = src.indexOf('const handleScroll = useCallback')
    const scrollSlice = src.slice(scrollIdx, scrollIdx + 5200)
    expect(scrollSlice).toMatch(/activeInteractionToken/)
    expect(scrollSlice).toMatch(/hasActiveUserInteraction|activeInteractionToken/)
    expect(scrollSlice).toMatch(/controller\.userTakeover\(/)
    expect(scrollSlice).toMatch(/commitSnapshotForRoute\(out\.routeKey/)
    expect(scrollSlice).not.toMatch(/userCancelledScroll/)
    expect(scrollSlice).not.toMatch(/canHandleUserViewportScroll/)
    // keeper/hook never independently gate+capture+write the same scroll.
    expect(scrollSlice).not.toMatch(/handleScrollPosition\(\)/)
    // Wheel/touch/pointer pre-declare plus keyboard pre-declare; scrollbar
    // drag is covered by pointerDown.
    expect(src).toMatch(/onWheel/)
    expect(src).toMatch(/onTouchStart/)
    expect(src).toMatch(/onPointerDown/)
    expect(src).toMatch(/onKeyDown/)
    // Unmount invalidates the controller (release exactly once, never leaves
    // hidden); stale finally blocks skip on epoch mismatch.
    const unmountIdx = src.indexOf('return () => {\n      unmountedRef.current = true')
    expect(unmountIdx).toBeGreaterThan(-1)
    const unmountSlice = src.slice(unmountIdx, unmountIdx + 1200)
    expect(unmountSlice).toMatch(/controller\.invalidateAll\(\)/)
    expect(unmountSlice).not.toMatch(/handle\.cancel\(\)/)
    expect(unmountSlice).not.toMatch(/\.release\(\)/)
    expect(src).toMatch(/isSessionCurrent\(epoch\)/)
    expect(src).toMatch(/controller\.currentEpoch !== armedEpoch/)
    expect(src).toMatch(/controller\.currentEpoch === topRestoreEpoch/)
  })

  it('(6) route/divider/context anchors live in separate namespaces', () => {
    const src = messagesSrc()
    expect(src).toMatch(/routeSavedRowAnchor/)
    expect(src).toMatch(/dividerVisualAnchor/)
    expect(src).toMatch(/contextBoundaryMessageId/)
    expect(src).toMatch(/never cross-write|never feeds this|never carries fork-divider or context/i)
  })

  it('(7) divider main button and top selector entry disable Antd two-char auto spacing (popup already set)', () => {
    const dividers = dividersSrc()
    expect(dividers).toMatch(/ForkDividerNameButton/)
    const nameBtnIdx = dividers.indexOf('ForkDividerNameButton')
    // Local prop on the divider main button (no global ConfigProvider).
    expect(
      dividers.slice(dividers.indexOf('<ForkDividerNameButton'), dividers.indexOf('<ForkDividerNameButton') + 600)
    ).toMatch(/autoInsertSpace=\{false\}/)
    expect(dividers).not.toMatch(/ConfigProvider/)
    expect(topicContentSrc()).toMatch(/branch-selector-entry/)
    const entryIdx = topicContentSrc().indexOf('branch-selector-entry')
    expect(topicContentSrc().slice(entryIdx - 400, entryIdx + 400)).toMatch(/autoInsertSpace=\{false\}/)
    void nameBtnIdx
  })
})
