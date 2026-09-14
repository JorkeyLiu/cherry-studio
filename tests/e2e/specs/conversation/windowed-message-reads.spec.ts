/**
 * S6.1 Windowed reads — evidence-tier-honest regression.
 *
 * Evidence tiers (honest classification):
 * - R-02 latest bootstrap — INTEGRATED evidence: seed > displayCount via approved
 *   `assistants/addTopic` + `window.api.chatDb.ensureTopic` + `pasteMessagesToTopic`,
 *   activate the rendered topic item (real HomePage → useActiveTopic →
 *   loadTopicMessagesThunk), wait on real Redux/DOM, assert bounded window,
 *   expected tail IDs, and hasMoreBefore (via contract probe). This is renderer
 *   activation/projection proof.
 * - R-03 around — CONTRACT-ONLY evidence via real `window.api.chatDb.fetchMessagesWindow`
 *   through preload/Main IPC: obtain the stable oldestMessageId from the actually
 *   loaded Redux/DOM projection, call Main with {kind:'around', anchorMessageId,
 *   before:LOAD_MORE, after:1}, assert request bounds, anchor echo/inclusion,
 *   completeness=window, returnedCount/first/last consistency, deterministic
 *   order/no duplicate IDs, and hasMore flags. This is NOT renderer merge/scroll
 *   UI proof.
 * - R-03 renderer merge — INTEGRATED UI evidence: real topic activation followed by
 *   a real scroll event on the existing `#messages` container to the inverse
 *   threshold (`Math.min(0, clientHeight - scrollHeight)`), production
 *   InfiniteScroll → around → mergeWindowIntoTopic → Redux/DOM growth. No
 *   synthetic dispatch, no spacer, no instrumentation.
 * - R-04 whole-topic snapshot via real copy-as-Markdown — INTEGRATED snapshot
 *   action with independent fetchWholeTopicSnapshot oracle; loaded window
 *   unchanged (snapshot never publishes).
 * - R-05 ChatFlowHistory whole-topic graph — INTEGRATED UI evidence: enable
 *   messageNavigation via existing settings action, cold-activate the same
 *   50/20 seed, open Chat History through the hover-gated navigation button
 *   (accessible role/name, locale-robust), assert the ReactFlow drawer holds
 *   deterministic head/window-outside + tail content with node count 50 > 20
 *   against the fetchWholeTopicSnapshot oracle, loaded Redux/DOM unchanged,
 *   then real-send a marker with the drawer open and assert the coalesced
 *   MESSAGE_COMPLETE/updatedAt refetch grows the graph (marker + reply +
 *   retained head, no empty state).
 *
 * Governing constraints:
 * - Uses standard fixture (fresh production build, disposable profile, mock provider).
 * - Seeds via approved pattern only; no direct SQLite file writes.
 * - Calls the existing `chatdb:fetch-messages-window` contract and the
 *   already-used `chatdb:fetch-whole-topic-snapshot` oracle only; 1..100 are
 *   validation bounds, not new defaults; no R-06, no new fields/SQL/cursors.
 * - No wrapper/monkey-patching of `window.api.chatDb.fetchMessagesWindow`,
 *   `window.electron.ipcRenderer`, or legacy `fetchMessages`; no call-count asserts
 *   from ineffective wrappers; no synthetic Redux publication. UI scroll uses the
 *   real container and bubbling Event('scroll'); only the throttle wait uses a
 *   bounded waitForTimeout(350).
 * - No production source/docs edits, no fixture-global edits, no new selectors.
 */

import { expect, findProductRequestAfter, getRequestSequence, test } from '../../fixtures/electron.fixture'

const DISPLAY_LIMIT = 20 // caller-provided limit within 1..100
const SYNTHETIC_TOTAL = 50 // > DISPLAY_LIMIT to prove bounded window
const LOAD_MORE = 20 // existing LOAD_MORE_COUNT (1..100)

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

async function seedWindowTopic(
  page: any,
  liveAssistantId: string,
  topicId: string
): Promise<{ topicId: string; liveAssistantId: string }> {
  const name = `Window Test ${topicId}`

  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        const store = (window as any).store
        store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name }
  )
  expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)

  const content = 'window-test-content-' + 'x'.repeat(40)
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < SYNTHETIC_TOTAL; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    entries.push({
      message: {
        id: msgId,
        topicId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        assistantId: liveAssistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [blockId],
        sortOrder: i
      },
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: `${content}-${pad(i, 5)}`,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  }

  const persist = await page.evaluate(
    async ({
      topicId,
      assistantId,
      name,
      entries
    }: {
      topicId: string
      assistantId: string
      name: string
      entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
    }) => {
      try {
        const api = (window as any).api as any
        const chatDb = api?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function') {
          return { ok: false, err: 'chatDb missing' }
        }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name, entries }
  )
  expect(persist.ok, `persist failed: ${(persist as any).err}`).toBe(true)

  return { topicId, liveAssistantId }
}

async function prepareDisplayCountAndAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, DISPLAY_LIMIT)

  const displayOk = await page.evaluate(
    (limit: number) => (window as any).store.getState().messages.displayCount,
    DISPLAY_LIMIT
  )
  expect(displayOk).toBe(DISPLAY_LIMIT)

  const liveAssistantId = await page.evaluate(
    () =>
      (window as any).store.getState().assistants?.assistants?.[0]?.id ??
      (window as any).store.getState().assistants?.defaultAssistant?.id ??
      null
  )
  expect(liveAssistantId, 'live assistant id must exist for addTopic').toBeTruthy()
  return liveAssistantId as string
}

async function activateTopicAndWaitForBootstrap(page: any, topicId: string): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()

  await page.waitForFunction(
    ({ topicId, expected }: { topicId: string; expected: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length === expected && loading !== true
    },
    { topicId, expected: DISPLAY_LIMIT },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages [data-message-id]').length === expected,
    DISPLAY_LIMIT,
    { timeout: 30000 }
  )
}

/**
 * Real UI send pattern copied from ordinary-chat.spec.ts (spec-local only —
 * never a fixture-global helper). Exercises the production InputbarCore →
 * sendMessage thunk path via React-compatible input events + Enter.
 */
