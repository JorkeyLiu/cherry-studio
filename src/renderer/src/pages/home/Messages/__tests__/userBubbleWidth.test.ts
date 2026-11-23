/**
 * Generic user-bubble width contract (all user messages, no model/name
 * special): short bubbles stay intrinsic and right-aligned; long bodies cap
 * at a reading proportion of the ACTUAL message column through ONE
 * continuous formula — `min(42rem, calc(100% - 91px), 80%)` — never a
 * width switch. Grouped and ungrouped bodies share the identical rule:
 * grouping never shrinks the bubble; the group label clamps to the free gap
 * instead (see `TopicSegmentLine`). Asserts the shipped stylesheet and the
 * components that must NOT carry reservation hooks (no float/reflow/margin
 * experiments, no `message-mentions` classes, no dead header mark), plus a
 * numeric proof that the shipped formula is monotonic and jump-free across
 * the reading-column sweep.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, '../../../../assets/styles/index.css'), 'utf8')
const messageTsx = readFileSync(resolve(here, '../Message.tsx'), 'utf8')
const messageContentTsx = readFileSync(resolve(here, '../MessageContent.tsx'), 'utf8')
const mainTextBlockTsx = readFileSync(resolve(here, '../Blocks/MainTextBlock.tsx'), 'utf8')
const sharedTsx = readFileSync(resolve(here, '../shared.tsx'), 'utf8')

/**
 * The shipped cap evaluated as the browser resolves it: `100%` and `80%`
 * both resolve against the same message-column width `w`, and `42rem`
 * resolves against the 16px root (`672px`). Mirrors the stylesheet formula
 * exactly — if the formula changes, this mirror must change with it (the
 * stylesheet assertion below pins the literal text).
 */
const bubbleCapFor = (columnWidthPx: number): number => Math.min(672, columnWidthPx - 91, 0.8 * columnWidthPx)

describe('generic user-bubble width', () => {
  it('keeps short bubbles intrinsic and right-aligned with the existing side margins', () => {
    expect(css).toMatch(/\.message-user\s+\.message-content-container\s*\{[^}]*width:\s*fit-content/)
    expect(css).toContain('margin-left: 46px')
    expect(css).toContain('margin-right: 45px')
  })

  it('caps long bodies with ONE continuous formula (no narrow/wide switch, no jump)', () => {
    expect(css).toMatch(/max-width:\s*min\(42rem,\s*calc\(100%\s*-\s*91px\),\s*80%\)/)
  })

  it('carries no container-query width switch (the reverse-jump source is gone)', () => {
    expect(css).not.toMatch(/calc\(80%\s*-\s*91px\)/)
    expect(css).not.toMatch(/@container[^{]*\{[^}]*message-content-container/)
    // The scrollport keeps its container-type (house convention); it simply
    // no longer keys a bubble width switch.
    expect(sharedTsx).toContain('container-type: inline-size')
  })

  it('the shipped cap is monotonic and jump-free across the reading-column sweep', () => {
    const widths: number[] = []
    for (let w = 280; w <= 1100; w += 16) widths.push(w)
    // Critical points: the old 641px switch edges, the binding handoffs
    // (100%-91 meets 80% at 455; 80% meets 42rem at 840) and ±1 around each.
    for (const w of [454, 455, 456, 639, 640, 641, 642, 839, 840, 841]) widths.push(w)
    widths.sort((a, b) => a - b)
    const caps = widths.map(bubbleCapFor)
    for (let i = 1; i < caps.length; i += 1) {
      expect(caps[i], `monotonic at column ${widths[i]}px`).toBeGreaterThanOrEqual(caps[i - 1])
      const step = widths[i] - widths[i - 1]
      // A continuous formula can move at most 1px per column px (the
      // steepest binding arm is 100% - 91px); anything more is a jump.
      expect(caps[i] - caps[i - 1], `no jump into column ${widths[i]}px`).toBeLessThanOrEqual(step)
    }
    // Spot facts of the three binding arms: near-full narrow, 80% middle,
    // 42rem far wide.
    expect(bubbleCapFor(280)).toBeCloseTo(189, 9)
    expect(bubbleCapFor(640)).toBeCloseTo(512, 9)
    expect(bubbleCapFor(1790)).toBe(672)
  })

  it('keeps inner code/table/media inside the capped bubble (assistant width untouched)', () => {
    for (const selector of ['pre', 'table', 'img', 'video']) {
      expect(css).toContain(`.message-user .message-content-container ${selector}`)
    }
    expect(css).not.toMatch(/\.message-assistant[^{]*max-width:\s*min\(42rem/)
  })

  it('carries no group reservation against the bubble (float/reflow/margin experiments removed)', () => {
    expect(css).not.toContain('headed-first-message')
    expect(css).not.toContain('--seg-head-pill-w')
    expect(messageTsx).not.toContain('headed-first-message')
    expect(messageContentTsx).not.toContain('message-mentions')
    expect(mainTextBlockTsx).not.toContain('message-mentions')
  })
})
