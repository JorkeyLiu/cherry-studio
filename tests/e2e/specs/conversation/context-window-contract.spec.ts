/**
 * Unified Context-Window Contract — focused aggregate Electron E2E
 *
 * Binds the historically drifting integrated user behavior:
 *   - Fixed-anchor growth: once any anchor is established (including the
 *     auto-derived default), it stays fixed and the selected window grows as
 *     the topic grows (LOCK-CTX-1/2/4).
 *   - TokenCount selected/total semantics (LOCK-CTX-5).
 *   - Quick reset to the default N via TokenCount click (LOCK-CTX-3).
 *   - Manual anchor set/clear via the message menubar anchor button.
 *   - Context boundary divider rendering (`data-testid="context-boundary"`).
 *
 * LOCK-E2E-1: fresh `pnpm build` + repository Electron Playwright fixture
 *             only. No generic CDP/dev-mode browser verification as evidence.
 * LOCK-E2E-2: minimal stable selectors added in production:
 *             - `data-testid="token-count-context"` (TokenCount context block)
 *             - `data-testid="context-anchor-btn"` (menubar anchor button)
 *             - `data-testid="context-boundary"` (divider, data-context-boundary retained)
 * LOCK-E2E-3: contextCount=3 and TokenCount visibility (`showInputEstimatedTokens`)
 *             are configured via controlled Redux setup BEFORE the conversation;
 *             settings-slider behavior is not part of this contract.
 * LOCK-E2E-4: messages are sent through the real input UI against the mock
 *             provider (no fabricated conversation messages).
 * LOCK-E2E-5: the integrated contract transitions A–F (asserted below).
 * LOCK-E2E-6: primary evidence is user-visible UI (TokenCount text, boundary
 *             visibility, anchor-button interactions); Redux is the secondary
 *             oracle for deterministic setup and anchor identity.
 * LOCK-E2E-7: selectors use test IDs / roles / structural scoping, never
 *             translation-coupled strings or generated message IDs.
 * LOCK-E2E-8: one scenario with test.step; no slider geometry or unrelated
 *             UI coverage.
 *
 * LOCK-E2E-REQUEST-1: focused secondary request assertions after the quick
 *             reset (Step B) and the subsequent 5th send (Step C) prove the
 *             model receives exactly the selected user-turn subset implied by
 *             the UI window — excluding the dropped turn 1.
 * LOCK-E2E-REQUEST-2: UI interactions / TokenCount / divider remain the
 *             primary evidence; the request-log assertion is a secondary
 *             integrated oracle.
 * LOCK-E2E-REQUEST-3: assert stable semantic content (the known unique user
 *             prompts), not generated ids or the complete provider payload
 *             shape. System/provider-required messages are allowed; the
 *             ordered user-role content subset is compared.
 * LOCK-E2E-REQUEST-4: before the quick reset, sends naturally include all
 *             history because the initial anchor stays at the first turn.
 *             After the quick reset (latest 3 of 4), the 5th send must include
 *             user prompts for turns 2,3,4 plus the new turn 5 and must
 *             EXCLUDE turn 1 (UI shows 4/5 after the response). One exact
 *             request-boundary assertion at Step C is sufficient.
 * LOCK-E2E-REQUEST-5: no broad shared helper extraction in this task —
 *             duplication is accepted.
 * LOCK-E2E-REQUEST-6: ZIP/import files, fixture logic, renderer context
 *             algorithm, and governance files are untouched.
 */
import { expect, findProductRequestAfter, getRequestSequence, test } from '../../fixtures/electron.fixture'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Active assistant + topic from Redux. */
async function getActiveContext(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const topic = assistant?.topics?.[0]
    return {
      assistantId: assistant?.id || '',
      topicId: topic?.id || '',
      model: assistant?.model || null
    }
  })
}

/**
 * LOCK-E2E-3: configure contextCount=3 and TokenCount visibility via Redux
 * before the conversation begins. This is controlled test setup — the
 * settings-slider behavior is not the contracted feature.
 */
async function seedContextConfig(page: import('@playwright/test').Page): Promise<string> {
  const { assistantId } = await getActiveContext(page)
  expect(assistantId).not.toBe('')

  await page.evaluate(
    ({ assistantId }) => {
      const store = (window as any).store
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextCount: 3 } }
      })
      store.dispatch({ type: 'settings/setShowInputEstimatedTokens', payload: true })
    },
    { assistantId }
  )

  const seeded = await page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return {
      contextCount: assistant?.settings?.contextCount,
      showInputEstimatedTokens: s.settings?.showInputEstimatedTokens
    }
  })
  expect(seeded.contextCount).toBe(3)
  expect(seeded.showInputEstimatedTokens).toBe(true)
  return assistantId
}

