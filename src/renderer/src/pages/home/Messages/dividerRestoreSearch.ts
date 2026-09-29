/**
 * Divider restore search state machine (pure decisions, no DOM, no React).
 *
 * Binding invariant: for a divider restore whose requested stable-ID
 * divider/shared anchor is outside the initial resident window, route-stable
 * completion MUST wait until:
 * 1. the requested restore identity is resident/connected (divider row, or
 *    the explicitly selected valid shared-message fallback),
 * 2. the committed window covers that anchor,
 * 3. all pagination needed to reach it has completed (no restore-owned page
 *    is active or queued),
 * 4. the target is aligned to the captured offset,
 * 5. post-alignment layout is quiet.
 * Only then commit the target route's stable snapshot, advance
 * displayed-route provenance, clear the restore intent, end scroll
 * ownership/token, and permit future ordinary saving.
 *
 * `edgeFallbackOnMissing` parking is INTERMEDIATE search placement
 * (`searching`), never final success. The single decision entry
 * `decideDividerRestoreSearchStep` maps one observation to exactly one owner
 * action; only `align-and-commit` may precede a stable commit, and only
 * `terminal-fallback` ends the search without one (preserving the
 * pre-existing target route snapshot — committing an edge/intermediate
 * position would poison future restores with a false divider anchor).
 */

import type { PreferredRestoreAnchorSnapshot } from './routeRestoreAnchor'

/** Bounded restore-owned pagination: oldest-edge termination normally wins first. */
export const MAX_DIVIDER_SEARCH_PAGES = 12

/** Why the search ended without committing a divider-position snapshot. */
export type DividerSearchTerminalReason =
  | 'oldest-edge'
  | 'load-failed'
  | 'page-cap'
  | 'superseded'
  | 'unmounted'
  | 'missing-window'

export interface DividerRestoreSearchInput {
  /** Divider row (requested identity) currently resident/connected. */
  dividerResident: boolean
  /** Explicitly selected valid shared-message fallback currently resident/connected. */
  sharedResident: boolean
  /** Committed window still has older pages to fetch. */
  hasMoreOlder: boolean
  /** A restore-owned older page is currently in flight. */
  loadingOlder: boolean
  /** Restore-owned pages driven so far (cap guard). */
  pagesDriven: number
  /** Topic/route/mounted/epoch still identify this restore (else superseded). */
  targetCurrent: boolean
  /** Component still mounted (else unmounted). */
  mounted: boolean
  /** Committed window exists (else missing-window terminal). */
  hasWindow: boolean
  /** Last older-page fetch failed (fail-closed terminal, never silent retry loop). */
  lastLoadFailed: boolean
}

export type DividerRestoreSearchDecision =
  | {
      action: 'align-and-commit'
      /** Which resident identity to align: requested divider wins over shared fallback. */
      alignKind: 'divider-row' | 'shared-message'
      /** Never commits on this step; the caller aligns, quiets, then commits once. */
      commitStable: false
    }
  | {
      action: 'drive-older'
      /** Restore-owned page carries the preserved preferred anchor identity + offset. */
      preferred: PreferredRestoreAnchorSnapshot
      commitStable: false
    }
  | { action: 'wait-load'; commitStable: false }
  | { action: 'terminal-fallback'; reason: DividerSearchTerminalReason; commitStable: false }

/**
 * Pure single-step decision. No scroll state is consulted: restore-owned
 * pagination is driven explicitly from window/hasMoreOlder/anchor-residency
 * state, never from a scroll event. Every decision carries
 * `commitStable: false`; the caller performs the one stable commit only after
 * `align-and-commit` + quiet, and performs no commit on any other step
 * (terminal paths preserve the pre-existing target route snapshot).
 */
export const decideDividerRestoreSearchStep = (
  input: DividerRestoreSearchInput,
  preferred: PreferredRestoreAnchorSnapshot
): DividerRestoreSearchDecision => {
  if (!input.mounted) return { action: 'terminal-fallback', reason: 'unmounted', commitStable: false }
  if (!input.targetCurrent) return { action: 'terminal-fallback', reason: 'superseded', commitStable: false }
  if (!input.hasWindow) return { action: 'terminal-fallback', reason: 'missing-window', commitStable: false }
  if (input.lastLoadFailed) return { action: 'terminal-fallback', reason: 'load-failed', commitStable: false }
  // Requested identity resident (divider wins over the shared fallback):
  // align to the captured offset, quiet, then commit exactly once.
  if (input.dividerResident) return { action: 'align-and-commit', alignKind: 'divider-row', commitStable: false }
  if (input.sharedResident) return { action: 'align-and-commit', alignKind: 'shared-message', commitStable: false }
  // Anchor absent: an in-flight restore-owned page owns the next observation.
  if (input.loadingOlder) return { action: 'wait-load', commitStable: false }
  if (input.pagesDriven >= MAX_DIVIDER_SEARCH_PAGES) {
    return { action: 'terminal-fallback', reason: 'page-cap', commitStable: false }
  }
  // Authoritative oldest edge reached with the anchor still absent: explicit
  // terminal fallback (fail visible, release exactly once, no false commit).
  if (!input.hasMoreOlder) return { action: 'terminal-fallback', reason: 'oldest-edge', commitStable: false }
  return { action: 'drive-older', preferred, commitStable: false }
}
