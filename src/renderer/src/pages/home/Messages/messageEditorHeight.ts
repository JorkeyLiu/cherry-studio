import { loggerService } from '@logger'

const logger = loggerService.withContext('MessageEditorHeight')

/**
 * Renderer-local inline editor height preference.
 *
 * A single numeric localStorage entry (per Electron profile/origin, like all
 * renderer localStorage): it survives editor close/open and application
 * relaunch, but it is deliberately NOT part of any synced settings slice
 * (settings sync across windows; this is private per-window UI geometry) and
 * never touches chat authority (no SQLite/Dexie/sync writes). It must not be
 * renamed: compatibility keys stay stable.
 */
export const MESSAGE_EDITOR_HEIGHT_STORAGE_KEY = 'cherry-chat.message-editor.height.v1'

/** Initial inline height in px when no preference is stored. */
export const MESSAGE_EDITOR_HEIGHT_DEFAULT = 340

/** Absolute lower bound for the displayed inline height in px. */
export const MESSAGE_EDITOR_HEIGHT_MIN = 220

/** Inline height never exceeds this share of the viewport height. */
export const MESSAGE_EDITOR_HEIGHT_MAX_VIEWPORT_RATIO = 0.52

/** Hard sanity ceiling for a stored payload (px); display clamps tighter. */
export const MESSAGE_EDITOR_HEIGHT_ABSOLUTE_MAX = 1600

/** Keyboard resize step in px (Shift = coarse step). */
export const MESSAGE_EDITOR_HEIGHT_KEYBOARD_STEP = 8
export const MESSAGE_EDITOR_HEIGHT_KEYBOARD_COARSE_STEP = 48

/**
 * Validate a raw storage payload. Accepts finite positive numbers (or numeric
 * strings) only; anything else — missing, corrupt JSON, wrong schema,
 * non-positive, non-finite — is null so the caller falls back to default.
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

/**
 * Read the last user-committed inline height, or null when nothing usable is
 * stored. Never throws: inaccessible storage and corrupt payloads fall back
 * to null (a corrupt entry is dropped so it cannot poison future reads).
 */
export function readMessageEditorHeight(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const stored = localStorage.getItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY)
    if (stored === null || stored === '') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(stored)
    } catch {
      // Corrupt JSON: treated as unusable below, and the entry is dropped.
      parsed = undefined
    }
    const height = parseMessageEditorHeight(parsed)
    if (height === null) {
      try {
        localStorage.removeItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY)
      } catch {}
    }
    return height
  } catch (error) {
    logger.warn('Failed to read message editor height preference:', error as Error)
    return null
  }
}

/**
 * Persist the last USER-committed height (pointer-up / keyboard commit only —
 * never per-pointermove, never on viewport resize). Validates before writing;
 * invalid input is ignored. Never throws.
 */
export function writeMessageEditorHeight(height: number): void {
  try {
    const validated = parseMessageEditorHeight(height)
    if (validated === null) return
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY, JSON.stringify(Math.round(validated)))
  } catch (error) {
    logger.warn('Failed to write message editor height preference:', error as Error)
  }
}

export interface MessageEditorHeightBounds {
  min: number
  max: number
}

/**
 * Responsive display bounds for the inline surface. The minimum stays at or
 * below 220px on short viewports so the editor never traps a small window;
 * the maximum mirrors the historical 52vh cap. Guaranteed min <= max.
 */
export function getMessageEditorHeightBounds(viewportHeight?: number): MessageEditorHeightBounds {
  if (typeof viewportHeight !== 'number' || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return { min: MESSAGE_EDITOR_HEIGHT_MIN, max: MESSAGE_EDITOR_HEIGHT_ABSOLUTE_MAX }
  }
  const max = Math.max(160, Math.floor(viewportHeight * MESSAGE_EDITOR_HEIGHT_MAX_VIEWPORT_RATIO))
  const min = Math.min(MESSAGE_EDITOR_HEIGHT_MIN, max)
  return { min, max }
}

/**
 * Clamp a preferred height into the displayable range. Small-window clamps
 * apply here at USE time only — the stored preference itself is never
 * rewritten by a clamp, so reopening in a taller window restores the saved
 * size.
 */
export function resolveMessageEditorDisplayHeight(preferred: number | null, viewportHeight?: number): number {
  const fallback = parseMessageEditorHeight(preferred) ?? MESSAGE_EDITOR_HEIGHT_DEFAULT
  const { min, max } = getMessageEditorHeightBounds(viewportHeight)
  return Math.max(min, Math.min(max, fallback))
}
