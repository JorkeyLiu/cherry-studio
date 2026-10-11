/**
 * Content-wrapper intrinsic-height contract (paused-stream fractional zoom).
 *
 * Static source guard for the sole firstElementChild content wrapper inside
 * #messages: same DOM level (no extra wrapper), top-aligned reversed
 * children, native TRUE intrinsic height (content + margins rounded up to the
 * live device-pixel quantum via `--messages-pixel-size`). The keeper
 * synchronizes the var to `1/window.devicePixelRatio` on the existing wrapper
 * through the existing observer/layout path (no new state/listeners). No
 * duplicated layout math, no JS number rounding, no timers/observers/hooks,
 * no manual height writes, no order/data change. Unit/static level only: real
 * pixel bounds are proven by the E2E rAF sampler in
 * tests/e2e/specs/conversation/streaming-click-pause.spec.ts.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

const messagesSrc = () => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

describe('content-wrapper intrinsic-height contract', () => {
  it('sole firstElementChild wrapper keeps levels/order, top-aligns, uses native quantum intrinsic height', () => {
    const src = messagesSrc()
    const containerIdx = src.indexOf('id="messages"')
    expect(containerIdx).toBeGreaterThan(-1)
    const slice = src.slice(containerIdx, containerIdx + 4000)
    // Same DOM: exactly one layout-only flex wrapper directly under the
    // container, holding the app-owned older-paging node + Prompt.
    expect(slice).toMatch(/display:\s*'flex'/)
    expect(slice).toMatch(/flexDirection:\s*'column-reverse'/)
    expect(slice).toMatch(/data-older-paging/)
    expect(slice).toMatch(/<Prompt/)
    // Top alignment of the reversed children (no fractional root start).
    expect(slice).toMatch(/justifyContent:\s*'flex-end'/)
    expect(slice).toMatch(/flexShrink:\s*0/)
    // Native TRUE intrinsic size rounded up to the live device-pixel quantum
    // (keeper-synchronized var, 1px fallback for unsupported engines).
    expect(slice).toMatch(/calc-size\(auto,\s*round\(up,\s*size,\s*var\(--messages-pixel-size,\s*1px\)\)\)/)
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
