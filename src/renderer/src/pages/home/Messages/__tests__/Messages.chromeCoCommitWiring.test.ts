import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * STRUCTURAL wiring guard for the Goal-A window/commit co-commit — NOT a
 * behavior integration test.
 *
 * `Messages` is not mounted here (no existing harness mounts it), so this file
 * asserts the production source contract that unit tests cannot reach:
 * - every route-window pipeline reads through a deferred receipt
 *   (`dispatchDeferredRouteWindowRead`: fetch publishes nothing, the response
 *   is bound to its dispatch-source provenance), validates the receipt with
 *   `isDeferredRouteWindowReceiptCurrent` immediately before any commit, and
 *   refuses stale receipts with zero projection/chrome/window pollution;
 * - every atomic commit entry invokes its joint `onPublish` (blocks + rebase
 *   with mutable ids/cleared reference + chrome, synchronously inside the
 *   commit, AFTER the stale guards and BEFORE `window/apply`), so the first
 *   visible frame already hosts the target route's groups and structure;
 * - `publishCommittedChrome` itself never publishes on a null/failed fetch
 *   and never throws (retained/hook behavior survives).
 *
 * The derivation itself (wires → structure, hook equivalence, single-flight)
 * is proven behaviorally in
 * `src/renderer/src/utils/__tests__/routeCommittedChrome.test.ts`.
 */
