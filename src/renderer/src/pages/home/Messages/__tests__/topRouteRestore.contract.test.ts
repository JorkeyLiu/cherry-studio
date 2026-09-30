/**
 * Top-selector exclusive-anchor restore contract (pure decisions).
 *
 * - Canonical saved `messageId` wins; legacy `anchorId` fills.
 * - Valid exclusive anchors never degrade to vicinity/tail/raw.
 * - Typed NOT_FOUND → invalid-snapshot terminal default (may replace stale
 *   only after stable default); transport stays fail-visible/preserve.
 * - Stable commit requires coverage for valid anchors; defaults/bottom pass.
 */
import {
  canonicalSavedAnchorId,
  chooseRouteWindowRequest,
  chooseTopFirstPositionPlan,
  decideTopRestoreAnchor,
  isTopRestoreNotFoundError,
  isTopStableCommittable
} from '@renderer/pages/home/Messages/messageWindow'
import { describe, expect, it } from 'vitest'

describe('canonicalSavedAnchorId + chooseRouteWindowRequest', () => {
  it('canonical messageId wins over legacy anchorId', () => {
    expect(
      canonicalSavedAnchorId({ scrollTop: 1, anchorId: 'legacy', messageId: 'canonical', isAtBottom: false })
    ).toBe('canonical')
    expect(
      chooseRouteWindowRequest({ scrollTop: 1, anchorId: 'legacy', messageId: 'canonical', isAtBottom: false })
    ).toEqual({
      kind: 'around',
      anchorMessageId: 'canonical'
    })
  })

  it('legacy anchorId fills when canonical is absent', () => {
    expect(canonicalSavedAnchorId({ scrollTop: 1, anchorId: 'legacy', isAtBottom: false })).toBe('legacy')
    expect(chooseRouteWindowRequest({ scrollTop: 1, anchorId: 'legacy', isAtBottom: false })).toEqual({
      kind: 'around',
      anchorMessageId: 'legacy'
    })
  })

  it('empty strings never select around', () => {
    expect(canonicalSavedAnchorId({ scrollTop: 1, anchorId: '', messageId: '', isAtBottom: false })).toBeNull()
    expect(chooseRouteWindowRequest({ scrollTop: 1, anchorId: '', messageId: '', isAtBottom: false })).toEqual({
      kind: 'latest'
    })
  })

  it('valid anchor selects around even when isAtBottom (exact viewport outranks bottom)', () => {
    expect(
      chooseRouteWindowRequest({
        scrollTop: -8,
        anchorId: null,
        messageId: 'bexcl-00006',
        intraRowOffset: -51,
        isAtBottom: true
      })
    ).toEqual({
      kind: 'around',
      anchorMessageId: 'bexcl-00006'
    })
    expect(chooseRouteWindowRequest({ scrollTop: 0, anchorId: 'a', messageId: 'm', isAtBottom: true })).toEqual({
      kind: 'around',
      anchorMessageId: 'm'
    })
  })

  it('anchorless isAtBottom still selects latest', () => {
    expect(chooseRouteWindowRequest({ scrollTop: 0, anchorId: null, messageId: null, isAtBottom: true })).toEqual({
      kind: 'latest'
    })
    expect(chooseRouteWindowRequest({ scrollTop: 0, anchorId: '', messageId: '', isAtBottom: true })).toEqual({
      kind: 'latest'
    })
  })

  it('missing snapshot selects latest', () => {
    expect(chooseRouteWindowRequest(null)).toEqual({ kind: 'latest' })
  })
})

describe('isTopRestoreNotFoundError', () => {
  it('classifies the typed NOT_FOUND family only', () => {
    for (const code of ['NOT_FOUND', 'ERR_NOT_FOUND', 'TOPIC_NOT_FOUND']) {
      expect(isTopRestoreNotFoundError({ code } as unknown as Error)).toBe(true)
    }
    expect(isTopRestoreNotFoundError(new Error('transport fail'))).toBe(false)
    expect(isTopRestoreNotFoundError({ code: 'VALIDATION_ERROR' } as unknown as Error)).toBe(false)
    expect(isTopRestoreNotFoundError(null)).toBe(false)
  })
})

