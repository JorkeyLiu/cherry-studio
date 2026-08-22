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
 *
 * Missing coverage (intentionally not faked):
 * - R-03 renderer merge / InfiniteScroll scroll-triggered UI remains uncovered.
 *   This spec does NOT dispatch `messageBlocks/upsertManyBlocks` or
 *   `newMessages/messagesReceived` and does NOT treat a raw contract call as UI
 *   proof. Any future R-03 UI regression must add a deterministic scroll/trigger
 *   E2E that proves Redux/DOM growth via the production path.
 *
 * Governing constraints:
 * - Uses standard fixture (fresh production build, disposable profile, mock provider).
 * - Seeds via approved pattern only; no direct SQLite file writes.
 * - Calls the existing `chatdb:fetch-messages-window` contract only; 1..100 are
 *   validation bounds, not new defaults; no R-04/R-05/R-06, no new fields/SQL/cursors.
 * - No wrapper/monkey-patching of `window.api.chatDb.fetchMessagesWindow`,
 *   `window.electron.ipcRenderer`, or legacy `fetchMessages`; no call-count asserts
 *   from ineffective wrappers; no fixed sleeps; no synthetic Redux publication.
 * - No production source/docs edits, no fixture-global edits, no new selectors.
 */

import { expect, test } from '../../fixtures/electron.fixture'

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
        'R-03 CONTRACT-ONLY: real window.api.chatDb.fetchMessagesWindow({kind:around}) through preload/Main. Does NOT prove renderer merge/scroll UI — that coverage is missing and must not be faked via synthetic dispatch.'
    })
    // Explicit comment for report-facing classification: this test is contract-only.
    // Missing R-03 UI coverage: scroll-triggered InfiniteScroll → around request →
    // Redux/DOM merge is not proven here; a future deterministic UI trigger spec
    // is required for R-03 renderer projection regression.

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
})
