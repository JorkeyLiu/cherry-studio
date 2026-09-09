/**
 * Stable Context-Window Contract — focused aggregate Electron E2E
 *
 * Binds the historically drifting integrated user behavior to the approved
 * stable anchor-to-topic-end semantics (`docs/context-window.md`):
 *   - `contextWindowAnchor[topicId]` is the persisted STABLE topic context
 *     start (the start turn's group key). A non-empty initialized topic has
 *     exactly one anchor; the context window is anchor-to-topic-end.
 *   - First establishment: the first user send persists the anchor at the
 *     default window position derived from the assistant's `contextCount`
 *     (finite N → the turn leaving at most N turns; null → the first turn).
 *   - Additional messages grow the window but NEVER move the anchor.
 *   - Changing the default `contextCount` alone NEVER moves an existing
 *     anchor (CW-1).
 *   - TokenCount click is an explicit RE-ANCHOR to the CURRENT default
 *     window position (current turns + current `contextCount`); it never
 *     leaves a non-empty initialized topic anchorless.
 *   - Message-anchor button: clicking a non-anchored turn moves the anchor
 *     there; clicking the CURRENT anchored turn re-anchors to the current
 *     default position (CW-4/CW-8).
 *   - UI highlight, TokenCount, boundary divider, and model request all
 *     resolve from the same persisted anchor (CW-6).
 *   - Persistence is ordinary renderer assistant-settings persistence; the
 *     migration 220 unit tests prove the `contextStartOverride` →
 *     `contextWindowAnchor` field evolution. NO anchor-specific relaunch E2E
 *     is required (CW-7) — no restart scenario exists in this spec.
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
 *     conversation. TokenCount visibility is always-on; settings-slider
 *     behavior is not part of this contract.
 *   - Messages are sent through the real input UI against the mock provider
 *     (no fabricated conversation messages).
 *   - Primary evidence is user-visible UI (TokenCount text, boundary
 *     visibility, anchor-button interactions); Redux is the secondary oracle
 *     for deterministic setup and anchor identity.
 *   - Selectors use test IDs / roles / structural scoping, never
 *     translation-coupled strings or generated message IDs.
 *   - One scenario with test.step; no slider geometry or unrelated UI
 *     coverage.
 *
 * Anchor-icon oracle:
 *   - RENDERED-anchor scope (CW-E2E-1): when the anchored turn's user message
 *     is mounted, a helper counts RENDERED `data-context-anchor-active="true"`
 *     buttons and asserts exactly ONE highlighted message id matching the
 *     expected context-start group. The expected group is the persisted
 *     `contextWindowAnchor[topicId]` group key when resolvable (the stable
 *     contract guarantees one for every non-empty state after first
 *     establishment / re-anchor), falling back to the contextCount-derived
 *     default start for uninitialized legacy states.
 *   - VIRTUALIZED-anchor scope (CW-E2E-2): message windowing may unmount the
 *     anchored turn (e.g. turn 1 after the topic outgrows the rendered
 *     window), so zero highlighted rendered buttons is then VALID. The
 *     virtualized helper first proves the anchored message itself is NOT in
 *     the rendered DOM (`[data-message-id]` count 0) while at least one
 *     anchor button IS rendered, then asserts zero highlighted buttons;
 *     anchor semantics are still proven independently by the persisted
 *     `contextWindowAnchor` group key, the TokenCount current/max, the
 *     boundary divider, and the exact provider request user-turn subset
 *     asserted in the step. A rendered-but-unhighlighted anchor would be a
 *     CW-E2E-1 violation, not this case.
 *
 * Request-level oracle:
 *   - Focused secondary request assertions after the anchor-stable growth
 *     (Step E) and after the re-anchor interactions prove the model receives
 *     exactly the selected user-turn subset implied by the UI window.
 *   - Assert stable semantic content (the known unique user prompts), not
 *     generated ids or the complete provider payload shape.
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

/** Configure contextCount via Redux before the conversation begins. */
async function seedContextConfig(page: import('@playwright/test').Page, contextCount: number | null): Promise<string> {
  const { assistantId } = await getActiveContext(page)
  expect(assistantId).not.toBe('')

  await page.evaluate(
    ({ assistantId, contextCount }) => {
      const store = (window as any).store
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextCount } }
      })
    },
    { assistantId, contextCount }
  )

  const seeded = await page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return {
      contextCount: assistant?.settings?.contextCount
    }
  })
  expect(seeded.contextCount).toBe(contextCount)
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
  // (handleTextareaChange → setText) processes.
  await textarea.fill(text)

  // Deterministic value check before the real Enter submission.
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

