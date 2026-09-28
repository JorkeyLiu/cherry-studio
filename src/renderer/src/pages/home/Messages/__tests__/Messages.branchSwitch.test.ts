import * as fs from 'node:fs'

import {
  __testSetPendingNavigate,
  clearPendingNavigate,
  getPendingNavigate,
  setPendingAnchorNavigate
} from '@renderer/services/MessagesService'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Pending-anchor bootstrap path (behavioral companion to the
 * Messages.trueBranchListener contract-grep suite).
 *
 * Topic bootstrap in Messages.tsx performs: savePosition(),
 * setPendingAnchorNavigate({ messageId: anchor, topicId }) with the SAME
 * logical topicId, then NAVIGATE_TO_MESSAGE(anchor) for anchor-vicinity
 * scroll (never bottom). Divider route switches preserve the visual
 * reference directly (no pending navigate); these tests pin the observable
 * behavior of the remaining pending mechanism: the anchor pending is set
 * for the logical topic, survives until the consumer clears it, and a newer
 * request overwrites a stale pending from another anchor.
 */
describe('branch divider switch pending-anchor path', () => {
  beforeEach(() => {
    __testSetPendingNavigate(null)
  })

  it('sets a pending anchor navigation for the same logical topic and shared anchor', () => {
    // Same call handleSelectRoute makes on divider switch.
    setPendingAnchorNavigate({ messageId: 'm1', topicId: 't-1' })
    expect(getPendingNavigate()).toEqual({ messageId: 'm1', topicId: 't-1' })
  })

  it('the route consumer clears only its own anchor (stale-anchor safety)', () => {
    setPendingAnchorNavigate({ messageId: 'm1', topicId: 't-1' })
    // A stale listener for another anchor cannot consume it.
    expect(clearPendingNavigate({ messageId: 'm1', topicId: 't-1' })).toBe(true)
    expect(getPendingNavigate()).toBeNull()
  })

  it('a newer route switch overwrites a stale pending (no cross-switch leak)', () => {
    setPendingAnchorNavigate({ messageId: 'm1', topicId: 't-1' })
    setPendingAnchorNavigate({ messageId: 'm2', topicId: 't-1' })
    expect(getPendingNavigate()).toEqual({ messageId: 'm2', topicId: 't-1' })
    expect(clearPendingNavigate({ messageId: 'm1', topicId: 't-1' })).toBe(false)
    expect(getPendingNavigate()).toEqual({ messageId: 'm2', topicId: 't-1' })
  })
})

/**
 * True incremental branch switch (windowed, no full fetch).
 *
 * STRUCTURAL guardrails only: they pin wiring shape, not behavior. Behavior
 * evidence lives in messageWindow.routeRebase.test.ts (rebase/viewport
 * choice) and messageThunk.routeSwitch.test.ts (windowed loads, around→latest
 * fallback, empty clear, staleness).
 *
 * Divider keeps the current visual position via fork-anchor around reads;
 * top-selector restores the target route snapshot via latest/around reads.
 * Both publish via atomic rebase without blank/reset or full-route fetch.
 */
describe('true branch incremental switch (windowed)', () => {
  const messagesSource = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
  const thunkSource = fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')

  it('divider switch reads around the fork anchor (not history snapshot, not bottom)', () => {
    const idx = messagesSource.indexOf('Divider route switch')
    expect(idx).toBeGreaterThanOrEqual(0)
    const slice = messagesSource.slice(idx, idx + 14000)
    // Production path delegates the fork-anchor around read (+latest
    // fallback) to loadRouteWindowWithFallback with the divider anchor.
    expect(slice).toMatch(/loadRouteWindowWithFallback/)
    expect(slice).toMatch(/anchorMessageId/)
    expect(slice).toMatch(/dividerVisualAnchorOffset|dividerKey/)
    expect(slice).toMatch(/findViewportTopAnchorWithOffset/)
    // Double failure rolls back to the previous route (never new-active +
    // old-projection, never mixed pagination).
    expect(slice).toMatch(/prevRoute/)
    const code = slice
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/setPendingAnchorNavigate/)
    expect(code).not.toMatch(/NAVIGATE_TO_MESSAGE/)
  })

  it('top-selector switch reads latest/around from the target snapshot (never overwrites it)', () => {
    const idx = messagesSource.indexOf('Top-selector route switch')
    expect(idx).toBeGreaterThanOrEqual(0)
    const slice = messagesSource.slice(idx, idx + 9000)
    expect(slice).toMatch(/getRouteSavedPosition/)
    expect(slice).toMatch(/isAtBottom/)
    expect(slice).toMatch(/anchorId/)
    expect(slice).toMatch(/kind:\s*'latest'/)
    expect(slice).toMatch(/kind:\s*'around'/)
    const code = slice
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/savePosition\(\)/)
  })

  it('route loads are windowed only (no full fetchMessages) with atomic rebase', () => {
    const start = thunkSource.indexOf('export const loadRouteMessagesThunk')
    expect(start).toBeGreaterThanOrEqual(0)
    const slice = thunkSource.slice(start, start + 8000)
    expect(slice).toMatch(/fetchMessagesWindow/)
    expect(slice).toMatch(/rebaseRouteMessages/)
    expect(slice).not.toMatch(/fetchMessages\(topicId/)
  })
})
