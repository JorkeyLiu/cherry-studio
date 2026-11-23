import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * STRUCTURAL wiring guard for the window+structure bundle co-commit — NOT a
 * behavior integration test.
 *
 * `Messages` is not mounted here (no existing harness mounts it), so this file
 * asserts the production source contract that unit tests cannot reach:
 * - every route-window pipeline reads through a deferred receipt
 *   (`dispatchDeferredRouteWindowRead`: fetch publishes nothing, the response
 *   is bound to its dispatch-source provenance), validates the receipt with
 *   `isDeferredRouteWindowReceiptCurrent` immediately before any commit, and
 *   refuses stale receipts with zero projection/chrome/window pollution;
 * - every deferred pipeline carries the bundled structure on the SAME receipt
 *   (`toDeferredJointPayload` exposes `structure`; no `fetchRouteChromeWires`,
 *   no `listSegments`, no second IPC, no store-catalog join), and a missing
 *   structure fails closed with no publish and no independent backfill;
 * - every atomic commit entry invokes its joint `onPublish` (blocks + rebase
 *   with mutable ids/cleared reference + chrome, synchronously inside the
 *   commit, AFTER the stale guards and BEFORE `window/apply`), so the first
 *   visible frame already hosts the target route's groups and structure;
 * - `publishCommittedChrome` itself never publishes on a null structure
 *   and never throws (retained/hook behavior survives).
 *
 * The derivation itself (structure → committed chrome, hook equivalence,
 * single-flight) is proven behaviorally in
 * `src/renderer/src/utils/__tests__/routeCommittedChrome.structure.test.ts`.
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

  it('publish is fail-closed: null structure returns early, projection misses and throws never dispatch', () => {
    const slice = publishSlice()
    const earlyIdx = slice.indexOf('if (!structure) return')
    const tryIdx = slice.indexOf('try {')
    const guardedIdx = slice.indexOf('if (projected)')
    for (const [name, index] of Object.entries({ earlyIdx, tryIdx, guardedIdx })) {
      expect(index, `${name} must be present`).toBeGreaterThanOrEqual(0)
    }
    expect(earlyIdx).toBeLessThan(tryIdx)
    expect(tryIdx).toBeLessThan(guardedIdx)
    expect(slice).toMatch(/catch \{\s*\/\/ fail-closed/)
    expect(slice).toContain('projectCommittedChromeFromStructure')
  })

  it('no independent chrome fetch: no fetchRouteChromeWires, no listSegments, no wires join', () => {
    expect(source).not.toContain('fetchRouteChromeWires')
    expect(source).not.toContain('chromeWires')
    expect(source).not.toContain('ListSegmentsResponse')
    expect(source).not.toContain('listSegments')
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

  it('the divider pipeline carries the bundled structure on the same receipt and publishes it first in the deferred batch', () => {
    // Deferred-only reads: the thunk publishes nothing; the joint commit below publishes.
    expect(source).toContain('deferredReceipt = await loadLatestWindow()')
    // The bundled structure rides the same receipt (explicit adapter, no silent
    // drop): required for the co-commit; missing fails closed with no publish
    // and no independent backfill.
    expect(source).toContain('const joint = toDeferredJointPayload(deferredReceipt)')
    expect(source).toContain('deferredStructure = joint.structure')
    expect(source).toContain("throw new Error('route structure missing in bundled window response')")
    // The deferred batch publishes the structure before hydrating route messages.
    expect(source).toMatch(/const publishDeferredProjection = \(unionMessages\?: readonly Message\[\]\): void/)
    const batch = sliceOf('const publishDeferredProjection = (', 'if (restoreEpoch === null)')
    const publishIdx = batch.indexOf('publishCommittedChrome(topicIdAtStart, branchId, deferredStructure)')
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
    // Missing bundled structure fails closed: no publish, no backfill.
    expect(source).toContain('if (!topJoint.structure) {')
    expect(source).toContain('const topChromeStructure = topJoint.structure')
    expect(source).toContain('publishCommittedChrome(topicIdAtEffect, routeAtEffect, topChromeStructure)')
    expect(source).toContain('mutableMessageIds: [...topJoint.mutableMessageIds]')
    expect(source).toContain('reference: topJoint.reference ?? null')
    // Visible fast path + hidden restore commit share the idempotent closure;
    // the single-use hidden fallback publishes it bare (authoritative order)
    // and still carries the bundled structure.
    expect(source).toContain('() => publishTopJointProjection(unionOldestFirst)')
    expect((source.match(/publishTopJointProjection/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('chromeStructure: topChromeStructure')
  })

  it('the deletion fallback reads through a deferred receipt and commits it as the joint onPublish, refusing stale epochs', () => {
    expect(source).toContain('deletionReceipt = await dispatchDeferredRouteWindowRead(')
    // Double late gate: after the fetch and again before publish (no new
    // fetch, same-tick adjacency) — an ABA in between still refuses.
    expect(
      (source.match(/isDeferredRouteWindowReceiptCurrent\(\(\) => store\.getState\(\), deletionReceipt\)/g) ?? [])
        .length
    ).toBeGreaterThanOrEqual(2)
    expect(source).toContain('const deletionJoint = toDeferredJointPayload(deletionReceipt)')
    // Missing bundled structure fails closed: no publish, no backfill.
    expect(source).toContain('if (!deletionJoint.structure) {')
    expect(source).toContain('const deletionChromeStructure = deletionJoint.structure')
    expect(source).toContain('publishCommittedChrome(topicIdAtEffect, routeAtEffect, deletionChromeStructure)')
    expect(source).toContain('mutableMessageIds: [...deletionJoint.mutableMessageIds]')
    expect(source).toContain('reference: deletionJoint.reference ?? null')
    const commit = sliceOf('deletionEpoch = commitRouteWindowAtomic(', 'if (deletionEpoch === null)')
    expect(commit).toContain('publishDeletionJointProjection')
  })
})
