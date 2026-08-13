/**
 * Unified Context-Window Contract — focused aggregate Electron E2E
 *
 * Binds the historically drifting integrated user behavior to the approved
 * explicit-anchor semantics:
 *   - `contextStartOverride[topicId]` holds ONLY a user-specified context
 *     start. With no override the window start is derived DYNAMICALLY from the
 *     assistant's default contextCount (finite N → the latest N turns; null →
 *     the first turn) — a derived anchor is projection, never persisted state.
 *   - A resolvable override wins and the window grows with the topic
 *     (anchor-to-topic-end).
 *   - TokenCount reset DELETES the override; the effective start then falls
 *     back to the dynamic default derivation.
 *   - Manual override set/clear via the message menubar anchor button.
 *   - Context boundary divider rendering (`data-testid="context-boundary"`).
 *   - Anchor-icon invariant: for every tested non-empty user-led state exactly
 *     ONE rendered anchor icon is highlighted and it corresponds to the
 *     expected context-start group — the single resolved anchor of the window
 *     (derived default, user override, override clear/reset). The exactly-one
 *     visible-button invariant is scoped to user-led topics because anchor
 *     buttons render only on user messages; the semantic resolved anchor
 *     remains universal for every non-empty window regardless of message role.
 *     Override-state checks remain separate (the icon reflects the resolved
 *     anchor, not the settings input).
 *   - Persistence of the override field across app relaunch is NOT a
 *     context-anchor E2E contract: it is ordinary settings persistence,
 *     covered by store behavior tests and the migration 219 unit tests
 *     (`contextWindowAnchor` → `contextStartOverride` field evolution).
 *
 * Evidence rules:
 *   - Fresh `pnpm build` + repository Electron Playwright fixture only. No
 *     generic CDP/dev-mode browser verification as evidence.
 *   - Minimal stable selectors added in production:
 *     - `data-testid="token-count-context"` (TokenCount context block)
 *     - `data-testid="context-anchor-btn"` (menubar anchor button)
 *     - `data-testid="context-boundary"` (divider, data-context-boundary retained)
 *     - `data-context-anchor-active` (resolved-anchor highlight state
 *       attribute on the anchor button)
 *   - contextCount=3 is configured via controlled Redux setup BEFORE the
 *     conversation. TokenCount visibility is always-on (the old
 *     `showInputEstimatedTokens` setting is removed — no dispatch, no gate);
 *     settings-slider behavior is not part of this contract.
 *   - Messages are sent through the real input UI against the mock provider
 *     (no fabricated conversation messages).
 *   - The integrated contract transitions A–F (asserted below).
 *   - Primary evidence is user-visible UI (TokenCount text, boundary
 *     visibility, anchor-button interactions); Redux is the secondary oracle
 *     for deterministic setup and anchor identity.
 *   - Selectors use test IDs / roles / structural scoping, never
 *     translation-coupled strings or generated message IDs.
 *   - One scenario with test.step; no slider geometry or unrelated UI
 *     coverage.
 *
 * Anchor-icon oracle:
 *   - The anchor-icon invariant is asserted with a helper that counts RENDERED
 *     `data-context-anchor-active="true"` buttons and compares the single
 *     highlighted message id against the expected context-start group. The
 *     expected group is computed from Redux (user override when
 *     active+resolvable, otherwise the contextCount-derived default start over
 *     user turns), mirroring `computeContextInfo` for user-led topics.
 *   - The invariant is asserted at every tested non-empty transition
 *     (within-count start, sliding default after overflow, user override
 *     set/clear, reset, anchored growth).
 *
 * Request-level oracle:
 *   - Focused secondary request assertions after the manual anchor (Step C)
 *     and after the reset + next send (Step E) prove the model receives
 *     exactly the selected user-turn subset implied by the UI window.
 *   - UI interactions / TokenCount / divider remain the primary evidence; the
 *     request-log assertion is a secondary integrated oracle.
 *   - Assert stable semantic content (the known unique user prompts), not
 *     generated ids or the complete provider payload shape. System/provider-
 *     required messages are allowed; the ordered user-role content subset is
 *     compared.
 *   - With the override at turn 1 (Step C), the 5th request includes ALL user
 *     prompts (full history — anchored growth). After the reset (Step E), the
 *     6th request must include the latest 3 prompts (turns 4,5,6) and EXCLUDE
 *     turns 1–3 — the dynamic default window actually applied. One exact
 *     request-boundary assertion per step is sufficient.
 *   - No broad shared helper extraction in this task — duplication is
 *     accepted.
 *   - ZIP/import files, fixture logic, renderer context algorithm, and
 *     governance files are untouched.
 *
 * Persistence coverage: the `contextStartOverride` field persists through
 * ordinary settings store behavior, and the migration 219 unit tests prove
 * the `contextWindowAnchor` → `contextStartOverride` field evolution. Neither
 * is re-proven here — the same-profile relaunch scenario and its helper
 * machinery were removed because persistence is not a separate
 * anchor-specific E2E contract.
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
 * Configure contextCount=3 via Redux before the conversation begins. The
 * TokenCount display is always-on — the removed
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
  // Determinism: no force click, no arbitrary sleep, no Redux dispatch, no
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

/** User context-start override groupKey for the topic from Redux settings
 *  (policy input), or null. Read immediately after set/clear to clarify the
 *  policy-input semantics — not a restart-persistence contract. */
