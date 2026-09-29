/**
 * Divider restore search lifecycle (binding invariant, pure decisions).
 *
 * Covers the confirmed 867px-flaw lifecycle at the cheapest sufficient layer:
 * - edge fallback is INTERMEDIATE search, never a stable success;
 * - restore-owned pagination continues while the anchor is absent even with
 *   no scroll event (the decision consults no scroll state);
 * - the restore intent (preferred identity + captured offset) survives every
 *   older-window expansion;
 * - no stable commit happens on intermediate pages;
 * - once the divider is resident, alignment keeps the captured offset and the
 *   single commit follows;
 * - failure / oldest-edge / page-cap / supersession terminate with NO commit
 *   (the pre-existing target snapshot is preserved, never a false edge state).
 */
import { describe, expect, it } from 'vitest'

import {
  decideDividerRestoreSearchStep,
  type DividerRestoreSearchInput,
  MAX_DIVIDER_SEARCH_PAGES
} from '../dividerRestoreSearch'
import type { PreferredRestoreAnchorSnapshot } from '../routeRestoreAnchor'

const preferredDivider: PreferredRestoreAnchorSnapshot = {
  kind: 'divider-row',
  dividerKey: 'anchor::parent',
  targetOffset: -120
}

const baseInput: DividerRestoreSearchInput = {
  dividerResident: false,
  sharedResident: false,
  hasMoreOlder: true,
  loadingOlder: false,
  pagesDriven: 0,
  targetCurrent: true,
  mounted: true,
  hasWindow: true,
  lastLoadFailed: false
}

describe('decideDividerRestoreSearchStep', () => {
  it('anchor absent + older pages remain + loader idle drives restore-owned pagination (no scroll event consulted)', () => {
    // The input carries no scrollTop/scroll-event/wheel state: the drive is
    // explicit from window/hasMoreOlder/anchor-residency. A short window at
    // edge=0 that never fires InfiniteScroll still pages.
    const decision = decideDividerRestoreSearchStep(baseInput, preferredDivider)
    expect(decision).toEqual({ action: 'drive-older', preferred: preferredDivider, commitStable: false })
  })

  it('restore intent survives expansion: consecutive absent-anchor pages keep the same preferred identity + offset', () => {
    // Models the 11→16 growth: each intermediate page still misses the
    // divider, and every drive carries the SAME captured identity/offset —
    // never a silent loss to an anchor-less fallback.
    let pagesDriven = 0
    for (let page = 0; page < 3; page += 1) {
      const decision = decideDividerRestoreSearchStep({ ...baseInput, pagesDriven }, preferredDivider)
      expect(decision.action).toBe('drive-older')
      if (decision.action === 'drive-older') {
        expect(decision.preferred).toEqual(preferredDivider)
        expect(decision.commitStable).toBe(false)
      }
      pagesDriven += 1
    }
  })

  it('no stable commit happens on any intermediate page (drive or wait)', () => {
    expect(decideDividerRestoreSearchStep(baseInput, preferredDivider).commitStable).toBe(false)
    expect(decideDividerRestoreSearchStep({ ...baseInput, loadingOlder: true }, preferredDivider).commitStable).toBe(
      false
    )
    expect(decideDividerRestoreSearchStep({ ...baseInput, loadingOlder: true }, preferredDivider).action).toBe(
      'wait-load'
    )
  })

  it('once the divider is resident, alignment wins and the single commit follows (offset retained)', () => {
    const decision = decideDividerRestoreSearchStep(
      { ...baseInput, dividerResident: true, pagesDriven: 2 },
      preferredDivider
    )
    expect(decision.action).toBe('align-and-commit')
    if (decision.action === 'align-and-commit') {
      expect(decision.alignKind).toBe('divider-row')
      // The caller aligns `measured - preferred.targetOffset` (captured
      // offset retained, never outgoing raw scrollTop) and commits once
      // after quiet; the decision itself never commits inline.
      expect(decision.commitStable).toBe(false)
      expect(preferredDivider.targetOffset).toBe(-120)
    }
  })

  it('divider wins over the shared fallback when both are resident', () => {
    const decision = decideDividerRestoreSearchStep(
      { ...baseInput, dividerResident: true, sharedResident: true },
      preferredDivider
    )
    expect(decision).toMatchObject({ action: 'align-and-commit', alignKind: 'divider-row' })
  })

  it('resident shared fallback aligns when the divider row is still absent', () => {
    const decision = decideDividerRestoreSearchStep(
      { ...baseInput, sharedResident: true },
      { kind: 'message-row', messageId: 'shared', targetOffset: -64 }
    )
    expect(decision).toMatchObject({ action: 'align-and-commit', alignKind: 'shared-message' })
  })

  it('authoritative oldest edge with the anchor still absent terminates with NO commit (prior snapshot preserved)', () => {
    const decision = decideDividerRestoreSearchStep(
      { ...baseInput, hasMoreOlder: false, pagesDriven: 4 },
      preferredDivider
    )
    expect(decision).toEqual({ action: 'terminal-fallback', reason: 'oldest-edge', commitStable: false })
  })

  it('load failure terminates with NO commit (never a silent retry loop, never a false edge snapshot)', () => {
    const decision = decideDividerRestoreSearchStep({ ...baseInput, lastLoadFailed: true }, preferredDivider)
    expect(decision).toEqual({ action: 'terminal-fallback', reason: 'load-failed', commitStable: false })
  })

  it('page cap terminates with NO commit', () => {
    const decision = decideDividerRestoreSearchStep(
      { ...baseInput, pagesDriven: MAX_DIVIDER_SEARCH_PAGES },
      preferredDivider
    )
    expect(decision).toEqual({ action: 'terminal-fallback', reason: 'page-cap', commitStable: false })
  })

  it('supersession invalidates stale steps: no drive, no align, no commit', () => {
    const superseded: DividerRestoreSearchInput = {
      ...baseInput,
      targetCurrent: false,
      dividerResident: true
    }
    // Even a resident anchor must not align/commit for a stale epoch —
    // rapid route/topic switches invalidate stale completions.
    expect(decideDividerRestoreSearchStep(superseded, preferredDivider)).toEqual({
      action: 'terminal-fallback',
      reason: 'superseded',
      commitStable: false
    })
  })

  it('unmounted and missing-window terminate without commit', () => {
    expect(decideDividerRestoreSearchStep({ ...baseInput, mounted: false }, preferredDivider)).toMatchObject({
      action: 'terminal-fallback',
      reason: 'unmounted',
      commitStable: false
    })
    expect(decideDividerRestoreSearchStep({ ...baseInput, hasWindow: false }, preferredDivider)).toMatchObject({
      action: 'terminal-fallback',
      reason: 'missing-window',
      commitStable: false
    })
  })

  it('every decision carries commitStable:false — the caller commits exactly once after align+quiet', () => {
    const cases: DividerRestoreSearchInput[] = [
      baseInput,
      { ...baseInput, dividerResident: true },
      { ...baseInput, sharedResident: true },
      { ...baseInput, loadingOlder: true },
      { ...baseInput, hasMoreOlder: false },
      { ...baseInput, lastLoadFailed: true },
      { ...baseInput, pagesDriven: MAX_DIVIDER_SEARCH_PAGES + 1 },
      { ...baseInput, targetCurrent: false },
      { ...baseInput, mounted: false },
      { ...baseInput, hasWindow: false }
    ]
    for (const input of cases) {
      expect(decideDividerRestoreSearchStep(input, preferredDivider).commitStable).toBe(false)
    }
  })
})