/**
 * Persisted `contextWindowAnchor[topicId]` group key from Redux settings
 * (the stable topic anchor), or null. Read after every transition to prove
 * the persisted anchor is the single source of truth.
 */
async function getPersistedAnchorGroupKey(
  page: import('@playwright/test').Page,
  topicId: string
): Promise<string | null> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const anchor = assistant?.settings?.contextWindowAnchor?.[topicId]
    return anchor?.kind === 'active' ? anchor.groupKey : null
  }, topicId)
}

/**
 * Ids of the RENDERED user messages whose anchor button carries
 * `data-context-anchor-active="true"` — the resolved-anchor projection.
 * Anchor buttons render only on user messages, so this query is inherently a
 * user-led topic surface.
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
 * `computeContextInfo` from Redux state: the persisted
 * `contextWindowAnchor[topicId]` group key when it is resolvable against the
 * topic's user turns (the stable contract guarantees one for every non-empty
 * state after first establishment); otherwise the contextCount-derived
 * default start (finite N → the user turn leaving at most N user turns;
 * null → the first user turn) for uninitialized/legacy states. Returns null
 * for an empty topic.
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

    const anchor = assistant?.settings?.contextWindowAnchor?.[topicId]
    if (anchor?.kind === 'active' && userIds.includes(anchor.groupKey)) {
      return anchor.groupKey
    }

    // Safety projection for uninitialized/legacy states (mirrors
    // computeContextInfo fallback). Runtime-aligned normalization: an
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
 * Rendered-anchor invariant (CW-E2E-1), scoped to user-led topics: when the
 * anchored turn's user message is mounted, exactly ONE rendered anchor button
 * is highlighted, and it corresponds to the expected context-start group (the
 * persisted stable anchor). The exactly-one visible button is a user-led UI
 * invariant because anchor buttons render only on user messages. Use
 * `expectAnchorVirtualized` instead when the anchored turn may be unmounted
 * by message windowing.
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

/**
 * Virtualized-anchor invariant (CW-E2E-2): the anchored turn is OUTSIDE the
 * rendered DOM because message windowing has unmounted it, so zero highlighted
 * rendered buttons is VALID — a highlight can only exist on a mounted anchor
 * button. To keep the assertion strong this helper proves the virtualized
 * precondition first: at least one anchor button IS rendered (the message
 * window is live) while the anchored message's own `[data-message-id]`
 * container is absent, then asserts zero `data-context-anchor-active="true"`
 * buttons. A rendered-but-unhighlighted anchor would be a CW-E2E-1 violation,
 * not this case. Anchor semantics are proven independently at the call site
 * by the persisted `contextWindowAnchor` group key, TokenCount, boundary
 * divider, and exact provider request subset.
 */
