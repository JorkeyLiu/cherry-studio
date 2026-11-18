import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * STRUCTURAL wiring guard for the Goal-A window/commit co-commit — NOT a
 * behavior integration test.
 *
 * `Messages` is not mounted here (no existing harness mounts it), so this file
 * asserts the production source contract that unit tests cannot reach:
 * - every route-window pipeline fetches the lightweight qualification
 *   alongside its window fetch, joins it before any commit, and converts a
 *   fetch failure to a null join (fail-closed: no publish);
 * - every atomic commit entry invokes its `onPublish` synchronously inside
 *   the commit, AFTER the stale guards and BEFORE `window/apply`, so the
 *   first visible frame already hosts the target route's group structure;
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
    const batch = sliceOf(
      'const publishDeferredProjection = (): void => {',
      'const { window: targetWindow } = buildRouteViewport('
    )
    const publishIdx = batch.indexOf('publishCommittedChrome(topicIdAtStart, branchId, chromeWires)')
    const rebaseIdx = batch.indexOf('rebaseRouteMessages')
    expect(publishIdx).toBeGreaterThanOrEqual(0)
    expect(rebaseIdx).toBeGreaterThanOrEqual(0)
    expect(publishIdx).toBeLessThan(rebaseIdx)
    // The deferred projection reaches commits as onPublish (visible + hidden entries).
    expect((source.match(/publishDeferredProjection\n/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('the top pipeline joins the qualification before any commit and every top commit carries it', () => {
    expect(source).toContain('const topChromeWires = await topChromeWiresPromise')
    expect(source).toContain('publishCommittedChrome(topicIdAtEffect, routeAtEffect, topChromeWires)')
    // Visible fast path + hidden restore commit share the idempotent closure;
    // the single-use hidden fallback publishes from its stashed wires.
    expect((source.match(/publishTopCommittedChrome/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('chromeWires: topChromeWires')
  })

  it('the deletion fallback joins its qualification and commits it as onPublish, refusing stale epochs', () => {
    expect(source).toContain('const deletionChromeWires = await deletionChromeWiresPromise')
    const commit = sliceOf('deletionEpoch = commitRouteWindowAtomic(', 'if (deletionEpoch === null)')
    expect(commit).toContain('() => publishCommittedChrome(topicIdAtEffect, routeAtEffect, deletionChromeWires)')
  })
})
