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
import {
  clearRequestLog,
  findProductRequest,
  findProductRequestAfter,
  getRequestSequence
} from '../../fixtures/electron.fixture'
import {
  EXTENDED_SLOW_STREAM_MARKER,
  getExtendedSlowStreamReply,
  getSlowStreamReply,
  SLOW_STREAM_MARKER,
  type MockRequestEntry
} from '../../fixtures/mock-openai-server'
import { ensureComposerExpanded } from '../../utils/composer'
import {
  parseComposerTailInsetPx,
  resolveUnobscuredBottom,
  TAIL_GAP_TOLERANCE_PX,
  tailGapToUnobscuredBand
} from '../../utils/unobscuredTailGap'
import {
  activateTopic,
  letterMessageId,
  pad,
  prepareAssistant,
  seedSmallTopic,
  seedSourceTopic
} from '../../utils/branch-route-setup'

const MODEL = 'mock-model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type text into the real textarea and submit via Enter (production send path). */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  // Input-island composer: non-empty topics start collapsed (textarea hidden).
  await ensureComposerExpanded(page)
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
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
// Cross-topic continuity helpers (this behavior only — no shared-harness change)
// ---------------------------------------------------------------------------

const CONTINUITY_DRAFT = 'DRAFT-A-keep-12345'
const CONTINUITY_ANCHOR_TOL = 12 // topic-scroll-save-restore OFFSET_TOL geometry

/** Center-viewport stable anchor: the message under the viewport middle plus its intra-row offset. */
async function readCenterAnchor(page: import('@playwright/test').Page): Promise<{ id: string; offset: number } | null> {
  return page.evaluate(() => {
    const cont = document.querySelector('#messages')
    if (!cont) return null
    const cr = cont.getBoundingClientRect()
    const cy = cr.top + cr.height / 2
    const nodes = Array.from(document.querySelectorAll('[data-message-id]'))
    for (const node of nodes) {
      const r = (node as HTMLElement).getBoundingClientRect()
      if (r.top <= cy && r.bottom >= cy) {
        return { id: (node as HTMLElement).getAttribute('data-message-id')!, offset: Math.round(r.top - cr.top) }
      }
    }
    return null
  })
}

