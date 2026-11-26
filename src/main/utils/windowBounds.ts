/**
 * Window floor for the derived chat reading minimum.
 *
 * Electron's `setMinimumSize` only constrains FUTURE resizes: it does not grow a
 * window that already sits below the new floor. The chat floor can be raised
 * while the window is still narrow (e.g. the closed-panels minimum), so the floor
 * is applied together with one bounded grow — the window is only ever enlarged
 * to satisfy its own minimum, never shrunk.
 */
export interface MinimumSizeWindow {
  getSize: () => number[]
  setMinimumSize: (width: number, height: number) => void
  setSize: (width: number, height: number) => void
}

const sanitize = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.round(value) : fallback

/**
 * Applies the requested minimum size and, when the live window is narrower than
 * it, grows the window to the floor. Returns the resulting width/height.
 */
export function setMinimumSizeEnsuringBounds(
  window: MinimumSizeWindow,
  width: number,
  height: number,
  fallback: [number, number]
): [number, number] {
  const minWidth = sanitize(width, fallback[0])
  const minHeight = sanitize(height, fallback[1])
  window.setMinimumSize(minWidth, minHeight)
  const [currentWidth = minWidth, currentHeight = minHeight] = window.getSize()
  if (currentWidth >= minWidth) return [currentWidth, currentHeight]
  window.setSize(minWidth, currentHeight)
  return [minWidth, currentHeight]
}
