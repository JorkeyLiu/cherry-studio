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
