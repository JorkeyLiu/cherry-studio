import { loggerService } from '@logger'

const logger = loggerService.withContext('MessageEditorHeight')

/**
 * Inline editor height geometry (session-only, never persisted).
 *
 * ONE sizing logic and bounds: the inline surface defaults to a
 * content-adaptive height measured from the live CodeMirror engine
 * (`contentHeight` at the current width), and an explicit drag/keyboard
 * adjustment sets a manual height for THIS edit session only. Both paths
 * are just ways to supply a desired height into the SAME resolver below —
 * there are no separate auto/manual floors or clamps.
 *
 * The single lower bound reflects one actual rendered text line plus normal
 * vertical padding, not an arbitrary minimum. Measured runtime geometry
 * (600px viewport, 14px type at 1.6 line-height): one `.cm-line` is 22.4px
 * tall, `.cm-content` carries 4px + 4px of vertical padding, so one rendered
 * text line naturally occupies ~30.4px. The 40px floor is that natural line
 * plus normal slack/rounding — short one-line drafts render with only a
 * small normal pad below the text, never a large empty area. Two-line and
 * wrapped short content sizes to its actual natural document height, and
 * long drafts grow up to the shared 52vh maximum, then scroll internally.
 * Toolbar and action-bar heights live outside the input surface and are
 * preserved independently of this floor.
 *
 * The manual session override never persists: later text edits never
 * overwrite it, and close/save/cancel + reopen starts adaptive again.
 * Nothing here touches chat authority or synced settings; there is no
 * storage key by design (a stale saved height must never pin a new session).
 */

/**
 * Single lower bound for the input surface in px: one rendered text line
 * plus normal vertical padding/slack (see above). Used by BOTH the adaptive
 * measurement path and the explicit manual path — dragging an adaptive
 * short draft starts from the actually displayed height with no jump.
 */
export const MESSAGE_EDITOR_HEIGHT_MIN = 40

/** Inline height never exceeds this share of the viewport height. */
export const MESSAGE_EDITOR_HEIGHT_MAX_VIEWPORT_RATIO = 0.52

/** Hard sanity ceiling for a height payload (px); display clamps tighter. */
export const MESSAGE_EDITOR_HEIGHT_ABSOLUTE_MAX = 1600

/**
 * Slack added to the live engine's measured natural content height when
 * sizing the input surface (subpixel rounding + the borderless flex chain
 * between the surface and the scroller), so the last line is never clipped
 * by a 1px shortfall.
 */
export const MESSAGE_EDITOR_MEASURED_CHROME_PX = 4

/**
 * Per-line estimate used ONLY for the first paint before the live engine
 * reports its measured content height (approx 14px type at 1.6 line-height).
 */
export const MESSAGE_EDITOR_ESTIMATE_LINE_PX = 22

/**
 * Fixed chrome in the first-paint estimate (content padding + normal slack):
 * a single-line draft estimates exactly at the single floor (never a
 * large-height flash, never a jump when the first measurement lands).
 */
export const MESSAGE_EDITOR_ESTIMATE_CHROME_PX = 18

/** Keyboard resize step in px (Shift = coarse step). */
export const MESSAGE_EDITOR_HEIGHT_KEYBOARD_STEP = 8
export const MESSAGE_EDITOR_HEIGHT_KEYBOARD_COARSE_STEP = 48

/**
 * Validate a raw height payload. Accepts finite positive numbers (or numeric
 * strings) only; anything else is null so the caller keeps its current value.
 */
export function parseMessageEditorHeight(raw: unknown): number | null {
  try {
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
    return value
  } catch {
    return null
  }
}

export interface MessageEditorHeightBounds {
  min: number
  max: number
}

/**
 * Responsive display bounds for the inline surface. The single minimum is
 * the one-line floor above; the maximum mirrors the historical 52vh cap.
 * Guaranteed min <= max (short viewports clamp the maximum first, then the
 * minimum yields to it so the editor never traps a small window).
 */
export function getMessageEditorHeightBounds(viewportHeight?: number): MessageEditorHeightBounds {
  if (typeof viewportHeight !== 'number' || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return { min: MESSAGE_EDITOR_HEIGHT_MIN, max: MESSAGE_EDITOR_HEIGHT_ABSOLUTE_MAX }
  }
  const max = Math.max(MESSAGE_EDITOR_HEIGHT_MIN, Math.floor(viewportHeight * MESSAGE_EDITOR_HEIGHT_MAX_VIEWPORT_RATIO))
  const min = Math.min(MESSAGE_EDITOR_HEIGHT_MIN, max)
  return { min, max }
}

/**
 * THE single height resolver for the inline surface. Every desired height —
 * whether from the adaptive measurement (engine content height + slack, or
 * the first-paint estimate) or from an explicit session-manual
 * drag/keyboard adjustment — passes through here. Desired values below the
 * one-line floor rise to it, values above the 52vh maximum clamp to it, and
 * invalid input falls back to the floor so a bad report can never collapse
 * the surface. Manual commits store this displayed effective height, so what
 * the user sees is what the session keeps.
 */
export function resolveMessageEditorHeight(desired: number, viewportHeight?: number): number {
  const { min, max } = getMessageEditorHeightBounds(viewportHeight)
  // Finite numbers clamp silently (an over-drag past zero is just the floor,
  // never a collapse); only corrupt payloads warn.
  if (typeof desired === 'number' && Number.isFinite(desired)) {
    return Math.max(min, Math.min(max, desired))
  }
  const valid = parseMessageEditorHeight(desired)
  if (valid === null) {
    logger.warn('Ignoring invalid editor height; keeping the one-line floor.')
    return min
  }
  return Math.max(min, Math.min(max, valid))
}

/**
 * First-paint estimate before the live engine reports its measured height.
 * Counts physical lines only (wraps resolve upward after mount, never into a
 * large-height flash): a single-line draft estimates exactly at the single
 * floor, long drafts estimate at the 52vh maximum they will measure into.
 * Clamped through the same single resolver as every other path.
 */
export function estimateMessageEditorAutoHeight(content: string, viewportHeight?: number): number {
  const lines = typeof content === 'string' && content.length > 0 ? content.split('\n').length : 1
  const raw = MESSAGE_EDITOR_ESTIMATE_CHROME_PX + Math.max(1, lines) * MESSAGE_EDITOR_ESTIMATE_LINE_PX
  return resolveMessageEditorHeight(raw, viewportHeight)
}