describe('Messages chrome co-commit wiring (structural)', () => {
  const source = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  const sliceOf = (startMarker: string, endMarker: string): string => {
    const start = source.indexOf(startMarker)
    expect(start, `${startMarker} must exist`).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(endMarker, start)
    expect(end, `${endMarker} must follow ${startMarker}`).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  const publishSlice = (): string =>
    sliceOf('const publishCommittedChrome = useCallback(', 'const commitRouteWindowAtomic = useCallback(')
  const windowCommitSlice = (): string =>
    sliceOf('const commitRouteWindowAtomic = useCallback(', 'const commitDividerVisibleAtomic = useCallback(')
  const dividerCommitSlice = (): string =>
    sliceOf('const commitDividerVisibleAtomic = useCallback(', 'const commitTopVisibleAtomic = useCallback(')
  const topCommitSlice = (): string =>
    sliceOf('const commitTopVisibleAtomic = useCallback(', 'const endDividerSearchTerminal = useCallback(')

  it('publish is fail-closed: null wires return early, projection misses and throws never dispatch', () => {
    const slice = publishSlice()
    const earlyIdx = slice.indexOf('if (!wires) return')
    const tryIdx = slice.indexOf('try {')
    const guardedIdx = slice.indexOf('if (projected) setCommittedChrome(projected)')
    for (const [name, index] of Object.entries({ earlyIdx, tryIdx, guardedIdx })) {
      expect(index, `${name} must be present`).toBeGreaterThanOrEqual(0)
    }
    expect(earlyIdx).toBeLessThan(tryIdx)
    expect(tryIdx).toBeLessThan(guardedIdx)
    expect(slice).toMatch(/catch \{\s*\/\/ fail-closed/)
  })

  it('the single route-window entry refuses stale sessions before publish and applies the window after', () => {
    const slice = windowCommitSlice()
    const staleIdx = slice.indexOf('if (!controller.isSessionCurrent(fetchEpoch))')
    const intentIdx = slice.indexOf('if (!intent || intent.topicId !== topicIdAtStart')
    const phaseIdx = slice.indexOf("if (controller.currentPhase !== 'fetch-hold')")
    const publishIdx = slice.indexOf('onPublish()')
    const applyIdx = slice.indexOf("viewportDispatch({ type: 'window/apply', window })")
    for (const [name, index] of Object.entries({ staleIdx, intentIdx, phaseIdx, publishIdx, applyIdx })) {
      expect(index, `${name} must be present`).toBeGreaterThanOrEqual(0)
    }
    expect(staleIdx).toBeLessThan(publishIdx)
    expect(intentIdx).toBeLessThan(publishIdx)
    expect(phaseIdx).toBeLessThan(publishIdx)
    // The publish runs inside the commit, synchronously before the window is applied.
    expect(publishIdx).toBeLessThan(applyIdx)
  })

  it('both visible fast paths refuse stale sessions before publish and apply the window after', () => {
    for (const [name, slice] of Object.entries({ divider: dividerCommitSlice(), top: topCommitSlice() })) {
      const staleIdx = slice.indexOf('if (!controller.isSessionCurrent(fetchEpoch))')
      const publishIdx = slice.indexOf('onPublish()')
      const applyIdx = slice.indexOf("viewportDispatch({ type: 'window/apply', window })")
      for (const [entry, index] of Object.entries({ staleIdx, publishIdx, applyIdx })) {
        expect(index, `${name}: ${entry} must be present`).toBeGreaterThanOrEqual(0)
      }
      expect(staleIdx, `${name}: stale guard before publish`).toBeLessThan(publishIdx)
      expect(publishIdx, `${name}: publish before window/apply`).toBeLessThan(applyIdx)
    }
  })

  it('the divider pipeline joins the qualification before any commit and publishes it first in the deferred batch', () => {
    // Pre-fetch alongside the window fetch; failure converts to a null join.
    expect(source).toMatch(
      /const chromeWiresPromise: Promise<ListSegmentsResponse \| null> = fetchRouteChromeWires\(\s*topicIdAtStart,\s*branchId\s*\)\.then\(\s*\(wires\) => wires,\s*\(\) => null\s*\)/
    )
    expect(source).toContain('chromeWires = await chromeWiresPromise')
    // The deferred batch publishes the structure before hydrating route messages.
    // The batch helper now takes the optional visible-union override (hidden
    // path passes nothing and publishes the target window order as before);
    // the slice runs from its definition through both commit entries (visible
    // union call + hidden bare pass as onPublish).
    expect(source).toMatch(/const publishDeferredProjection = \(unionMessages\?: readonly Message\[\]\): void/)
    const batch = sliceOf('const publishDeferredProjection = (', 'if (restoreEpoch === null)')
    const publishIdx = batch.indexOf('publishCommittedChrome(topicIdAtStart, branchId, chromeWires)')
    const rebaseIdx = batch.indexOf('rebaseRouteMessages')
    expect(publishIdx).toBeGreaterThanOrEqual(0)
    expect(rebaseIdx).toBeGreaterThanOrEqual(0)
    expect(publishIdx).toBeLessThan(rebaseIdx)
    // The deferred projection reaches commits as onPublish in both entries:
    // the visible path wraps the union order, the hidden path passes the
    // batch itself (which publishes the target window order).
    expect(batch).toContain('() => publishDeferredProjection(unionOldestFirst)')
    expect(source).toMatch(/^\s*publishDeferredProjection$/m)
  })

  it('the top pipeline reads through a deferred receipt and every top commit carries the joint publish', () => {
    // Deferred-only read: publishes nothing; the joint commit below publishes.
    expect(source).toContain('topReceipt = await dispatchDeferredRouteWindowRead(')
    // Receipt late gate before any commit: a superseding request, route ABA,
    // deletion or generation advance refuses with zero pollution.
    expect(source).toContain('!isDeferredRouteWindowReceiptCurrent(() => store.getState(), topReceipt)')
    // Success-only window build from the authoritative deferred response
    // (never from the store — the deferred read published nothing).
    expect(source).toContain('const loaded = topJoint.messages')
    expect(source).toContain('const topJoint = toDeferredJointPayload(topReceipt)')
    expect(source).toContain('publishCommittedChrome(topicIdAtEffect, routeAtEffect, topChromeWires)')
    expect(source).toContain('mutableMessageIds: [...topJoint.mutableMessageIds]')
    expect(source).toContain('reference: topJoint.reference ?? null')
    // Visible fast path + hidden restore commit share the idempotent closure;
    // the single-use hidden fallback publishes it bare (authoritative order)
    // and still carries the joined chrome wires.
    expect(source).toContain('() => publishTopJointProjection(unionOldestFirst)')
    expect((source.match(/publishTopJointProjection/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('chromeWires: topChromeWires')
  })

  it('the deletion fallback reads through a deferred receipt and commits it as the joint onPublish, refusing stale epochs', () => {
    expect(source).toContain('deletionReceipt = await dispatchDeferredRouteWindowRead(')
    // Double late gate: after the fetch and again after the chrome join (no
    // new fetch, same-tick adjacency) — an ABA in between still refuses.
    expect(
      (source.match(/isDeferredRouteWindowReceiptCurrent\(\(\) => store\.getState\(\), deletionReceipt\)/g) ?? [])
        .length
    ).toBeGreaterThanOrEqual(2)
    expect(source).toContain('const deletionJoint = toDeferredJointPayload(deletionReceipt)')
    expect(source).toContain('publishCommittedChrome(topicIdAtEffect, routeAtEffect, deletionChromeWires)')
    expect(source).toContain('mutableMessageIds: [...deletionJoint.mutableMessageIds]')
    expect(source).toContain('reference: deletionJoint.reference ?? null')
    const commit = sliceOf('deletionEpoch = commitRouteWindowAtomic(', 'if (deletionEpoch === null)')
    expect(commit).toContain('publishDeletionJointProjection')
  })
})
