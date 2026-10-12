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

/**
 * Edit-turn interaction shield: in edit mode the message content is native
 * `inert` (`display: contents`) and a sibling `[data-testid=edit-turn-cover]`
 * receives pointer/hover/right-click. A Playwright click on the inner
 * `[data-message-id]` node is intentionally no longer actionable, so edit
 * gestures target the cover at a truthfully hit-tested point (real
 * elementFromPoint, no force, no synthetic DOM click).
 *
 * Electron reality: `page.viewportSize()` is null (no Playwright viewport),
 * so the window size fallback is `window.innerWidth/innerHeight`. The
 * route-stable keeper compensates programmatic `scrollIntoViewIfNeeded`
 * (no interaction token), so visibility is established with genuine
 * `page.mouse.wheel` intent over `#messages` and remeasured immediately
 * before each click.
 */
type CoverGeom = {
  found: boolean
  turnAsk: string | null
  winW: number
  winH: number
  messageRect: { x: number; y: number; width: number; height: number } | null
  coverRect: { x: number; y: number; width: number; height: number } | null
  containerRect: { x: number; y: number; width: number; height: number } | null
  ok: boolean
  x: number
  y: number
  hitKind: string | null
  hitTurnAsk: string | null
}

async function readCoverGeom(page: Page, messageId: string): Promise<CoverGeom> {
  return page.evaluate((mid: string) => {
    const out: CoverGeom = {
      found: false,
      turnAsk: null,
      winW: window.innerWidth,
      winH: window.innerHeight,
      messageRect: null,
      coverRect: null,
      containerRect: null,
      ok: false,
      x: -1,
      y: -1,
      hitKind: null,
      hitTurnAsk: null
    }
    const msg = document.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
    const container = document.getElementById('messages') as HTMLElement | null
    if (!msg || !container) return out
    const turn = msg.closest('[data-testid="edit-turn"]') as HTMLElement | null
    if (!turn) return out
    const cover = turn.querySelector('[data-testid="edit-turn-cover"]') as HTMLElement | null
    if (!cover) return out
    out.found = true
    out.turnAsk = turn.getAttribute('data-turn-ask')
    const mr = msg.getBoundingClientRect()
    const cr = cover.getBoundingClientRect()
    const vr = container.getBoundingClientRect()
    out.messageRect = { x: mr.left, y: mr.top, width: mr.width, height: mr.height }
    out.coverRect = { x: cr.left, y: cr.top, width: cr.width, height: cr.height }
    out.containerRect = { x: vr.left, y: vr.top, width: vr.width, height: vr.height }
    // Visible intersection of message + cover + #messages viewport.
    const ix0 = Math.max(mr.left, cr.left, vr.left)
    const iy0 = Math.max(mr.top, cr.top, vr.top)
    const ix1 = Math.min(mr.right, cr.right, vr.right)
    const iy1 = Math.min(mr.bottom, cr.bottom, vr.bottom)
    if (ix1 - ix0 < 10 || iy1 - iy0 < 10) return out
    // Floating edit action-bar occlusion zone: union of edit-* buttons + margin.
    let barTop = Infinity
    let barBottom = -Infinity
    let barLeft = Infinity
    let barRight = -Infinity
    let hasBar = false
    for (const btn of Array.from(
      document.querySelectorAll(
        '[data-testid="edit-copy-btn"],[data-testid="edit-cut-btn"],[data-testid="edit-paste-btn"],[data-testid="edit-delete-btn"],[data-testid="edit-close-btn"]'
      )
    )) {
      const b = (btn as HTMLElement).getBoundingClientRect()
      if (b.width <= 0 || b.height <= 0) continue
      hasBar = true
      barTop = Math.min(barTop, b.top)
      barBottom = Math.max(barBottom, b.bottom)
      barLeft = Math.min(barLeft, b.left)
      barRight = Math.max(barRight, b.right)
    }
    const inBar = (x: number, y: number): boolean => {
      if (!hasBar) return false
      return x >= barLeft - 6 && x <= barRight + 6 && y >= barTop - 6 && y <= barBottom + 6
    }
    const cands: Array<{ x: number; y: number }> = []
    const insetX0 = ix0 + 5
    const insetX1 = ix1 - 5
    const insetY0 = iy0 + 5
    const insetY1 = iy1 - 5
    // Prefer vertical center-away-from-top-bar: middle rows first.
    for (const fy of [0.5, 0.65, 0.35, 0.8, 0.2]) {
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        cands.push({ x: insetX0 + (insetX1 - insetX0) * fx, y: insetY0 + (insetY1 - insetY0) * fy })
      }
    }
    for (const c of cands) {
      if (!(c.x >= 0 && c.y >= 0 && c.x < window.innerWidth && c.y < window.innerHeight)) continue
      if (inBar(c.x, c.y)) continue
      let hit: HTMLElement | null = null
      try {
        hit = document.elementFromPoint(c.x, c.y) as HTMLElement | null
      } catch {
        continue
      }
      if (!hit) continue
      const hitCover = hit.closest('[data-testid="edit-turn-cover"]') as HTMLElement | null
      const hitTurn = hit.closest('[data-testid="edit-turn"]') as HTMLElement | null
      const hitAsk = hitTurn?.getAttribute('data-turn-ask') ?? null
      out.hitKind = hitCover ? 'cover' : hitTurn ? 'turn' : hit.tagName
      out.hitTurnAsk = hitAsk
      if ((hitCover || hitTurn) && hitAsk === out.turnAsk) {
        out.ok = true
        out.x = c.x
        out.y = c.y
        return out
      }
    }
    return out
  }, messageId)
}

