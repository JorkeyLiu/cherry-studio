/**
 * Unified Context-Window Contract — focused aggregate Electron E2E
 *
 * Binds the historically drifting integrated user behavior to the approved
 * explicit-anchor semantics:
 *   - `contextWindowAnchor[topicId]` holds ONLY a user-specified context
 *     start. With no explicit anchor the window start is derived DYNAMICALLY
 *     from the assistant's default contextCount (finite N → the latest N
 *     turns; null → the first turn) — a derived default is projection, never
 *     persisted state.
 *   - A resolvable explicit anchor wins and the window grows with the topic
 *     (anchor-to-end, LOCK-CTX-1).
 *   - TokenCount reset DELETES the explicit anchor; the effective start then
 *     falls back to the dynamic default derivation.
 *   - Manual anchor set/clear via the message menubar anchor button.
 *   - Context boundary divider rendering (`data-testid="context-boundary"`).
 *   - Focused restart regression (separate scenario): a persisted explicit
 *     anchor survives a full close + same-profile relaunch untouched —
 *     transient empty/loading startup states never mutate it. The restart
 *     scenario anchors a NON-default position (LOCK-005: the second user
 *     turn, while the derived default is the first turn), so a reintroduced
 *     delete-and-rederive at startup fails the persisted groupKey assertion
 *     deterministically.
 *
 * LOCK-E2E-1: fresh `pnpm build` + repository Electron Playwright fixture
 *             only. No generic CDP/dev-mode browser verification as evidence.
 * LOCK-E2E-2: minimal stable selectors added in production:
 *             - `data-testid="token-count-context"` (TokenCount context block)
 *             - `data-testid="context-anchor-btn"` (menubar anchor button)
 *             - `data-testid="context-boundary"` (divider, data-context-boundary retained)
 * LOCK-E2E-3: contextCount=3 is configured via controlled Redux setup BEFORE
 *             the conversation. TokenCount visibility is always-on (LOCK-108:
 *             the old `showInputEstimatedTokens` setting is removed — no
 *             dispatch, no gate); settings-slider behavior is not part of this
 *             contract.
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
 * LOCK-E2E-REQUEST-1: focused secondary request assertions after the manual
 *             anchor (Step C) and after the reset + next send (Step E) prove
 *             the model receives exactly the selected user-turn subset implied
 *             by the UI window.
 * LOCK-E2E-REQUEST-2: UI interactions / TokenCount / divider remain the
 *             primary evidence; the request-log assertion is a secondary
 *             integrated oracle.
 * LOCK-E2E-REQUEST-3: assert stable semantic content (the known unique user
 *             prompts), not generated ids or the complete provider payload
 *             shape. System/provider-required messages are allowed; the
 *             ordered user-role content subset is compared.
 * LOCK-E2E-REQUEST-4: with the explicit anchor at turn 1 (Step C), the 5th
 *             request includes ALL user prompts (full history — anchored
 *             growth). After the reset (Step E), the 6th request must include
 *             the latest 3 prompts (turns 4,5,6) and EXCLUDE turns 1–3 — the
 *             dynamic default window actually applied. One exact
 *             request-boundary assertion per step is sufficient.
 * LOCK-E2E-REQUEST-5: no broad shared helper extraction in this task —
 *             duplication is accepted.
 * LOCK-E2E-REQUEST-6: ZIP/import files, fixture logic, renderer context
 *             algorithm, and governance files are untouched.
 * Restart coverage note: the restart scenario reuses the established
 * same-profile relaunch helper (`relaunchSameProfile`) + exact-token cleanup
 * (LOCK-625), matching the L2 import specs — no harness redesign. The manual
 * anchor is placed on the SECOND user turn (LOCK-005): with contextCount=3
 * and two turns the derived default start is the FIRST turn, so the anchored
 * groupKey is provably distinct from any delete-and-rederive outcome.
 */
import { expect, findProductRequestAfter, getRequestSequence, test } from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'

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
 * LOCK-E2E-3: configure contextCount=3 via Redux before the conversation
 * begins. The TokenCount display is always-on (LOCK-108) — the removed
 * `settings/setShowInputEstimatedTokens` action is intentionally NOT
 * dispatched, and visibility is asserted at Step 0 as always-on proof.
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
    },
    { assistantId }
  )

  const seeded = await page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return {
      contextCount: assistant?.settings?.contextCount
    }
  })
  expect(seeded.contextCount).toBe(3)
  return assistantId
}

