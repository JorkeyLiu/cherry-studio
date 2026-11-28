/**
 * Regression: the owner-only edit pill must escape the chat-canvas stacking
 * context so the overlay titlebar cannot intercept its hits.
 *
 * Defect: `chat-titlebar` is a full-width absolute drag root (z 6) sitting as
 * a sibling above `ChatCanvas` (z 0, `isolation: isolate`). The action bar
 * rendered inside the canvas, so its own z 10 was flattened by that isolation
 * and the top-overlapped pill hits landed on the titlebar — the E2E
 * `edit-copy-btn` was visible and enabled yet its click was intercepted.
 *
 * Fix: `EditModeActionBarHost` portals the bar into the titlebar's own
 * stacking context (below the control floats, above the blank drag pixels);
 * without a titlebar host it falls back to the inline position. The pill
 * itself opts out of window drag (`no-drag`) while its full-width container
 * stays click-through, so blank titlebar drag is unchanged.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import EditModeActionBarHost from '../EditModeActionBarHost'

describe('EditModeActionBarHost titlebar portal', () => {
  it('portals the pill into the overlay titlebar when the chat shell is present', () => {
    render(
      <div id="chat-main">
        <div data-testid="chat-canvas" />
        <div data-testid="chat-titlebar" />
      </div>
    )
    render(
      <EditModeActionBarHost>
        <div data-testid="edit-pill" />
      </EditModeActionBarHost>
    )

    const titlebar = screen.getByTestId('chat-titlebar')
    const pill = screen.getByTestId('edit-pill')
    // Escapes the canvas stacking context: the pill hit layer lives inside
    // the titlebar context (above its blank drag surface), never flattened
    // under it.
    expect(titlebar.contains(pill)).toBe(true)
    expect(screen.getByTestId('chat-canvas').contains(pill)).toBe(false)
  })

  it('falls back to the inline position without a titlebar host', () => {
    expect(document.querySelector('[data-testid="chat-titlebar"]')).toBeNull()
    const { container } = render(
      <EditModeActionBarHost>
        <div data-testid="edit-pill-inline" />
      </EditModeActionBarHost>
    )
    expect(container.contains(screen.getByTestId('edit-pill-inline'))).toBe(true)
  })

  it('pill opts out of window drag while the container stays click-through', async () => {
    const fs = await import('node:fs')
    const bar = fs.readFileSync('src/renderer/src/components/EditModeActionBar.tsx', 'utf-8')
    // Inside the titlebar drag root the interactive pill must not drag the
    // window, while blank pixels around it keep reaching the drag root.
    expect(bar).toContain('-webkit-app-region: no-drag')
    expect(bar).toContain('pointer-events: none')
    expect(bar).toContain('pointer-events: auto')
    expect(bar).toContain('data-testid="edit-mode-action-bar"')

    const host = fs.readFileSync('src/renderer/src/pages/home/Messages/EditModeActionBarHost.tsx', 'utf-8')
    expect(host).toContain('createPortal')
    expect(host).toContain('chat-titlebar')

    const messages = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf-8')
    expect(messages).toContain('EditModeActionBarHost')
  })
})
