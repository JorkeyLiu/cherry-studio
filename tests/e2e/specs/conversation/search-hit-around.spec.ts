/**
 * Unified stable-ID navigation — search hit outside latest window (INTEGRATED E2E)
 *
 * Verifies that a hit outside the latest bounded projection reaches the real
 * Messages viewport through the unified direct navigation path: the search hit
 * calls the stable-ID entry (SearchResults → locateToMessageTarget, no pseudo
 * Message, no preview, no private window fetch/merge/publish), which drives
 * the Messages unified navigate path — ensure via existing
 * fetchMessagesWindow around (10/19), atomic message+blocks merge, then the
 * existing runMessageNavigationTransaction (viewport/DOM/reveal/scroll).
 * No whole-topic fetch in this path.
 *
 * Evidence tier: INTEGRATED — drives actual History/SearchResults UI controls
 * directly through to the real #messages DOM (no preview-locate two-step).
 * Deterministic setup uses direct Redux dispatch only for seeding
 * (assistants/addTopic, newMessages/setDisplayCount) plus ensured chatDb
 * persistence (ensureTopic/pasteMessagesToTopic); the complement publication
 * itself does not directly dispatch — it exercises the production Messages
 * ensure + transaction path.
 *
 * - Uses standard fixture (fresh build, disposable profile, mock provider)
 * - Seeds via approved ensureTopic + pasteMessagesToTopic
 * - Activates via real topic-item click → loadTopicMessagesThunk latest 20
 * - Opens History via real Navbar search button (data-testid=navbar-search-button)
 * - Enters query into real history-search-input, presses Enter, waits for real
 *   SearchResults to fetch via window.api.chatDb.searchMessages
 * - Clicks real search-result-hit (data-testid=search-result-hit) — production
 *   SearchResults.handleMessageClick → locateToMessageTarget → pendingNavigate +
 *   navigate('/') + NAVIGATE_TO_MESSAGE → Messages unified ensure (around
 *   10/19 → validate → union → upsertManyBlocks + messagesReceived) →
 *   runMessageNavigationTransaction
 * - Primary assertions are DOM + viewport reachability inside #messages
 *   (Redux presence is supporting only, never the sole proof)
 * - Supplemental direct fetchMessagesWindow around probe only (not a substitute)
 */

import { expect, test } from '../../fixtures/electron.fixture'

const DISPLAY_LIMIT = 20
const SYNTHETIC_TOTAL = 50

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