/**
 * Type text into the real textarea and submit via Enter key.
 * Exercises the production InputbarCore → sendMessage → _sendMessage thunk path.
 */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })

  // Single atomic fill: Playwright focuses the textarea, sets the full value
  // and dispatches a real input event, which React 19's controlled onChange
  // (handleTextareaChange → setText) processes — the same mechanism the
  // committed native-setter specs rely on, without per-keystroke delivery so
  // the first keystroke cannot be dropped. Repository precedent:
  // ChatPage.typeMessage fills this input area (tests/e2e/pages/chat.page.ts).
  // LOCK-EVIDENCE: no force click, no arbitrary sleep, no Redux dispatch, no
  // native-setter bypass.
  await textarea.fill(text)

  // Deterministic value check before the real Enter submission — fill awaits
  // the input event, and this auto-retrying assertion confirms the controlled
  // React value rendered the exact full text.
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
  return getNthUserMessageId(page, topicId, 1)
}

/**
 * Id of the n-th user message for a topic (chronological order, 1-indexed).
 * Returns '' when fewer than n user messages exist.
 */
async function getNthUserMessageId(page: import('@playwright/test').Page, topicId: string, n: number): Promise<string> {
  return page.evaluate(
    ({ topicId, n }: { topicId: string; n: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages.messageIdsByTopic[topicId] || []
      let userCount = 0
      for (const id of ids) {
        const m = s.messages.entities[id]
        if (m?.role === 'user') {
          userCount++
          if (userCount === n) return id
        }
      }
      return ''
    },
    { topicId, n }
  )
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
  test('dynamic default, explicit anchor growth, reset, manual anchor, boundary divider', async ({ mainWindow }) => {
    test.setTimeout(300000)
    const page = mainWindow

    const tokenCount = page.locator('[data-testid="token-count-context"]')
    const boundary = page.locator('[data-testid="context-boundary"]')
    // ── Step 0: deterministic setup (LOCK-E2E-3) ─────────────────────────
    await test.step('0: Seed contextCount=3 via Redux; assert always-on TokenCount visibility', async () => {
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

    // ── Step A: 4 turns, NO explicit anchor → dynamic default derivation ──
    let topicId: string
    await test.step('A: send 4 turns → dynamic default: 1/1 → 3/3, then 3/4 + boundary, anchor stays null', async () => {
      const ctx = await getActiveContext(page)
      topicId = ctx.topicId
      let assistantCount = 0

      for (let turn = 1; turn <= 3; turn++) {
        const seq = getRequestSequence()
        const text = `Context contract turn ${turn}`
        await uiSendMessage(page, text)
        assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)

        // Real request reached the mock provider (LOCK-E2E-4).
        const productReq = findProductRequestAfter(seq)
        expect(productReq).not.toBeNull()
        expect((productReq!.parsed as any)?.messages).toContainEqual({ role: 'user', content: text })

        // With no explicit anchor the window derives dynamically from
        // contextCount=3: while history <= 3 the whole topic is selected
        // (turn/turn, no boundary).
        await expectTokenCount(page, turn, turn)
        await expect(boundary).toHaveCount(0)
      }

      // 4th turn: dynamic default slides to the latest 3 turns → 3/4 with a
      // boundary divider. The derived default is NEVER persisted:
      // the Redux anchor entry must stay absent.
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 4')
      assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)
      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()
      await expectTokenCount(page, 3, 4)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      console.log('[E2E][ContextWindow] Step A passed: 3/4, boundary visible, no persisted anchor')
    })

    // ── Step B: manual anchor on the first user turn → 4/4, no boundary ──
    let firstUserId: string
    await test.step('B: manually anchor first user turn → 4/4, boundary disappears', async () => {
      firstUserId = await getFirstUserMessageId(page, topicId)
      expect(firstUserId).not.toBe('')

      await clickContextAnchor(page, firstUserId)

      await expectTokenCount(page, 4, 4)
      await expect(boundary).toHaveCount(0)

      const anchorNow = await getAnchorGroupKey(page, topicId)
      expect(anchorNow).toBe(firstUserId)
      console.log('[E2E][ContextWindow] Step B passed: 4/4, no boundary')
    })

    // ── Step C: 5th turn with the explicit anchor → anchored growth 5/5 ──
    await test.step('C: send 5th turn → 5/5, anchor fixed, full history in request', async () => {
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 5')
      await waitForAssistantResponseComplete(page, topicId, 4)

      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()

      // LOCK-E2E-REQUEST-1/4: with the explicit anchor at turn 1, the 5th
      // request delivers ALL five user prompts (full history — anchored
      // growth, LOCK-CTX-1). The anchor must be unchanged.
      const userPrompts = getRequestUserPrompts(productReq)
      expect(userPrompts).toEqual([
        'Context contract turn 1',
        'Context contract turn 2',
        'Context contract turn 3',
        'Context contract turn 4',
        'Context contract turn 5'
      ])

      await expectTokenCount(page, 5, 5)
      await expect(boundary).toHaveCount(0)

      const anchorNow = await getAnchorGroupKey(page, topicId)
      expect(anchorNow).toBe(firstUserId)
      console.log('[E2E][ContextWindow] Step C passed: 5/5, anchor fixed, full history delivered')
    })

    // ── Step D: TokenCount reset → delete explicit → dynamic 3/5 ─────────
    await test.step('D: TokenCount reset deletes the explicit anchor → 3/5, boundary back, anchor null', async () => {
      await tokenCount.click()
      await expectTokenCount(page, 3, 5)
      await expect(boundary).toBeVisible({ timeout: 15000 })

      // Reset REMOVES the explicit designation; the effective start is then
      // derived dynamically from contextCount=3.
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      console.log('[E2E][ContextWindow] Step D passed: 3/5, boundary visible, explicit anchor deleted')
    })

    // ── Step E: 6th turn after reset → dynamic 3/6; request excludes 1–3 ─
    await test.step('E: send 6th turn → 3/6, dynamic window; request excludes turns 1–3', async () => {
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 6')
      await waitForAssistantResponseComplete(page, topicId, 5)

      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()

      // LOCK-E2E-REQUEST-1/4: after the reset, the 6th request must deliver
      // exactly the dynamic default window: the latest 3 prompts (turns 4,5,6)
      // and EXCLUDE turns 1–3.
      const userPrompts = getRequestUserPrompts(productReq)
      expect(userPrompts).toEqual(['Context contract turn 4', 'Context contract turn 5', 'Context contract turn 6'])

      await expectTokenCount(page, 3, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      console.log('[E2E][ContextWindow] Step E passed: 3/6, request user subset = turns 4-6')
    })

    // ── Step F: manual anchor set + clear preserved ──────────────────────
    await test.step('F: manual turn-2 anchor (5/6, boundary visible), then click same anchor again to clear → 3/6', async () => {
      // Step F re-anchors a turn that stays INSIDE the windowed message
      // renderer. After 12 messages (6 turns) the display window keeps only
      // the latest 5 groups — user turns 2–6 — while turn 1 is virtualized
      // out of the DOM and no longer reachable. The manual set/clear contract
      // must be proven against a rendered, deterministic anchor: the second
      // user turn (the same non-default position LOCK-005 relies on).
      const secondUserId = await getNthUserMessageId(page, topicId, 2)
      expect(secondUserId).not.toBe('')
      expect(secondUserId).not.toBe(firstUserId)

      // Set: explicit anchor at turn 2 → window turns 2–6 = 5/6. Turn 1 sits
      // above the anchored start, so the context boundary divider renders
      // (turn 2's group is inside the display window, so the divider appears).
      await clickContextAnchor(page, secondUserId)
      await expectTokenCount(page, 5, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBe(secondUserId)
      console.log('[E2E][ContextWindow] Step F (set): 5/6, boundary visible before turn 2')

      // Clear: clicking the same anchored turn again deletes the explicit
      // entry; the dynamic default derivation takes over → 3/6 with the
      // boundary back at the latest-3 window.
      await clickContextAnchor(page, secondUserId)
      await expectTokenCount(page, 3, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      console.log('[E2E][ContextWindow] Step F passed: clear → 3/6, boundary restored')
    })

    // Final oracle: 6 user turns + 6 assistant turns exist (real conversation).
    const finalMessageCount = await page.evaluate((topicId: string) => {
      return (window as any).store.getState().messages.messageIdsByTopic[topicId]?.length || 0
    }, topicId)
    expect(finalMessageCount).toBe(12)
  })

  // ---------------------------------------------------------------------------
  // Restart regression: a persisted explicit anchor must survive a full close +
  // same-profile relaunch untouched. The historical bug deleted the anchor while
  // startup messages were still empty and then overwrote it with a derived
  // default once messages loaded; this scenario proves neither mutation happens.
  // ---------------------------------------------------------------------------
  test('explicit anchor survives a same-profile restart; startup does not mutate it', async ({
    mainWindow,
    electronApp,
    userDataDir,
    ownedTmpRoot,
    mockPort
  }) => {
    test.setTimeout(300000)
    const page = mainWindow
    const boundary = page.locator('[data-testid="context-boundary"]')

    let topicId = ''
    let relaunched: Awaited<ReturnType<typeof relaunchSameProfile>> | null = null

    try {
      // ── Phase 1: conversation with a manual explicit anchor ──────────────
      await seedContextConfig(page)
      const ctx = await getActiveContext(page)
      topicId = ctx.topicId
      expect(topicId).not.toBe('')

      let assistantCount = 0
      for (let turn = 1; turn <= 2; turn++) {
        const seq = getRequestSequence()
        const text = `Restart anchor turn ${turn}`
        await uiSendMessage(page, text)
        assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)
        const productReq = findProductRequestAfter(seq)
        expect(productReq).not.toBeNull()
      }

      const firstUserId = await getFirstUserMessageId(page, topicId)
      expect(firstUserId).not.toBe('')

      // LOCK-005: manual explicit anchor on the SECOND user turn — a position
      // provably different from the derived default. With contextCount=3 and
      // two turns the derived default start is the FIRST turn; anchoring the
      // second turn yields a window of 1/2 with a boundary divider before it.
      // A reintroduced startup delete-and-rederive would re-anchor to the
      // first turn, so the persisted groupKey assertion after relaunch fails
      // deterministically.
      const secondUserId = await getNthUserMessageId(page, topicId, 2)
      expect(secondUserId).not.toBe('')
      expect(secondUserId).not.toBe(firstUserId)

      await clickContextAnchor(page, secondUserId)
      await expectTokenCount(page, 1, 2)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBe(secondUserId)

      // ── Phase 2: full app close + same-profile relaunch (LOCK-625) ───────
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => electronApp.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await new Promise((resolve) => setTimeout(resolve, 3000))

      relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
      const rpage = relaunched.page

      // The relaunched app rehydrates the same default assistant/topic.
      const afterCtx = await getActiveContext(rpage)
      expect(afterCtx.topicId).toBe(topicId)

      // ── Phase 3: regression proof — the explicit anchor survived and was
      // not mutated by the startup empty/loading message states ─────────────
      // The persisted groupKey must remain the EXACT second-turn id (LOCK-005).
      // Any reintroduced delete-and-rederive would re-derive the default start
      // (the first turn) and fail this assertion deterministically.
      const anchorAfterRestart = await getAnchorGroupKey(rpage, topicId)
      expect(anchorAfterRestart).toBe(secondUserId)

      // UI projection: the anchored window is 1/2 with a boundary divider
      // before the second turn.
      await expectTokenCount(rpage, 1, 2)
      await expect(rpage.locator('[data-testid="context-boundary"]')).toBeVisible({ timeout: 15000 })

      // Anchor-to-end growth survives the restart: a new turn keeps the
      // explicit anchor fixed → 2/3, boundary still visible.
      const seq = getRequestSequence()
      await uiSendMessage(rpage, 'Restart anchor turn 3')
      await waitForAssistantResponseComplete(rpage, topicId, 2)
      await expectTokenCount(rpage, 2, 3)
      await expect(rpage.locator('[data-testid="context-boundary"]')).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(rpage, topicId)).toBe(secondUserId)
      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()
    } finally {
      // Close the spec-launched relaunched instance by exact token.
      if (relaunched) {
        try {
          await closeElectronWithExactCleanup(userDataDir, {
            close: () => relaunched!.app.close(),
            findExactProcesses: findProcessesByUserDataDir,
            terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
          })
        } catch (error) {
          console.log(
            `[E2E][ContextWindow] relaunched app cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }
  })
})
