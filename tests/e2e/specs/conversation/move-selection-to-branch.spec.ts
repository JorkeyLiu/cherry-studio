/**
 * Move selected turns to a new branch — focused E2E (real UI, real IPC, real SQLite).
 *
 * Contract: actual edit-mode selection (click + shift-click whole turns),
 * actual right-click context menu (`Move to New Branch` / `移至新建分支`),
 * actual new branch route with stable IDs, parent/new route sequences, and
 * same-profile relaunch persistence. Negative cases assert the menu item
 * stays visible but disabled (no preceding anchor; selection holds a branch
 * anchor).
 *
 * Uses the standard shared fixture, a unique disposable profile, and mocked
 * external providers. Not run by the implementation lane; executed by
 * Validation after a fresh production build.
 */
import * as fs from 'fs'
import type { Page } from '@playwright/test'
import { expect, test } from '../../fixtures/electron.fixture'
import {
  getChatDbPath,
  getUserDataDir,
  queryChatDbViaElectron,
  queryChatDbViaElectronWithRetry
} from '../../fixtures/electron.fixture'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'
import { activateTopic, pad, prepareAssistant, seedSourceTopic } from '../../utils/branch-route-setup'

const esc = (v: string): string => v.replace(/'/g, "''")

async function messageIdsOnRoute(page: Page, topicId: string, branchId: string | null): Promise<string[]> {
  return page.evaluate(
    async ({ tid, bid }: { tid: string; bid: string | null }) => {
      const win = window as unknown as {
        api: { chatDb: { fetchMessagesWindow: (req: unknown) => Promise<unknown> } }
      }
      const res = (await win.api.chatDb.fetchMessagesWindow({
        kind: 'latest',
        topicId: tid,
        branchId: bid,
        limit: 50
      })) as { ok: boolean; value?: { messages?: Array<{ id: string }> } }
      if (!res || res.ok !== true || !res.value || !Array.isArray(res.value.messages)) {
        throw new Error('window read failed')
      }
      return res.value.messages.map((m) => m.id)
    },
    { tid: topicId, bid: branchId }
  )
}

async function enableEditMode(page: Page): Promise<void> {
  await page.locator('[data-testid="edit-mode-toggle"]').click()
  await page.waitForFunction(
    () => {
      const win = window as unknown as { store: { getState: () => { editMode: { enabled: boolean } } } }
      return win.store.getState().editMode.enabled === true
    },
    null,
    { timeout: 15000 }
  )
}

async function clickGroup(page: Page, messageId: string, modifiers?: { shift?: boolean }): Promise<void> {
  const sel = `[data-message-id="${messageId}"]`
  const target = page.locator(sel).first()
  await target.scrollIntoViewIfNeeded()
  await expect(target).toBeVisible({ timeout: 15000 })
  if (modifiers?.shift) {
    await target.click({ modifiers: ['Shift'] })
  } else {
    await target.click()
  }
}

async function selectedGroups(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as { store: { getState: () => { editMode: { selectedGroupIds: string[] } } } }
    return win.store.getState().editMode.selectedGroupIds
  })
}

async function openEditMenu(page: Page, messageId: string): Promise<void> {
  const sel = `[data-message-id="${messageId}"]`
  const target = page.locator(sel).first()
  await target.scrollIntoViewIfNeeded()
  await target.click({ button: 'right' })
}

function moveMenuItem(page: Page) {
  return page.getByRole('menuitem', { name: /移至新建分支|Move to New Branch/ })
}

function requireRows(
  outcome: Awaited<ReturnType<typeof queryChatDbViaElectronWithRetry>>,
  what: string
): readonly Record<string, unknown>[] {
  if (!outcome.ok) {
    throw new Error(`${what} failed with code ${outcome.code}`)
  }
  return outcome.rows
}