async function isCoverBoxStable(page: Page, messageId: string, tol = 2): Promise<boolean> {
  const frames: Array<{ x: number; y: number } | null> = await page.evaluate(
    (mid: string) =>
      new Promise<Array<{ x: number; y: number } | null>>((resolve) => {
        const read = (): { x: number; y: number } | null => {
          const msg = document.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
          if (!msg) return null
          const r = msg.getBoundingClientRect()
          return { x: r.left, y: r.top }
        }
        const acc: Array<{ x: number; y: number } | null> = []
        const step = (): void => {
          acc.push(read())
          if (acc.length < 3) {
            requestAnimationFrame(step)
            return
          }
          resolve(acc)
        }
        requestAnimationFrame(step)
      }),
    messageId
  )
  if (frames.some((f) => !f)) return false
  const xs = frames.map((f) => f!.x)
  const ys = frames.map((f) => f!.y)
  return Math.max(...xs) - Math.min(...xs) <= tol && Math.max(...ys) - Math.min(...ys) <= tol
}

async function wheelCoverIntoView(page: Page, messageId: string, maxSteps = 20): Promise<CoverGeom> {
  const focusMessages = async (): Promise<void> => {
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }
  const frameSettle = async (): Promise<void> => {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        })
    )
  }
  await focusMessages()
  let last: CoverGeom = await readCoverGeom(page, messageId)
  for (let i = 0; i < maxSteps; i++) {
    if (last.ok && (await isCoverBoxStable(page, messageId))) return last
    // Wheel direction follows the cover center relative to the container.
    let dy = 480
    if (last.coverRect && last.containerRect) {
      const mid = (last.coverRect.y + last.coverRect.height / 2) as number
      const cTop = last.containerRect.y
      const cBottom = last.containerRect.y + last.containerRect.height
      if (last.coverRect.y + last.coverRect.height <= cTop) dy = -480
      else if (last.coverRect.y >= cBottom) dy = 480
      else dy = mid < cTop + (cBottom - cTop) / 2 ? -240 : 240
    }
    await focusMessages()
    await page.mouse.wheel(0, dy)
    await frameSettle()
    last = await readCoverGeom(page, messageId)
  }
  if (last.ok && (await isCoverBoxStable(page, messageId))) return last
  return last
}

async function messageCoverPoint(page: Page, messageId: string): Promise<{ x: number; y: number }> {
  const sel = `[data-message-id="${messageId}"]`
  const message = page.locator(sel).first()
  await message.scrollIntoViewIfNeeded()
  await expect(message).toBeVisible({ timeout: 15000 })
  // Same ask-split assumption: one EditTurn owns this group and renders a
  // cover in edit mode. Fail here (not in production) if the wrapper changes.
  const turn = page.locator(`[data-testid="edit-turn"]:has(${sel})`).first()
  await expect(turn).toBeVisible({ timeout: 15000 })
  await expect(turn.locator('[data-testid="edit-turn-cover"]').first()).toBeVisible({ timeout: 15000 })
  // Genuine user-intent reveal: programmatic scroll may be restored by the
  // viewport keeper, so wheel over #messages and remeasure immediately.
  const settled = await wheelCoverIntoView(page, messageId)
  if (!settled.ok) {
    throw new Error(
      `[E2E] cover point not hit-testable for ${messageId}: ` +
        JSON.stringify({
          turnAsk: settled.turnAsk,
          win: { w: settled.winW, h: settled.winH },
          messageRect: settled.messageRect,
          coverRect: settled.coverRect,
          containerRect: settled.containerRect,
          hitKind: settled.hitKind,
          hitTurnAsk: settled.hitTurnAsk
        })
    )
  }
  if (!(settled.x >= 0 && settled.y >= 0 && settled.x < settled.winW && settled.y < settled.winH)) {
    throw new Error(`[E2E] cover point outside window for ${messageId}: (${settled.x},${settled.y})`)
  }
  return { x: settled.x, y: settled.y }
}

async function clickGroup(page: Page, messageId: string, modifiers?: { shift?: boolean }): Promise<void> {
  const point = await messageCoverPoint(page, messageId)
  if (modifiers?.shift) {
    await page.keyboard.down('Shift')
    try {
      await page.mouse.click(point.x, point.y)
    } finally {
      await page.keyboard.up('Shift')
    }
  } else {
    await page.mouse.click(point.x, point.y)
  }
}

async function selectedGroups(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as { store: { getState: () => { editMode: { selectedGroupIds: string[] } } } }
    return win.store.getState().editMode.selectedGroupIds
  })
}

async function openEditMenu(page: Page, messageId: string): Promise<void> {
  const point = await messageCoverPoint(page, messageId)
  await page.mouse.click(point.x, point.y, { button: 'right' })
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
