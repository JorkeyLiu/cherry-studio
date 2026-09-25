import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Route-switch scroll contract (source-level pins; behavior is exercised in
 * the true-branch Playwright spec with deterministic tolerance):
 *
 * - Scroll snapshots are route-keyed (`topic-<id>::<branch|main>`) with the
 *   legacy topic-only key as the main-route fallback.
 * - Top-selector switches restore the new route's saved browsing position
 *   naturally (no forced anchor positioning beyond the saved snapshot; the
 *   vicinity window is the deterministic fallback when none exists).
 * - Divider switches preserve the visual reference via first-visible stable
 *   element + viewport-offset compensation (no pending anchor navigation,
 *   no NAVIGATE_TO_MESSAGE dispatch).
 * - All assistant-message footers sit on the LEFT side; user positioning is
 *   unchanged.
 */
describe('route-switch scroll + footer contract', () => {
  const messagesSource = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
  const messageSource = fs.readFileSync('src/renderer/src/pages/home/Messages/Message.tsx', 'utf8')

  it('uses route-keyed scroll snapshots with legacy main-route fallback', () => {
    expect(messagesSource).toMatch(/topic-\$\{topic\.id\}::\$\{activeBranchId/)
    expect(messagesSource).toMatch(/getRouteSavedPosition/)
    expect(messagesSource).toMatch(/getLegacyMainSavedPosition/)
    expect(messagesSource).toMatch(/scroll:topic-\$\{topic\.id\}/)
  })

  it('top-selector path restores the saved route position without forcing anchor positioning', () => {
    const effectIdx = messagesSource.indexOf('Top-selector route switch')
    expect(effectIdx).toBeGreaterThanOrEqual(0)
    const effect = messagesSource.slice(effectIdx, effectIdx + 6000)
    expect(effect).toMatch(/getRouteSavedPosition/)
    expect(effect).toMatch(/isAtBottom/)
    expect(effect).toMatch(/anchorId/)
    expect(effect).toMatch(/vicinity/)
    // The old route snapshot is never overwritten with the new route key.
    expect(effect).not.toMatch(/savePosition\(\)/)
  })

  it('divider path compensates the first-visible stable offset and never pends navigates', () => {
    const switchIdx = messagesSource.indexOf('Divider route switch')
    expect(switchIdx).toBeGreaterThanOrEqual(0)
    // Strip line comments so prose mentions (e.g. "never dispatches
    // NAVIGATE_TO_MESSAGE") cannot false-positive the call assertions.
    const handler = messagesSource
      .slice(switchIdx, switchIdx + 8000)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(handler).toMatch(/findFirstVisibleMessage/)
    expect(handler).toMatch(/visualOffset/)
    expect(handler).toMatch(/rawScrollTop/)
    expect(handler).toMatch(/loadRouteMessagesThunk/)
    expect(handler).not.toMatch(/setPendingAnchorNavigate/)
    expect(handler).not.toMatch(/NAVIGATE_TO_MESSAGE/)
  })

  it('divider popup keeps stable layout height (overlay, no in-flow expansion)', () => {
    const dividerSource = fs.readFileSync('src/renderer/src/pages/home/Messages/BranchDividers.tsx', 'utf8')
    expect(dividerSource).toMatch(/Popover/)
    expect(dividerSource).toMatch(/min-height/)
    // The old inline expanding list is gone.
    expect(dividerSource).not.toMatch(/ForkChildList/)
    expect(dividerSource).not.toMatch(/expanded &&/)
  })

  it('all assistant footers render on the LEFT; user side unchanged', () => {
    expect(messageSource).toMatch(/shouldReverseFooter = isAssistantMessage/)
    expect(messageSource).not.toMatch(/shouldReverseFooter = isLastMessage && isAssistantMessage/)
  })
})
