/**
 * Content-wrapper layout contract (normal flow, paused-stream fractional zoom).
 *
 * Static source guard for the sole firstElementChild content wrapper inside
 * #messages: same DOM level (no extra wrapper), ordinary DOM order equal to
 * visual order (oldest first), intrinsic content height, and no auto block-start
 * margin — a short flow therefore starts at the top of the scrollport (normal
 * margins, first content first) instead of being pushed to its end. The
 * scrollport still takes the available height, so long content keeps scrolling.
 * That replaces both the previous reversed direction and the device-pixel
 * `calc-size` rounding wrapper: a flow that only grows downward from a stable
 * top needs no fractional-zoom rounding hack. No
 * duplicated layout math, no JS number rounding, no timers/observers/hooks, no
 * manual height writes, no order/data change. Unit/static level only: real
 * pixel bounds are proven by the E2E rAF sampler in
 * tests/e2e/specs/conversation/streaming-click-pause.spec.ts.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

const messagesSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

describe('content-wrapper layout contract', () => {
  it('sole firstElementChild wrapper keeps levels/order, starts at the scrollport top with no auto margin, and carries no quantum hack', () => {
    const src = messagesSrc()
    const containerIdx = src.indexOf('id="messages"')
    expect(containerIdx).toBeGreaterThan(-1)
    const slice = src.slice(containerIdx, containerIdx + 4000)
    // Same DOM: exactly one layout-only flex wrapper directly under the
    // container, holding the app-owned older-paging node (the top prompt no
    // longer renders here).
    expect(slice).toMatch(/display:\s*'flex'/)
    // Normal flow: DOM order IS visual order, so the oldest content (the
    // older-paging node with the message segments) comes first and no
    // direction is reversed.
    expect(slice).toMatch(/flexDirection:\s*'column'/)
    expect(slice).not.toMatch(/column-reverse/)
    expect(slice).toMatch(/data-older-paging/)
    // The top prompt no longer renders: no Prompt node survives in the
    // wrapper, and the older-paging node (message segments inside) is the
    // first content.
    expect(slice).not.toMatch(/<Prompt/)
    expect(slice.indexOf('data-older-paging')).toBeLessThan(slice.indexOf('renderMessageSegments'))
    // Top-start alignment: no auto block-start margin pushing short content to
    // the end of the scrollport, and no reversed direction either.
    expect(slice).not.toMatch(/marginBlockStart/)
    expect(slice).not.toMatch(/justifyContent:\s*'flex-end'/)
    expect(slice).toMatch(/flexShrink:\s*0/)
    // No device-pixel quantum wrapper workaround survives on either side.
    expect(slice).not.toMatch(/calc-size\(/)
    expect(slice).not.toMatch(/--messages-pixel-size/)
  })

  it('no duplicated layout math / JS rounding / new coordination on the wrapper', () => {
    const src = messagesSrc()
    const containerIdx = src.indexOf('id="messages"')
    const slice = src.slice(containerIdx, containerIdx + 4000)
    expect(slice).not.toMatch(/Math\.(round|ceil|floor)/)
    expect(slice).not.toMatch(/scrollHeight/)
    expect(slice).not.toMatch(/getBoundingClientRect/)
    expect(slice).not.toMatch(/requestAnimationFrame/)
    expect(slice).not.toMatch(/ResizeObserver/)
    expect(slice).not.toMatch(/MutationObserver/)
    expect(slice).not.toMatch(/setTimeout/)
    expect(slice).not.toMatch(/setInterval/)
  })
})
