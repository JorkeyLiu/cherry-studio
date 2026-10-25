/**
 * Single scroll-owner contract for the owned chat viewport (#messages).
 *
 * The route viewport keeper is the sole compensation owner on this host
 * (column-reverse bottom pin + interaction-region holds). Browser scroll
 * anchoring (`overflow-anchor`) would fight it during message-editor
 * top-edge resize (same-press DOWN→UP / UP→DOWN turnaround, clamped
 * height), edit open, and cancel — native corrections racing keeper
 * corrections read as ±5–10px bottom motion plus a release snap. Disabling
 * anchoring on this host only removes the second owner so the captured
 * bottom edge stays stable and the top follows the height delta.
 *
 * Scoping: the declaration lives on MessagesContainer (the #messages
 * scroll host) and must not leak to editor scrollers, notes, history, or
 * other native containers. Static level only: every-frame bottom stability
 * is proven by downstream runtime observation, never here.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { MessagesContainer } from '../shared'

describe('single scroll-owner contract (#messages)', () => {
  it('disables browser scroll anchoring on the owned chat scroll host', () => {
    const rules: string = MessagesContainer?.componentStyle?.rules?.join('') ?? ''
    expect(rules).toContain('overflow-anchor: none')
  })

  it('keeps the host a column-reverse scroll container', () => {
    const rules: string = MessagesContainer?.componentStyle?.rules?.join('') ?? ''
    expect(rules).toContain('column-reverse')
    expect(rules).toContain('overflow-x: hidden')
  })

  it('does not disable anchoring on other editor/notes/history/native containers', () => {
    const sharedSource = fs.readFileSync('src/renderer/src/pages/home/Messages/shared.tsx', 'utf-8')
    // Exactly one declaration in the shared viewport surface: the host.
    expect(sharedSource.match(/overflow-anchor/g)?.length ?? 0).toBe(1)
    // The generic scrollbar base (all other Scrollbar consumers) is untouched.
    const scrollbarSource = fs.readFileSync('src/renderer/src/components/Scrollbar/index.tsx', 'utf-8')
    expect(scrollbarSource).not.toMatch(/overflow-anchor/)
    // The message editor (resize surface, editor scroller, modal) is untouched.
    const editorSource = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageEditor.tsx', 'utf-8')
    expect(editorSource).not.toMatch(/overflow-anchor/)
    // The message row (content scroller, footer) is untouched.
    const messageSource = fs.readFileSync('src/renderer/src/pages/home/Messages/Message.tsx', 'utf-8')
    expect(messageSource).not.toMatch(/overflow-anchor/)
  })
})