/** Wait until a topic's newest assistant message and all its blocks reach terminal status. */
async function waitForAssistantTerminal(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 90000
): Promise<void> {
  await page.waitForFunction(
    ({ tid, prev }: { tid: string; prev: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const ids = (s.messages.messageIdsByTopic || {})[tid] || []
      const ents = s.messages.entities || {}
      let count = 0
      for (const id of ids) {
        if (ents[id]?.role === 'assistant') count++
      }
      if (count <= prev) return false
      // Generation-terminal gate: loadingByTopic is generation-only since the
      // read/generation split; window-read settle is asserted explicitly below.
      if ((s.messages.loadingByTopic || {})[tid] === true) return false
      if (((s.messages.pendingWindowReadsByTopic || {})[tid] ?? []).length !== 0) return false
      let latest: any = null
      for (let i = ids.length - 1; i >= 0; i--) {
        if (ents[ids[i]]?.role === 'assistant') {
          latest = ents[ids[i]]
          break
        }
      }
      if (!latest || (latest.status !== 'success' && latest.status !== 'error')) return false
      const blocks = latest.blocks || []
      if (blocks.length === 0) return false
      const bents = (s.messageBlocks?.entities || {}) as Record<string, any>
      for (const b of blocks) {
        if (!bents[b] || (bents[b].status !== 'success' && bents[b].status !== 'error')) return false
      }
      return true
    },
    { tid: topicId, prev: previousAssistantCount },
    { timeout }
  )
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
    // The chat viewport is a normal-flow container: scrollTop sh - ch is the
    // bottom (newest content). Scrolling UP (negative deltaY) moves through
    // the message history while the response is still streaming — the natural
    // gesture for reviewing earlier content mid-stream. A positive delta would
    // scroll toward the already-reached bottom and produce no movement.
    // The assertion is a magnitude change.
    await page.mouse.wheel(0, -1500)
    await page.waitForTimeout(200)
    const scrollAfter = await page.locator('#messages').evaluate((el) => el.scrollTop)
    expect(Math.abs(scrollAfter - scrollBefore)).toBeGreaterThan(0)
    console.log(`[E2E] Scroll during streaming: scrollTop ${scrollBefore} -> ${scrollAfter}`)

    // ═══════════════════════════════════════════════════════════════════
    // 3. INPUT INTERACTION DURING STREAMING
    // ═══════════════════════════════════════════════════════════════════
    // Composer may have collapsed (outside-canvas pointer collapses the island).
    await ensureComposerExpanded(page)
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

  /**
   * Streaming cross-topic continuity — the generation belongs to the dialogue.
   *
   * A seeded scrollable topic streams an XL reply (~18s deterministic window);
   * leaving mid-stream for another topic keeps A alive (no cancel/error) while
   * B stays fully usable, and returning to A restores position + full content.
   * The shared single-instance Inputbar keeps the A draft across the switch
   * itself; B's own send consumes the box, so the return shows the post-B-send
   * state with no B-text leak — per-topic draft restore is NOT claimed.
   *
   * Evidence classes: real UI gestures (sidebar clicks, Enter send,
   * pressSequentially draft, wheel scroll), mock request log (one streaming
   * product request per send), Redux terminal/block facts, rendered Markdown
   * tail. Seams only: existing selectors, store introspection, established
   * seed helpers. No profile/metadata/performance counters.
   */
  test('streaming continues across topic leave and return with position and content intact', async ({ mainWindow }) => {
    test.setTimeout(300000)
    const page = mainWindow
    clearRequestLog()

    // ═══════════════════════════════════════════════════════════════════
    // 1. SEED — A scrollable (40) + B small (4) via Main authority, real open
    // ═══════════════════════════════════════════════════════════════════
    const assistantId = await prepareAssistant(page, 200)
    const topicA = 'stream-leave-A'
    const topicB = 'stream-leave-B'
    const seedA = await seedSourceTopic(page, {
      assistantId,
      topicId: topicA,
      name: 'stream-leave-A',
      total: 40,
      messageIdForIndex: (i: number) => letterMessageId(topicA, i),
      contentPrefix: 'leave-a-body-',
      contentForIndex: (i: number) => `leave-a-body-${pad(i, 5)} ${'deterministic scrollable filler words '.repeat(40)}`
    })
    const seedB = await seedSmallTopic(page, assistantId, topicB, 'stream-leave-B')
    expect(seedA.length).toBe(40)
    expect(seedB.length).toBe(4)
    await activateTopic(page, topicA, 40)

    // ═══════════════════════════════════════════════════════════════════
    // 2. XL SEND on A — real UI; Enter consumes; keyboard draft right after
    // ═══════════════════════════════════════════════════════════════════
    const seqBeforeA = getRequestSequence()
    await uiSendMessage(page, `xl continuity probe ${EXTENDED_SLOW_STREAM_MARKER}`)
    const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
    await expect(textarea).toHaveValue('', { timeout: 10000 })
    await ensureComposerExpanded(page)
    await textarea.click()
    await textarea.pressSequentially(CONTINUITY_DRAFT, { delay: 15 })
    await expect(textarea).toHaveValue(CONTINUITY_DRAFT, { timeout: 5000 })

    // ═══════════════════════════════════════════════════════════════════
    // 3. STREAM START + product request evidence
    // ═══════════════════════════════════════════════════════════════════
    await page.waitForFunction(
      ({ tid, prev }: { tid: string; prev: number }) => {
        const s = (window as any).store?.getState()
        if (!s) return false
        const ids = (s.messages.messageIdsByTopic || {})[tid] || []
        let count = 0
        for (const id of ids) {
          if (s.messages.entities[id]?.role === 'assistant') count++
        }
        if (count > prev) return true
        for (const b of Object.values(s.messageBlocks.entities) as any[]) {
          if (b?.type === 'main_text' && b?.status === 'streaming') return true
        }
        return false
      },
      { tid: topicA, prev: 20 },
      { timeout: 60000 }
    )
    const reqA = findProductRequestAfter(seqBeforeA)
    expect(reqA).not.toBeNull()
    expect(reqA!.parsed).toEqual(expect.objectContaining({ model: MODEL, stream: true }))

    // ═══════════════════════════════════════════════════════════════════
    // 4. READ UPWARD — real wheel, center-viewport stable anchor
    // ═══════════════════════════════════════════════════════════════════
    const messagesBox = await page.locator('#messages').boundingBox()
    expect(messagesBox).not.toBeNull()
    await page.mouse.move(messagesBox!.x + messagesBox!.width / 2, messagesBox!.y + messagesBox!.height / 2)
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -900)
      await page.waitForTimeout(300)
    }
    const anchor = await readCenterAnchor(page)
    expect(anchor).not.toBeNull()
    console.log(`[E2E] Leave anchor: ${anchor!.id} offset=${anchor!.offset}`)

    // ═══════════════════════════════════════════════════════════════════
    // 5. LEAVE to B — real sidebar; route + DOM + draft preserved by switch
    // ═══════════════════════════════════════════════════════════════════
    await activateTopic(page, topicB, 4)
    await expect(page.locator(`#messages [data-message-id="${seedB[seedB.length - 1]}"]`)).toBeAttached({
      timeout: 10000
    })
    // Single shared Inputbar (no topic key): the A draft survives the switch itself.
    await expect(textarea).toHaveValue(CONTINUITY_DRAFT, { timeout: 5000 })

    // ═══════════════════════════════════════════════════════════════════
    // 6. B SEND — real send; wait only for B streaming START (not terminal):
    // the overlap claim below needs the early return while A still streams.
    // ═══════════════════════════════════════════════════════════════════
    const seqBeforeB = getRequestSequence()
    await uiSendMessage(page, 'b-quick-hello')
    await expect(textarea).toHaveValue('', { timeout: 10000 })
    await page.waitForFunction(
      ({ tid, prev }: { tid: string; prev: number }) => {
        const s = (window as any).store?.getState()
        if (!s) return false
        const ids = (s.messages.messageIdsByTopic || {})[tid] || []
        let count = 0
        for (const id of ids) {
          if (s.messages.entities[id]?.role === 'assistant') count++
        }
        return count > prev
      },
      { tid: topicB, prev: 2 },
      { timeout: 60000 }
    )
    const reqB = findProductRequestAfter(seqBeforeB)
    expect(reqB).not.toBeNull()
    expect(reqB!.parsed).toEqual(expect.objectContaining({ model: MODEL, stream: true }))

    // ═══════════════════════════════════════════════════════════════════
    // 6b. EARLY RETURN to A while A still streams — read/generation overlap.
    // Read-settled gate only (never generation): the shared activateTopic
    // helper waits for generation end, so the route click + explicit gates
    // are inline here. No fixed sleep: store/DOM predicates only.
    // ═══════════════════════════════════════════════════════════════════
    const backToA = page.locator(`[data-testid="topic-item"][data-topic-id="${topicA}"]`).first()
    await backToA.waitFor({ state: 'visible', timeout: 15000 })
    await backToA.click()
    await page.waitForFunction(
      ({ tid, min }: { tid: string; min: number }) => {
        const s = (window as any).store?.getState()
        if (!s) return false
        const ids = (s.messages.messageIdsByTopic || {})[tid] || []
        if (!Array.isArray(ids) || ids.length < min) return false
        // Read settled (pending window-read identities drained) while
        // generation may still run — the split in one predicate pair.
        return ((s.messages.pendingWindowReadsByTopic || {})[tid] ?? []).length === 0
      },
      { tid: topicA, min: 42 },
      { timeout: 30000 }
    )
    await expect(page.locator(`#messages [data-message-id="${anchor!.id}"]`)).toBeAttached({ timeout: 10000 })
    // Split assertion on the live store: generation ongoing AND read settled.
    const overlap = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return {
        generating: s.messages.loadingByTopic?.[tid] === true,
        readSettled: ((s.messages.pendingWindowReadsByTopic || {})[tid] ?? []).length === 0
      }
    }, topicA)
    expect(overlap.generating).toBe(true)
    expect(overlap.readSettled).toBe(true)
    console.log(`[E2E] Early-return overlap: A generating with read settled`)
    // DOM readable while generating: seed content present and Stop offered.
    await expect(page.locator('#messages .message-assistant .markdown').first()).toContainText('leave-a-body-', {
      timeout: 10000
    })
    // Composer may collapse on route return; expand via production gesture before Stop gate.
    await ensureComposerExpanded(page)
    await expect(page.getByTestId('stop-generation-button')).toBeVisible({ timeout: 15000 })

    // ═══════════════════════════════════════════════════════════════════
    // 7. RETURN SETTLES — anchor drift in tolerance; B terminal from any route
    // ═══════════════════════════════════════════════════════════════════
    const anchorOffsetAfter = await page.evaluate((id: string) => {
      const cont = document.querySelector('#messages')
      const node = document.querySelector(`#messages [data-message-id="${id}"]`)
      if (!cont || !node) return null
      const cr = cont.getBoundingClientRect()
      const r = (node as HTMLElement).getBoundingClientRect()
      return Math.round(r.top - cr.top)
    }, anchor!.id)
    expect(anchorOffsetAfter).not.toBeNull()
    expect(Math.abs(anchorOffsetAfter! - anchor!.offset)).toBeLessThanOrEqual(CONTINUITY_ANCHOR_TOL)
    // Shared-input semantics: B's own send consumed the box; no B text leaks into A.
    await expect(textarea).toHaveValue('', { timeout: 5000 })
    // B completes in the background (store predicate, route-independent).
    await waitForAssistantTerminal(page, topicB, 2)

    // ═══════════════════════════════════════════════════════════════════
    // 8. A COMPLETES — exact full XL reply in store blocks + rendered tail
    // ═══════════════════════════════════════════════════════════════════
    const expectedXL = getExtendedSlowStreamReply(MODEL)
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
      expectedXL,
      { timeout: 120000 }
    )
    const lastAssistantMarkdown = page.locator('#messages .message-assistant .markdown').last()
    await expect(lastAssistantMarkdown).toContainText('tail-marker-END', { timeout: 15000 })

    // ═══════════════════════════════════════════════════════════════════
    // 9. SCROLL TO BOTTOM — final message renders the tail at the bottom
    // ═══════════════════════════════════════════════════════════════════
    const bottomBox = await page.locator('#messages').boundingBox()
    expect(bottomBox).not.toBeNull()
    await page.mouse.move(bottomBox!.x + bottomBox!.width / 2, bottomBox!.y + bottomBox!.height / 2)
    let bottomState: {
      atBottom: boolean
      hasTail: boolean
      bottomEdge: number
      unobscuredBottom: number
      visibleTailGap: number
    } | null = null
    // Convergent wheel-down: a fixed 12-iteration budget proved flaky (the
    // leave/return restore lands the anchor at run-varying offsets, so the
    // distance to the bottom varies). Keep wheeling while the viewport moves
    // and stop as soon as the real bottom predicate holds. Two consecutive
    // identical scrollTop reads mean the container is clamped at a physical
    // edge — at the true bottom atBottom is definitionally true, so stopping
    // elsewhere fails honestly instead of burning the remaining budget.
    let lastScrollTop = -1
    let settledReads = 0
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 1200)
      await page.waitForTimeout(300)
      const read = await page.evaluate(() => {
        const cont = document.querySelector('#messages')
        if (!cont) return null
        const max = cont.scrollHeight - cont.clientHeight
        const nodes = Array.from(document.querySelectorAll('#messages .message-assistant .markdown'))
        if (nodes.length === 0) return null
        const last = nodes[nodes.length - 1] as HTMLElement
        const r = last.getBoundingClientRect()
        const vr = cont.getBoundingClientRect()
        return {
          atBottom: cont.scrollTop >= max - 100,
          hasTail: (last.textContent || '').includes('tail-marker-END'),
          bottomEdge: Math.round(r.bottom - vr.bottom),
          tailBottom: r.bottom,
          containerBottom: vr.bottom,
          rawInset: window.getComputedStyle(cont).getPropertyValue('--composer-tail-inset'),
          scrollTop: cont.scrollTop
        }
      })
      if (!read) continue
      // The floating composer overlay covers the container's bottom strip, so
      // the tail gap is measured against the unobscured band edge (the same
      // --composer-tail-inset source production reads off #messages), never
      // the raw container rect bottom. Fail-closed inset 0 === legacy metric.
      const unobscuredBottom = resolveUnobscuredBottom(read.containerBottom, parseComposerTailInsetPx(read.rawInset))
      const visibleTailGap = tailGapToUnobscuredBand(read.tailBottom, unobscuredBottom)
      bottomState = {
        atBottom: read.atBottom,
        hasTail: read.hasTail,
        bottomEdge: read.bottomEdge,
        unobscuredBottom,
        visibleTailGap
      }
      if (bottomState.atBottom && bottomState.hasTail && Math.abs(bottomState.visibleTailGap) <= TAIL_GAP_TOLERANCE_PX)
        break
      if (read.scrollTop === lastScrollTop) {
        settledReads += 1
        if (settledReads >= 2) break
      } else {
        settledReads = 0
      }
      lastScrollTop = read.scrollTop
    }
    expect(bottomState?.atBottom).toBe(true)
    expect(bottomState?.hasTail).toBe(true)
    expect(Math.abs(bottomState!.visibleTailGap)).toBeLessThanOrEqual(TAIL_GAP_TOLERANCE_PX)
    console.log(
      `[E2E] Leave-return continuity: anchor=${anchor!.id} drift<=${CONTINUITY_ANCHOR_TOL}px tail bottom edge=${bottomState!.bottomEdge}px unobscured bottom=${Math.round(bottomState!.unobscuredBottom)}px visible tail gap=${Math.round(bottomState!.visibleTailGap)}px`
    )
  })
})