async function seedWindowTopic(page: any, liveAssistantId: string, topicId: string): Promise<void> {
  const name = `SearchHit Test ${topicId}`
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
          content: `search-hit-content-${pad(i, 5)}`,
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
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function')
          return { ok: false, err: 'chatDb missing' }
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
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
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

test.describe('search-hit around window (R-04) — integrated UI', () => {
  test.setTimeout(180000)

  test('hit outside latest 20 via real History/SearchResults UI click becomes available (resident tail retained, no whole-topic)', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'R-04 INTEGRATED UI: deterministic setup via direct Redux dispatch (addTopic/displayCount) + ensured chatDb persistence; real Navbar search button → history-search-input Enter → real SearchResults hit outside tail → real search-result-hit click → locateToMessageTarget → Messages unified ensure fetchMessagesWindow(around 10/19) → isValidWindowResponse → canonical unionWindowMessages → atomic Redux staging (real UI publication path, not direct Redux dispatch). Supplemental direct fetch probe only.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `searchhit-r04-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await seedWindowTopic(page, liveAssistantId, topicId)
    await activateTopicAndWaitForBootstrap(page, topicId)

    const pre = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      return { ids, domCount }
    }, topicId)
    expect(pre.ids.length).toBe(DISPLAY_LIMIT)
    expect(pre.domCount).toBe(DISPLAY_LIMIT)
    const expectedTail: string[] = []
    for (let i = SYNTHETIC_TOTAL - DISPLAY_LIMIT; i < SYNTHETIC_TOTAL; i++)
      expectedTail.push(`${topicId}-msg-${pad(i, 5)}`)
    expect(pre.ids).toEqual(expectedTail)
    const hitId = `${topicId}-msg-${pad(5, 5)}`
    // Use a simple numeric token that is FTS-safe and uniquely identifies the hit in substring mode; full hyphenated phrase can hit FTS syntax edge cases in whole-word mode.
    const hitQuery = pad(5, 5)
    expect(pre.ids).not.toContain(hitId)

    // Navigate to History/Search surface via real UI control (not page.evaluate SearchPopup.show harness)
    // Navbar search button is hidden via CSS on narrow viewports (NarrowIcon @media max-width:1000px). Prefer the existing keyboard shortcut route (CommandOrControl+Shift+F) which is the canonical alternate path — no synthetic harness.
    const navbarSearch = page.getByTestId('navbar-search-button')
    const isNavbarVisible = await navbarSearch.isVisible().catch(() => false)
    if (isNavbarVisible) {
      await navbarSearch.click()
    } else {
      // Use the real shortcut binding (search_message = CommandOrControl+Shift+F) to open SearchPopup
      const isMac = process.platform === 'darwin'
      if (isMac) {
        await page.keyboard.press('Meta+Shift+F')
      } else {
        await page.keyboard.press('Control+Shift+F')
      }
    }

    const historyInput = page.getByTestId('history-search-input')
    await expect(historyInput, 'history search input must be visible after opening SearchPopup').toBeVisible({
      timeout: 15000
    })
    await historyInput.fill(hitQuery)
    await historyInput.press('Enter')

    // After entering the query, SearchResults is shown with default whole-word mode. Switch to substring to ensure the numeric token matches the hyphenated block content via LIKE/trigram path and avoids whole-word FTS phrase edge cases.
    // Locale-independent semantic testid on the match-mode Segmented option label (see SearchResults.tsx).
    const containsOption = page.getByTestId('history-search-match-substring')
    await expect(containsOption, 'substring match option must be visible in search toolbar').toBeVisible({
      timeout: 10000
    })
    await containsOption.click()

    // Wait for real SearchResults to produce the hit via SQLite searchMessages (substring mode)
    const hitLocator = page.locator(`[data-testid="search-result-hit"][data-message-id="${hitId}"]`)
    await expect(hitLocator, `search result hit ${hitId} must appear after real history search`).toBeVisible({
      timeout: 30000
    })

    // Click real result — production SearchResults.handleMessageClick navigates
    // directly to Chat via locateToMessageTarget (no pseudo-Message, no preview,
    // no private window fetch/merge/publish; complement happens in Messages).
    await hitLocator.click()

    // Supporting Redux observation: hit + resident tail present, no duplicates, ordered.
    // (Supporting only — DOM + viewport below are the primary proof.)
    await page.waitForFunction(
      ({ topicId, hitId, expectedTail }: { topicId: string; hitId: string; expectedTail: string[] }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        if (!ids.includes(hitId)) return false
        for (const tid of expectedTail) if (!ids.includes(tid)) return false
        return ids.length > expectedTail.length
      },
      { topicId, hitId, expectedTail },
      { timeout: 30000 }
    )

    const post = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      const entities: Record<string, any> = s.messages?.entities ?? {}
      const msgs: any[] = ids.map((id) => entities[id]).filter(Boolean)
      return { ids, msgs }
    }, topicId)

    expect(post.ids).toContain(hitId)
    for (const tailId of expectedTail) expect(post.ids).toContain(tailId)
    expect(post.ids.length).toBeGreaterThan(DISPLAY_LIMIT)
    expect(new Set(post.ids).size).toBe(post.ids.length)
    // Deterministic order: ascending numeric suffix (derived from sortOrder)
    const toNum = (id: string) => Number(id.split('-').pop())
    for (let i = 1; i < post.ids.length; i++) {
      expect(toNum(post.ids[i])).toBeGreaterThan(toNum(post.ids[i - 1]))
    }

    // Primary proof: the target truly entered the #messages DOM via the direct path.
    const targetInMessages = page.locator(`#messages [data-message-id="${hitId}"]`)
    await expect(targetInMessages, `hit ${hitId} must render inside #messages after direct hit click`).toBeAttached({
      timeout: 30000
    })
    await expect(targetInMessages, `hit ${hitId} must be visible inside #messages after direct hit click`).toBeVisible({
      timeout: 15000
    })

    // Primary proof: the target is viewport-reachable (scrolled into view by the transaction).
    await expect(targetInMessages, `hit ${hitId} must be viewport-reachable after direct hit click`).toBeInViewport({
      timeout: 15000
    })
    const rect = await targetInMessages.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height, innerHeight: window.innerHeight }
    })
    expect(rect.height).toBeGreaterThan(0)
    expect(rect.bottom).toBeGreaterThan(0)
    expect(rect.top).toBeLessThan(rect.innerHeight)

    // Supplemental direct contract probe only (not a substitute for UI path) — verifies around window contract still valid
    const probe: any = await page.evaluate(
      async ({ topicId, hitId }: { topicId: string; hitId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchMessagesWindow({
          kind: 'around',
          topicId,
          anchorMessageId: hitId,
          before: 10,
          after: 19
        })
      },
      { topicId, hitId }
    )
    expect(probe.ok).toBe(true)
    expect(probe.value.window.kind).toBe('around')
    expect(probe.value.window.completeness).toBe('window')
    expect(probe.value.window.completeness).not.toBe('whole-topic')
    expect(probe.value.window.topicId).toBe(topicId)
    expect(probe.value.window.anchorMessageId).toBe(hitId)
    expect(probe.value.window.requested.before).toBe(10)
    expect(probe.value.window.requested.after).toBe(19)
    expect(probe.value.messages.some((m: any) => m.id === hitId)).toBe(true)
  })
})
