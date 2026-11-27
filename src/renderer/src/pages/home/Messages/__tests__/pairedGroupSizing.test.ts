import { describe, expect, it } from 'vitest'

import {
  bubbleMinPx,
  genericBubbleCapPx,
  PAIRED_APP_CHROME_PX,
  PAIRED_AXIS_FIXED_PX,
  PAIRED_GROUP_GAP_PX,
  pairedChatColumnMin,
  requiredWindowWidth,
  resolvePairedWidths,
  sidebarDragMax
} from '../pairedGroupSizing'

describe('resolvePairedWidths — shared pair budget', () => {
  it('keeps a 10px gap and both preferred when the pair fits', () => {
    const r = resolvePairedWidths(500, 200, 80, 200, 150)
    expect(r.t).toBe(1)
    expect(r.label).toBe(200)
    expect(r.bubble).toBe(200)
    expect(r.gap).toBe(100)
    expect(r.gap).toBeGreaterThanOrEqual(PAIRED_GROUP_GAP_PX)
    expect(r.belowMin).toBe(false)
  })

  it('distributes spare as gap, never grows past preferred', () => {
    const r = resolvePairedWidths(1000, 280, 60, 400, 192)
    expect(r.label).toBe(280)
    expect(r.bubble).toBe(400)
    expect(r.gap).toBe(1000 - 280 - 400)
  })

  it('shrinks both by the SAME t above minima', () => {
    const Lp = 280
    const Lm = 60
    const Bp = 500
    const Bm = 192
    const S = Lp - Lm + (Bp - Bm)
    const A = Lm + Bm + 10 + S * 0.5
    const r = resolvePairedWidths(A, Lp, Lm, Bp, Bm)
    expect(r.t).toBeCloseTo(0.5, 9)
    const tL = (r.label - Lm) / (Lp - Lm)
    const tB = (r.bubble - Bm) / (Bp - Bm)
    expect(tL).toBeCloseTo(tB, 9)
    expect(r.gap).toBe(PAIRED_GROUP_GAP_PX)
  })

  it('is monotonic and continuous across the sweep', () => {
    const Lp = 280
    const Lm = 70
    const Bp = 600
    const Bm = 192
    let prevL = -1
    let prevB = -1
    for (let A = 0; A <= 1200; A += 4) {
      const r = resolvePairedWidths(A, Lp, Lm, Bp, Bm)
      if (!r.belowMin) {
        expect(r.label).toBeGreaterThanOrEqual(prevL - 1e-9)
        expect(r.bubble).toBeGreaterThanOrEqual(prevB - 1e-9)
        prevL = r.label
        prevB = r.bubble
      }
      expect(r.gap).toBeGreaterThanOrEqual(PAIRED_GROUP_GAP_PX - 1e-9)
    }
    // Transition continuity at the preferred boundary: ±1px stays within 1px.
    const pref = Lp + Bp + 10
    const below = resolvePairedWidths(pref - 1, Lp, Lm, Bp, Bm)
    const at = resolvePairedWidths(pref, Lp, Lm, Bp, Bm)
    expect(Math.abs(at.label - below.label)).toBeLessThanOrEqual(1.001)
    expect(Math.abs(at.bubble - below.bubble)).toBeLessThanOrEqual(1.001)
  })

  it('floors at minima and flags below-min without collapsing the gap', () => {
    const r = resolvePairedWidths(100, 280, 70, 500, 192)
    expect(r.label).toBe(70)
    expect(r.bubble).toBe(192)
    expect(r.gap).toBe(10)
    expect(r.belowMin).toBe(true)
    expect(r.minPair).toBe(70 + 192 + 10)
  })
  it('handles short content without forced-wide bubbles or priorities', () => {
    // Short intrinsic: preferred equals intrinsic, min collapses to it.
    const intrinsic = 120
    const r = resolvePairedWidths(400, 100, 60, intrinsic, Math.min(192, intrinsic))
    expect(r.label).toBe(100)
    expect(r.bubble).toBe(intrinsic)
    expect(r.gap).toBe(400 - 100 - intrinsic)
    // Both above minima share one t — no sequential clamp, no fixed 120 floor.
    const r2 = resolvePairedWidths(200, 100, 60, 180, 120)
    expect(r2.t).toBeGreaterThan(0)
    expect(r2.t).toBeLessThan(1)
    expect((r2.label - 60) / (100 - 60)).toBeCloseTo(r2.t, 9)
    expect((r2.bubble - 120) / (180 - 120)).toBeCloseTo(r2.t, 9)
  })

  it('handles degenerate S without NaN', () => {
    const r = resolvePairedWidths(50, 60, 60, 192, 192)
    expect(Number.isFinite(r.label)).toBe(true)
    expect(Number.isFinite(r.bubble)).toBe(true)
  })

  it('pins the 10px gap constant and the 12rem bubble floor', () => {
    expect(PAIRED_GROUP_GAP_PX).toBe(10)
    expect(bubbleMinPx(16)).toBe(192)
    expect(bubbleMinPx(14)).toBeCloseTo(168, 9)
    // Generic cap stays monotonic (existing continuous rule).
    expect(genericBubbleCapPx(640)).toBeCloseTo(512, 9)
    expect(genericBubbleCapPx(1790)).toBe(672)
  })

  it('derives a sidebar-independent chat floor and sums the window once', () => {
    const minPair = 70 + 192 + 10
    const chatMin = pairedChatColumnMin(minPair)
    expect(chatMin).toBe(minPair + PAIRED_AXIS_FIXED_PX)
    expect(pairedChatColumnMin(0)).toBe(0)
    // The nav gutter belongs to the article, not to the app chrome.
    expect(pairedChatColumnMin(minPair, 46)).toBe(minPair + PAIRED_AXIS_FIXED_PX + 46)
    // Policy dominates while the summed chrome stays under it.
    expect(requiredWindowWidth(960, 275, 0)).toBe(960)
    expect(requiredWindowWidth(960, 0, chatMin)).toBe(960)
    // Summed chrome (fixed chrome + single sidebar + reading) dominates past policy.
    expect(requiredWindowWidth(520, 275, chatMin)).toBe(PAIRED_APP_CHROME_PX + 275 + chatMin)
    // Closing the sidebar lowers the window; an inactive pair resets to policy.
    expect(requiredWindowWidth(520, 0, 0)).toBe(520)
  })

  it('clamps sidebar drags at a fixed window before squeezing chat', () => {
    const chatMin = pairedChatColumnMin(70 + 192 + 10)
    // Wide window: the 600 cap governs, never the raw budget.
    expect(sidebarDragMax(1400, chatMin)).toBe(600)
    // Narrow window: only the remaining budget is allowed, never past 600.
    expect(sidebarDragMax(1000, chatMin)).toBe(1000 - PAIRED_APP_CHROME_PX - chatMin)
    expect(sidebarDragMax(900, chatMin)).toBeLessThan(600)
    expect(sidebarDragMax(900, chatMin, 300)).toBeLessThanOrEqual(300)
  })
})

describe('genericBubbleCapPx — the cap belongs to the content column', () => {
  it('resolves 100% against the message content column, never the row host', () => {
    // The generic rule is `min(42rem, calc(100% - 91px), 80%)`; `100%` resolves
    // against the rendered content parent of the bubble, which already excludes
    // the row inset. Feeding the row host over-sizes the cap by that inset.
    const rowInset = 20
    const hostWidth = 700
    const contentColumn = hostWidth - rowInset
    expect(genericBubbleCapPx(contentColumn, 16)).toBe(0.8 * contentColumn)
    expect(genericBubbleCapPx(hostWidth, 16)).toBe(0.8 * hostWidth)
    expect(genericBubbleCapPx(contentColumn, 16)).toBeLessThan(genericBubbleCapPx(hostWidth, 16))
    // 42rem stays the continuous cap on wide columns regardless of the column.
    expect(genericBubbleCapPx(contentColumn + 2000, 16)).toBe(42 * 16)
    // A pair built from the content-column cap still closes its budget with gap >= 10.
    const r = resolvePairedWidths(600, 200, 80, genericBubbleCapPx(contentColumn, 16), 192)
    expect(r.gap).toBeGreaterThanOrEqual(PAIRED_GROUP_GAP_PX)
  })
})