async function getAnchorGroupKey(page: import('@playwright/test').Page, topicId: string): Promise<string | null> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const override = assistant?.settings?.contextStartOverride?.[topicId]
    return override?.kind === 'active' ? override.groupKey : null
  }, topicId)
}

/**
 * Ids of the RENDERED user messages whose anchor button carries
 * `data-context-anchor-active="true"` — the resolved-anchor projection.
 * The attribute is present on the button regardless of hover opacity, so the
 * query is deterministic without hovering. Anchor buttons render only on user
 * messages, so this query is inherently a user-led topic surface.
 */
async function getHighlightedAnchorIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids: string[] = []
    const buttons = document.querySelectorAll('[data-testid="context-anchor-btn"][data-context-anchor-active="true"]')
    for (const button of buttons) {
      const container = button.closest('[data-message-id]')
      const id = container?.getAttribute('data-message-id') || ''
      if (id) ids.push(id)
    }
    return ids
  })
}

/**
 * Expected resolved anchor group key for a user-led topic, mirroring
 * `computeContextInfo` from Redux state: an active+resolvable user override
 * wins; otherwise the default derivation (finite N → the user turn leaving at
 * most N user turns selected; null → the first user turn). Returns null for an
 * empty topic.
 *
 * The contextCount normalization mirrors the runtime `getAssistantSettings`
 * semantics: `undefined` falls back to the finite runtime default (25), and
 * only an explicit `null` means unlimited. The scenario seeds contextCount=3
 * before the conversation (asserted in `seedContextConfig`), so this fallback
 * keeps the oracle runtime-aligned even if the seed were ever omitted.
 */
async function getExpectedAnchorGroupKey(
  page: import('@playwright/test').Page,
  topicId: string
): Promise<string | null> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] || []
    const entities = s.messages?.entities || {}
    const userIds = ids.filter((id) => entities[id]?.role === 'user')
    if (userIds.length === 0) return null

    const override = assistant?.settings?.contextStartOverride?.[topicId]
    if (override?.kind === 'active' && userIds.includes(override.groupKey)) {
      return override.groupKey
    }

    // Runtime-aligned normalization (matches `getAssistantSettings`): an
    // undefined contextCount is the finite runtime default (25); only an
    // explicit null is unlimited (first user turn).
    const rawContextCount = assistant?.settings?.contextCount
    const contextCount = rawContextCount === undefined ? 25 : rawContextCount
    if (contextCount === null) {
      return userIds[0] ?? null
    }
    const n = Math.max(1, Math.floor(contextCount))
    const startIndex = Math.max(0, userIds.length - n)
    return userIds[startIndex] ?? null
  }, topicId)
}