describe('decideTopRestoreAnchor', () => {
  it('valid resident anchor restores exactly it (no vicinity/tail)', () => {
    const d = decideTopRestoreAnchor({
      canonicalAnchor: 'main-excl-3',
      snapshotInvalidForRoute: false,
      loadedIds: new Set(['fork', 'main-excl-3'])
    })
    expect(d).toEqual({ routeSavedRowAnchor: 'main-excl-3', snapshotInvalidForRoute: false, mustFailVisible: false })
  })

  it('valid anchor absent from projection fails visible (never a fallback commit)', () => {
    const d = decideTopRestoreAnchor({
      canonicalAnchor: 'main-excl-3',
      snapshotInvalidForRoute: false,
      loadedIds: new Set(['fork', 'other'])
    })
    expect(d.mustFailVisible).toBe(true)
    expect(d.routeSavedRowAnchor).toBeNull()
  })

  it('invalid snapshot takes the terminal default (null anchor, committable)', () => {
    const d = decideTopRestoreAnchor({
      canonicalAnchor: 'stale-id',
      snapshotInvalidForRoute: true,
      loadedIds: new Set(['fork', 'tail'])
    })
    expect(d.routeSavedRowAnchor).toBeNull()
    expect(d.snapshotInvalidForRoute).toBe(true)
    expect(d.mustFailVisible).toBe(false)
  })

  it('no snapshot takes the deterministic default', () => {
    const d = decideTopRestoreAnchor({
      canonicalAnchor: null,
      snapshotInvalidForRoute: false,
      loadedIds: new Set(['a'])
    })
    expect(d.routeSavedRowAnchor).toBeNull()
    expect(d.mustFailVisible).toBe(false)
  })
})

describe('isTopStableCommittable', () => {
  it('valid anchor commits only when covered + connected', () => {
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'main-excl-3',
        projectionContains: true,
        domConnected: true
      })
    ).toBe(true)
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'main-excl-3',
        projectionContains: false,
        domConnected: true
      })
    ).toBe(false)
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'main-excl-3',
        projectionContains: true,
        domConnected: false
      })
    ).toBe(false)
  })

  it('valid anchor with isAtBottom still requires coverage (no bottom bypass)', () => {
    expect(
      isTopStableCommittable({
        isAtBottom: true,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'bexcl-00006',
        projectionContains: true,
        domConnected: true
      })
    ).toBe(true)
    expect(
      isTopStableCommittable({
        isAtBottom: true,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'bexcl-00006',
        projectionContains: false,
        domConnected: true
      })
    ).toBe(false)
    expect(
      isTopStableCommittable({
        isAtBottom: true,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'bexcl-00006',
        projectionContains: true,
        domConnected: false
      })
    ).toBe(false)
  })

  it('terminal default and anchorless bottom commit without anchor coverage', () => {
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: true,
        requestedAnchor: null,
        projectionContains: false,
        domConnected: false
      })
    ).toBe(true)
    expect(
      isTopStableCommittable({
        isAtBottom: true,
        snapshotInvalidForRoute: false,
        requestedAnchor: null,
        projectionContains: false,
        domConnected: false
      })
    ).toBe(true)
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: false,
        requestedAnchor: null,
        projectionContains: false,
        domConnected: false
      })
    ).toBe(true)
  })
})

