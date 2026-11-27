/**
 * Paired group label+bubble layout — single shared truth.
 *
 * Contract (parent spec):
 * - Available pair width A is measured on the actual pair axis: from the
 *   pill's attached left edge (hostLeft - 8) to the bubble's anchored right
 *   limit (host box right minus the 45px bubble right margin minus the 10px
 *   message-row right inset). A = hostWidth - 47 (8 + 45 + 10), fixed
 *   paddings/margins counted once, never double-91; verified against the real
 *   rendered frame at 1790/1440/1000.
 * - GAP = 10 is the single truth. Both widths shrink simultaneously by the
 *   SAME t, never sequentially, never a free-gap observer after the bubble,
 *   never a leader/compact replacement, never a fixed 120 floor, never a
 *   special width at 641.
 * - S = (Lp - Lm) + (Bp - Bm); t = clamp((A - GAP - Lm - Bm) / S, 0, 1)
 *   (S <= 0 handled: already at minima). L = Lm + t*(Lp-Lm),
 *   B = Bm + t*(Bp-Bm).
 * - When A >= Lp + Bp + GAP both stay preferred and the spare distributes as
 *   gap >= 10 (bubble anchored right, label left). When A < Lm + Bm + GAP the
 *   pair stays at minima and the caller propagates the minimum required
 *   reading width — gap never collapses, label/body never underflow.
 * - Long-bubble preferred is the existing generic continuous cap
 *   (42rem / reading %); short-bubble preferred is its intrinsic (never the
 *   cap). Min bubble is 12rem (192 CSSpx at 16px root, root-scaled otherwise);
 *   short content with intrinsic <= min collapses both min/preferred to that
 *   intrinsic so no forced-wide bubble.
 * - The returned bubble value is a MAX-WIDTH CAP, never an assigned width: the
 *   consumer keeps the bubble's own `width: fit-content` and the generic cap and
 *   can only narrow it, so pairing never widens a short bubble's rendered box.
 */

export const PAIRED_GROUP_GAP_PX = 10

/**
 * Fixed pair-axis chrome, counted once: the pill's attached edge sits 8px left
 * of the run host, and the user bubble's content box ends 55px right of the host
 * (45px bubble right margin + the 10px message-row right inset). So the pair
 * axis runs from hostLeft - 8 to hostRight - 55 and A = hostWidth - 47.
 */
export const PAIRED_AXIS_FIXED_PX = 47

/**
 * Fixed non-article chrome measured once against the real window: navbar +
 * scroll-container gutters + the single workspace resizer handle + the
 * message scrollbar. The 89px budget is kept conservative (it still covers
 * the retired second handle) so a fixed window is never squeezed below the
 * reading minimum: window = PAIRED_APP_CHROME_PX + sidebar + chat column,
 * the chat minimum never double-counts these.
 */
export const PAIRED_APP_CHROME_PX = 89

/** Min bubble in rem — resolved against the root font size. */
export const PAIRED_BUBBLE_MIN_REM = 12

export interface PairedWidths {
  /** Applied label width. */
  label: number
  /** Bubble max-width cap (never an assigned width; `fit-content` governs). */
  bubble: number
  /** Applied inter-pair gap (>= 10). */
  gap: number
  /** Shared shrink factor (1 = both preferred, 0 = both minima). */
  t: number
  /** Minimum pair budget Lm + Bm + GAP (caller adds fixed chrome). */
  minPair: number
  /** Whether A fell below the minimum (caller must grow/propagate). */
  belowMin: boolean
}

export function bubbleMinPx(rootFontPx?: number): number {
  const root = Number.isFinite(rootFontPx as number) && (rootFontPx as number) > 0 ? (rootFontPx as number) : 16
  return PAIRED_BUBBLE_MIN_REM * root
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function resolvePairedWidths(
  availablePairWidth: number,
  preferredLabel: number,
  minLabel: number,
  preferredBubble: number,
  minBubble: number
): PairedWidths {
  const Lp = Math.max(0, preferredLabel)
  const Lm = Math.max(0, Math.min(minLabel, Lp))
  const Bp = Math.max(0, preferredBubble)
  // Short content: intrinsic <= generic min never forces a wide bubble.
  const intrinsicShort = Math.min(Lp, Bp)
  void intrinsicShort
  const BmRaw = Math.max(0, Math.min(minBubble, Bp))
  const Bm = BmRaw
  const minPair = Lm + Bm + PAIRED_GROUP_GAP_PX
  const A = availablePairWidth
  if (!Number.isFinite(A) || A < minPair) {
    return { label: Lm, bubble: Bm, gap: PAIRED_GROUP_GAP_PX, t: 0, minPair, belowMin: true }
  }
  const prefSum = Lp + Bp + PAIRED_GROUP_GAP_PX
  if (A >= prefSum) {
    return { label: Lp, bubble: Bp, gap: A - Lp - Bp, t: 1, minPair, belowMin: false }
  }
  const S = Lp - Lm + (Bp - Bm)
  if (S <= 0) {
    return { label: Lm, bubble: Bm, gap: PAIRED_GROUP_GAP_PX, t: 0, minPair, belowMin: false }
  }
  const t = clamp01((A - PAIRED_GROUP_GAP_PX - Lm - Bm) / S)
  return {
    label: Lm + t * (Lp - Lm),
    bubble: Bm + t * (Bp - Bm),
    gap: PAIRED_GROUP_GAP_PX,
    t,
    minPair,
    belowMin: false
  }
}

/** Chat floor independent of sidebars: pair minima + the pair-axis chrome. */
export function pairedChatColumnMin(minPair: number, navGutterPx = 0): number {
  if (!Number.isFinite(minPair) || minPair <= 0) return 0
  return minPair + PAIRED_AXIS_FIXED_PX + (navGutterPx > 0 ? navGutterPx : 0)
}

/** Required window width: max(existing policy, chrome + sidebar + reading). */
export function requiredWindowWidth(
  policyWidth: number,
  sidebar: number,
  chatColumnMin: number,
  appChrome = PAIRED_APP_CHROME_PX
): number {
  return Math.max(policyWidth, appChrome + sidebar + chatColumnMin)
}

/**
 * Sidebar drag clamp in a fixed window: stop before squeezing the chat column.
 * appChrome already counts the single resizer handle, so nothing is added twice.
 */
export function sidebarDragMax(
  windowWidth: number,
  chatColumnMin: number,
  absoluteMax = 600,
  appChrome = PAIRED_APP_CHROME_PX
): number {
  return Math.min(absoluteMax, windowWidth - appChrome - chatColumnMin)
}

/** Generic long-bubble cap mirror (browser resolves % against column width). */
export function genericBubbleCapPx(columnWidthPx: number, rootFontPx = 16): number {
  const cap42 = 42 * rootFontPx
  return Math.min(cap42, columnWidthPx - 91, 0.8 * columnWidthPx)
}