/**
 * Unified anchor-icon invariant, scoped to user-led topics: for a non-empty
 * user-led state exactly ONE rendered anchor button is highlighted, and it
 * corresponds to the expected context-start group. The exactly-one visible
 * button is a user-led UI invariant because anchor buttons render only on user
 * messages; the semantic resolved anchor itself remains universal for every
 * non-empty window. Persisted-override assertions stay separate.
 */
async function expectExactlyOneAnchor(
  page: import('@playwright/test').Page,
  topicId: string,
  timeout = 15000
): Promise<void> {
  await expect(async () => {
    const highlighted = await getHighlightedAnchorIds(page)
    if (highlighted.length !== 1) {
      throw new Error(
        `expected exactly 1 highlighted anchor button on the user-led topic, got ${highlighted.length}: ${JSON.stringify(highlighted)}`
      )
    }
    const expected = await getExpectedAnchorGroupKey(page, topicId)
    if (expected === null) {
      throw new Error('expected a resolved anchor for a non-empty user-led topic, got null')
    }
    if (highlighted[0] !== expected) {
      throw new Error(`highlighted anchor button ${highlighted[0]} != expected context-start group ${expected}`)
    }
  }).toPass({ timeout })
}

/** Empty-window invariant: no resolved anchor → no highlighted anchor icon. */
async function expectNoAnchor(page: import('@playwright/test').Page): Promise<void> {
  const highlighted = await getHighlightedAnchorIds(page)
  expect(highlighted.length).toBe(0)
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
 * product request. Compares stable semantic content
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
    // ── Step 0: deterministic setup (seeded contextCount=3) ──────────────
    await test.step('0: Seed contextCount=3 via Redux; assert always-on TokenCount visibility', async () => {
      await seedContextConfig(page)
      const ctx = await getActiveContext(page)
      expect(ctx.topicId).not.toBe('')

      // TokenCount block must be visible before any conversation message.
      await expect(tokenCount).toBeVisible({ timeout: 15000 })
      // Topic must be fresh: zero messages → empty window has no anchor.
      const msgCount = await page.evaluate((topicId: string) => {
        return (window as any).store.getState().messages.messageIdsByTopic[topicId]?.length || 0
      }, ctx.topicId)
      expect(msgCount).toBe(0)
      // An empty window has no resolved anchor → no highlighted icon.
      await expectNoAnchor(page)
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

        // Real request reached the mock provider.
        const productReq = findProductRequestAfter(seq)
        expect(productReq).not.toBeNull()
        expect((productReq!.parsed as any)?.messages).toContainEqual({ role: 'user', content: text })

        // With no explicit override the window derives dynamically from
        // contextCount=3: while history <= 3 the whole topic is selected
        // (turn/turn, no boundary).
        await expectTokenCount(page, turn, turn)
        await expect(boundary).toHaveCount(0)

        // Within-count states keep the FIRST user turn as the single
        // resolved anchor (start never moves while history <= N).
        await expectExactlyOneAnchor(page, topicId)
      }

      // 4th turn: dynamic default slides to the latest 3 turns → 3/4 with a
      // boundary divider. The derived anchor is NEVER persisted:
      // the Redux override entry must stay absent.
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 4')
      assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)
      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()
      await expectTokenCount(page, 3, 4)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      // Within-count start (turns 1–3) anchors the FIRST user turn;
      // after overflow the sliding default anchors the SECOND user turn.
      // Exactly one highlighted anchor matches the expected start group.
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step A passed: 3/4, boundary visible, no persisted override')
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
      // The user override at the first turn resolves to the SAME anchor the
      // default derivation produced before the click (origin independence).
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step B passed: 4/4, no boundary')
    })

    // ── Step C: 5th turn with the explicit anchor → anchored growth 5/5 ──
    await test.step('C: send 5th turn → 5/5, anchor fixed, full history in request', async () => {
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 5')
      await waitForAssistantResponseComplete(page, topicId, 4)

      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()

      // With the explicit anchor at turn 1, the 5th
      // request delivers ALL five user prompts (full history — anchored
      // growth). The anchor must be unchanged.
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
      // Anchored growth: the resolved anchor stays at the first user turn.
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step C passed: 5/5, anchor fixed, full history delivered')
    })

    // ── Step D: TokenCount reset → delete override → dynamic 3/5 ─────────
    await test.step('D: TokenCount reset deletes the override → 3/5, boundary back, override null', async () => {
      await tokenCount.click()
      await expectTokenCount(page, 3, 5)
      await expect(boundary).toBeVisible({ timeout: 15000 })

      // Reset REMOVES the user designation; the effective start is then
      // derived dynamically from contextCount=3 → anchor = third user turn.
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step D passed: 3/5, boundary visible, override deleted')
    })

    // ── Step E: 6th turn after reset → dynamic 3/6; request excludes 1–3 ─
    await test.step('E: send 6th turn → 3/6, dynamic window; request excludes turns 1–3', async () => {
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 6')
      await waitForAssistantResponseComplete(page, topicId, 5)

      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()

      // After the reset, the 6th request must deliver
      // exactly the dynamic default window: the latest 3 prompts (turns 4,5,6)
      // and EXCLUDE turns 1–3.
      const userPrompts = getRequestUserPrompts(productReq)
      expect(userPrompts).toEqual(['Context contract turn 4', 'Context contract turn 5', 'Context contract turn 6'])

      await expectTokenCount(page, 3, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      // Dynamic default after reset + growth: anchor = the fourth user turn.
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step E passed: 3/6, request user subset = turns 4-6')
    })

    // ── Step F: manual anchor set + clear preserved ──────────────────────
    await test.step('F: manual turn-2 anchor (5/6, boundary visible), then click same anchor again to clear → 3/6', async () => {
      // Step F re-anchors a turn that stays INSIDE the windowed message
      // renderer. After 12 messages (6 turns) the display window keeps only
      // the latest 5 groups — user turns 2–6 — while turn 1 is virtualized
      // out of the DOM and no longer reachable. The manual set/clear contract
      // must be proven against a rendered, deterministic anchor: the second
      // user turn — a non-default position inside the rendered window.
      const secondUserId = await getNthUserMessageId(page, topicId, 2)
      expect(secondUserId).not.toBe('')
      expect(secondUserId).not.toBe(firstUserId)

      // Set: override at turn 2 → window turns 2–6 = 5/6. Turn 1 sits
      // above the anchored start, so the context boundary divider renders
      // (turn 2's group is inside the display window, so the divider appears).
      await clickContextAnchor(page, secondUserId)
      await expectTokenCount(page, 5, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBe(secondUserId)
      // User override at turn 2 → the single resolved anchor is turn 2.
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step F (set): 5/6, boundary visible before turn 2')

      // Clear: clicking the same overridden turn again deletes the override
      // entry; the dynamic default derivation takes over → 3/6 with the
      // boundary back at the latest-3 window.
      await clickContextAnchor(page, secondUserId)
      await expectTokenCount(page, 3, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getAnchorGroupKey(page, topicId)).toBeNull()
      // Override clear → default derivation → anchor = the fourth user turn.
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step F passed: clear → 3/6, boundary restored')
    })

    // Final oracle: 6 user turns + 6 assistant turns exist (real conversation).
    const finalMessageCount = await page.evaluate((topicId: string) => {
      return (window as any).store.getState().messages.messageIdsByTopic[topicId]?.length || 0
    }, topicId)
    expect(finalMessageCount).toBe(12)
  })
})