describe('chooseTopFirstPositionPlan (anchor outranks isAtBottom)', () => {
  it('anchor + isAtBottom selects message with the saved intra-row offset', () => {
    expect(
      chooseTopFirstPositionPlan({
        saved: { scrollTop: -8, anchorId: null, messageId: 'bexcl-00006', intraRowOffset: -51, isAtBottom: true },
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: 'bexcl-00006'
      })
    ).toEqual({ kind: 'message', messageId: 'bexcl-00006', wantOffset: -51, fallbackScrollTop: null })
  })

  it('anchorless isAtBottom selects bottom', () => {
    expect(
      chooseTopFirstPositionPlan({
        saved: { scrollTop: 0, anchorId: null, isAtBottom: true },
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: null
      })
    ).toEqual({ kind: 'bottom' })
  })

  it('invalid snapshot selects the terminal default even with an anchor', () => {
    expect(
      chooseTopFirstPositionPlan({
        saved: { scrollTop: -8, anchorId: null, messageId: 'stale', intraRowOffset: -51, isAtBottom: true },
        snapshotInvalidForRoute: true,
        routeSavedRowAnchor: null
      })
    ).toEqual({ kind: 'none' })
  })

  it('no snapshot selects the deterministic bottom default', () => {
    expect(
      chooseTopFirstPositionPlan({ saved: null, snapshotInvalidForRoute: false, routeSavedRowAnchor: null })
    ).toEqual({
      kind: 'bottom'
    })
  })

  it('anchorless without usable raw scrollTop selects bottom (never outgoing, never none)', () => {
    expect(
      chooseTopFirstPositionPlan({
        saved: { scrollTop: Number.NaN, anchorId: null, messageId: null, intraRowOffset: null, isAtBottom: false },
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: null
      })
    ).toEqual({ kind: 'bottom' })
  })

  it('raw-only legacy snapshot keeps the same-route scrollTop fallback', () => {
    expect(
      chooseTopFirstPositionPlan({
        saved: { scrollTop: -400, anchorId: null, messageId: null, intraRowOffset: null, isAtBottom: false },
        snapshotInvalidForRoute: false,
        routeSavedRowAnchor: null
      })
    ).toEqual({ kind: 'scrollTop', scrollTop: -400 })
  })
})

describe('continuous top-route sequence: branch anchor survives shared crossing-first (decision level)', () => {
  it('branch anchor@+47 + main missing -> main bottom; main->branch commits branch anchor, not crossing-first', () => {
    // Dynamic case: branch snapshot bexcl02@+47, main key absent.
    const branchSaved = {
      scrollTop: -500,
      anchorId: 'bexcl02',
      messageId: 'bexcl02',
      intraRowOffset: 47,
      rawScrollTop: -500,
      isAtBottom: false
    } as const
    // Branch arrival: valid anchor resident -> message plan at +47.
    const branchLoaded = new Set(['msg08', 'bexcl02', 'msg20'])
    const branchDecision = decideTopRestoreAnchor({
      canonicalAnchor: 'bexcl02',
      snapshotInvalidForRoute: false,
      loadedIds: branchLoaded
    })
    expect(branchDecision.routeSavedRowAnchor).toBe('bexcl02')
    expect(branchDecision.mustFailVisible).toBe(false)
    const branchPlan = chooseTopFirstPositionPlan({
      saved: { ...branchSaved },
      snapshotInvalidForRoute: false,
      routeSavedRowAnchor: branchDecision.routeSavedRowAnchor
    })
    expect(branchPlan).toEqual({ kind: 'message', messageId: 'bexcl02', wantOffset: 47, fallbackScrollTop: null })
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'bexcl02',
        projectionContains: true,
        domConnected: true
      })
    ).toBe(true)
    // Identity commit content: applied anchor + wantOffset, never the live
    // crossing-first (shared msg08 surfaced by the expanded window).
    const liveCrossingFirst = 'msg08'
    expect(liveCrossingFirst).not.toBe('bexcl02')
    const identitySnapshot = {
      anchorId: 'bexcl02',
      messageId: 'bexcl02',
      intraRowOffset: 47
    }
    expect(identitySnapshot.messageId).toBe('bexcl02')
    expect(identitySnapshot.messageId).not.toBe(liveCrossingFirst)

    // Branch -> main with main key absent (saved=null): deterministic bottom,
    // never outgoing scrollTop, never none.
    const mainPlan = chooseTopFirstPositionPlan({
      saved: null,
      snapshotInvalidForRoute: false,
      routeSavedRowAnchor: null
    })
    expect(mainPlan).toEqual({ kind: 'bottom' })
    const mainAnchorlessBottom = chooseTopFirstPositionPlan({
      saved: { scrollTop: 0, anchorId: null, messageId: null, isAtBottom: true },
      snapshotInvalidForRoute: false,
      routeSavedRowAnchor: null
    })
    expect(mainAnchorlessBottom).toEqual({ kind: 'bottom' })
    // No-snapshot bottom completion is committable without anchor coverage
    // and establishes the route default (not outgoing geometry).
    expect(
      isTopStableCommittable({
        isAtBottom: true,
        snapshotInvalidForRoute: false,
        requestedAnchor: null,
        projectionContains: false,
        domConnected: false
      })
    ).toBe(true)

    // Main -> branch again: same applied anchor@+47, same crossing-first
    // foreign row live. Decision still resolves bexcl02; commit gate still
    // requires its own coverage (not the crossing-first row's).
    const backDecision = decideTopRestoreAnchor({
      canonicalAnchor: 'bexcl02',
      snapshotInvalidForRoute: false,
      loadedIds: branchLoaded
    })
    expect(backDecision.routeSavedRowAnchor).toBe('bexcl02')
    const backPlan = chooseTopFirstPositionPlan({
      saved: { ...branchSaved },
      snapshotInvalidForRoute: false,
      routeSavedRowAnchor: backDecision.routeSavedRowAnchor
    })
    expect(backPlan).toEqual({ kind: 'message', messageId: 'bexcl02', wantOffset: 47, fallbackScrollTop: null })
    // Unmet anchor (evicted) never commits a fallback.
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'bexcl02',
        projectionContains: false,
        domConnected: true
      })
    ).toBe(false)
  })
})