/**
 * Type text into the real textarea and submit via Enter key.
 * Exercises the production InputbarCore → sendMessage → _sendMessage thunk path.
 */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.focus()

  // Real sequential keyboard input: every keystroke goes through React 19's
  // controlled-textarea onChange, so the value tracker stays in sync. The
  // previous native-setter + input/change dispatch path desynchronized React's
  // value tracker and was flaky. LOCK-EVIDENCE: no force click, no arbitrary
  // sleep, no Redux dispatch, no native-setter bypass.
  await textarea.pressSequentially(text, { delay: 0 })

  // Deterministic value check before the real Enter submission — pressSequentially
  // awaits the final keystroke, so this assertion cannot race the controlled value.
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/**
 * Wait for a new assistant response to complete by monitoring Redux state.
 * Returns when the assistant count increases past `previousAssistantCount`
 * and the latest assistant message + all its blocks reach terminal state.
 */
async function waitForAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<number> {
  await page.waitForFunction(
    ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let count = 0
      for (const id of msgIds) {
        const msg = s.messages.entities?.[id]
        if (msg?.role === 'assistant') count++
      }
      return count > prevCount
    },
    { topicId, prevCount: previousAssistantCount },
    { timeout }
  )

  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      if (s.messages?.loadingByTopic?.[topicId]) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let latestAssistantId: string | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        const msg = s.messages.entities?.[msgIds[i]]
        if (msg?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages.entities[latestAssistantId]
      const terminalStatuses = ['success', 'error']
      if (!terminalStatuses.includes(assistantMsg.status)) return false
      const blocks = assistantMsg.blocks || []
      if (blocks.length === 0) return false
      for (const blockId of blocks) {
        const block = s.messageBlocks?.entities?.[blockId]
        if (!block) return false
        if (block.status !== 'success' && block.status !== 'error') return false
      }
      return true
    },
    { topicId },
    { timeout }
  )

  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    let count = 0
    for (const id of msgIds) {
      const msg = s.messages.entities[id]
      if (msg?.role === 'assistant') count++
    }
    return count
  }, topicId)
}

/** First user message id for a topic (chronological order). */
async function getFirstUserMessageId(page: import('@playwright/test').Page, topicId: string): Promise<string> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const ids = s.messages.messageIdsByTopic[topicId] || []
    for (const id of ids) {
      const m = s.messages.entities[id]
      if (m?.role === 'user') return id
    }
    return ''
  }, topicId)
}

/** Persisted anchor groupKey for the topic, or null. */
async function getAnchorGroupKey(page: import('@playwright/test').Page, topicId: string): Promise<string | null> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const anchor = assistant?.settings?.contextWindowAnchor?.[topicId]
    return anchor?.kind === 'active' ? anchor.groupKey : null
  }, topicId)
}

/**
 * The message ids inside the boundary divider's preceding message-group DOM
 * sibling. When a boundary divider exists this returns the ids of the messages
 * that form the first selected turn — asserting the boundary stayed on the
 * same starting turn across a step.
 */
async function getBoundaryGroupMessageIds(page: import('@playwright/test').Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const boundary = document.querySelector('[data-testid="context-boundary"]')
    if (!boundary) return null
    const group = boundary.previousElementSibling
    if (!group) return null
    const ids = Array.from(group.querySelectorAll('[data-message-id]')).map((el) => el.getAttribute('data-message-id'))
    return ids.filter((id): id is string => id !== null)
  })
}

/** Click the menubar anchor button of a specific user message (real hover). */
async function clickContextAnchor(page: import('@playwright/test').Page, messageId: string): Promise<void> {
  const msgContainer = page.locator(`[data-message-id="${messageId}"]`)
  await msgContainer.scrollIntoViewIfNeeded()
  await msgContainer.hover()
  const anchorBtn = msgContainer.locator('[data-testid="context-anchor-btn"]')
  await anchorBtn.waitFor({ state: 'visible', timeout: 10000 })
  await anchorBtn.click()
}

