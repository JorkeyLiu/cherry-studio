/**
 * S6.2 R-05 / S6.2c-1 / S6.2c-2 — INTEGRATED E2E (real UI)
 *
 * Covers:
 * - R-05 answer-group: real MessageGroup model selector click → fetchAnswerGroup (complete) → selectAnswerMessage
 *   with partial projection (exactly one member missing before click).
 * - Branch by anchor: real MessageMenubar NEW_BRANCH click → branchMessagesToTopic (Main prefix)
 * - Insert after anchor: real MessageMenubar insert click → insertMessagesAfterAnchor (group-tail)
 *
 * Deterministic seed via ensureTopic + pasteMessagesToTopic; displayCount=20 groups (R-02: counts complete viewport groups, not raw messages), synthetic total=50.
 * When the oldest visible group straddles the boundary, messageIds length may exceed DISPLAY_LIMIT (e.g. 21-22); bootstrap invariant is >= DISPLAY_LIMIT.
 * Standard fixture, fresh build, disposable profile, mock provider.
 * No direct Redux publication for action path; direct fetch/branch/insert IPC used only as supplemental authority probe.
 */
import * as fs from 'fs'
import { expect, test } from '../../fixtures/electron.fixture'
import { getChatDbPath, queryChatDbViaElectron } from '../../fixtures/electron.fixture'

const DISPLAY_LIMIT = 20
const TOTAL = 50

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
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
  // R-02: latest window limit counts complete viewport groups (MessageGroup), not raw message rows.
  // A boundary group straddling the 20-group limit may make messageIds length exceed DISPLAY_LIMIT (e.g. 21-22).
  // Bootstrap readiness is therefore group-compatible: loading complete and message count >= DISPLAY_LIMIT.
  await page.waitForFunction(
    ({ topicId, atLeast }: { topicId: string; atLeast: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= atLeast && loading !== true
    },
    { topicId, atLeast: DISPLAY_LIMIT },
    { timeout: 30000 }
  )
  // Viewport displayMessages may lag behind Redux ids briefly; wait for at least DISPLAY_LIMIT DOM elements.
  // Folded members are hidden via CSS but still in DOM under [data-message-id]; >= is the stable group-compatible invariant.
  await page.waitForFunction(
    (atLeast: number) => document.querySelectorAll('#messages [data-message-id]').length >= atLeast,
    DISPLAY_LIMIT,
    { timeout: 30000 }
  )
}

function buildEntries(
  topicId: string,
  assistantId: string,
  opts: { groupStart: number; groupAskUserId: string }
): Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const groupIds = new Set(
    [opts.groupStart, opts.groupStart + 1, opts.groupStart + 2].map((idx) => `${topicId}-msg-${pad(idx, 5)}`)
  )
  // For deterministic sort_order, we rely on paste order (insert order). All entries appended in array order.
  for (let i = 0; i < TOTAL; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    let role: string
    let askId: string | undefined
    let foldSelected: boolean | undefined
    if (i === opts.groupStart - 1) {
      role = 'user'
      // this user is the askId source for group
      // ensure its id equals groupAskUserId for later verification
    } else if (groupIds.has(msgId)) {
      role = 'assistant'
      askId = opts.groupAskUserId
      // initial foldSelected: true for first group member (missing), false for others
      if (i === opts.groupStart) foldSelected = true
      else foldSelected = false
    } else {
      // alternating baseline: even user, odd assistant (except overwritten)
      if (i % 2 === 0) role = 'user'
      else {
        role = 'assistant'
        // give preceding user as askId if preceding is user
        const prevUserIdx = i - 1
        const prevIsUser = prevUserIdx % 2 === 0 || prevUserIdx === opts.groupStart - 1
        if (prevIsUser) askId = `${topicId}-msg-${pad(prevUserIdx, 5)}`
      }
    }
    const message: Record<string, unknown> = {
      id: msgId,
      topicId,
      role,
      assistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      sortOrder: i
    }
    if (askId) (message as any).askId = askId
    if (foldSelected !== undefined) (message as any).foldSelected = foldSelected
    // ensure model field for assistant to render avatar
    if (role === 'assistant') {
      ;(message as any).model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      ;(message as any).modelId = 'mock-model'
    }
    const block = {
      id: blockId,
      messageId: msgId,
      type: 'main_text',
      content: `s62-content-${pad(i, 5)}`,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    entries.push({ message, blocks: [block] })
  }
  return entries
}