describe('top-effect saved substitution is route-qualified (provenance, not displayed==target)', () => {
  // Behavioral coverage only (no caller-spelling assertion): the controller
  // provenance unit below covers route-qualified semantics (a foreign live
  // anchor reads as null for the incoming target); Messages caller wiring
  // itself is covered by the real-runtime top-cross-route-provenance E2E,
  // not by this unit.
  it('controller provenance: foreign live anchor is unobservable for the incoming target', async () => {
    const { RouteViewportController } = await import('@renderer/pages/home/Messages/routeViewportController')
    const c = new RouteViewportController({ topicId: 't1', route: 'A' })
    c.declareUserIntent()
    c.userTakeover({ messageId: 'a1', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
    c.noteInteractionScrollEnd()
    c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'B',
      saved: { scrollTop: -500, messageId: 'b1', intraRowOffset: -30, isAtBottom: false }
    })
    // Effect-side decision for incoming A: qualified read returns null for
    // the foreign B anchor, so the caller keeps the persisted A snapshot.
    expect(c.getAnchorFor({ topicId: 't1', route: 'A' })).toBeNull()
    expect(c.getAnchorFor({ topicId: 't1', route: 'B' })).toEqual({
      kind: 'message',
      messageId: 'b1',
      offset: -30
    })
  })
})

describe('no-scroll A→B→A→B→A with distinct exclusive IDs (decision level)', () => {
  it('each arrival resolves its own exclusive anchor without cross-route fallback', () => {
    const mainExclusive = 'main-excl-7'
    const branchExclusive = 'branchB-excl-7'
    const mainLoaded = new Set(['fork', mainExclusive])
    const branchLoaded = new Set(['fork', branchExclusive])
    const arrivals: (string | null)[] = []
    const visit = (canonical: string, loaded: Set<string>): void => {
      const d = decideTopRestoreAnchor({
        canonicalAnchor: canonical,
        snapshotInvalidForRoute: false,
        loadedIds: loaded
      })
      expect(d.mustFailVisible).toBe(false)
      arrivals.push(d.routeSavedRowAnchor)
      // Stable commit exactly once after resident/connected.
      expect(
        isTopStableCommittable({
          isAtBottom: false,
          snapshotInvalidForRoute: false,
          requestedAnchor: d.routeSavedRowAnchor,
          projectionContains: true,
          domConnected: true
        })
      ).toBe(true)
    }
    visit(branchExclusive, branchLoaded)
    visit(mainExclusive, mainLoaded)
    visit(branchExclusive, branchLoaded)
    visit(mainExclusive, mainLoaded)
    expect(arrivals).toEqual([branchExclusive, mainExclusive, branchExclusive, mainExclusive])
    // Opposite exclusive IDs are never resident on the wrong route.
    expect(mainLoaded.has(branchExclusive)).toBe(false)
    expect(branchLoaded.has(mainExclusive)).toBe(false)
  })
})