/**
 * Assert the TokenCount context block shows exactly `current/max`
 * (whitespace-tolerant: the HStack renders icon + current + "/" + max).
 */
async function expectTokenCount(
  page: import('@playwright/test').Page,
  current: number,
  max: number,
  timeout = 15000
): Promise<void> {
  await expect(page.locator('[data-testid="token-count-context"]')).toHaveText(
    new RegExp(`^\\s*${current}\\s*\\/\\s*${max}\\s*$`),
    { timeout }
  )
}

/**
 * Extract the ordered string contents of the user-role messages from a
 * product request (LOCK-E2E-REQUEST-3). Compares stable semantic content
 * only — never generated ids or the complete provider payload shape.
 * System/provider-required messages are ignored; only the ordered user-role
 * subset is compared. If a provider payload wraps content as multimodal
 * parts, normalize just enough to recover the plain text — this must not
 * weaken the exclusion assertion.
 */
function getRequestUserPrompts(productReq: { parsed: Record<string, unknown> | null } | null): string[] {
  const messages = productReq?.parsed?.messages
  if (!Array.isArray(messages)) return []
  return messages
    .filter((m) => (m as { role?: string })?.role === 'user')
    .map((m) => {
      const content = (m as { content?: unknown })?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter((part) => typeof (part as { text?: unknown })?.text === 'string')
          .map((part) => (part as { text: string }).text)
          .join('')
      }
      return ''
    })
    .filter((text) => text.length > 0)
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Unified Context Window Contract', () => {
  test('fixed anchor growth, TokenCount semantics, quick reset, manual anchor, boundary divider', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    const page = mainWindow

    const tokenCount = page.locator('[data-testid="token-count-context"]')
    const boundary = page.locator('[data-testid="context-boundary"]')
    // ── Step 0: deterministic setup (LOCK-E2E-3) ─────────────────────────
    await test.step('0: Seed contextCount=3 + TokenCount visibility via Redux', async () => {
      await seedContextConfig(page)
      const ctx = await getActiveContext(page)
      expect(ctx.topicId).not.toBe('')

      // TokenCount block must be visible before any conversation message.
      await expect(tokenCount).toBeVisible({ timeout: 15000 })
      // Topic must be fresh: zero messages.
      const msgCount = await page.evaluate((topicId: string) => {
        return (window as any).store.getState().messages.messageIdsByTopic[topicId]?.length || 0
      }, ctx.topicId)
      expect(msgCount).toBe(0)
      console.log(`[E2E][ContextWindow] Setup complete: topic=${ctx.topicId}, contextCount=3`)
    })

    // ── Step A: send 4 turns; auto default anchor stays fixed ────────────
    let topicId: string
    await test.step('A: send 4 turns → TokenCount grows 1/1 → 4/4, no boundary', async () => {
      const ctx = await getActiveContext(page)
      topicId = ctx.topicId
      let assistantCount = 0

      for (let turn = 1; turn <= 4; turn++) {
        const seq = getRequestSequence()
        const text = `Context contract turn ${turn}`
        await uiSendMessage(page, text)
        assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)

        // Real request reached the mock provider (LOCK-E2E-4).
        const productReq = findProductRequestAfter(seq)
        expect(productReq).not.toBeNull()
        expect((productReq!.parsed as any)?.messages).toContainEqual({ role: 'user', content: text })

        // Auto-derived default anchor (contextCount=3) fixes the start at the
        // first turn while history <= 3, so the selected window grows with the
        // topic: TokenCount = turn/turn and no boundary.
        await expectTokenCount(page, turn, turn)
        await expect(boundary).toHaveCount(0)
      }
      console.log('[E2E][ContextWindow] Step A passed: 4/4, no boundary')
    })

    // ── Step B: TokenCount quick reset → default latest 3 ────────────────
    let anchorAfterReset: string | null
    let boundaryGroupAfterReset: string[] | null
    await test.step('B: click TokenCount quick reset → 3/4, boundary appears', async () => {
      await tokenCount.click()
      await expectTokenCount(page, 3, 4)
      await expect(boundary).toBeVisible({ timeout: 15000 })

      anchorAfterReset = await getAnchorGroupKey(page, topicId)
      expect(anchorAfterReset).not.toBeNull()
      boundaryGroupAfterReset = await getBoundaryGroupMessageIds(page)
      expect(boundaryGroupAfterReset).not.toBeNull()
      expect(boundaryGroupAfterReset!.length).toBeGreaterThan(0)
      console.log(`[E2E][ContextWindow] Step B passed: 3/4, boundary visible, anchor=${anchorAfterReset}`)
    })

    // ── Step C: 5th turn; anchor stays fixed → 4/5, boundary same start ──
    await test.step('C: send 5th turn → 4/5, anchor fixed, boundary same starting turn', async () => {
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 5')
      await waitForAssistantResponseComplete(page, topicId, 4)

      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()

      // LOCK-E2E-REQUEST-1/2/4: after the quick reset (latest 3 of 4), the
      // 5th request must deliver exactly the user turns selected by the UI
      // window: turns 2,3,4 plus the new turn 5 — and must EXCLUDE turn 1.
      // TokenCount (4/5) and the boundary only assert the UI; this request
      // subset is the secondary integrated oracle that the model actually
      // received the same window (LOCK-E2E-REQUEST-3).
      const userPrompts = getRequestUserPrompts(productReq)
      expect(userPrompts).toEqual([
        'Context contract turn 2',
        'Context contract turn 3',
        'Context contract turn 4',
        'Context contract turn 5'
      ])

      await expectTokenCount(page, 4, 5)
      await expect(boundary).toBeVisible({ timeout: 15000 })

      // Anchor identity must be unchanged (fixed anchor growth).
      const anchorNow = await getAnchorGroupKey(page, topicId)
      expect(anchorNow).toBe(anchorAfterReset)

      // Boundary divider must sit on the same starting turn.
      const boundaryGroupNow = await getBoundaryGroupMessageIds(page)
      expect(boundaryGroupNow).toEqual(boundaryGroupAfterReset)
      console.log(
        '[E2E][ContextWindow] Step C passed: 4/5, anchor fixed, boundary same start; request user subset = turns 2-5'
      )
    })

    // ── Step D: manual anchor on the first user turn → 5/5, no boundary ──
    await test.step('D: manually anchor first user turn → 5/5, boundary disappears', async () => {
      const firstUserId = await getFirstUserMessageId(page, topicId)
      expect(firstUserId).not.toBe('')

      await clickContextAnchor(page, firstUserId)

      await expectTokenCount(page, 5, 5)
      await expect(boundary).toHaveCount(0)

      const anchorNow = await getAnchorGroupKey(page, topicId)
      expect(anchorNow).toBe(firstUserId)
      console.log('[E2E][ContextWindow] Step D passed: 5/5, no boundary')
    })

    // ── Step E: click the same anchor again to clear → 3/5, boundary back ─
    await test.step('E: click same manual anchor again → default latest 3 restored (3/5), boundary appears', async () => {
      const firstUserId = await getFirstUserMessageId(page, topicId)

      await clickContextAnchor(page, firstUserId)

      await expectTokenCount(page, 3, 5)
      await expect(boundary).toBeVisible({ timeout: 15000 })

      // Anchor is gone; the default derivation took over.
      const anchorNow = await getAnchorGroupKey(page, topicId)
      expect(anchorNow).not.toBe(firstUserId)
      console.log(`[E2E][ContextWindow] Step E passed: 3/5, boundary visible, anchor=${anchorNow}`)
    })

    // ── Step F: non-default manual anchor, then TokenCount reset ─────────
    await test.step('F: manual first-turn anchor (5/5), then TokenCount reset → 3/5, boundary restored', async () => {
      const firstUserId = await getFirstUserMessageId(page, topicId)

      await clickContextAnchor(page, firstUserId)
      await expectTokenCount(page, 5, 5)
      await expect(boundary).toHaveCount(0)
      expect(await getAnchorGroupKey(page, topicId)).toBe(firstUserId)
      console.log('[E2E][ContextWindow] Step F (manual): 5/5, no boundary')

      await tokenCount.click()
      await expectTokenCount(page, 3, 5)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      const anchorNow = await getAnchorGroupKey(page, topicId)
      expect(anchorNow).not.toBe(firstUserId)
      console.log('[E2E][ContextWindow] Step F passed: TokenCount reset → 3/5, boundary restored')
    })

    // Final oracle: 5 user turns + 5 assistant turns exist (real conversation).
    const finalMessageCount = await page.evaluate((topicId: string) => {
      return (window as any).store.getState().messages.messageIdsByTopic[topicId]?.length || 0
    }, topicId)
    expect(finalMessageCount).toBe(10)
  })
})
