/**
 * Tail-gap oracle against the unobscured reading band (test-only).
 *
 * The floating composer overlay (ComposerPlane) covers the bottom strip of
 * #messages, so the container rect bottom is NOT the visible reading edge.
 * Production publishes the measured tail clearance as `--composer-tail-inset`
 * on the chat canvas (inherited by #messages) and reads it via
 * readComposerTailInsetPx; the strict E2E tail assertion must measure against
 * the same unobscured edge: unobscuredBottom = containerBottom - tailInset.
 * Fail-closed 0 keeps the legacy container-bottom behaviour when no overlay
 * info is published (inset unset/garbage => identical to the old metric).
 */
export const TAIL_GAP_TOLERANCE_PX = 100

export function parseComposerTailInsetPx(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value < 0) return 0
  return value
}

export function resolveUnobscuredBottom(containerBottom: number, tailInsetPx: number): number {
  const inset = Number.isFinite(tailInsetPx) && tailInsetPx > 0 ? tailInsetPx : 0
  return containerBottom - inset
}

export function tailGapToUnobscuredBand(tailBottom: number, unobscuredBottom: number): number {
  return tailBottom - unobscuredBottom
}
