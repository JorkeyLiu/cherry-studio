/**
 * Semantic regression for the authoritative reference re-read in a TERMINAL
 * viewport (the real failure: an open reference target stopped re-reading
 * Main after its viewport session had released to `terminal`).
 *
 * Observed production sequence (E2E, two-device relay):
 *   1. Main delivers a correct `ChatDb_HistoryReferenceInvalidated` hint for the
 *      resident target (token raised, provenance marked failed).
 *   2. The passive route effect re-runs and hits the terminal no-retry guard
 *      BEFORE it ever consults the obligation.
 *   3. No `fetch-messages-window` is issued, so the resident relation stays
 *      `available` with the stale foreign prefix — and stays that way for every
 *      later hint (rename, restore) because the terminal phase persists.
 *
 * The obligation is an explicit external trigger with a monotonic one-shot
 * token, not a progress reentry, so the terminal gate must not swallow it.
 * These cases pin that decision (and its composition with the topic-bound
 * token decision) rather than the source text.
 */
import { describe, expect, it } from 'vitest'

import {
  isReferenceReloadObliged,
  type ReferenceReloadObligation,
  shouldRouteEffectHoldTerminal
} from '../messageWindow'

const RESIDENT = 'topic-resident'

/** Compose the two production decisions exactly as the route effect does. */
const wouldRead = (
  phase: string,
  pending: ReferenceReloadObligation | null,
  consumed: number,
  topicId: string = RESIDENT
): boolean => {
  const obliged = isReferenceReloadObliged(pending, consumed, topicId)
  return !shouldRouteEffectHoldTerminal({ phase, referenceReloadObliged: obliged })
}

describe('shouldRouteEffectHoldTerminal (terminal no-retry gate)', () => {
  it('holds a terminal viewport when nothing authoritative is outstanding', () => {
    expect(shouldRouteEffectHoldTerminal({ phase: 'terminal', referenceReloadObliged: false })).toBe(true)
  })

  it('never holds a live session (only terminal releases are no-retry)', () => {
    for (const phase of ['idle', 'fetch-hold', 'positioning', 'searching', 'aligned', 'stable']) {
      expect(shouldRouteEffectHoldTerminal({ phase, referenceReloadObliged: false }), phase).toBe(false)
    }
  })

  it('releases the terminal hold for an outstanding reference obligation', () => {
    // The failure this pins: previously the effect returned here and the hint
    // was lost forever.
    expect(shouldRouteEffectHoldTerminal({ phase: 'terminal', referenceReloadObliged: true })).toBe(false)
  })
})

describe('terminal reference re-read composition (actual cause)', () => {
  it('a hint for the resident target re-reads even after the session released to terminal', () => {
    expect(wouldRead('terminal', { token: 4, topicId: RESIDENT }, 3)).toBe(true)
  })

  it('a terminal viewport still does not retry on its own (no progress reentry)', () => {
    expect(wouldRead('terminal', null, 3)).toBe(false)
    expect(wouldRead('terminal', { token: 4, topicId: RESIDENT }, 4)).toBe(false)
  })

  it('is one-shot: the same hint never re-reads twice after the pipeline consumes it', () => {
    const pending = { token: 4, topicId: RESIDENT }
    expect(wouldRead('terminal', pending, 3)).toBe(true)
    // The re-read pipeline consumed token 4 when it claimed the session.
    expect(wouldRead('terminal', pending, 4)).toBe(false)
  })

  it('a newer hint raised during the in-flight re-read outlives the consume', () => {
    expect(wouldRead('terminal', { token: 5, topicId: RESIDENT }, 4)).toBe(true)
  })

  it('stays fail-closed for another topic (a foreign obligation never re-reads this route)', () => {
    expect(wouldRead('terminal', { token: 9, topicId: 'topic-other' }, 0)).toBe(false)
  })

  it('keeps re-reading across successive waves (rename → edit → delete)', () => {
    let consumed = 0
    for (const token of [1, 2, 3]) {
      const pending = { token, topicId: RESIDENT }
      expect(wouldRead('terminal', pending, consumed), `wave token ${token}`).toBe(true)
      consumed = token
      expect(wouldRead('terminal', pending, consumed), `wave token ${token} settled`).toBe(false)
    }
  })
})
