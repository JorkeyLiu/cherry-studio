/**
 * Position primitives for route viewport anchoring (pure unless noted).
 *
 * The single route viewport transition controller owns transition truth
 * (epoch/intent/phase/ownership/displayed/anchor); persistent stable
 * anchoring runs in the scoped keeper (`routeViewportContext`), not in a
 * loop here. This module keeps only pure decisions:
 * - `isRestoreTargetValid` (topic/route/mounted/epoch currency),
 * - single-frame keyboard pre-cancel (`shouldCancelStabilizerForKeyDown`).
 */

/**
 * Pure restore-target validity: topic + route + mounted + this restore
 * generation still current. Deliberately independent of the viewport scroll
 * token: `beginScroll('anchoring'/'programmatic')` closes
 * `canHandleUserViewportScroll` by design, so consulting it here would
 * self-cancel every restore. Anchoring therefore keeps this true.
 */
export const isRestoreTargetValid = (input: {
  topicMatch: boolean
  routeMatch: boolean
  mounted: boolean
  epochCurrent: boolean
}): boolean => input.topicMatch && input.routeMatch && input.mounted && input.epochCurrent

/**
 * Keyboard scroll pre-cancel: ArrowUp/Down, PageUp/Down, Home/End, Space.
 * Input targets never cancel (INPUT/TEXTAREA/SELECT/contentEditable), and
 * modified keys (Ctrl/Meta/Alt) are ignored so shortcuts never miscancel.
 */
const STABILIZER_CANCEL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])

const isStabilizerScrollKey = (key: string): boolean => STABILIZER_CANCEL_KEYS.has(key)

const isEditableTarget = (target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean => {
  if (!target) return false
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable === true
}

export const shouldCancelStabilizerForKeyDown = (
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined
): boolean => {
  if (!isStabilizerScrollKey(event.key)) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (isEditableTarget(target)) return false
  return true
}

/**
 * Browse-direction input primitive (pure, semantic only).
 *
 * At a clamped edge no scroll event can fire (the viewport cannot move), so a
 * genuine gesture would never page through the post-scroll path. The input
 * adapter therefore reports the browse DIRECTION the input itself expresses;
 * whether that direction may actually page is decided afterwards against live
 * session, ownership, committed-viewport and edge geometry — one shared path
 * for both directions, never a per-direction flow.
 *
 * - wheel: `deltaY` sign only (`< 0` toward older, `> 0` toward newer; sign,
 *   never magnitude thresholds or event counts);
 * - keys: `PageUp` / `ArrowUp` / `Home` toward older, `PageDown` /
 *   `ArrowDown` / `End` toward newer, `Space` toward the native page
 *   direction (`Shift+Space` toward older);
 * - pointer / touch / focus carry no direction at all (a press at an edge is
 *   not a browse gesture).
 *
 * The native default is always preserved (no preventDefault, no custom
 * page-scroll arithmetic).
 */
export type BrowseInputDirection = 'older' | 'newer'

export type BrowsePagingInput =
  | { kind: 'wheel'; deltaY: number }
  | { kind: 'key'; key: string; shiftKey?: boolean }
  | { kind: 'pointer' }
  | { kind: 'touch' }
  | { kind: 'focus' }

export const browseDirectionForClampedInput = (input: BrowsePagingInput): BrowseInputDirection | null => {
  switch (input.kind) {
    case 'wheel':
      if (!Number.isFinite(input.deltaY) || input.deltaY === 0) return null
      return input.deltaY < 0 ? 'older' : 'newer'
    case 'key': {
      if (input.key === 'PageUp' || input.key === 'ArrowUp' || input.key === 'Home') return 'older'
      if (input.key === 'PageDown' || input.key === 'ArrowDown' || input.key === 'End') return 'newer'
      if (input.key === ' ' || input.key === 'Spacebar') return input.shiftKey === true ? 'older' : 'newer'
      return null
    }
    default:
      return null
  }
}

/**
 * One viewport geometry sample of a row: its viewport-relative offset (row top
 * minus scroll-container top, the same coordinate the stable anchor records)
 * together with the container `scrollTop` measured at the SAME instant.
 */
export interface ViewportGeometrySample {
  viewportOffset: number
  scrollTop: number
}

/**
 * Layout metric of a sampled row: `viewportOffset + scrollTop`.
 *
 * This sum is INVARIANT under user scrolling in both scroll conventions: input
 * moves the scroll position and the row's viewport offset by equal and opposite
 * amounts (column-reverse included, where `scrollTop` decreases as the viewport
 * moves toward the visually older edge). It changes only when layout/content
 * moves the row, so the DIFFERENCE of this metric is the layout-only
 * displacement — compensating exactly that holds a row through layout growth
 * without cancelling the movement the user's own input produced.
 */
export const viewportLayoutMetric = (sample: ViewportGeometrySample): number => sample.viewportOffset + sample.scrollTop

/**
 * Layout-only displacement of a sampled row since a captured baseline metric.
 *
 * `null` means "no input-independent baseline exists" (never captured, route or
 * anchor identity moved, stale window generation, invalid numbers): the caller
 * must fail closed to its existing behavior instead of inventing a baseline.
 * A non-null result is the actuator input (`scrollTop += displacement`), which
 * is the only value that corrects layout without undoing user movement.
 */
export const layoutOnlyDisplacement = (
  baselineMetric: number | null,
  current: ViewportGeometrySample
): number | null => {
  if (baselineMetric === null || !Number.isFinite(baselineMetric)) return null
  const metric = viewportLayoutMetric(current)
  if (!Number.isFinite(metric)) return null
  return metric - baselineMetric
}

/** Subpixel tolerance of every layout/position comparison (same 1px budget). */
export const VIEWPORT_GEOMETRY_EPSILON_PX = 1

/** Whether a displacement is measurable beyond subpixel rounding. */
export const isMeasurableDisplacement = (displacement: number | null): displacement is number =>
  displacement !== null && Number.isFinite(displacement) && Math.abs(displacement) > VIEWPORT_GEOMETRY_EPSILON_PX