async function uiSendMessage(page: any, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()

  await page.evaluate(
    ({ selector, text }: { selector: string; text: string }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', text }
  )

  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/**
 * R-05 drawer-open send (spec-local only — never a fixture-global helper).
 * The ReactFlow drawer pane overlays `.inputbar textarea`, so Playwright
 * pointer actionability (click / locator.press) cannot pass while the drawer
 * stays open. This helper keeps the drawer open and still exercises the
 * production input event + Enter send path: DOM focus (no click), native
 * HTMLTextAreaElement value setter + bubbling `input` event for React state,
 * value assertion, then global Enter while the textarea is focused. No Redux
 * thunk/service dispatch, no production formatter calls.
 */
async function uiSendMessageWithDrawerOpen(page: any, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'attached', timeout: 15000 })
  await expect(textarea).toBeEnabled({ timeout: 10000 })
  await textarea.evaluate((el: HTMLTextAreaElement) => el.focus())

  await page.evaluate(
    ({ selector, text }: { selector: string; text: string }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', text }
  )

  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await page.keyboard.press('Enter')
}

/**
 * Assistant-completion wait copied from ordinary-chat.spec.ts (spec-local
 * only). Resolves when a new assistant message reaches terminal status with
 * terminal blocks and the topic queue drained.
 */
async function waitForAssistantResponseComplete(
  page: any,
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
      if (!['success', 'error'].includes(assistantMsg.status)) return false
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

const HISTORY_ACCESSIBLE_NAME = '^(Chat History|聊天历史)$'

/**
 * Opens the Chat History drawer through the real hover-gated navigation bar
 * (ChatNavigation.tsx, spec-local only). The bar is pointer-events:none until
 * the cursor enters the trigger band (RIGHT_GAP=16, width=60, vertical
 * 35%..65% of viewport, right offset +275 when right topics are shown). The
 * trigger point is derived from that production geometry plus the live
 * store/viewport — never arbitrary coordinates — and delivered as a real
 * mouse move through the production window-mousemove path. Up to four
 * derived vertical candidates are probed (elementFromPoint actionability) to
 * tolerate an excluded-area landing (e.g. code-toolbar under the cursor).
 */
async function openChatHistoryDrawer(page: any): Promise<void> {
  const candidates = await page.evaluate(() => {
    const s = (window as any).store.getState()
    const showRightTopics = s.settings?.showTopics !== false
    const rightOffset = 16 + (showRightTopics ? 275 : 0)
    const x = Math.round(window.innerWidth - rightOffset - 60 / 2)
    const ys = [0.5, 0.42, 0.58, 0.38].map((f) => Math.round(window.innerHeight * f))
    return { x, ys }
  })

  let exposed = false
  for (const y of candidates.ys) {
    await page.mouse.move(candidates.x, y)
    // Bounded settle for the 50ms production mousemove throttle + React flush.
    await page.waitForTimeout(300)
    const probe = await page.evaluate((pattern: string) => {
      const re = new RegExp(pattern)
      const btn =
        Array.from(document.querySelectorAll('button')).find((b) =>
          re.test((b.getAttribute('aria-label') || '').trim())
        ) ?? null
      if (!btn) return { found: false, hit: false }
      const r = btn.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return { found: true, hit: false }
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { found: true, hit: !!el && (el === btn || btn.contains(el)) }
    }, HISTORY_ACCESSIBLE_NAME)
    if (probe.hit) {
      exposed = true
      break
    }
  }
  expect(exposed, 'hover trigger band never exposed the history navigation button').toBe(true)

  const historyBtn = page.getByRole('button', { name: new RegExp(HISTORY_ACCESSIBLE_NAME) })
  await historyBtn.hover({ timeout: 10000 })
  await historyBtn.click({ timeout: 10000 })
}

test.describe('windowed reads: latest and around', () => {
  test.setTimeout(180000)

  test('R-02 latest bootstrap — integrated activation/projection (windowed)', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'R-02 INTEGRATED: real topic activation → loadTopicMessagesThunk → Redux/DOM bounded window. Direct window.api latest probe is supplementary CONTRACT evidence, not renderer UI proof.'
    })

    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `window-r02-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await seedWindowTopic(page, liveAssistantId, topicId)
    await activateTopicAndWaitForBootstrap(page, topicId)

    // Integrated assertions: bounded window via real Redux/DOM
    const projection = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      return { ids, domCount, domIds }
    }, topicId)

    expect(projection.ids.length).toBe(DISPLAY_LIMIT)
    expect(projection.domCount).toBe(DISPLAY_LIMIT)
    expect(projection.domIds.length).toBe(DISPLAY_LIMIT)

    // IDs must be the expected tail (deterministic sortOrder ascending)
    const expectedTailIds: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT; i < SYNTHETIC_TOTAL; i++) {
      expectedTailIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }
    expect(projection.ids).toEqual(expectedTailIds)
    // DOM order is render-dependent (column-reverse / flex); assert same set regardless of order
    expect([...projection.domIds].sort()).toEqual([...expectedTailIds].sort())
    expect(projection.domIds).toContain(expectedTailIds[0])
    expect(projection.domIds).toContain(expectedTailIds[expectedTailIds.length - 1])

    // Deterministic order / no duplicates
    expect(new Set(projection.ids).size).toBe(projection.ids.length)
    const toNum = (id: string) => Number(id.split('-').pop())
    for (let i = 1; i < projection.ids.length; i++) {
      expect(toNum(projection.ids[i])).toBeGreaterThan(toNum(projection.ids[i - 1]))
    }

    // hasMoreBefore proof via direct contract (same channel, real Main) — labeled as CONTRACT evidence
    // This supplements the integrated projection; it is not itself renderer UI regression proof.
    const latestContract = await page.evaluate(
      async ({ topicId, limit }: { topicId: string; limit: number }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'latest', topicId, limit })
      },
      { topicId, limit: DISPLAY_LIMIT }
    )

    // latestContract is ChatDbResult<WindowResponse>
    expect(latestContract.ok).toBe(true)
    const val: any = latestContract.value
    expect(val).toBeTruthy()
    expect(val.window).toBeTruthy()
    expect(val.window.kind).toBe('latest')
    expect(val.window.completeness).toBe('window')
    expect(val.window.topicId).toBe(topicId)
    expect(val.window.requested?.limit).toBe(DISPLAY_LIMIT)
    expect(val.window.returnedCount).toBe(val.messages.length)
    expect(val.window.returnedCount).toBe(DISPLAY_LIMIT)
    expect(val.window.firstMessageId).toBeTruthy()
    expect(val.window.lastMessageId).toBeTruthy()
    expect(val.messages[0].id).toBe(val.window.firstMessageId)
    expect(val.messages[val.messages.length - 1].id).toBe(val.window.lastMessageId)
    expect(val.window.hasMoreBefore).toBe(true)
    expect(val.window.hasMoreAfter).toBe(false)

    const expectedFirst = `${topicId}-msg-${pad(SYNTHETIC_TOTAL - DISPLAY_LIMIT, 5)}`
    const expectedLast = `${topicId}-msg-${pad(SYNTHETIC_TOTAL - 1, 5)}`
    expect(val.window.firstMessageId).toBe(expectedFirst)
    expect(val.window.lastMessageId).toBe(expectedLast)
    expect(val.messages.map((m: any) => m.id)).toEqual(expectedTailIds)
  })

  test('R-03 around contract — Main/preload windowed read via real window.api (contract-only)', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'R-03 CONTRACT-ONLY: real window.api.chatDb.fetchMessagesWindow({kind:around}) through preload/Main. Does NOT prove renderer merge/scroll UI — that is proven by the companion integrated test "R-03 renderer merge — real scroll triggers around and merges into Redux/DOM" below in this same spec; this contract test must not use synthetic dispatch.'
    })
    // Explicit comment for report-facing classification: this test is contract-only.
    // Scroll-triggered InfiniteScroll → around request → Redux/DOM merge is not
    // proven by this contract test; it is proven by the integrated renderer test
    // "R-03 renderer merge — real scroll triggers around and merges into Redux/DOM"
    // below in this spec. This scoping does not claim broader Phase closure.

    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `window-r03-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await seedWindowTopic(page, liveAssistantId, topicId)
    await activateTopicAndWaitForBootstrap(page, topicId)

    // Stable oldestMessageId from the actually loaded Redux/DOM projection (real bootstrap)
    const anchorInfo = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      return { ids, domIds }
    }, topicId)

    expect(anchorInfo.ids.length).toBe(DISPLAY_LIMIT)
    const oldestAnchorId = anchorInfo.ids[0]
    expect(oldestAnchorId).toBeTruthy()
    // DOM order is render-dependent (column-reverse); assert DOM contains the stable anchor and bounded set
    expect(anchorInfo.domIds).toContain(oldestAnchorId)
    expect([...anchorInfo.domIds].sort()).toEqual([...anchorInfo.ids].sort())

    const expectedAnchor = `${topicId}-msg-${pad(SYNTHETIC_TOTAL - DISPLAY_LIMIT, 5)}`
    expect(oldestAnchorId).toBe(expectedAnchor)

    // Direct around contract via real preload/Main IPC — no synthetic Redux publication
    const aroundRes: any = await page.evaluate(
      async ({
        topicId,
        anchor,
        before,
        after
      }: {
        topicId: string
        anchor: string
        before: number
        after: number
      }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({
          kind: 'around',
          topicId,
          anchorMessageId: anchor,
          before,
          after
        })
      },
      { topicId, anchor: oldestAnchorId, before: LOAD_MORE, after: 1 }
    )

    expect(aroundRes.ok).toBe(true)
    const aval: any = aroundRes.value
    expect(aval).toBeTruthy()
    expect(aval.window).toBeTruthy()
    expect(aval.window.kind).toBe('around')
    expect(aval.window.completeness).toBe('window')
    expect(aval.window.topicId).toBe(topicId)
    expect(aval.window.anchorMessageId).toBe(oldestAnchorId)
    expect(aval.window.requested?.before).toBe(LOAD_MORE)
    expect(aval.window.requested?.after).toBe(1)

    // Request bounds 1..100
    expect(aval.window.requested.before).toBeGreaterThanOrEqual(1)
    expect(aval.window.requested.before).toBeLessThanOrEqual(100)
    expect(aval.window.requested.after).toBeGreaterThanOrEqual(1)
    expect(aval.window.requested.after).toBeLessThanOrEqual(100)

    // returnedCount / first / last consistency
    expect(aval.window.returnedCount).toBe(aval.messages.length)
    expect(aval.window.firstMessageId).toBeTruthy()
    expect(aval.window.lastMessageId).toBeTruthy()
    expect(typeof aval.window.firstMessageId).toBe('string')
    expect(typeof aval.window.lastMessageId).toBe('string')
    expect(aval.messages[0].id).toBe(aval.window.firstMessageId)
    expect(aval.messages[aval.messages.length - 1].id).toBe(aval.window.lastMessageId)

    // Anchor echo and inclusion
    expect(aval.messages.some((m: any) => m.id === oldestAnchorId)).toBe(true)

    // Deterministic order / no duplicate IDs
    expect(new Set(aval.messages.map((m: any) => m.id)).size).toBe(aval.messages.length)
    const toNum = (id: string) => Number(id.split('-').pop())
    for (let i = 1; i < aval.messages.length; i++) {
      expect(toNum(aval.messages[i].id)).toBeGreaterThan(toNum(aval.messages[i - 1].id))
    }

    // hasMore flags — booleans present and consistent with seeded topology
    expect(typeof aval.window.hasMoreBefore).toBe('boolean')
    expect(typeof aval.window.hasMoreAfter).toBe('boolean')
    // With 50 seeded, tail anchor at 30, before 20 → start 10 >0, end 32 <50
    expect(aval.window.hasMoreBefore).toBe(true)
    expect(aval.window.hasMoreAfter).toBe(true)

    // Bounds: hasMoreBefore true because older messages remain, hasMoreAfter true because newer remain
    // Window should be anchored: for this seed, expect 22 messages (10..31 inclusive)
    const expectedAroundFirst = `${topicId}-msg-${pad(10, 5)}`
    const expectedAroundLast = `${topicId}-msg-${pad(31, 5)}`
    expect(aval.window.firstMessageId).toBe(expectedAroundFirst)
    expect(aval.window.lastMessageId).toBe(expectedAroundLast)
    expect(aval.window.returnedCount).toBe(22)

    // Verify Redux/DOM remain at the bounded bootstrap window — contract call does
    // not auto-merge into renderer projection (that merge is the uncovered R-03 UI path).
    const stillBounded = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      return { idsLen: ids.length, domCount }
    }, topicId)
    expect(stillBounded.idsLen).toBe(DISPLAY_LIMIT)
    expect(stillBounded.domCount).toBe(DISPLAY_LIMIT)

    // Ensure no legacy scroll/dispatch was faked — use polling to confirm no unexpected growth
    await expect
      .poll(
        async () =>
          await page.evaluate(
            (topicId: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[topicId]?.length ?? 0,
            topicId
          ),
        { timeout: 1500 }
      )
      .toBe(DISPLAY_LIMIT)
  })

  test('R-03 renderer merge — real scroll triggers around and merges into Redux/DOM', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'R-03 INTEGRATED UI: real #messages scroll to inverse threshold → InfiniteScroll next → around → mergeWindowIntoTopic → Redux/DOM growth. No synthetic dispatch, no spacer, no instrumentation.'
    })

    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `window-r03-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await seedWindowTopic(page, liveAssistantId, topicId)
    await activateTopicAndWaitForBootstrap(page, topicId)

    // Pre-state: real Redux/DOM/scroll geometry and contract hasMoreBefore
    const preState = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      const el = document.getElementById('messages') as HTMLElement | null
      const geom = el ? { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop } : null
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      return { ids, domIds, geom, domCount }
    }, topicId)

    expect(
      preState.ids.length,
      `pre Redux length expected ${DISPLAY_LIMIT}, got ${preState.ids.length} ids=${JSON.stringify(preState.ids)}`
    ).toBe(DISPLAY_LIMIT)
    expect(preState.domCount, `pre DOM count expected ${DISPLAY_LIMIT}, got ${preState.domCount}`).toBe(DISPLAY_LIMIT)
    expect(preState.domIds.length).toBe(DISPLAY_LIMIT)

    const expectedTailIds: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT; i < SYNTHETIC_TOTAL; i++) {
      expectedTailIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }
    expect(preState.ids).toEqual(expectedTailIds)
    expect([...preState.domIds].sort()).toEqual([...expectedTailIds].sort())

    expect(preState.geom, '#messages geometry must exist').toBeTruthy()
    const preGeom = preState.geom!
    // Content must naturally overflow (no spacer); scrollHeight > clientHeight is required for the inverse threshold to be <0
    expect(
      preGeom.scrollHeight > preGeom.clientHeight,
      `expected overflow: scrollHeight(${preGeom.scrollHeight}) > clientHeight(${preGeom.clientHeight})`
    ).toBe(true)

    const preLatest = await page.evaluate(
      async ({ topicId, limit }: { topicId: string; limit: number }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'latest', topicId, limit })
      },
      { topicId, limit: DISPLAY_LIMIT }
    )
    expect(preLatest.ok, `latest contract failed ${JSON.stringify(preLatest)}`).toBe(true)
    expect((preLatest.value as any).window.hasMoreBefore).toBe(true)
    expect((preLatest.value as any).window.hasMoreAfter).toBe(false)

    const preOldestAnchorId = preState.ids[0]
    const expectedPreOldest = `${topicId}-msg-${pad(SYNTHETIC_TOTAL - DISPLAY_LIMIT, 5)}`
    expect(preOldestAnchorId).toBe(expectedPreOldest)
    expect(preState.domIds).toContain(preOldestAnchorId)

    // Trigger older loading via real scroll on existing #messages (no spacer, no fake callback)
    // Production semantics: Messages.tsx:1027 uses oldestMessageId as request anchor, while
    // Messages.tsx:1039 captures the first actually visible message via findFirstVisibleMessage
    // and Messages.tsx:1121-1141 stabilizes newRect.top - oldRect.top by adjusting container.scrollTop.
    // The correct behavioral proxy is the first visible message's offset relative to #messages.
    const scrollInfo = await page.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      if (!el) throw new Error('#messages not found')
      const targetTop = Math.min(0, el.clientHeight - el.scrollHeight)
      const before = { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
      el.scrollTop = targetTop
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
      const after = { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }
      return { targetTop, before, after }
    })

    // The element must reach the inverse threshold (allow small tolerance for clamping)
    expect(
      Math.abs(scrollInfo.after.scrollTop - scrollInfo.targetTop) <= 12,
      `scrollTop after dispatch ${scrollInfo.after.scrollTop} should be near targetTop ${scrollInfo.targetTop} (before=${JSON.stringify(scrollInfo.before)} after=${JSON.stringify(scrollInfo.after)})`
    ).toBe(true)

    // Ensure scroll geometry is settled before reading the visible anchor (single rAF, no unbounded sleep).
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

    // Production-aligned visible anchor capture: after threshold scroll but before throttle/merge.
    // Mirrors findFirstVisibleMessage (src/renderer/src/pages/home/Messages/domVisibility.ts): filter display:none, zero-height,
    // no positive intersection with container rect, choose element whose rect.top is closest
    // to container rect.top. Record container-relative offset (rect.top - containerRect.top).
    const visibleAnchor = await page.evaluate(() => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return null
      const containerRect = container.getBoundingClientRect()
      const candidates = Array.from(container.querySelectorAll('[data-message-id]')) as HTMLElement[]
      let closest: {
        id: string
        offset: number
        containerTop: number
        rectTop: number
      } | null = null
      let minDistance = Infinity
      for (const el of candidates) {
        if (window.getComputedStyle(el).display === 'none') continue
        const rect = el.getBoundingClientRect()
        if (rect.height === 0) continue
        const visibleHeight = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top)
        if (visibleHeight <= 0) continue
        const distance = Math.abs(rect.top - containerRect.top)
        if (distance < minDistance) {
          const id = el.getAttribute('data-message-id') || ''
          if (!id) continue
          minDistance = distance
          closest = {
            id,
            offset: rect.top - containerRect.top,
            containerTop: containerRect.top,
            rectTop: rect.top
          }
        }
      }
      return closest
    })

    expect(
      visibleAnchor,
      'visible anchor must be found after threshold scroll (findFirstVisibleMessage semantics: filtered [data-message-id] closest to container top)'
    ).toBeTruthy()

    // Throttle wait — InfiniteScroll/debounce requires at least 300ms before the around request fires
    await page.waitForTimeout(350)

    // Wait for real Redux/DOM projection to grow beyond the initial window via production merge path
    await page.waitForFunction(
      ({ topicId, preLen }: { topicId: string; preLen: number }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        return Array.isArray(ids) && ids.length > preLen
      },
      { topicId, preLen: DISPLAY_LIMIT },
      { timeout: 15000 }
    )

    // Ideally exactly one LOAD_MORE around load → 40 messages (20 + 20 older)
    await expect
      .poll(
        async () =>
          await page.evaluate(
            (topicId: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[topicId]?.length ?? 0,
            topicId
          ),
        { timeout: 15000 }
      )
      .toBe(DISPLAY_LIMIT + LOAD_MORE)

    await page.waitForFunction(
      (expected: number) => document.querySelectorAll('#messages [data-message-id]').length === expected,
      DISPLAY_LIMIT + LOAD_MORE,
      {
        timeout: 15000
      }
    )

    const postState = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      const el = document.getElementById('messages') as HTMLElement | null
      const geom = el ? { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop } : null
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      return { ids, domIds, geom, domCount }
    }, topicId)

    expect(
      postState.ids.length,
      `post Redux length expected ${DISPLAY_LIMIT + LOAD_MORE}, got ${postState.ids.length}`
    ).toBe(DISPLAY_LIMIT + LOAD_MORE)
    expect(postState.domCount).toBe(DISPLAY_LIMIT + LOAD_MORE)
    expect(postState.domIds.length).toBe(DISPLAY_LIMIT + LOAD_MORE)

    // Newly loaded IDs are 00010..00029, complete visible 00010..00049
    const expectedNewIds: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT - LOAD_MORE; i < SYNTHETIC_TOTAL - DISPLAY_LIMIT; i++) {
      expectedNewIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }
    const expectedAllIds: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT - LOAD_MORE; i < SYNTHETIC_TOTAL; i++) {
      expectedAllIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }
    expect(expectedNewIds).toEqual(Array.from({ length: LOAD_MORE }, (_, k) => `${topicId}-msg-${pad(10 + k, 5)}`))
    expect(expectedAllIds).toEqual(
      Array.from({ length: DISPLAY_LIMIT + LOAD_MORE }, (_, k) => `${topicId}-msg-${pad(10 + k, 5)}`)
    )

    // Every newly loaded ID must now be present and the full set must match
    for (const nid of expectedNewIds) {
      expect(postState.ids, `missing newly loaded id ${nid} in ${JSON.stringify(postState.ids)}`).toContain(nid)
    }
    expect(postState.ids).toEqual(expectedAllIds)

    // Redux order ascending by numeric suffix and no duplicates; DOM equals Redux set
    expect(new Set(postState.ids).size, `duplicate ids in ${JSON.stringify(postState.ids)}`).toBe(postState.ids.length)
    const toNum = (id: string) => Number(id.split('-').pop())
    for (let i = 1; i < postState.ids.length; i++) {
      expect(
        toNum(postState.ids[i]),
        `order break at ${i}: ${postState.ids[i - 1]} -> ${postState.ids[i]}`
      ).toBeGreaterThan(toNum(postState.ids[i - 1]))
    }
    expect(new Set(postState.domIds).size, `duplicate DOM ids ${JSON.stringify(postState.domIds)}`).toBe(
      postState.domIds.length
    )
    expect([...postState.domIds].sort()).toEqual([...postState.ids].sort())

    // hasMoreBefore remains true (still 0..9 older remain), hasMoreAfter remains false (still at newest)
    const postLatest = await page.evaluate(
      async ({ topicId, limit }: { topicId: string; limit: number }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({ kind: 'latest', topicId, limit })
      },
      { topicId, limit: DISPLAY_LIMIT }
    )
    expect(postLatest.ok).toBe(true)
    expect((postLatest.value as any).window.hasMoreBefore).toBe(true)
    expect((postLatest.value as any).window.hasMoreAfter).toBe(false)

    // Anchor/viewport invariants: pre-load oldest remains present, scroll not reset to newest-bottom, anchor in DOM
    expect(postState.ids, `pre-oldest anchor ${preOldestAnchorId} missing after merge`).toContain(preOldestAnchorId)
    expect(postState.domIds, `pre-oldest anchor not in DOM after merge`).toContain(preOldestAnchorId)
    const anchorStillConnected = await page.evaluate((anchorId: string) => {
      const el = document.getElementById(`message-${anchorId}`)
      return !!el && el.isConnected
    }, preOldestAnchorId)
    expect(anchorStillConnected, `anchor element message-${preOldestAnchorId} should remain connected`).toBe(true)

    expect(postState.geom, 'post geometry missing').toBeTruthy()
    const postGeom = postState.geom!
    // Not reset to newest-bottom (0): scrollTop must remain near the inverse threshold, i.e. negative / far from 0
    expect(
      Math.abs(postGeom.scrollTop) > 20,
      `scrollTop should not be reset to bottom 0, got ${postGeom.scrollTop} targetTop ${scrollInfo.targetTop}`
    ).toBe(true)
    // Remains at/near target (allow anchoring delta up to ~150px, but must not have jumped to 0)
    expect(
      Math.abs(postGeom.scrollTop - scrollInfo.targetTop) < 200,
      `post scrollTop ${postGeom.scrollTop} should stay near targetTop ${scrollInfo.targetTop} (visible anchor ${visibleAnchor!.id} preOffset ${visibleAnchor!.offset})`
    ).toBe(true)

    // Production-aligned viewport stability: container-relative offset of the first visible
    // message must remain stable within a small layout-tolerant bound. Mirrors
    // src/renderer/src/pages/home/Messages/domVisibility.ts findFirstVisibleMessage (display:none / zero-height / intersection filter,
    // closest rect.top to container top) and Messages.tsx:1121-1141 anchoring
    // (delta = newRect.top - oldRect.top compensated via container.scrollTop).
    const postVisible = await page.evaluate((anchorId: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return null
      const containerRect = container.getBoundingClientRect()
      const el =
        (Array.from(container.querySelectorAll('[data-message-id]')).find(
          (element) => element.getAttribute('data-message-id') === anchorId
        ) as HTMLElement | null) ?? (document.getElementById(`message-${anchorId}`) as HTMLElement | null)
      const target = el
      if (!target || !target.isConnected)
        return {
          connected: false,
          offset: null as number | null,
          containerTop: containerRect.top,
          rectTop: null as number | null
        }
      const rect = target.getBoundingClientRect()
      return {
        connected: true,
        offset: rect.top - containerRect.top,
        containerTop: containerRect.top,
        rectTop: rect.top
      }
    }, visibleAnchor!.id)

    expect(postVisible, 'post visible anchor probe missing').toBeTruthy()
    expect(postVisible!.connected, `visible anchor message-${visibleAnchor!.id} should remain connected`).toBe(true)
    // Container rect top must remain stable for offset comparison to be meaningful
    expect(
      Math.abs(postVisible!.containerTop - visibleAnchor!.containerTop) <= 4,
      `container top shifted excessively: pre ${visibleAnchor!.containerTop} post ${postVisible!.containerTop}`
    ).toBe(true)
    expect(postVisible!.offset !== null, `visible anchor offset missing for ${visibleAnchor!.id}`).toBe(true)
    // Layout-tolerant bound 32px (not viewport-sized): allows font/layout jitter but catches full-viewport jump
    expect(
      Math.abs((postVisible!.offset as number) - visibleAnchor!.offset) <= 32,
      `visible anchor container-relative offset moved excessively: pre ${visibleAnchor!.offset} (id ${visibleAnchor!.id} rectTop ${visibleAnchor!.rectTop}) post ${postVisible!.offset} (rectTop ${postVisible!.rectTop}) containerTop pre ${visibleAnchor!.containerTop} post ${postVisible!.containerTop} clientHeight ${postGeom.clientHeight}`
    ).toBe(true)
  })

  test('R-04 whole-topic snapshot via real copy-as-Markdown — bounded window preserved', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'R-04 INTEGRATED: real topic-item context menu → copy-as-Markdown (whole-topic Main snapshot) → clipboard holds head+tail; independent fetchWholeTopicSnapshot IPC oracle; loaded Redux/DOM window unchanged (snapshot never publishes).'
    })

    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `window-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await seedWindowTopic(page, liveAssistantId, topicId)
    await activateTopicAndWaitForBootstrap(page, topicId)

    const topicName = `Window Test ${topicId}`
    const heading = `# ${topicName}`
    const seedContent = `window-test-content-${'x'.repeat(40)}`
    const headContent = `${seedContent}-${pad(0, 5)}`
    const tailContent = `${seedContent}-${pad(SYNTHETIC_TOTAL - 1, 5)}`
    const headId = `${topicId}-msg-${pad(0, 5)}`
    const tailId = `${topicId}-msg-${pad(SYNTHETIC_TOTAL - 1, 5)}`
    const expectedFullIds: string[] = []
    for (let i = 0; i < SYNTHETIC_TOTAL; i++) {
      expectedFullIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }
    const expectedTailIds: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT; i < SYNTHETIC_TOTAL; i++) {
      expectedTailIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }

    // Exact pre-action projection: loaded Redux IDs, topic block membership (IDs, not global count), DOM IDs/count.
    const pre = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = [...(s.messages?.messageIdsByTopic?.[topicId] ?? [])]
      const blockIdsInOrder: string[] = []
      for (const id of ids) {
        const m = s.messages?.entities?.[id]
        if (m && Array.isArray(m.blocks)) blockIdsInOrder.push(...m.blocks)
      }
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      return { ids, blockIdsInOrder, domIds, domCount: domIds.length }
    }, topicId)

    expect(pre.ids).toEqual(expectedTailIds)
    expect(pre.domCount).toBe(DISPLAY_LIMIT)
    expect([...pre.domIds].sort()).toEqual([...expectedTailIds].sort())
    expect(pre.ids).not.toContain(headId)
    expect(pre.ids).toContain(tailId)
    expect(pre.blockIdsInOrder.length).toBe(DISPLAY_LIMIT)
    console.log(`[E2E] R-04 pre window ids=${pre.ids.length} dom=${pre.domCount} blocks=${pre.blockIdsInOrder.length}`)

    // Real user-visible action: topic-item context menu → Copy submenu → Copy as markdown.
    // Locale-robust (app locale zh-CN per trace): parent `chat.topics.copy.title` (复制|Copy),
    // child `chat.topics.copy.md` (复制为 Markdown|Copy as markdown); no direct formatter call.
    const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await topicItem.scrollIntoViewIfNeeded()
    await topicItem.click({ button: 'right' })
    const copyParent = page
      .locator('.ant-dropdown-menu-submenu')
      .filter({ hasText: /^(复制|Copy)$/ })
      .first()
    await copyParent.waitFor({ state: 'visible', timeout: 10000 })
    await copyParent.hover()
    const mdItem = page.getByRole('menuitem', { name: /^(复制为 Markdown|Copy as markdown)$/ }).first()
    await mdItem.waitFor({ state: 'visible', timeout: 10000 })
    await mdItem.click()

    // User-visible copy success toast (antd message from `message.copy.success`: zh-CN 复制成功 / en-US Copied!).
    await expect(page.locator('.ant-message')).toContainText(/(复制成功|Copied!)/, { timeout: 10000 })
    console.log('[E2E] R-04 copy success toast visible')

    // Repository clipboard pattern: window.api.clipboard.readText fallback navigator.clipboard; poll until
    // heading + authority head (outside loaded window) + tail are all present in order (no truncation).
    let clipboard: string | null = null
    const MAX_POLL_ATTEMPTS = 30
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      clipboard = await page.evaluate(async () => {
        try {
          if ((window as any).api?.clipboard?.readText) {
            return await (window as any).api.clipboard.readText()
          }
          return await navigator.clipboard.readText()
        } catch {
          return null
        }
      })
      if (
        clipboard &&
        clipboard.includes(heading) &&
        clipboard.includes(headContent) &&
        clipboard.includes(tailContent)
      ) {
        break
      }
      await page.waitForTimeout(200)
    }
    expect(clipboard, 'clipboard must be readable after real copy action').not.toBeNull()
    const text = clipboard as string
    expect(text.includes(heading), 'clipboard must contain the topic heading').toBe(true)
    expect(text.includes(headContent), 'clipboard must contain authority head content outside the loaded window').toBe(
      true
    )
    expect(text.includes(tailContent), 'clipboard must contain the tail content (no truncation)').toBe(true)
    const headingIdx = text.indexOf(heading)
    const headIdx = text.indexOf(headContent)
    const tailIdx = text.indexOf(tailContent)
    expect(headingIdx).toBeGreaterThanOrEqual(0)
    expect(headIdx).toBeGreaterThan(headingIdx)
    expect(tailIdx).toBeGreaterThan(headIdx)
    console.log(`[E2E] R-04 clipboard len=${text.length} heading@${headingIdx} head@${headIdx} tail@${tailIdx}`)

    // Independent real IPC oracle: whole-topic snapshot straight from Main authority.
    const snap: any = await page.evaluate(
      async (topicId: string) => await (window as any).api.chatDb.fetchWholeTopicSnapshot({ topicId }),
      topicId
    )
    expect(snap.ok).toBe(true)
    const sval: any = snap.value
    expect(sval).toBeTruthy()
    expect(sval.snapshot).toBeTruthy()
    expect(sval.snapshot.completeness).toBe('whole-topic')
    expect(sval.snapshot.topicId).toBe(topicId)
    expect(sval.snapshot.returnedCount).toBe(SYNTHETIC_TOTAL)
    expect(sval.snapshot.firstMessageId).toBe(headId)
    expect(sval.snapshot.lastMessageId).toBe(tailId)
    expect(sval.snapshot.returnedCount).toBe(sval.messages.length)
    expect(sval.messages[0].id).toBe(sval.snapshot.firstMessageId)
    expect(sval.messages[sval.messages.length - 1].id).toBe(sval.snapshot.lastMessageId)
    expect(sval.messages.map((m: any) => m.id)).toEqual(expectedFullIds)
    expect(sval.messages.some((m: any) => m.id === headId)).toBe(true)
    expect(new Set(sval.messages.map((m: any) => m.id)).size).toBe(sval.messages.length)
    const toNum = (id: string) => Number(id.split('-').pop())
    for (let i = 1; i < sval.messages.length; i++) {
      expect(toNum(sval.messages[i].id)).toBeGreaterThan(toNum(sval.messages[i - 1].id))
    }
    console.log(`[E2E] R-04 snapshot ok count=${sval.snapshot.returnedCount} first=${sval.snapshot.firstMessageId}`)

    // Snapshot must not publish: loaded Redux IDs, topic block entities, and DOM IDs/count unchanged exactly.
    const post = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = [...(s.messages?.messageIdsByTopic?.[topicId] ?? [])]
      const blockIdsInOrder: string[] = []
      for (const id of ids) {
        const m = s.messages?.entities?.[id]
        if (m && Array.isArray(m.blocks)) blockIdsInOrder.push(...m.blocks)
      }
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      return { ids, blockIdsInOrder, domIds, domCount: domIds.length }
    }, topicId)
    expect(post.ids).toEqual(pre.ids)
    expect(post.blockIdsInOrder).toEqual(pre.blockIdsInOrder)
    expect(post.domCount).toBe(pre.domCount)
    expect([...post.domIds].sort()).toEqual([...pre.domIds].sort())
    await expect
      .poll(
        async () =>
          await page.evaluate(
            (topicId: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[topicId]?.length ?? 0,
            topicId
          ),
        { timeout: 1500 }
      )
      .toBe(DISPLAY_LIMIT)
    console.log('[E2E] R-04 post window unchanged (Redux blocks/DOM stable, no publish)')
  })

  test('R-05 ChatFlowHistory whole-topic graph — bounded window preserved + live marker refetch', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'R-05 INTEGRATED UI: settings/setMessageNavigation enable → cold activate 50-msg topic (20 loaded) → hover-gated Chat History drawer shows whole-topic ReactFlow graph (head + tail, 50 nodes) against fetchWholeTopicSnapshot oracle with loaded Redux/DOM unchanged → real-send marker with drawer open → coalesced MESSAGE_COMPLETE/updatedAt refetch grows graph to 52 (marker + reply + retained head, no empty state). Deterministic mocked provider; no direct formatter/component calls.'
    })

    const page = mainWindow

    // 1) Enable messageNavigation through the existing Redux settings action/path.
    await page.evaluate(() => {
      ;(window as any).store.dispatch({ type: 'settings/setMessageNavigation', payload: true })
    })
    const navEnabled = await page.evaluate(() => (window as any).store.getState().settings?.messageNavigation)
    expect(navEnabled).toBe(true)
    console.log('[E2E] R-05 messageNavigation enabled via settings/setMessageNavigation')

    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `window-r05-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedWindowTopic(page, liveAssistantId, topicId)

    // 2) Cold activate and capture the loaded tail; head ID/content absent from the loaded projection.
    await activateTopicAndWaitForBootstrap(page, topicId)

    const seedContent = `window-test-content-${'x'.repeat(40)}`
    const headId = `${topicId}-msg-${pad(0, 5)}`
    const tailId = `${topicId}-msg-${pad(SYNTHETIC_TOTAL - 1, 5)}`
    const headContent = `${seedContent}-${pad(0, 5)}`
    const tailContent = `${seedContent}-${pad(SYNTHETIC_TOTAL - 1, 5)}`
    const expectedTailIds: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT; i < SYNTHETIC_TOTAL; i++) {
      expectedTailIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }
    const expectedFullIds: string[] = []
    for (let i = 0; i < SYNTHETIC_TOTAL; i++) {
      expectedFullIds.push(`${topicId}-msg-${pad(i, 5)}`)
    }

    const pre = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = [...(s.messages?.messageIdsByTopic?.[topicId] ?? [])]
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      return { ids, domIds, domCount: domIds.length }
    }, topicId)
    expect(pre.ids).toEqual(expectedTailIds)
    expect(pre.domCount).toBe(DISPLAY_LIMIT)
    expect([...pre.domIds].sort()).toEqual([...expectedTailIds].sort())
    expect(pre.ids).not.toContain(headId)
    expect(pre.ids).toContain(tailId)
    await expect(page.locator('#messages')).not.toContainText(headContent, { timeout: 10000 })
    await expect(page.locator('#messages')).toContainText(tailContent, { timeout: 10000 })
    console.log(`[E2E] R-05 pre window ids=${pre.ids.length} dom=${pre.domCount} head absent`)

    // 3) Open Chat History via the hover-gated navigation button (accessible role/name, locale-robust).
    await openChatHistoryDrawer(page)
    const drawer = page.locator('.ant-drawer.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 15000 })
    await expect(drawer.locator('.ant-drawer-title')).toHaveText(/^(Chat History|聊天历史)$/, { timeout: 10000 })
    await expect(drawer.locator('.react-flow')).toBeVisible({ timeout: 20000 })
    console.log('[E2E] R-05 drawer + ReactFlow visible')

    // 4) Graph holds deterministic head/window-outside + tail content; node
    // count exact 50 (25 user + 25 assistant incl. equal-stamp orphans) > 20;
    // independent whole-topic snapshot oracle for count/order.
    await expect(drawer).toContainText(headContent, { timeout: 20000 })
    await expect(drawer).toContainText(tailContent, { timeout: 10000 })
    await expect
      .poll(async () => await drawer.locator('.react-flow__node').count(), { timeout: 20000 })
      .toBe(SYNTHETIC_TOTAL)
    const nodeCount = await drawer.locator('.react-flow__node').count()
    expect(nodeCount).toBeGreaterThan(pre.ids.length)
    console.log(`[E2E] R-05 graph nodes=${nodeCount} loaded=${pre.ids.length}`)

    const snap: any = await page.evaluate(
      async (topicId: string) => await (window as any).api.chatDb.fetchWholeTopicSnapshot({ topicId }),
      topicId
    )
    expect(snap.ok).toBe(true)
    const sval: any = snap.value
    expect(sval.snapshot.completeness).toBe('whole-topic')
    expect(sval.snapshot.topicId).toBe(topicId)
    expect(sval.snapshot.returnedCount).toBe(SYNTHETIC_TOTAL)
    expect(sval.snapshot.firstMessageId).toBe(headId)
    expect(sval.snapshot.lastMessageId).toBe(tailId)
    expect(sval.messages.map((m: any) => m.id)).toEqual(expectedFullIds)
    expect(new Set(sval.messages.map((m: any) => m.id)).size).toBe(sval.messages.length)
    console.log(`[E2E] R-05 snapshot oracle count=${sval.snapshot.returnedCount}`)

    // 5) Loaded Redux IDs and normal message DOM remain unchanged/bounded after opening the drawer.
    const post = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = [...(s.messages?.messageIdsByTopic?.[topicId] ?? [])]
      const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
        (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
      )
      return { ids, domIds, domCount: domIds.length }
    }, topicId)
    expect(post.ids).toEqual(pre.ids)
    expect(post.domCount).toBe(DISPLAY_LIMIT)
    expect([...post.domIds].sort()).toEqual([...pre.domIds].sort())
    await expect
      .poll(
        async () =>
          await page.evaluate(
            (topicId: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[topicId]?.length ?? 0,
            topicId
          ),
        { timeout: 1500 }
      )
      .toBe(DISPLAY_LIMIT)
    console.log('[E2E] R-05 post-drawer window unchanged (Redux/DOM stable, no publish)')

    // 6) While the drawer remains open, real-send a marker through the input
    // UI and wait for assistant completion (terminal Redux state).
    const prevAssistantCount = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      let n = 0
      for (const id of ids) {
        if (s.messages?.entities?.[id]?.role === 'assistant') n++
      }
      return n
    }, topicId)
    const marker = `R05 history marker ${Date.now()}`
    const seq = getRequestSequence()
    await uiSendMessageWithDrawerOpen(page, marker)
    await waitForAssistantResponseComplete(page, topicId, prevAssistantCount)
    const productReq = findProductRequestAfter(seq)
    expect(productReq).not.toBeNull()
    expect(JSON.stringify((productReq as any).parsed?.messages ?? '')).toContain(marker)
    const expectedReply = `[Mock mock-model] You said: "${marker.slice(0, 100)}"`
    console.log(`[E2E] R-05 marker sent+completed seq=${(productReq as any)?.sequence}`)

    // After terminal MESSAGE_COMPLETE/coalesced refetch: drawer contains the
    // new user marker (and deterministic assistant reply) while the old head
    // remains; graph is fresh (52 nodes), never stale/empty.
    await expect(drawer).toContainText(marker, { timeout: 20000 })
    await expect(drawer).toContainText(expectedReply, { timeout: 20000 })
    await expect(drawer).toContainText(headContent, { timeout: 10000 })
    await expect(drawer.locator('.react-flow')).toBeVisible({ timeout: 10000 })
    await expect(drawer.getByText(/^(No Messages Found|没有找到消息)$/)).toHaveCount(0)
    await expect
      .poll(async () => await drawer.locator('.react-flow__node').count(), { timeout: 20000 })
      .toBe(SYNTHETIC_TOTAL + 2)
    console.log('[E2E] R-05 drawer refetched: marker + reply + head present, nodes=52')

    const snap2: any = await page.evaluate(
      async (topicId: string) => await (window as any).api.chatDb.fetchWholeTopicSnapshot({ topicId }),
      topicId
    )
    expect(snap2.ok).toBe(true)
    const sval2: any = snap2.value
    expect(sval2.snapshot.completeness).toBe('whole-topic')
    expect(sval2.snapshot.returnedCount).toBe(SYNTHETIC_TOTAL + 2)
    expect(sval2.snapshot.firstMessageId).toBe(headId)
    expect(sval2.snapshot.lastMessageId).not.toBe(tailId)
    expect(new Set(sval2.messages.map((m: any) => m.id)).size).toBe(sval2.messages.length)
    const toNum = (id: string) => Number(id.split('-').pop())
    const seededNums = sval2.messages
      .map((m: any) => m.id)
      .filter((id: string) => id.startsWith(`${topicId}-msg-`))
      .map(toNum)
    for (let i = 1; i < seededNums.length; i++) {
      expect(seededNums[i]).toBeGreaterThan(seededNums[i - 1])
    }
    console.log(`[E2E] R-05 post-send snapshot oracle count=${sval2.snapshot.returnedCount}`)

    // 7) Close via visible drawer's own close button; drawer hidden, no global cleanup.
    const drawerCloseButton = drawer.locator('.ant-drawer-close')
    await expect(drawerCloseButton).toBeVisible({ timeout: 10000 })
    await drawerCloseButton.click()
    await expect(page.locator('.ant-drawer.ant-drawer-open')).toHaveCount(0, { timeout: 10000 })
    console.log('[E2E] R-05 drawer closed via close button')
  })
})
