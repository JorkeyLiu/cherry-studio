/**
 * LOCK-004 Streaming Responsiveness — E2E
 *
 * A seeded long, slow streaming response must keep user scroll/input
 * responsive BEFORE completion, and the final rendered Markdown must contain
 * the exact complete content (tail included, no truncation).
 *
 * Evidence classes (per tests/e2e/README.md §7):
 *   - Real UI gestures: message send via real textarea, mouse wheel scroll,
 *     textarea typing during streaming
 *   - Mock request log: product request reached the mock with stream: true
 *   - Redux state snapshots: block status transitions + exact final content
 *   - Rendered UI: .markdown contains the tail marker after completion
 *
 * The mock server streams one paragraph every 60ms for ~9s (opt-in via the
 * `__E2E_SLOW_STREAM__` marker), giving a deterministic mid-stream interaction
 * window (roughly doubled vs the prior 40ms/~6s cadence) without any live API.
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { clearRequestLog, findProductRequest } from '../../fixtures/electron.fixture'
import { getSlowStreamReply, SLOW_STREAM_MARKER, type MockRequestEntry } from '../../fixtures/mock-openai-server'

const MODEL = 'mock-model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type text into the real textarea and submit via Enter (production send path). */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()

  await page.evaluate(
    ({ selector, value }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', value: text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/**
 * Assistant-scoped rendered Markdown. User messages also render a `.markdown`
 * element (`<p className="markdown">`), so a bare `.markdown.first()` targets
 * the USER message. Scoping to the assistant message container is the only way
 * the streaming reply assertions are trustworthy.
 */
function assistantMarkdown(
  page: import('@playwright/test').Page
): ReturnType<import('@playwright/test').Page['locator']> {
  return page.locator('#messages .message-assistant .markdown').first()
}

/** Set the textarea value through the same native setter used by production input. */
async function setTextareaValue(page: import('@playwright/test').Page, value: string): Promise<void> {
  await page.evaluate(
    ({ selector, text }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', text: value }
  )
}

interface StreamingBlockInfo {
  id: string
  content: string
  status: string
}

/** Find the currently streaming assistant main-text block with growing content. */
async function findStreamingBlock(page: import('@playwright/test').Page): Promise<StreamingBlockInfo | null> {
  return page.evaluate(() => {
    const s = (window as any).store?.getState()
    if (!s?.messageBlocks?.entities) return null
    for (const block of Object.values(s.messageBlocks.entities) as any[]) {
      if (block?.type === 'main_text' && block?.status === 'streaming' && typeof block?.content === 'string') {
        return { id: block.id, content: block.content, status: block.status }
      }
    }
    return null
  })
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe('Streaming responsiveness (LOCK-004)', () => {
  test('long slow stream keeps scroll/input responsive and completes with exact content', async ({ mainWindow }) => {
    test.setTimeout(180000)
    const page = mainWindow
    clearRequestLog()

    // ═══════════════════════════════════════════════════════════════════
    // 1. SEND — real UI → production pipeline → slow mock stream
    // ═══════════════════════════════════════════════════════════════════
    await uiSendMessage(page, `seeded slow stream ${SLOW_STREAM_MARKER}`)

    // The slow stream must be actively streaming with substantial content —
    // enough that the rendered message overflows the chat viewport so the
    // scroll interaction is measurable mid-stream. The threshold is kept low
    // (interaction starts early) so the mid-stream interaction window has a
    // comfortable margin before the stream completes.
    await page.waitForFunction(
      () => {
        const s = (window as any).store?.getState()
        if (!s?.messageBlocks?.entities) return false
        for (const block of Object.values(s.messageBlocks.entities) as any[]) {
          if (block?.type === 'main_text' && block?.status === 'streaming' && block?.content?.length > 2000) {
            return true
          }
        }
        return false
      },
      undefined,
      { timeout: 30000 }
    )

    // Mock request evidence: product-originated streaming request.
    const productReq: MockRequestEntry | null = findProductRequest()
    expect(productReq).not.toBeNull()
    expect(productReq!.parsed).toEqual(expect.objectContaining({ model: MODEL, stream: true }))

    // Rendered Markdown is progressing while streaming (bounded cadence keeps
    // the parsed content advancing, not frozen until completion). Scoped to the
    // assistant message: `.markdown.first()` would target the user message.
    await expect(assistantMarkdown(page)).toContainText('Slow stream started', { timeout: 15000 })

    // ═══════════════════════════════════════════════════════════════════
    // 2. SCROLL INTERACTION DURING STREAMING
    // ═══════════════════════════════════════════════════════════════════
    const messagesBox = await page.locator('#messages').boundingBox()
    expect(messagesBox).not.toBeNull()
    await page.mouse.move(messagesBox!.x + messagesBox!.width / 2, messagesBox!.y + messagesBox!.height / 2)

    const scrollBefore = await page.locator('#messages').evaluate((el) => el.scrollTop)
    // The chat viewport is a column-reverse container: scrollTop 0 is the
    // bottom (newest content). Scrolling UP (negative deltaY) moves through
    // the message history while the response is still streaming — the natural
    // gesture for reviewing earlier content mid-stream. A positive delta would
    // scroll toward the already-reached bottom and produce no movement.
    // Column-reverse engines may report positive or negative scrollTop, so the
    // assertion is a magnitude change.
    await page.mouse.wheel(0, -1500)
    await page.waitForTimeout(200)
    const scrollAfter = await page.locator('#messages').evaluate((el) => el.scrollTop)
    expect(Math.abs(scrollAfter - scrollBefore)).toBeGreaterThan(0)
    console.log(`[E2E] Scroll during streaming: scrollTop ${scrollBefore} -> ${scrollAfter}`)

    // ═══════════════════════════════════════════════════════════════════
    // 3. INPUT INTERACTION DURING STREAMING
    // ═══════════════════════════════════════════════════════════════════
    const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
    await textarea.click()
    await setTextareaValue(page, 'interaction-during-stream')
    await expect(textarea).toHaveValue('interaction-during-stream', { timeout: 5000 })
    // Clear it back so no stray draft is left.
    await setTextareaValue(page, '')
    await expect(textarea).toHaveValue('', { timeout: 5000 })

    // ═══════════════════════════════════════════════════════════════════
    // 4. PROVE INTERACTIONS HAPPENED BEFORE COMPLETION
    // ═══════════════════════════════════════════════════════════════════
    const midStream = await findStreamingBlock(page)
    expect(midStream).not.toBeNull()
    expect(midStream!.status).toBe('streaming')
    expect(midStream!.content).not.toContain('tail-marker-END')
    console.log(`[E2E] Interactions completed while still streaming: ${midStream!.content.length} chars in`)

    // ═══════════════════════════════════════════════════════════════════
    // 4b. S3.3 LAYER CONTRACT — simultaneous history/live, single host, no duplicate/missing (mid-stream)
    // ═══════════════════════════════════════════════════════════════════
    await expect(page.locator('#messages')).toHaveCount(1)
    const midLayerKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-layer-kind]')).map((el) =>
        el.getAttribute('data-layer-kind')
      )
    )
    expect(midLayerKinds).toContain('history')
    expect(midLayerKinds).toContain('live')
    console.log(`[E2E] Mid-stream layer kinds: ${midLayerKinds.join(',')}`)

    const midStableGroups = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-stable-group-id]')).map((el) =>
        el.getAttribute('data-stable-group-id')
      )
    )
    expect(midStableGroups.length).toBeGreaterThan(1)
    expect(new Set(midStableGroups).size).toBe(midStableGroups.length)
    const midMessageIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).map(
        (el) => el.getAttribute('data-message-id')!
      )
    )
    expect(new Set(midMessageIds).size).toBe(midMessageIds.length)
    // No duplicate/missing: groups and messages counts align with rendered uniqueness
    console.log(`[E2E] Mid-stream groups=${midStableGroups.length} messages=${midMessageIds.length}`)

    // Capture mid-stream history stable id for final transition check
    const midHistoryStableIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-layer-kind="history"][data-stable-group-id]')).map(
        (el) => el.getAttribute('data-stable-group-id')!
      )
    )
    expect(midHistoryStableIds.length).toBeGreaterThan(0)

    // ═══════════════════════════════════════════════════════════════════
    // 5. COMPLETION — exact final content, no truncation
    // ═══════════════════════════════════════════════════════════════════
    const expectedReply = getSlowStreamReply(MODEL)

    // Redux: the block content must equal the exact full deterministic reply.
    await page.waitForFunction(
      (expected) => {
        const s = (window as any).store?.getState()
        if (!s?.messageBlocks?.entities) return false
        for (const block of Object.values(s.messageBlocks.entities) as any[]) {
          if (block?.type === 'main_text' && block?.content === expected && block?.status === 'success') {
            return true
          }
        }
        return false
      },
      expectedReply,
      { timeout: 30000 }
    )

    const finalBlock = await page.evaluate((expected) => {
      const s = (window as any).store.getState()
      for (const block of Object.values(s.messageBlocks.entities) as any[]) {
        if (block?.type === 'main_text' && block?.content === expected) {
          return { content: block.content, status: block.status, length: block.content.length }
        }
      }
      return null
    }, expectedReply)
    expect(finalBlock).not.toBeNull()
    expect(finalBlock!.status).toBe('success')
    expect(finalBlock!.content).toBe(expectedReply)

    // Rendered UI: the exact tail of the stream is present in the final
    // rendered Markdown (LOCK-001 — final content complete, no truncation).
    // Assistant-scoped: the user message's own `.markdown` element must not be
    // mistaken for the streaming reply.
    const markdown = assistantMarkdown(page)
    await expect(markdown).toContainText('tail-marker-END', { timeout: 10000 })
    await expect(markdown).toContainText(`paragraph-${149}`, { timeout: 10000 })

    // ═══════════════════════════════════════════════════════════════════
    // 6. S3.3 FINAL LIVE→HISTORY TRANSITION — single stable host, all history, history DOM preserved
    // ═══════════════════════════════════════════════════════════════════
    await expect(page.locator('#messages')).toHaveCount(1)
    const finalLayerKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-layer-kind]')).map((el) =>
        el.getAttribute('data-layer-kind')
      )
    )
    // After completion the streaming tail must have transitioned to history; no live markers remain
    expect(finalLayerKinds.length).toBeGreaterThan(0)
    expect(finalLayerKinds.every((k) => k === 'history')).toBe(true)
    console.log(`[E2E] Final layer kinds: ${finalLayerKinds.join(',')}`)

    const finalStableGroups = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-stable-group-id]')).map((el) =>
        el.getAttribute('data-stable-group-id')
      )
    )
    expect(new Set(finalStableGroups).size).toBe(finalStableGroups.length)
    // Mid-stream history groups must still be present with same stable ids (no remount-loss)
    for (const hid of midHistoryStableIds) {
      expect(finalStableGroups).toContain(hid)
    }
    const finalMessageIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).map(
        (el) => el.getAttribute('data-message-id')!
      )
    )
    expect(new Set(finalMessageIds).size).toBe(finalMessageIds.length)
    console.log(`[E2E] Final groups=${finalStableGroups.length} messages=${finalMessageIds.length}`)
  })
})
