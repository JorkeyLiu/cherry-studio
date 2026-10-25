/**
 * Message-controls normal-geometry guard (VIEWPORT-13/14 normal appearance).
 *
 * The edit baseline is the region BOTTOM, never a forced equal height: the
 * closed footer keeps its HEAD normal style and the open action bar keeps
 * its HEAD normal box (min-38, vertical padding 4, top border) with house
 * circle-30 ActionIconButtons and no 26 override. This file pins the source
 * contract against reintroducing the removed 26-box error; the rendered
 * circle/whitespace itself is proven by Playwright + ui:observe, never here.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (p: string): string => fs.readFileSync(p, 'utf-8')

describe('message-controls normal geometry (no forced 26 box)', () => {
  it('shared surface carries no controls-region style', () => {
    const shared = read('src/renderer/src/pages/home/Messages/shared.tsx')
    expect(shared).not.toMatch(/messageControlsRegionStyle/)
    expect(shared).not.toMatch(/min-height:\s*26px/)
  })

  it('closed footer keeps HEAD normal style (no shared 26 import)', () => {
    const message = read('src/renderer/src/pages/home/Messages/Message.tsx')
    expect(message).not.toMatch(/messageControlsRegionStyle/)
    expect(message).toMatch(/display:\s*flex/)
  })

  it('open action bar keeps HEAD normal box with no 26 button override', () => {
    const editor = read('src/renderer/src/pages/home/Messages/MessageEditor.tsx')
    expect(editor).not.toMatch(/messageControlsRegionStyle/)
    expect(editor).toMatch(/min-height:\s*38px/)
    expect(editor).toMatch(/padding:\s*4px 6px/)
    expect(editor).toMatch(/border-top:/)
    expect(editor).not.toMatch(/width:\s*26px/)
    expect(editor).not.toMatch(/height:\s*26px/)
  })

  it('house action buttons stay circle-30 (h-7.5/w-7.5)', () => {
    const buttons = read('src/renderer/src/components/Buttons/ActionIconButton.tsx')
    expect(buttons).toMatch(/h-7\.5/)
    expect(buttons).toMatch(/w-7\.5/)
    expect(buttons).toMatch(/circle/)
  })
})