async function seedTopicWithStraddleGroup(
  page: any,
  liveAssistantId: string,
  topicId: string,
  groupStart: number
): Promise<{ groupAskUserId: string; missingId: string; visibleIds: string[]; anchorId: string; tailId: string }> {
  const name = `S62 Test ${topicId}`
  const groupAskUserId = `${topicId}-msg-${pad(groupStart - 1, 5)}`
  const missingId = `${topicId}-msg-${pad(groupStart, 5)}`
  const visibleIds = [`${topicId}-msg-${pad(groupStart + 1, 5)}`, `${topicId}-msg-${pad(groupStart + 2, 5)}`]
  const anchorId = visibleIds[0]
  const tailId = visibleIds[1]

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

  const entries = buildEntries(topicId, liveAssistantId, { groupStart, groupAskUserId })

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
      entries: any
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
  return { groupAskUserId, missingId, visibleIds, anchorId, tailId }
}

async function hoverMessageAndOpenMore(page: any, messageId: string) {
  // Strict exact-target resolution: only the exact wrapper and its exact more-menu button.
  // No global fallback; if absent, fail with useful assertion.
  const escAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const e = escAttr(messageId)
  const sel = `[id="message-${e}"][data-message-id="${e}"]`
  let container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 15000 })
  // Ensure element is in viewport center to handle column-reverse InfiniteScroll viewport
  await page.evaluate((id: string) => {
    const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${esc}"][data-message-id="${esc}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
  }, messageId)
  // Scroll may trigger React virtualized re-render/detach; re-resolve stable wrapper
  container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible after scroll`).toBeVisible({
    timeout: 15000
  })
  // Hover may be flaky for grouped fold members near viewport edge; attempt hover but fall back to direct more-button click.
  let hovered = false
  try {
    await container.hover({ timeout: 8000 })
    hovered = true
  } catch {
    try {
      await container.hover({ force: true, timeout: 5000 } as any)
      hovered = true
    } catch {
      hovered = false
    }
  }
  const moreBtn = container.locator('[data-testid="message-more-menu-btn"]')
  await expect(moreBtn, `more-menu button for ${messageId} must be attached`).toBeAttached({ timeout: 10000 })
  if (hovered) {
    try {
      await expect(moreBtn, `more-menu button for ${messageId} must be visible`).toBeVisible({ timeout: 3000 })
    } catch {
      // opacity transition may still be pending
    }
  }
  // Primary: Playwright locator click with exact scoping; fallback to narrowly scoped evaluate that validates exact wrapper + exact button
  try {
    await moreBtn.click({ timeout: 5000 } as any)
  } catch {
    try {
      await moreBtn.evaluate((el: HTMLElement) => el.click())
    } catch {
      await page.evaluate((id: string) => {
        const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const sel = `[id="message-${esc}"][data-message-id="${esc}"] [data-testid="message-more-menu-btn"]`
        const btn = document.querySelector(sel) as HTMLElement | null
        if (btn) btn.click()
      }, messageId)
    }
  }
  // Dropdown portal appears after click — wait for portal to ensure menu is open (meaningful condition, not arbitrary sleep)
  await expect(
    page.locator('.ant-dropdown').first(),
    'dropdown portal must be visible after more-menu click'
  ).toBeVisible({
    timeout: 10000
  })
}

// LOCK-E2E-CLEAN-005: portal-scoped branch/insert action — no document-global querySelector fallback.
// Scoped to currently visible opened dropdown portal (.ant-dropdown visible), assert exact data-testid
// and exact menuitem target, Playwright locator click as primary. Evaluate fallback operates only on
// that exact visible portal locator and fails if none/multiple.
async function clickPortalScopedMenuAction(page: any, dataTestId: string): Promise<void> {
  const dropdownLocator = page.locator('.ant-dropdown')
  await expect
    .poll(
      async () => {
        const count = await dropdownLocator.count()
        let matches = 0
        for (let i = 0; i < count; i++) {
          const p = dropdownLocator.nth(i)
          if (!(await p.isVisible())) continue
          const has = await p.locator(`[data-testid="${dataTestId}"]`).count()
          if (has === 1) matches++
        }
        return matches
      },
      { timeout: 10000, intervals: [100, 250] }
    )
    .toBe(1)
  let portal: any = null
  const total = await dropdownLocator.count()
  for (let i = 0; i < total; i++) {
    const p = dropdownLocator.nth(i)
    if (!(await p.isVisible())) continue
    if ((await p.locator(`[data-testid="${dataTestId}"]`).count()) === 1) {
      portal = p
      break
    }
  }
  if (!portal) throw new Error(`portal-scoped action failed: no visible portal with [data-testid="${dataTestId}"]`)
  await expect(portal.locator(`[data-testid="${dataTestId}"]`)).toHaveCount(1)
  const actionBtn = portal.locator(`[data-testid="${dataTestId}"]`)
  await expect(actionBtn, `${dataTestId} inside visible portal must be visible`).toBeVisible({ timeout: 10000 })
  const menuItem = actionBtn.locator('xpath=ancestor::*[@role="menuitem"]').first()
  const hasMenuItem = (await menuItem.count()) > 0
  const clickTarget = hasMenuItem ? menuItem : actionBtn
  await expect(clickTarget).toBeVisible({ timeout: 5000 })
  try {
    await clickTarget.click({ timeout: 5000 })
    return
  } catch {}
  try {
    await clickTarget.evaluate((el: HTMLElement) => el.click())
    return
  } catch {}
  await portal.evaluate((portalEl: HTMLElement, testId: string) => {
    const candidates = portalEl.querySelectorAll(`[data-testid="${testId}"]`)
    if (candidates.length !== 1)
      throw new Error(`expected exactly one [data-testid="${testId}"] in visible portal, got ${candidates.length}`)
    const el = candidates[0] as HTMLElement
    const mi = el.closest('[role="menuitem"]') as HTMLElement | null
    ;(mi ?? el).click()
  }, dataTestId)
}

// LOCK-E2E-CLEAN-006: meaningful DB readiness polling — no fixed post-close sleeps.
// Uses existing ownership-scoped queryChatDbViaElectron helper with bounded expect.poll retry
// that proves disposable DB is open/readable and contains expected state.
async function pollDbUntil(
  dbPath: string,
  sql: string,
  validate: (rows: any[]) => boolean,
  timeoutMs = 30000
): Promise<any[]> {
  let captured: any[] | null = null
  await expect
    .poll(
      () => {
        const res = queryChatDbViaElectron(dbPath, sql)
        if (!res.ok) return null
        const rows = (res as any).rows as any[]
        if (!Array.isArray(rows)) return null
        if (!validate(rows)) return null
        captured = rows
        return rows
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] }
    )
    .not.toBeNull()
  return captured!
}

test.describe('S6.2 R-05 / branch / insert — integrated UI', () => {
  test.setTimeout(180000)

  test('R-05 answer-group: real selector click mutates complete Main group despite missing projection member', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'R-05 INTEGRATED UI: deterministic seed via addTopic/displayCount/pasteMessagesToTopic with straddle group (29,30,31, missing 29 before click); real MessageGroup avatar selector click (data-testid=answer-group-selector) → fetchAnswerGroup + selectAnswerMessage; Redux + post-exit SQLite authority probe for complete group mutation.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `s62-r05-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const groupStart = 29 // straddle: 29 missing, 30/31 visible in latest 20
    const { missingId, visibleIds, anchorId, tailId } = await seedTopicWithStraddleGroup(
      page,
      liveAssistantId,
      topicId,
      groupStart
    )
    await activateTopicAndWaitForBootstrap(page, topicId)

    const pre = await page.evaluate(
      ({ topicId, missingId }: { topicId: string; missingId: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        const hasMissing = ids.includes(missingId)
        const entities: Record<string, any> = s.messages?.entities ?? {}
        const askIds = ids.map((id) => entities[id]?.askId).filter(Boolean)
        return {
          ids,
          hasMissing,
          count: ids.length,
          domCount: document.querySelectorAll('#messages [data-message-id]').length
        }
      },
      { topicId, missingId }
    )
    // R-02 group-compatible readiness: latest 20 complete groups may yield >20 messages when a boundary group straddles.
    // Stale exact-20 oracle expected missing outside window (30..49); group-compatible window is 28..49 (22 msgs) with full group 29-31 included.
    // Update incidental count + membership oracle to group-compatible while preserving visible checks and complete-group authority probe.
    expect(pre.count).toBeGreaterThanOrEqual(DISPLAY_LIMIT)
    expect(pre.hasMissing).toBe(true)
    expect(pre.ids).toContain(missingId)
    // visible ids must be present (contract-essential: group members visible)
    expect(pre.ids).toContain(visibleIds[0])
    expect(pre.ids).toContain(visibleIds[1])

    // Authority probe before action: complete group is 3 via fetchAnswerGroup
    const preGroup: any = await page.evaluate(
      async ({ topicId, anchorId }: { topicId: string; anchorId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchAnswerGroup({ topicId, anchorMessageId: anchorId })
      },
      { topicId, anchorId }
    )
    expect(preGroup.ok).toBe(true)
    expect(preGroup.value.completeness).toBe('answer-group')
    expect(preGroup.value.messageIds).toHaveLength(3)
    expect(preGroup.value.messageIds).toContain(missingId)
    expect(preGroup.value.messageIds).toContain(visibleIds[0])
    expect(preGroup.value.messageIds).toContain(visibleIds[1])

    // DELIBERATE TEST-ONLY DISPOSABLE PROJECTION SETUP — not product behavior.
    // Remove exactly one renderer member and its companion block via existing window.store.dispatch
    // to create a partial projection (exactly one member missing before click) while Main/SQLite
    // remain authoritative with all 3 members. Must not mutate resident registry, topic segments,
    // generation, or SQLite — only newMessages/messageBlocks slices.
    // Derive companion block id from the entity's blocks array to guarantee deterministic removal
    // matches the actual stored block, falling back to the deterministic pad id.
    const missingBlockId: string = await page.evaluate(
      ({ topicId, missingId, fallback }: { topicId: string; missingId: string; fallback: string }) => {
        const s = (window as any).store.getState()
        const msg = s.messages?.entities?.[missingId] as any
        const bid = Array.isArray(msg?.blocks) && msg.blocks.length > 0 ? (msg.blocks[0] as string) : fallback
        return bid as string
      },
      { topicId, missingId, fallback: `${topicId}-block-${pad(groupStart, 5)}` }
    )
    // DELIBERATE TEST-ONLY DISPOSABLE PROJECTION: same-tick dispatch proves local removal
    const dispatchDebug = await page.evaluate(
      ({ topicId, missingId, missingBlockId }: { topicId: string; missingId: string; missingBlockId: string }) => {
        const store = (window as any).store
        const beforeMsg = (store.getState() as any).messages?.entities?.[missingId]
        const beforeBlock = (store.getState() as any).messageBlocks?.entities?.[missingBlockId]
        store.dispatch({ type: 'newMessages/removeMessages', payload: { topicId, messageIds: [missingId] } })
        const midState = store.getState() as any
        const afterMsgIds = midState.messages?.messageIdsByTopic?.[topicId] ?? []
        const afterMsgEntity = midState.messages?.entities?.[missingId]
        store.dispatch({ type: 'messageBlocks/removeManyBlocks', payload: [missingBlockId] })
        const afterBlock = (store.getState() as any).messageBlocks?.entities?.[missingBlockId]
        return {
          beforeMsgExists: !!beforeMsg,
          beforeBlockExists: !!beforeBlock,
          afterMsgIdsIncludes: afterMsgIds.includes(missingId),
          afterMsgEntityExists: !!afterMsgEntity,
          afterBlockExists: !!afterBlock,
          missingBlockId
        }
      },
      { topicId, missingId, missingBlockId }
    )
    expect(dispatchDebug.beforeMsgExists, `beforeMsg must exist ${JSON.stringify(dispatchDebug)}`).toBe(true)
    expect(dispatchDebug.beforeBlockExists, `beforeBlock must exist ${JSON.stringify(dispatchDebug)}`).toBe(true)
    expect(dispatchDebug.afterMsgIdsIncludes, `after dispatch msg absent ${JSON.stringify(dispatchDebug)}`).toBe(false)
    expect(
      dispatchDebug.afterMsgEntityExists,
      `after dispatch msg entity absent ${JSON.stringify(dispatchDebug)}`
    ).toBe(false)
    expect(
      dispatchDebug.afterBlockExists,
      `afterBlock must be removed immediately ${JSON.stringify(dispatchDebug)}`
    ).toBe(false)

    // Redux proof already captured in dispatchDebug immediate tick (before inter-evaluate gap where closure may re-upsert)
    // dispatchDebug.afterBlockExists false proves companion block absent locally at dispatch time;
    // a subsequent poll would race the closure's ~1.5s re-upsert and fail, so we rely on immediate proof

    // Poll/assert DOM until missing container absent and tail selector remains visible/selectable
    await page.waitForFunction(
      ({ missingId, tailId }: { missingId: string; tailId: string }) => {
        const esc = (v: string) => (typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(v) : v)
        const miss = esc(missingId)
        const tail = esc(tailId)
        const missingEl = document.querySelector(`[id="message-${miss}"][data-message-id="${miss}"]`)
        const tailSelector = document.querySelector(`[data-testid="answer-group-selector"][data-message-id="${tail}"]`)
        return missingEl === null && tailSelector !== null
      },
      { missingId, tailId },
      { timeout: 15000 }
    )
    const stillVisibleSelector = page.locator(`[data-testid="answer-group-selector"][data-message-id="${tailId}"]`)
    await expect(
      stillVisibleSelector,
      `tail selector for ${tailId} must remain visible after disposable projection removal`
    ).toBeVisible({
      timeout: 15000
    })

    // Prove Main still owns all 3 group members despite local partial projection (no SQLite/segment mutation)
    const mainStillComplete: any = await page.evaluate(
      async ({ topicId, anchorId }: { topicId: string; anchorId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.fetchAnswerGroup({ topicId, anchorMessageId: anchorId })
      },
      { topicId, anchorId }
    )
    expect(mainStillComplete.ok).toBe(true)
    expect(mainStillComplete.value.messageIds).toHaveLength(3)
    expect(mainStillComplete.value.messageIds).toContain(missingId)
    expect(mainStillComplete.value.messageIds).toContain(visibleIds[0])
    expect(mainStillComplete.value.messageIds).toContain(visibleIds[1])

    // Find the group container and click the selector for tailId (second visible) to switch selection
    // MessageGroupModelList renders avatars for the grouped messages; locate by data-message-id
    // The group containing our visibleIds is the one near the top of column-reverse? Search globally.
    const selector = page.locator(`[data-testid="answer-group-selector"][data-message-id="${tailId}"]`)
    await expect(
      selector,
      `answer-group selector for ${tailId} must be visible (partial projection ready)`
    ).toBeVisible({
      timeout: 15000
    })
    await selector.click()

    // Wait for Redux mutation: tail should become selected, missing should become not selected (all false except tail)
    await page.waitForFunction(
      ({ topicId, selectedId, groupIds }: { topicId: string; selectedId: string; groupIds: string[] }) => {
        const s = (window as any).store.getState()
        // After selection, the complete group should have been fetched via Main; local Redux for visible members should reflect,
        // but missing member not in Redux window won't appear. We check visible members and that no intermediate Redux publication
        // for missing is required — authority will be proven post-exit. At minimum visible selected should be true.
        const entities: Record<string, any> = s.messages?.entities ?? {}
        const tail = entities[selectedId]
        const otherVisible = entities[groupIds[0]]
        if (!tail || !otherVisible) return false
        // foldSelected is persisted via overflow; check entities foldSelected
        return tail.foldSelected === true && otherVisible.foldSelected === false
      },
      { topicId, selectedId: tailId, groupIds: visibleIds },
      { timeout: 30000 }
    )

    // Supplemental authority check: missing member's foldSelected should have been persisted false via selectAnswerMessage (complete group)
    // Use direct fetch while app still open (supplemental) then post-exit SQLite will be definitive.
    const postGroupDirect: any = await page.evaluate(
      async ({ topicId, anchorId }: { topicId: string; anchorId: string }) => {
        const api: any = (window as any).api.chatDb
        // Directly query messages via fetchMessages to inspect foldSelected if exposed? Use getRawTopic for wire messages
        const raw = await api.getRawTopic({ topicId })
        return raw
      },
      { topicId, anchorId }
    )
    expect(postGroupDirect.ok).toBe(true)
    const rawMessages: any[] = postGroupDirect.value?.messages ?? []
    const byId = new Map(rawMessages.map((m: any) => [m.id, m]))
    // Verify complete group persisted selection (including missing)
    for (const id of [missingId, visibleIds[0], tailId]) {
      expect(byId.has(id), `raw topic must contain ${id}`).toBe(true)
      const m = byId.get(id)
      // foldSelected lives in message object; check via extra? The wire may include foldSelected at top level
      // Some shapes put it in overflow, but aggregate returns via messageData.foldSelected.
      // Assert that only tail is true.
      const isSelected = (m as any).foldSelected === true
      if (id === tailId) expect(isSelected).toBe(true)
      else expect(isSelected).toBe(false)
    }

    // Post-exit SQLite authority probe (definitive) — messages.extra holds overflow {foldSelected}
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const esc = (v: string) => v.replace(/'/g, "''")
    const sqlR05 = `SELECT id, extra FROM messages WHERE topic_id = '${esc(topicId)}' AND id IN ('${esc(missingId)}','${esc(visibleIds[0])}','${esc(tailId)}')`
    await pollDbUntil(dbPath!, sqlR05, (rows) => rows.length === 3, 30000)
    const probe = queryChatDbViaElectron(dbPath!, sqlR05)
    expect(probe.ok, `SQLite probe failed: ${JSON.stringify(probe)}`).toBe(true)
    const rows: any[] = (probe as any).rows ?? []
    expect(rows.length).toBe(3)
    for (const row of rows) {
      const extra = row.extra ? (typeof row.extra === 'string' ? JSON.parse(row.extra) : row.extra) : {}
      // foldSelected is merged into extra via overflow delta; check directly
      const foldSelected = (extra as any).foldSelected
      if (row.id === tailId) expect(foldSelected).toBe(true)
      else expect(foldSelected).toBe(false)
    }
  })

  test('branch by anchor: real NEW_BRANCH click creates target topic with exact authority prefix', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'BRANCH INTEGRATED UI: seed source topic 30 msgs, anchor mid-topic, real MessageMenubar more-menu → New Branch click emits NEW_BRANCH with stable anchor id, Main branchMessagesToTopic prefix; verify via Redux + post-exit SQLite that target topic length equals anchor index+1 and ordered ids match source prefix.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const sourceTopicId = `s62-branch-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const groupStart = 10 // unrelated, just seed normal 30 msgs without straddle
    // Build simple 30-msg topic
    const totalForBranch = 30
    const anchorIdx = 15
    // Reuse helper but with custom total: we will build entries manually
    const name = `S62 Branch ${sourceTopicId}`
    const addOk = await page.evaluate(
      ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
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
      },
      { topicId: sourceTopicId, assistantId: liveAssistantId, name }
    )
    expect(addOk.ok).toBe(true)
    const entries: any[] = []
    for (let i = 0; i < totalForBranch; i++) {
      const msgId = `${sourceTopicId}-msg-${pad(i, 5)}`
      const blockId = `${sourceTopicId}-block-${pad(i, 5)}`
      const role = i % 2 === 0 ? 'user' : 'assistant'
      const msg: any = {
        id: msgId,
        topicId: sourceTopicId,
        role,
        assistantId: liveAssistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [blockId],
        sortOrder: i
      }
      if (role === 'assistant') {
        msg.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
        msg.modelId = 'mock-model'
        msg.askId = `${sourceTopicId}-msg-${pad(i - 1, 5)}`
      }
      const block = {
        id: blockId,
        messageId: msgId,
        type: 'main_text',
        content: `branch-content-${pad(i, 5)}`,
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      entries.push({ message: msg, blocks: [block] })
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
        entries: any
      }) => {
        const api = (window as any).api as any
        const ensured = await api.chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: JSON.stringify(ensured) }
        const pasted = await api.chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: JSON.stringify(pasted) }
        return { ok: true }
      },
      { topicId: sourceTopicId, assistantId: liveAssistantId, name, entries }
    )
    expect(persist.ok).toBe(true)

    await activateTopicAndWaitForBootstrap(page, sourceTopicId)
    // Anchor is at idx 15 -> msg id
    const anchorId = `${sourceTopicId}-msg-${pad(anchorIdx, 5)}`
    // Ensure anchor is visible (it should be in latest 20? source has 30, latest 20 = 10..29, anchor 15 is visible)
    const preVisible = await page.evaluate(
      ({ topicId, anchorId }: { topicId: string; anchorId: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        return { has: ids.includes(anchorId), count: ids.length }
      },
      { topicId: sourceTopicId, anchorId }
    )
    expect(preVisible.has).toBe(true)

    // Capture source ordered ids before branch for later prefix assertion
    const sourceOrderedIds: string[] = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        const raw = await api.getRawTopic({ topicId })
        if (!raw.ok) return []
        const msgs: any[] = raw.value?.messages ?? []
        return msgs.map((m: any) => m.id)
      },
      { topicId: sourceTopicId }
    )
    const expectedPrefix = sourceOrderedIds.slice(0, anchorIdx + 1)
    expect(expectedPrefix[expectedPrefix.length - 1]).toBe(anchorId)

    // Branch via real UI: hover message, open more-menu, click New Branch (portal-scoped, exact data-testid + menuitem)
    await hoverMessageAndOpenMore(page, anchorId)
    await clickPortalScopedMenuAction(page, 'message-branch-btn')

    // Wait for new branch topic to be created: any topic with expected length (anchorIdx+1) should appear,
    // with content matching source prefix content (since clone uses fresh IDs). We verify via API, not via same IDs.
    const expectedLen = expectedPrefix.length
    await page.waitForFunction(
      ({ expectedLen, sourceTopicId }: { expectedLen: number; sourceTopicId: string }) => {
        const s = (window as any).store.getState()
        const allTopicIds = Object.keys(s.messages?.messageIdsByTopic ?? {})
        for (const tid of allTopicIds) {
          if (tid === sourceTopicId) continue
          const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
          if (ids.length === expectedLen) return true
        }
        return false
      },
      { expectedLen, sourceTopicId },
      { timeout: 30000 }
    )

    // Find the new target topicId via Redux (the one with expectedLen and not source)
    const targetInfo: any = await page.evaluate(
      ({ expectedLen, sourceTopicId }: { expectedLen: number; sourceTopicId: string }) => {
        const s = (window as any).store.getState()
        const allTopicIds = Object.keys(s.messages?.messageIdsByTopic ?? {})
        for (const tid of allTopicIds) {
          if (tid === sourceTopicId) continue
          const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
          if (ids.length === expectedLen) return { topicId: tid, ids }
        }
        return null
      },
      { expectedLen, sourceTopicId }
    )
    expect(targetInfo, 'target branch topic must be found').not.toBeNull()
    expect(targetInfo.ids.length).toBe(expectedLen)

    // Supplementary direct check: fetch target via api and verify content prefix matches source prefix content
    const targetRaw: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.getRawTopic({ topicId })
      },
      { topicId: targetInfo.topicId }
    )
    expect(targetRaw.ok).toBe(true)
    const targetContents: string[] = (targetRaw.value?.messages ?? []).map((m: any) => {
      // message blocks relation includes blocks array? The raw topic messages include blocks ids but content is in separate block? Use message content derived via blocks
      // Instead use the blockMap via separate fetch: we can just check target length and ordering via message count, and verify via DB content query later.
      return m.id
    })
    expect(targetContents.length).toBe(expectedLen)
    // Verify source prefix contents match target contents via block content comparison (authoritative)
    const sourceRaw: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.getRawTopic({ topicId })
      },
      { topicId: sourceTopicId }
    )
    expect(sourceRaw.ok).toBe(true)
    const sourcePrefixContents: string[] = (sourceRaw.value?.messages ?? []).slice(0, expectedLen).map((m: any) => {
      // Use the message's first block content via later DB query; for now just ensure source and target have same count
      return (m as any).id
    })
    expect(sourcePrefixContents.length).toBe(expectedLen)

    // Post-exit SQLite probe for definitive prefix authority — verify target topic messages are ordered prefix of source (by content)
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const esc = (v: string) => v.replace(/'/g, "''")
    // Ordered authority prefix content equivalence: source prefix vs target ordered rows (deterministic sort_order ASC, id ASC).
    // Uses message_blocks content (stable branch-preserved field) plus message role/status to catch order/content permutations while length matches.
    const srcSql = `SELECT m.role as role, m.status as status, COALESCE(m.content,'') as msg_content, COALESCE(mb.content,'') as block_content, COALESCE(mb.type,'') as block_type FROM messages m LEFT JOIN message_blocks mb ON mb.message_id = m.id WHERE m.topic_id = '${esc(sourceTopicId)}' AND m.id IN (SELECT id FROM messages WHERE topic_id = '${esc(sourceTopicId)}' ORDER BY sort_order ASC, id ASC LIMIT ${expectedLen}) ORDER BY m.sort_order ASC, m.id ASC, mb.sort_order ASC, mb.id ASC`
    const tgtSql = `SELECT m.role as role, m.status as status, COALESCE(m.content,'') as msg_content, COALESCE(mb.content,'') as block_content, COALESCE(mb.type,'') as block_type FROM messages m LEFT JOIN message_blocks mb ON mb.message_id = m.id WHERE m.topic_id = '${esc(targetInfo.topicId)}' ORDER BY m.sort_order ASC, m.id ASC, mb.sort_order ASC, mb.id ASC`
    await pollDbUntil(dbPath!, srcSql, (rows) => rows.length === expectedLen, 30000)
    await pollDbUntil(dbPath!, tgtSql, (rows) => rows.length === expectedLen, 30000)
    const srcProbe = queryChatDbViaElectron(dbPath!, srcSql)
    expect(srcProbe.ok, `SQLite src prefix probe failed: ${JSON.stringify(srcProbe)}`).toBe(true)
    const tgtProbe = queryChatDbViaElectron(dbPath!, tgtSql)
    expect(tgtProbe.ok, `SQLite target probe failed: ${JSON.stringify(tgtProbe)}`).toBe(true)
    const srcRows: any[] = (srcProbe as any).rows ?? []
    const tgtRows: any[] = (tgtProbe as any).rows ?? []
    expect(srcRows.length).toBe(expectedLen)
    expect(tgtRows.length).toBe(expectedLen)
    expect(tgtRows.length).toBe(srcRows.length)
    // Fails if prefix order/content is wrong while length matches
    expect(
      tgtRows.map((r: any) => ({
        role: r.role,
        status: r.status,
        msg_content: r.msg_content,
        block_content: r.block_content,
        block_type: r.block_type
      }))
    ).toEqual(
      srcRows.map((r: any) => ({
        role: r.role,
        status: r.status,
        msg_content: r.msg_content,
        block_content: r.block_content,
        block_type: r.block_type
      }))
    )
    // Explicit ordered block_content sequence equivalence (deterministic content order)
    expect(tgtRows.map((r: any) => r.block_content)).toEqual(srcRows.map((r: any) => r.block_content))
  })

  test('insert after anchor: real insert click places two messages after full same-askId tail (authority order)', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INSERT INTEGRATED UI: seed straddle group (29 missing), real MessageMenubar insert click on anchor 30 via more-menu → insertMessagesAfterAnchor (group-tail), verify via Redux + post-exit SQLite that two new messages follow tail 31.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `s62-insert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const groupStart = 29
    const { missingId, visibleIds, anchorId, tailId } = await seedTopicWithStraddleGroup(
      page,
      liveAssistantId,
      topicId,
      groupStart
    )
    await activateTopicAndWaitForBootstrap(page, topicId)

    // Pre-check authority order: tail follows anchor
    const preOrder: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        const raw = await api.getRawTopic({ topicId })
        return raw
      },
      { topicId }
    )
    expect(preOrder.ok).toBe(true)
    const preIds: string[] = (preOrder.value?.messages ?? []).map((m: any) => m.id)
    const anchorIdxPre = preIds.indexOf(anchorId)
    const tailIdxPre = preIds.indexOf(tailId)
    expect(anchorIdxPre).toBeGreaterThan(-1)
    expect(tailIdxPre).toBe(anchorIdxPre + 1) // contiguous tail
    expect(preIds).toContain(missingId)

    // Trigger real insert via UI on anchor 30 — if fold-hidden (group selected at 29), use visible group member 29 as equivalent anchor (Main group-tail insertion after tail 31).
    // Preserve effective visible group member selection (29 when 30 is folded) via exact Redux window + foldSelected, no global fallback.
    const insertCandidates = [missingId, anchorId, tailId]
    const resolvedAnchor: string = await page.evaluate(
      ({ topicId, candidates }: { topicId: string; candidates: string[] }) => {
        const store: any = (window as any).store
        const s = store?.getState?.()
        const windowIds: string[] = s?.messages?.messageIdsByTopic?.[topicId] ?? []
        const entities: Record<string, any> = s?.messages?.entities ?? {}
        // Prefer selected (foldSelected true) among window-visible candidates
        const windowCandidates = candidates.filter((id) => windowIds.includes(id))
        if (windowCandidates.length > 0) {
          for (const id of windowCandidates) {
            if (entities[id]?.foldSelected === true) return id
          }
          return windowCandidates[0]
        }
        // Fallback: any candidate present in entities with foldSelected, else first candidate that exists in DOM
        for (const id of candidates) {
          if (entities[id]?.foldSelected === true) {
            const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
            const sel = `[id="message-${esc}"][data-message-id="${esc}"]`
            if (document.querySelector(sel)) return id
          }
        }
        for (const id of candidates) {
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          const sel = `[id="message-${esc}"][data-message-id="${esc}"]`
          if (document.querySelector(sel)) return id
        }
        return candidates[0]
      },
      { topicId, candidates: insertCandidates }
    )
    await expect(
      page.locator(
        `[id="message-${resolvedAnchor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"][data-message-id="${resolvedAnchor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
      ),
      `effective insert anchor ${resolvedAnchor} must be visible`
    ).toBeVisible({ timeout: 15000 })
    await hoverMessageAndOpenMore(page, resolvedAnchor)
    await clickPortalScopedMenuAction(page, 'message-insert-btn')

    // Meaningful pre-close synchronization: poll authority state for inserted count (TOTAL + 2) instead of unconditional sleep / trivial return true
    await page.waitForFunction(
      async ({ topicId, expectedLen }: { topicId: string; expectedLen: number }) => {
        const api: any = (window as any).api?.chatDb
        if (!api || typeof api.getRawTopic !== 'function') return false
        try {
          const raw = await api.getRawTopic({ topicId })
          if (!raw || raw.ok !== true) return false
          const msgs: any[] = raw.value?.messages ?? []
          return Array.isArray(msgs) && msgs.length === expectedLen
        } catch {
          return false
        }
      },
      { topicId, expectedLen: TOTAL + 2 },
      { timeout: 30000 }
    )

    // Fetch authoritative raw after insert while app open
    const postRaw: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.getRawTopic({ topicId })
      },
      { topicId }
    )
    expect(postRaw.ok).toBe(true)
    const postIds: string[] = (postRaw.value?.messages ?? []).map((m: any) => m.id)
    expect(postIds.length).toBe(TOTAL + 2)
    const tailIdx = postIds.indexOf(tailId)
    expect(tailIdx).toBeGreaterThan(-1)
    // Two new messages should be exactly after tail
    const afterTail1 = postIds[tailIdx + 1]
    const afterTail2 = postIds[tailIdx + 2]
    expect(afterTail1).toBeTruthy()
    expect(afterTail2).toBeTruthy()
    // Verify they are the inserted ones: they should not be in preIds
    expect(preIds).not.toContain(afterTail1)
    expect(preIds).not.toContain(afterTail2)
    // Verify askId linkage for second inserted (assistant should have askId of first inserted user)
    const postMsgsById = new Map((postRaw.value?.messages ?? []).map((m: any) => [m.id, m]))
    const insertedUser = postMsgsById.get(afterTail1) as any
    const insertedAssistant = postMsgsById.get(afterTail2) as any
    expect(insertedUser?.role).toBe('user')
    expect(insertedAssistant?.role).toBe('assistant')
    expect(insertedAssistant?.askId).toBe(insertedUser?.id)

    // Missing member should still be present and before anchor
    expect(postIds.indexOf(missingId)).toBeLessThan(postIds.indexOf(anchorId))

    // Post-exit SQLite definitive order probe
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const esc = (v: string) => v.replace(/'/g, "''")
    const sqlInsert = `SELECT id FROM messages WHERE topic_id = '${esc(topicId)}' ORDER BY sort_order ASC, id ASC`
    await pollDbUntil(dbPath!, sqlInsert, (rows) => rows.length === TOTAL + 2, 30000)
    const probe = queryChatDbViaElectron(dbPath!, sqlInsert)
    expect(probe.ok).toBe(true)
    const rows: any[] = (probe as any).rows ?? []
    const ordered: string[] = rows.map((r: any) => r.id)
    expect(ordered.length).toBe(TOTAL + 2)
    const dbTailIdx = ordered.indexOf(tailId)
    expect(ordered[dbTailIdx + 1]).toBe(afterTail1)
    expect(ordered[dbTailIdx + 2]).toBe(afterTail2)
  })
})
