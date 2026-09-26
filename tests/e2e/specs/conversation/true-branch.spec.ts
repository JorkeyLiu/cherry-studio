/**
 * Topic-internal branches — INTEGRATED E2E (real UI, real IPC, real SQLite).
 *
 * Final model: exactly ONE sidebar topic throughout. Branches are internal
 * route nodes (`topic_branches`), addressed by activeBranchId + logical
 * activeTopic. No child topics, no sidebar branch rows.
 *
 * Workflow (single test, disposable profile, mock provider, fresh build):
 * 1. Seed an ordinary source topic (30 msgs) via IPC + Redux addTopic.
 * 2. Real assistant-message toolbar click (msg-true-branch-btn) forks L1 at
 *    a mid anchor: same topicId, one branch row, effective route of stable
 *    IDs, top breadcrumb shows `Topic / <default name>`, sidebar stays one.
 * 3. Real top-selector rename (branch-rename-btn-*) renames DB-first; the
 *    divider + breadcrumb show the new name; the topic name is untouched.
 * 4. Real toolbar click on an INHERITED message forks L2 (parent = L1).
 * 5. Fork-divider switch (branch-fork-selected-*) to the parent/original
 *    route lands on the SAME shared anchor/current vicinity — never bottom.
 * 6. Top-selector cascader switch back to L2 — breadcrumb updates, no jump.
 * 7. Same-profile relaunch: catalog, names, active route, and dividers
 *    persist (in-app reload proof).
 * 8. Real top-selector Delete removes the L1 subtree (L1+L2); the topic is
 *    indistinguishable from never-branched (no selector, no dividers).
 * 9. Post-exit SQLite (durable proof): no branch rows, 30 main-route rows
 *    with NULL branch_id, no extra topics, no duplicated prefix rows.
 *
 * The legacy overflow Copy Topic proof lives in
 * s62-answer-branch-insert.spec.ts (real prefix-cloned new topic).
 */
import * as fs from 'fs'
import { expect, test } from '../../fixtures/electron.fixture'
import { getChatDbPath, getUserDataDir, queryChatDbViaElectron } from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'

const TOTAL = 30
const ANCHOR_IDX = 15
const INHERITED_ANCHOR_IDX = 5

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}
const esc = (v: string): string => v.replace(/'/g, "''")

async function prepareAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, TOTAL)
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