test.describe('Move selected turns to new branch (focused)', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')
  test('actual edit selection + right-click menu moves B,C to a new branch with stable IDs and relaunch persistence', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(240000)
    const userDataDir = getUserDataDir()
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, 20)
    const topicId = `move-e2e-${Date.now()}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: 'Move E2E',
      total: 8,
      messageIdForIndex: (i: number) => `${topicId}-msg-${pad(i, 5)}`,
      contentPrefix: 'move-'
    })
    // Turns: (0,1)=A (2,3)=B (4,5)=C (6,7)=D; group IDs are the user ids.
    const [uA, aA, uB, aB, uC, aC, uD, aD] = ids
    await activateTopic(page, topicId, 8)

    await enableEditMode(page)
    await clickGroup(page, uB)
    await clickGroup(page, uC, { shift: true })
    await page.waitForFunction(
      ({ b, c }: { b: string; c: string }) => {
        const win = window as unknown as { store: { getState: () => { editMode: { selectedGroupIds: string[] } } } }
        const sel = win.store.getState().editMode.selectedGroupIds
        return sel.includes(b) && sel.includes(c)
      },
      { b: uB, c: uC },
      { timeout: 15000 }
    )
    expect(await selectedGroups(page)).toEqual(expect.arrayContaining([uB, uC]))

    await openEditMenu(page, uB)
    const item = moveMenuItem(page)
    await expect(item).toBeVisible({ timeout: 15000 })
    await expect(item).toBeEnabled({ timeout: 15000 })
    await item.click()

    // New branch activates: catalog holds one node anchored at aA.
    await page.waitForFunction(
      (tid: string) => {
        const win = window as unknown as {
          store: { getState: () => { topicBranch?: { branchesByTopic?: Record<string, Array<{ id: string }>> } } }
        }
        const list = win.store.getState().topicBranch?.branchesByTopic?.[tid]
        return Array.isArray(list) && list.length === 1 ? list : null
      },
      topicId,
      { timeout: 30000 }
    )
    const catalog: Array<{ id: string; anchorMessageId: string }> = await page.evaluate(async (tid: string) => {
      const win = window as unknown as {
        api: { chatDb: { listBranches: (req: unknown) => Promise<unknown> } }
      }
      const res = (await win.api.chatDb.listBranches({ topicId: tid })) as {
        ok: boolean
        value?: { branches?: Array<{ id: string; anchorMessageId: string }> }
      }
      if (!res || res.ok !== true || !res.value || !Array.isArray(res.value.branches)) {
        throw new Error('listBranches failed')
      }
      return res.value.branches
    }, topicId)
    expect(catalog).toHaveLength(1)
    const branchId = catalog[0].id
    expect(catalog[0].anchorMessageId).toBe(aA)
    const activeRoute = await page.evaluate((tid: string) => {
      const win = window as unknown as {
        store: { getState: () => { topicBranch?: { activeBranchIdByTopic?: Record<string, string | null> } } }
      }
      return win.store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null
    }, topicId)
    expect(activeRoute).toBe(branchId)

    // Parent/new route sequences through windowed reads (bounded, never full injection).
    expect(await messageIdsOnRoute(page, topicId, null)).toEqual([uA, aA, uD, aD])
    expect(await messageIdsOnRoute(page, topicId, branchId)).toEqual([uA, aA, uB, aB, uC, aC])

    // Durable SQLite proof before relaunch: same stable IDs, moved rows owned by the branch.
    const dbPath = getChatDbPath()
    expect(dbPath).toBeTruthy()
    const movedOutcome = await queryChatDbViaElectronWithRetry(
      dbPath!,
      `SELECT id, branch_id AS branchId FROM messages WHERE topic_id='${esc(topicId)}' ORDER BY id ASC`
    )
    const movedRows = requireRows(movedOutcome, 'move ownership query')
    const byId = new Map(movedRows.map((r) => [String(r.id), (r.branchId ?? null) as string | null]))
    for (const id of [uB, aB, uC, aC]) expect(byId.get(id)).toBe(branchId)
    for (const id of [uA, aA, uD, aD]) expect(byId.get(id)).toBeNull()
    const blockOutcome = queryChatDbViaElectron(
      dbPath!,
      `SELECT id, message_id AS messageId FROM message_blocks WHERE message_id IN ('${esc(uB)}','${esc(aB)}','${esc(uC)}','${esc(aC)}')`
    )
    const blockRows = requireRows(blockOutcome, 'move block query')
    expect(blockRows.length).toBeGreaterThan(0)
    for (const row of blockRows) {
      expect([uB, aB, uC, aC]).toContain(String(row.messageId))
    }

    // Same-profile relaunch: catalog, active route, and sequences persist.
    await electronApp.close()
    const relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
    try {
      const page2 = relaunched.page
      await waitForAppReady(page2)
      const catalog2: Array<{ id: string }> = await page2.evaluate(async (tid: string) => {
        const win = window as unknown as {
          api: { chatDb: { listBranches: (req: unknown) => Promise<unknown> } }
        }
        const res = (await win.api.chatDb.listBranches({ topicId: tid })) as {
          ok: boolean
          value?: { branches?: Array<{ id: string }> }
        }
        if (!res || res.ok !== true || !res.value || !Array.isArray(res.value.branches)) {
          throw new Error('listBranches failed')
        }
        return res.value.branches
      }, topicId)
      expect(catalog2.map((b) => b.id)).toEqual([branchId])
      expect(await messageIdsOnRoute(page2, topicId, null)).toEqual([uA, aA, uD, aD])
      expect(await messageIdsOnRoute(page2, topicId, branchId)).toEqual([uA, aA, uB, aB, uC, aC])
    } finally {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunched.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
    }
    expect(fs.existsSync(dbPath!)).toBe(true)
  })

  test('menu stays visible but disabled with no preceding anchor or a branch anchor in the selection', async ({
    mainWindow
  }) => {
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, 20)
    const topicId = `move-e2e-neg-${Date.now()}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: 'Move E2E Neg',
      total: 8,
      messageIdForIndex: (i: number) => `${topicId}-msg-${pad(i, 5)}`,
      contentPrefix: 'moveneg-'
    })
    const [uA, aA, uB, aB] = ids
    await activateTopic(page, topicId, 8)
    await enableEditMode(page)

    // First-turn selection: no preceding anchor -> disabled.
    await clickGroup(page, uA)
    await openEditMenu(page, uA)
    const firstItem = moveMenuItem(page)
    await expect(firstItem).toBeVisible({ timeout: 15000 })
    await expect(firstItem).toBeDisabled({ timeout: 15000 })
    await page.keyboard.press('Escape')

    // Selection holding an existing branch anchor -> disabled.
    const created = (await page.evaluate(
      async ({ tid, anchor }: { tid: string; anchor: string }) => {
        const win = window as unknown as {
          api: { chatDb: { createBranch: (req: unknown) => Promise<unknown> } }
        }
        return win.api.chatDb.createBranch({ topicId: tid, parentBranchId: null, anchorMessageId: anchor })
      },
      { tid: topicId, anchor: aA }
    )) as { ok: boolean }
    expect(created?.ok).toBe(true)
    await page.evaluate(async (tid: string) => {
      const win = window as unknown as {
        api: { chatDb: { listBranches: (req: unknown) => Promise<unknown> } }
        store: { dispatch: (action: unknown) => void }
      }
      const res = (await win.api.chatDb.listBranches({ topicId: tid })) as {
        ok: boolean
        value?: { branches?: unknown[] }
      }
      if (!res || res.ok !== true || !res.value) throw new Error('catalog refresh failed')
      win.store.dispatch({
        type: 'topicBranch/branchesReceived',
        payload: { topicId: tid, branches: res.value.branches }
      })
    }, topicId)
    await clickGroup(page, uA)
    await clickGroup(page, uB, { shift: true })
    // Keep the anchor IDs referenced so the seeded topology is explicit.
    expect([aA, aB].length).toBe(2)
    await openEditMenu(page, uB)
    const anchorItem = moveMenuItem(page)
    await expect(anchorItem).toBeVisible({ timeout: 15000 })
    await expect(anchorItem).toBeDisabled({ timeout: 15000 })
  })
})