async function expectAnchorVirtualized(
  page: import('@playwright/test').Page,
  topicId: string,
  timeout = 15000
): Promise<void> {
  await expect(async () => {
    const anchorId = await getPersistedAnchorGroupKey(page, topicId)
    if (anchorId === null) {
      throw new Error('expected a persisted anchor for a non-empty topic, got null')
    }
    const renderedAnchorButtons = await page.locator('[data-testid="context-anchor-btn"]').count()
    if (renderedAnchorButtons === 0) {
      throw new Error('expected the rendered message window to include anchor buttons, got none')
    }
    const anchorRenderedCount = await page.locator(`[data-message-id="${anchorId}"]`).count()
    if (anchorRenderedCount !== 0) {
      throw new Error(`anchored message ${anchorId} is still rendered; expected it virtualized out of the window`)
    }
    const highlighted = await getHighlightedAnchorIds(page)
    if (highlighted.length !== 0) {
      throw new Error(
        `expected no rendered highlighted anchor button with the anchored turn virtualized, got ${highlighted.length}: ${JSON.stringify(highlighted)}`
      )
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
 * product request. Compares stable semantic content only — never generated
 * ids or the complete provider payload shape.
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

test.describe('Stable Context Window Contract', () => {
  test('first establishment, anchor stability, re-anchor, manual move, boundary divider', async ({ mainWindow }) => {
    test.setTimeout(300000)
    const page = mainWindow

    const tokenCount = page.locator('[data-testid="token-count-context"]')
    const boundary = page.locator('[data-testid="context-boundary"]')
    // ── Step 0: deterministic setup (seeded contextCount=3) ──────────────
    let topicId: string = ''
    await test.step('0: Seed contextCount=3 via Redux; empty topic has no anchor', async () => {
      await seedContextConfig(page, 3)
      const ctx = await getActiveContext(page)
      topicId = ctx.topicId
      expect(topicId).not.toBe('')

      // TokenCount block must be visible before any conversation message.
      await expect(tokenCount).toBeVisible({ timeout: 15000 })
      // Topic must be fresh: zero messages → empty window has no anchor.
      const msgCount = await page.evaluate((id: string) => {
        return (window as any).store.getState().messages.messageIdsByTopic[id]?.length || 0
      }, topicId)
      expect(msgCount).toBe(0)
      // An empty topic has no persisted anchor and no highlighted icon.
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBeNull()
      await expectNoAnchor(page)
      console.log(`[E2E][ContextWindow] Setup complete: topic=${topicId}, contextCount=3`)
    })

    // ── Step A: first send establishes the anchor at the default position ─
    let firstUserId: string
    await test.step('A: first send establishes the anchor at turn 1 (1/1, no boundary)', async () => {
      let assistantCount = 0
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 1')
      assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)

      // Real request reached the mock provider.
      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()
      expect((productReq!.parsed as any)?.messages).toContainEqual({ role: 'user', content: 'Context contract turn 1' })

      firstUserId = await getFirstUserMessageId(page, topicId)
      expect(firstUserId).not.toBe('')

      // First establishment: the anchor is persisted at the default window
      // position (contextCount=3, 1 turn → the first turn).
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(firstUserId)
      await expectTokenCount(page, 1, 1)
      await expect(boundary).toHaveCount(0)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step A passed: anchor established at turn 1')
    })

    // ── Step B: additional messages grow the window but never move the anchor ──
    await test.step('B: turns 2-4 → window grows to 4/4, anchor stays at turn 1', async () => {
      let assistantCount = 1
      for (let turn = 2; turn <= 4; turn++) {
        const seq = getRequestSequence()
        await uiSendMessage(page, `Context contract turn ${turn}`)
        assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)
        const productReq = findProductRequestAfter(seq)
        expect(productReq).not.toBeNull()
        expect((productReq!.parsed as any)?.messages).toContainEqual({
          role: 'user',
          content: `Context contract turn ${turn}`
        })
      }

      // Window = anchor-to-end: 4/4, no boundary (anchor at the first turn).
      await expectTokenCount(page, 4, 4)
      await expect(boundary).toHaveCount(0)
      // The anchor is STABLE: new messages never move it (CW-3).
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(firstUserId)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step B passed: 4/4, anchor fixed at turn 1')
    })

    // ── Step C: changing the default contextCount alone never moves the anchor ──
    await test.step('C: contextCount 3→1→3 → anchor stays at turn 1, window unchanged', async () => {
      await seedContextConfig(page, 1)
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(firstUserId)
      // Window still anchor-to-end: 4/4.
      await expectTokenCount(page, 4, 4)
      await expectExactlyOneAnchor(page, topicId)

      // Restore contextCount=3 for the remaining steps.
      await seedContextConfig(page, 3)
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(firstUserId)
      await expectTokenCount(page, 4, 4)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step C passed: default-count change never moved the anchor')
    })

    // ── Step D: TokenCount click re-anchors to the CURRENT default position ──
    await test.step('D: TokenCount click → re-anchor with contextCount=3 → turn 2, 3/4, boundary visible', async () => {
      await tokenCount.click()
      // Default position with 4 turns and contextCount=3 → the turn leaving at
      // most 3 turns = turn 2. Window = 3/4 with a boundary divider.
      await expectTokenCount(page, 3, 4)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      const secondUserId = await getNthUserMessageId(page, topicId, 2)
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(secondUserId)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step D passed: TokenCount re-anchored to turn 2')
    })

    // ── Step E: anchored growth after re-anchor; request excludes turn 1 ──
    await test.step('E: send turn 5 → 4/5, anchor stays turn 2; request = turns 2-5', async () => {
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 5')
      await waitForAssistantResponseComplete(page, topicId, 4)

      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()

      // With the stable anchor at turn 2, the 5th request delivers turns 2-5
      // and EXCLUDES turn 1.
      const userPrompts = getRequestUserPrompts(productReq)
      expect(userPrompts).toEqual([
        'Context contract turn 2',
        'Context contract turn 3',
        'Context contract turn 4',
        'Context contract turn 5'
      ])

      await expectTokenCount(page, 4, 5)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      const secondUserId = await getNthUserMessageId(page, topicId, 2)
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(secondUserId)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step E passed: 4/5, request user subset = turns 2-5')
    })

    // ── Step F: manual anchor move to turn 1 → 5/5, no boundary ──────────
    await test.step('F: manual anchor on turn 1 → 5/5, boundary disappears', async () => {
      firstUserId = await getFirstUserMessageId(page, topicId)
      expect(firstUserId).not.toBe('')

      await clickContextAnchor(page, firstUserId)

      await expectTokenCount(page, 5, 5)
      await expect(boundary).toHaveCount(0)
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(firstUserId)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step F passed: manual move to turn 1 → 5/5')
    })

    // ── Step G: anchored growth to 6/6; request includes ALL turns ──────
    await test.step('G: send turn 6 → 6/6, anchor fixed at turn 1; request = all 6', async () => {
      const seq = getRequestSequence()
      await uiSendMessage(page, 'Context contract turn 6')
      await waitForAssistantResponseComplete(page, topicId, 5)

      const productReq = findProductRequestAfter(seq)
      expect(productReq).not.toBeNull()

      // Anchor at turn 1 → full history delivered (anchored growth).
      const userPrompts = getRequestUserPrompts(productReq)
      expect(userPrompts).toEqual([
        'Context contract turn 1',
        'Context contract turn 2',
        'Context contract turn 3',
        'Context contract turn 4',
        'Context contract turn 5',
        'Context contract turn 6'
      ])

      await expectTokenCount(page, 6, 6)
      await expect(boundary).toHaveCount(0)
      // Turn 1 is virtualized out of the rendered window after 12 messages:
      // zero rendered highlights is valid here (CW-E2E-2). Anchor semantics
      // are still proven by the persisted anchor below plus TokenCount,
      // boundary absence, and the exact all-six-turn request subset above.
      // The exactly-one rendered highlight assertion resumes at Step H once a
      // rendered turn is re-anchored (CW-E2E-3).
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(firstUserId)
      await expectAnchorVirtualized(page, topicId)
      console.log('[E2E][ContextWindow] Step G passed: 6/6, full history delivered')
    })

    // ── Step H: manual anchor move to turn 6 → 1/6, boundary visible ─────
    await test.step('H: manual anchor on turn 6 → 1/6, boundary visible', async () => {
      const sixthUserId = await getNthUserMessageId(page, topicId, 6)
      expect(sixthUserId).not.toBe('')

      await clickContextAnchor(page, sixthUserId)

      await expectTokenCount(page, 1, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(sixthUserId)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step H passed: manual move to turn 6 → 1/6')
    })

    // ── Step I: clicking the CURRENT anchored turn re-anchors to default ──
    await test.step('I: click turn 6 (current anchor) → re-anchor to default → turn 4, 3/6', async () => {
      // Clicking the current anchored turn re-anchors to the CURRENT default
      // window position (contextCount=3, 6 turns → the turn leaving at most 3
      // turns = turn 4). It never leaves the topic anchorless.
      const sixthUserId = await getNthUserMessageId(page, topicId, 6)
      await clickContextAnchor(page, sixthUserId)

      await expectTokenCount(page, 3, 6)
      await expect(boundary).toBeVisible({ timeout: 15000 })
      const fourthUserId = await getNthUserMessageId(page, topicId, 4)
      expect(await getPersistedAnchorGroupKey(page, topicId)).toBe(fourthUserId)
      await expectExactlyOneAnchor(page, topicId)
      console.log('[E2E][ContextWindow] Step I passed: current-anchor click re-anchored to turn 4 (3/6)')
    })

    // Final oracle: 6 user turns + 6 assistant turns exist (real conversation).
    const finalMessageCount = await page.evaluate((id: string) => {
      return (window as any).store.getState().messages.messageIdsByTopic[id]?.length || 0
    }, topicId)
    expect(finalMessageCount).toBe(12)
  })
})