async function seedSourceTopic(page: any, assistantId: string, topicId: string, name: string): Promise<string[]> {
  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        ;(window as any).store.dispatch({
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
    { topicId, assistantId, name }
  )
  expect(addOk.ok).toBe(true)
  const entries: any[] = []
  const ids: string[] = []
  for (let i = 0; i < TOTAL; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    ids.push(msgId)
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const msg: any = {
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
    if (role === 'assistant') {
      msg.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      msg.modelId = 'mock-model'
      msg.askId = `${topicId}-msg-${pad(i - 1, 5)}`
    }
    entries.push({
      message: msg,
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: `true-branch-${pad(i, 5)}`,
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
      entries: any
    }) => {
      try {
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persist.ok, `seed failed: ${(persist as any).err}`).toBe(true)
  return ids
}

async function seedSmallTopic(page: any, assistantId: string, topicId: string, name: string): Promise<string[]> {
  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        ;(window as any).store.dispatch({
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
    { topicId, assistantId, name }
  )
  expect(addOk.ok).toBe(true)
  const ids = [`${topicId}-msg-00000`, `${topicId}-msg-00001`, `${topicId}-msg-00002`, `${topicId}-msg-00003`]
  const entries = ids.map((msgId, i) => {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const msg: any = {
      id: msgId,
      topicId,
      role,
      assistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [`${topicId}-block-0000${i}`],
      sortOrder: i
    }
    if (role === 'assistant') {
      msg.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      msg.modelId = 'mock-model'
      msg.askId = ids[i - 1]
    }
    return {
      message: msg,
      blocks: [
        {
          id: `${topicId}-block-0000${i}`,
          messageId: msgId,
          type: 'main_text',
          content: `other-topic-${i}`,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    }
  })
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
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persist.ok, `small seed failed: ${(persist as any).err}`).toBe(true)
  return ids
}

async function visualOffsetOfMessage(page: any, messageId: string): Promise<number | null> {
  return page.evaluate((id: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (!container || !el) return null
    return el.getBoundingClientRect().top - container.getBoundingClientRect().top
  }, messageId)
}

async function sidebarTopicIds(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    return s.assistants.assistants.flatMap((a: any) => (a.topics ?? []).map((t: any) => t.id)).sort()
  })
}

async function activateTopic(page: any, topicId: string, atLeast: number): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId, atLeast }: { topicId: string; atLeast: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= atLeast && loading !== true
    },
    { topicId, atLeast },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (atLeast: number) => document.querySelectorAll('#messages [data-message-id]').length >= atLeast,
    atLeast,
    { timeout: 30000 }
  )
}

async function clickToolbarBranch(page: any, messageId: string): Promise<void> {
  const e = messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const sel = `[id="message-${e}"][data-message-id="${e}"]`
  let container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 15000 })
  await page.evaluate((id: string) => {
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
  }, messageId)
  container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible after scroll`).toBeVisible({ timeout: 15000 })
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    // Hover flakiness near edges; the button click below uses force fallback.
  }
  const btn = container.locator('[data-testid="msg-true-branch-btn"]')
  await expect(btn, `true-branch toolbar button for ${messageId} must be attached`).toBeAttached({ timeout: 10000 })
  try {
    await btn.click({ timeout: 8000 })
  } catch {
    await btn.click({ force: true } as any)
  }
}

async function listBranches(page: any, topicId: string): Promise<any[]> {
  const res: any = await page.evaluate(
    async (tid: string) => (window as any).api.chatDb.listBranches({ topicId: tid }),
    topicId
  )
  expect(res?.ok, `listBranches failed: ${JSON.stringify(res)}`).toBe(true)
  return res.value.branches as any[]
}

async function scrollMetrics(page: any): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('#messages') as HTMLElement | null
    if (!el) return { scrollTop: -1, scrollHeight: -1, clientHeight: -1 }
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
}

async function isVisibleInMessagesViewport(page: any, messageId: string): Promise<boolean> {
  return page.evaluate((id: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (!container || !el) return false
    const c = container.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.bottom > c.top && r.top < c.bottom
  }, messageId)
}

test.describe('Topic-internal branches end-to-end', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('create L1/L2 → breadcrumb → divider/top switch → reload → subtree delete → pre-branch UI', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'TRUE-BRANCH INTEGRATED UI: one sidebar topic throughout; toolbar forks local-only route nodes (no prefix clone, no topics); breadcrumb/cascader + fork-divider switching without bottom jump; same-profile relaunch persistence; subtree delete restores pre-branch UI; post-exit SQLite proves branch/row/topic integrity.'
    })
    const userDataDir = getUserDataDir()
    await waitForAppReady(mainWindow)
    const page = mainWindow
    const assistantId = await prepareAssistant(page)
    const sourceTopicId = `intbranch-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topicName = `IntBranch ${sourceTopicId}`
    const sourceIds = await seedSourceTopic(page, assistantId, sourceTopicId, topicName)
    const anchorId = sourceIds[ANCHOR_IDX]
    const inheritedAnchorId = sourceIds[INHERITED_ANCHOR_IDX]
    await activateTopic(page, sourceTopicId, TOTAL)
    // Baseline sidebar identity (the disposable profile may carry its own
    // default topics): no step may ever add or remove a logical topic.
    const topicsBefore = await sidebarTopicIds(page)
    expect(topicsBefore).toContain(sourceTopicId)

    // 2. Fork L1 at the mid assistant anchor via the real toolbar button.
    await clickToolbarBranch(page, anchorId)
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len
      },
      { tid: sourceTopicId, len: ANCHOR_IDX + 1 },
      { timeout: 30000 }
    )
    let branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(1)
    expect(branches[0].topicId).toBe(sourceTopicId)
    expect(branches[0].parentBranchId).toBeNull()
    expect(branches[0].anchorMessageId).toBe(anchorId)
    const branch1Id = branches[0].id as string
    // Sidebar identity unchanged: no child-topic rows were created.
    expect(await sidebarTopicIds(page)).toEqual(topicsBefore)
    // Unified breadcrumb shows the branch path on the same logical topic.
    const crumb1 = await page.locator('[data-testid="branch-selector-breadcrumb"]').first().textContent()
    expect(crumb1).toContain(topicName)
    // Effective route: shared prefix through anchor with STABLE IDs (no clone).
    const routeIds: string[] = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [],
      sourceTopicId
    )
    expect(routeIds).toEqual(sourceIds.slice(0, ANCHOR_IDX + 1))

    // 3. Rename L1 via the top unified selector (rename/delete only).
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await page.locator(`[data-testid="branch-rename-btn-${branch1Id}"]`).first().click()
    const renameInput = page.locator('[data-testid="branch-selector-rename-input"]').first()
    await expect(renameInput).toBeVisible({ timeout: 10000 })
    await renameInput.fill('E2E Renamed Branch')
    await renameInput.press('Enter')
    await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
      'E2E Renamed Branch',
      { timeout: 30000 }
    )
    // The logical topic name is untouched by branch rename.
    const topicNameAfter: string = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return s.assistants.assistants.flatMap((a: any) => a.topics).find((t: any) => t.id === tid)?.name ?? ''
    }, sourceTopicId)
    expect(topicNameAfter).toBe(topicName)

    // 4. Second level from an INHERITED message (parent route = L1).
    await clickToolbarBranch(page, inheritedAnchorId)
    await page.waitForFunction(
      ({ tid }: { tid: string }) => {
        const s = (window as any).store.getState()
        return (s.topicBranch?.branchesByTopic?.[tid] ?? []).length === 2
      },
      { tid: sourceTopicId },
      { timeout: 30000 }
    )
    branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(2)
    const branch2 = branches.find((b: any) => b.id !== branch1Id)
    expect(branch2.parentBranchId).toBe(branch1Id)
    expect(branch2.anchorMessageId).toBe(inheritedAnchorId)
    const branch2Id = branch2.id as string
    expect(await sidebarTopicIds(page)).toEqual(topicsBefore)

    // 5. Fork-divider switch on the L1 route: its anchor fork is taken
    // (selected branch name shown); switching to the parent/original route
    // lands on the SAME shared anchor, never a bottom jump. (The fresh L2
    // route only spans main[0..m5], so its anchor fork is not in view —
    // return to L1 via the top selector first.)
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await page.locator(`[data-testid="branch-cascader-item-${branch1Id}"]`).first().click()
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len
      },
      { tid: sourceTopicId, len: ANCHOR_IDX + 1 },
      { timeout: 30000 }
    )
    const takenToggle = page.locator(`[data-testid="branch-fork-selected-${anchorId}"]`).first()
    await expect(takenToggle, 'taken fork must show the selected branch name').toBeVisible({ timeout: 30000 })
    await expect(takenToggle).toContainText('E2E Renamed Branch')
    await takenToggle.click()
    const forkList = page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()
    await expect(forkList, 'divider popup must open as an overlay').toBeVisible({ timeout: 15000 })
    // No in-flow expansion: the popup overlays content and never pushes it —
    // the option list is NOT an in-flow child of the divider row, so closed
    // and open states occupy the same layout height.
    expect(
      await page
        .locator(`[data-testid="branch-fork-divider-${anchorId}"] [data-testid="branch-fork-list-${anchorId}"]`)
        .count(),
      'divider popup must not expand in-flow'
    ).toBe(0)
    // Visual reference before the switch: the shared anchor's viewport offset.
    const offsetBefore = await visualOffsetOfMessage(page, anchorId)
    expect(offsetBefore, 'shared anchor must be measurable before divider switch').not.toBeNull()
    const parentItem = page.locator(`[data-testid="branch-fork-item-parent-${anchorId}"]`).first()
    await expect(parentItem, 'parent/original route must be offered').toBeVisible({ timeout: 15000 })
    await parentItem.click()
    // Main route restored in the same logical topic (full length), anchor in view.
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len
      },
      { tid: sourceTopicId, len: TOTAL },
      { timeout: 30000 }
    )
    // The shared anchor stays in view (anchor-vicinity navigation, polled —
    // the pending NAVIGATE_TO_MESSAGE resolves asynchronously after load).
    await page.waitForFunction(
      (id: string) => {
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const container = document.querySelector('#messages') as HTMLElement | null
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (!container || !el) return false
        const c = container.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.bottom > c.top && r.top < c.bottom
      },
      anchorId,
      { timeout: 30000 }
    )
    expect(await isVisibleInMessagesViewport(page, anchorId)).toBe(true)
    // Visual-anchor preservation: the shared anchor's viewport offset is
    // stable across the divider switch within deterministic tolerance.
    const offsetAfter = await visualOffsetOfMessage(page, anchorId)
    expect(offsetAfter, 'shared anchor must be measurable after divider switch').not.toBeNull()
    expect(
      Math.abs((offsetAfter as number) - (offsetBefore as number)),
      'divider switch must preserve the visual reference (viewport offset stable)'
    ).toBeLessThanOrEqual(12)
    const after = await scrollMetrics(page)
    if (after.scrollHeight > after.clientHeight + 200) {
      expect(
        after.scrollHeight - after.scrollTop - after.clientHeight,
        'divider switch must not jump to bottom'
      ).toBeGreaterThan(200)
    }
    expect(await sidebarTopicIds(page)).toEqual(topicsBefore)

    // 6. Top-selector cascader switch back to L2 — breadcrumb updates, no jump.
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    const l2row = page.locator(`[data-testid="branch-cascader-row-${branch1Id}"]`).first()
    await l2row.hover()
    const l2item = page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()
    await expect(l2item, 'nested branch must appear in the next cascader column').toBeVisible({ timeout: 15000 })
    await l2item.click()
    await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
      'E2E Renamed Branch',
      { timeout: 30000 }
    )
    expect(await isVisibleInMessagesViewport(page, inheritedAnchorId)).toBe(true)

    // 6b. Topic switch away/back restores the logical topic's previously
    // active branch (no reset to main). Sidebar stays logical-topic-only.
    const otherTopicId = `intbranch-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, otherTopicId, `Other ${otherTopicId}`)
    const topicsWithOther = await sidebarTopicIds(page)
    expect(topicsWithOther).toContain(sourceTopicId)
    expect(topicsWithOther).toContain(otherTopicId)
    expect(topicsWithOther).toEqual([...topicsBefore, otherTopicId].sort())
    await activateTopic(page, otherTopicId, 4)
    await activateTopic(page, sourceTopicId, INHERITED_ANCHOR_IDX + 1)
    // The L2 route is restored: breadcrumb keeps the branch path and the
    // stored active branch is L2 (not main).
    await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
      'E2E Renamed Branch',
      { timeout: 30000 }
    )
    const restoredBranchId: string | null = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(restoredBranchId).toBe(branch2Id)
    expect(await isVisibleInMessagesViewport(page, inheritedAnchorId)).toBe(true)
    expect(await sidebarTopicIds(page)).toEqual(topicsWithOther)

    // 6c. Top selector repeated open at depth: current L2 opens through the
    // L2-containing column but not L2's children; repeat close/open keeps
    // the same behavior (no collapse to first column, no over-expansion).
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()).toBeVisible({
      timeout: 15000
    })
    expect(await page.locator('[data-testid="branch-cascader-col-2"]').count()).toBe(0)
    // Repeat close/open preserves the same behavior (no collapse, no over-expansion).
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]')).toHaveCount(0, { timeout: 15000 })
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()).toBeVisible({
      timeout: 15000
    })
    expect(await page.locator('[data-testid="branch-cascader-col-2"]').count()).toBe(0)
    // Current L1 with children opens col-0 only (L1 highlighted, no child
    // column until hover on L1).
    await page.locator(`[data-testid="branch-cascader-item-${branch1Id}"]`).first().click()
    await expect(page.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
      'E2E Renamed Branch',
      { timeout: 30000 }
    )
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    expect(await page.locator('[data-testid="branch-cascader-col-1"]').count()).toBe(0)
    await page.locator(`[data-testid="branch-cascader-row-${branch1Id}"]`).first().hover()
    await expect(page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first()).toBeVisible({
      timeout: 15000
    })
    // Back to L2 for the relaunch persistence below.
    await page.locator(`[data-testid="branch-cascader-item-${branch2Id}"]`).first().click()
    await page.waitForFunction(
      ({ tid, bid }: { tid: string; bid: string }) => {
        const s = (window as any).store.getState()
        return s.topicBranch?.activeBranchIdByTopic?.[tid] === bid
      },
      { tid: sourceTopicId, bid: branch2Id },
      { timeout: 30000 }
    )

    // 7. Same-profile relaunch: catalog, names, active route, dividers persist.
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    await electronApp.close()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
    try {
      const page2 = relaunched.page
      await waitForAppReady(page2)
      await page2.evaluate((limit: number) => {
        ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
      }, TOTAL)
      // Still exactly one sidebar topic; the renamed branch persists.
      await expect(page2.locator(`[data-testid="topic-item"][data-topic-id="${sourceTopicId}"]`).first()).toBeVisible({
        timeout: 30000
      })
      const topicsAfterReload: string[] = await page2.evaluate(() => {
        const st = (window as any).store.getState()
        return st.assistants.assistants.flatMap((x: any) => (x.topics ?? []).map((t: any) => t.id)).sort()
      })
      expect(topicsAfterReload).toEqual(topicsWithOther)
      const branchesAfter: any[] = await page2.evaluate(
        async (tid: string) =>
          (window as any).api.chatDb.listBranches({ topicId: tid }).then((r: any) => r.value.branches),
        sourceTopicId
      )
      expect(branchesAfter).toHaveLength(2)
      expect(branchesAfter.find((b: any) => b.id === branch1Id)?.name).toBe('E2E Renamed Branch')
      // Same-profile relaunch restores the valid selected branch: opening
      // the topic lands back on the L2 route (breadcrumb keeps the branch
      // path), not on main. Catalog, names, and dividers persist.
      await page2.locator(`[data-testid="topic-item"][data-topic-id="${sourceTopicId}"]`).first().click()
      await expect(page2.locator('[data-testid="branch-selector-breadcrumb"]').first()).toContainText(
        'E2E Renamed Branch',
        { timeout: 30000 }
      )
      const relaunchedBranchId: string | null = await page2.evaluate(
        (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        sourceTopicId
      )
      expect(relaunchedBranchId).toBe(branch2Id)
      // The L2 route's own taken fork (at its anchor) is back as well.
      await expect(page2.locator(`[data-testid="branch-fork-selected-${inheritedAnchorId}"]`).first()).toBeVisible({
        timeout: 30000
      })

      // 8. Top-selector Delete removes the L1 subtree (L1+L2); pre-branch UI returns.
      await page2.locator('[data-testid="branch-selector-entry"]').first().click()
      await expect(page2.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
      await page2.locator(`[data-testid="branch-delete-btn-${branch1Id}"]`).first().click()
      await page2.locator('.ant-popconfirm-buttons .ant-btn-primary').first().click()
      await page2.waitForFunction(
        ({ tid }: { tid: string }) => {
          const s = (window as any).store.getState()
          return (s.topicBranch?.branchesByTopic?.[tid] ?? []).length === 0
        },
        { tid: sourceTopicId },
        { timeout: 30000 }
      )
      // Never-branched state: no selector, no fork dividers, full main route, one topic.
      await expect(page2.locator('[data-testid="branch-selector-entry"]')).toHaveCount(0, { timeout: 15000 })
      await expect(page2.locator('[data-testid^="branch-fork-divider-"]')).toHaveCount(0)
      await page2.waitForFunction(
        ({ tid, len }: { tid: string; len: number }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[tid]
          return Array.isArray(ids) && ids.length === len
        },
        { tid: sourceTopicId, len: TOTAL },
        { timeout: 30000 }
      )
      const topicsAfterDelete: string[] = await page2.evaluate(() => {
        const st = (window as any).store.getState()
        return st.assistants.assistants.flatMap((x: any) => (x.topics ?? []).map((t: any) => t.id)).sort()
      })
      expect(topicsAfterDelete).toEqual(topicsWithOther)
    } finally {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunched.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    // 9. Post-exit SQLite durable proof.
    expect(chatDbPath).not.toBeNull()
    expect(fs.existsSync(chatDbPath!)).toBe(true)
    const branchRowsGone = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM topic_branches WHERE topic_id = '${esc(sourceTopicId)}'`
    )
    expect(branchRowsGone?.ok).toBe(true)
    expect(((branchRowsGone as any).rows ?? [])[0]?.n).toBe(0)
    // All 30 rows are main-route (branch_id NULL); no duplicated prefix rows.
    const srcCount = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(sourceTopicId)}'`
    )
    expect(srcCount?.ok).toBe(true)
    expect(((srcCount as any).rows ?? [])[0]?.n).toBe(TOTAL)
    const branchedRows = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(sourceTopicId)}' AND branch_id IS NOT NULL`
    )
    expect(branchedRows?.ok).toBe(true)
    expect(((branchedRows as any).rows ?? [])[0]?.n).toBe(0)
    const srcOrder = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT id FROM messages WHERE topic_id = '${esc(sourceTopicId)}' ORDER BY sort_order ASC, id ASC`
    )
    expect(srcOrder?.ok).toBe(true)
    expect(((srcOrder as any).rows ?? []).map((r: any) => r.id)).toEqual(sourceIds)
    // No extra message-owning topics were ever created by branching: every
    // committed message belongs to either the single branched logical topic
    // or the step-6b switch-restore peer topic (the disposable profile may
    // own its own empty default topic rows, which carry no messages).
    const otherCount = queryChatDbViaElectron(
      chatDbPath!,
      `SELECT COUNT(*) AS n FROM messages WHERE topic_id = '${esc(otherTopicId)}'`
    )
    expect(otherCount?.ok).toBe(true)
    expect(((otherCount as any).rows ?? [])[0]?.n).toBe(4)
    const msgOwners = queryChatDbViaElectron(chatDbPath!, `SELECT DISTINCT topic_id AS id FROM messages`)
    expect(msgOwners?.ok).toBe(true)
    expect((((msgOwners as any).rows ?? []) as any[]).map((r: any) => r.id).sort()).toEqual(
      [otherTopicId, sourceTopicId].sort()
    )
  })
})
