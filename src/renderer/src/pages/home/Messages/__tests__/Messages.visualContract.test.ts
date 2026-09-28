/**
 * Visual position contracts (source-level guards):
 * (1) new true branch lands at latest/bottom via windowed read,
 * (2) divider switch restores the same divider row offset (not nearest msg),
 * (3) top selector uses route-local snapshot + sync OLD save + ownership,
 * (5) bounded stabilizer with cancel/deadline, (6) anchor namespaces.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

const messagesSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
const dividersSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/BranchDividers.tsx', 'utf8')
const hookSrc = () => fs.readFileSync('src/renderer/src/hooks/useScrollPosition.ts', 'utf8')
const topicContentSrc = () =>
  fs.readFileSync('src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/TopicContent.tsx', 'utf8')

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
    const idx = src.indexOf('const handleSelectRoute')
    const end = src.indexOf('Top-selector route switch', idx)
    const slice = src.slice(idx, end > idx ? end : idx + 20000)
    expect(slice).toMatch(/dividerVisualAnchorOffset/)
    expect(slice).toMatch(/data-divider-key/)
    expect(slice).toMatch(/buildRouteViewport/)
    expect(slice).toMatch(/decideDividerRestoreTarget/)
    expect(slice).toMatch(/runBoundedPositionStabilizer/)
    expect(slice).not.toMatch(/setPendingAnchorNavigate/)
  })

  it('(2b) dividers expose a stable anchor+parent identity and pass switch info', () => {
    const src = dividersSrc()
    expect(src).toMatch(/buildDividerKey/)
    expect(src).toMatch(/DividerSwitchInfo/)
    expect(src).toMatch(/dividerOffset/)
    expect(src).toMatch(/data-divider-key/)
  })

  it('(3) top selector synchronously saves the OLD route and restores with precise offset under ownership', () => {
    expect(topicContentSrc()).toMatch(/saveRouteScrollSync/)
    expect(hookSrc()).toMatch(/saveRouteScrollSync/)
    expect(hookSrc()).toMatch(/holdProgrammaticScrollOwnership/)
    expect(hookSrc()).toMatch(/intraRowOffset/)
    const src = messagesSrc()
    expect(src).toMatch(/routeSavedRowAnchor/)
    expect(src).toMatch(/isAtBottom/)
    expect(src).toMatch(/holdProgrammaticScrollOwnership/)
    // Target route snapshot is never overwritten in either switch path.
    const idx = src.indexOf('const handleSelectRoute')
    expect(src.slice(idx, idx + 12000)).not.toMatch(/clearSavedPosition/)
  })

  it('(5) bounded stabilizer is cancellable with deadline/quiet and reuses the viewport scroll token', () => {
    const src = messagesSrc()
    expect(src).toMatch(/beginScroll\('anchoring'/)
    expect(src).toMatch(/scroll\/end/)
    expect(src).toMatch(/maxMs:\s*1500/)
    expect(src).toMatch(/quietMs/)
    const stab = fs.readFileSync('src/renderer/src/pages/home/Messages/positionStabilizer.ts', 'utf8')
    expect(stab).toMatch(/cancel/)
    expect(stab).toMatch(/maxMs/)
    expect(stab).toMatch(/quietMs/)
    expect(stab).toMatch(/ResizeObserver/)
    // Real observation (not an empty observer): container + target row with
    // re-measure in the callback, safe rebinding, and disconnect/cancel cleanup.
    expect(stab).toMatch(/getTargetElement/)
    expect(stab).toMatch(/ro\.observe\(container\)/)
    expect(stab).toMatch(/ro\.unobserve/)
    expect(stab).toMatch(/disconnect\(\)/)
    expect(stab).toMatch(/cancelAnimationFrame/)
    expect(stab).not.toMatch(/nudges the rAF loop/)
    // Synchronous idempotent cancel: settles `done` without another frame so
    // unmount never hangs on a paused rAF; single-frame suppress + keyboard
    // guard live in the same module (no 80ms window).
    expect(stab).toMatch(/finish\('cancelled'\)/)
    expect(stab).toMatch(/StabilizerScrollSuppress/)
    expect(stab).toMatch(/shouldCancelStabilizerForKeyDown/)
    expect(stab).not.toMatch(/lastStabilizerApplyAt/)
  })

  it('(1b) divider/top restore validity never consults canHandleUserViewportScroll (no self-cancel)', () => {
    const src = messagesSrc()
    expect(src).toMatch(/isRestoreTargetValid/)
    expect(src).toMatch(/restoreEpochRef/)
    // Scope to each restore body only (never spill into pagination gates that
    // legitimately use canHandleUserViewportScroll). Prose comments may name
    // the forbidden call to explain why it is absent, so strip `//` comment
    // lines before asserting the code itself never calls it.
    const stripLineComments = (code: string): string =>
      code
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
    const dividerIdx = src.indexOf('const handleSelectRoute')
    const dividerEnd = src.indexOf('Top-selector route switch', dividerIdx)
    const dividerSlice = src.slice(dividerIdx, dividerEnd > dividerIdx ? dividerEnd : dividerIdx + 14000)
    expect(dividerSlice).toMatch(/stillTarget/)
    expect(stripLineComments(dividerSlice)).not.toMatch(/canHandleUserViewportScroll/)
    // stillTarget itself is the epoch predicate (topic/route/mounted/epoch).
    const stillIdx = dividerSlice.indexOf('const stillTarget')
    expect(dividerSlice.slice(stillIdx, stillIdx + 500)).toMatch(/isRestoreTargetValid/)
    const topIdx = src.indexOf('Top-selector route switch')
    const topEnd = src.indexOf('return (', topIdx)
    const topSlice = src.slice(topIdx, topEnd > topIdx ? topEnd : topIdx + 12000)
    expect(topSlice).toMatch(/stillTopTarget/)
    expect(topSlice).toMatch(/isRestoreTargetValid/)
    expect(stripLineComments(topSlice)).not.toMatch(/canHandleUserViewportScroll/)
  })

  it('(2c) genuine user scroll/wheel/touch/keyboard cancels the stabilizer with single-frame suppress and sync unmount teardown', () => {
    const src = messagesSrc()
    // Precise single-frame suppress replaces the old 80ms window.
    expect(src).toMatch(/activeStabilizerRef/)
    expect(src).toMatch(/stabilizerSuppressRef/)
    expect(src).toMatch(/isSelfInducedStabilizerScroll/)
    expect(src).toMatch(/armStabilizerSuppress/)
    expect(src).not.toMatch(/applyingStabilizerDeltaRef/)
    expect(src).not.toMatch(/lastStabilizerApplyAtRef/)
    expect(src).not.toMatch(/<\s*80/)
    expect(src).toMatch(/cancelActiveStabilizerForUser/)
    expect(src).toMatch(/handleStabilizerUserInput/)
    expect(src).toMatch(/handleStabilizerKeyDown/)
    expect(src).toMatch(/shouldCancelStabilizerForKeyDown/)
    // handleScroll checks the active stabilizer BEFORE the viewport gate.
    const scrollIdx = src.indexOf('const handleScroll = useCallback')
    const scrollSlice = src.slice(scrollIdx, scrollIdx + 3200)
    expect(scrollSlice).toMatch(/activeStabilizerRef/)
    expect(scrollSlice.indexOf('activeStabilizerRef')).toBeLessThan(scrollSlice.indexOf('canHandleUserViewportScroll'))
    // The cancelling (including pure keyboard-triggered) scroll falls through
    // and is recorded as the route snapshot despite the stale anchoring gate.
    expect(scrollSlice).toMatch(/userCancelledScroll/)
    expect(scrollSlice).toMatch(/handleScrollPosition/)
    // Wheel/touch/pointer pre-cancel plus keyboard pre-cancel; scrollbar drag
    // is covered by pointerDown.
    expect(src).toMatch(/onWheel/)
    expect(src).toMatch(/onTouchStart/)
    expect(src).toMatch(/onPointerDown/)
    expect(src).toMatch(/onKeyDown/)
    // Cancelled sessions never compensate further; deadline retained.
    expect(src).toMatch(/if \(activeStabilizerRef\.current\?\.epoch ===/)
    // Unmount synchronously cancels and releases scroll token + ownership.
    const unmountIdx = src.indexOf('return () => {\n      unmountedRef.current = true')
    expect(unmountIdx).toBeGreaterThan(-1)
    const unmountSlice = src.slice(unmountIdx, unmountIdx + 1200)
    expect(unmountSlice).toMatch(/restoreEpochRef\.current \+= 1/)
    expect(unmountSlice).toMatch(/handle\.cancel\(\)/)
    expect(unmountSlice).toMatch(/scroll\/end/)
    expect(unmountSlice).toMatch(/\.release\(\)/)
    // Restore finally blocks release exactly once per epoch (no double
    // end/release when user-cancel/unmount already took the session).
    expect(src).toMatch(/restoreEpochRef\.current === restoreEpoch/)
    expect(src).toMatch(/restoreEpochRef\.current === topRestoreEpoch/)
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
