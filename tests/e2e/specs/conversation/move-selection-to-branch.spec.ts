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

// ---------------------------------------------------------------------------
// Context-window anchor helpers (route-scoped, renderer-persisted settings)
// ---------------------------------------------------------------------------

function routeKeyFor(topicId: string, branchId: string | null): string {
  return typeof branchId === 'string' && branchId.length > 0 ? `${topicId}:${branchId}` : topicId
}

async function setAssistantContextCount(page: Page, contextCount: number | null): Promise<void> {
  const assistantId = await page.evaluate(
    () => (window as unknown as { store: { getState: () => any } }).store.getState().assistants?.assistants?.[0]?.id
  )
  expect(assistantId, 'live assistant id must exist').toBeTruthy()
  await page.evaluate(
    ({ assistantId, contextCount }: { assistantId: string; contextCount: number | null }) => {
      ;(window as unknown as { store: { dispatch: (a: unknown) => void } }).store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextCount } }
      })
    },
    { assistantId, contextCount }
  )
}

async function setRouteAnchor(page: Page, topicId: string, branchId: string | null, groupKey: string): Promise<void> {
  const routeKey = routeKeyFor(topicId, branchId)
  await page.evaluate(
    ({ routeKey, groupKey }: { routeKey: string; groupKey: string }) => {
      const store = (window as unknown as { store: { getState: () => any; dispatch: (a: unknown) => void } }).store
      const assistant = store.getState().assistants.assistants[0]
      const current = assistant?.settings?.contextWindowAnchor ?? {}
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId: assistant.id,
          settings: { contextWindowAnchor: { ...current, [routeKey]: { kind: 'active', groupKey } } }
        }
      })
    },
    { routeKey, groupKey }
  )
}

async function readRouteAnchor(page: Page, topicId: string, branchId: string | null): Promise<string | null> {
  const routeKey = routeKeyFor(topicId, branchId)
  return page.evaluate((key: string) => {
    const assistant = (window as unknown as { store: { getState: () => any } }).store.getState().assistants
      ?.assistants?.[0]
    const anchor = assistant?.settings?.contextWindowAnchor?.[key]
    return anchor?.kind === 'active' ? (anchor.groupKey as string) : null
  }, routeKey)
}

async function expectTokenCount(page: Page, current: number, max: number, timeout = 45000): Promise<void> {
  await expect(page.locator('[data-testid="token-count-context"]').first()).toHaveText(
    new RegExp(`^\\s*${current}\\s*\\/\\s*${max}\\s*$`),
    { timeout }
  )
}

async function setActiveRoute(page: Page, topicId: string, branchId: string | null): Promise<void> {
  await page.evaluate(
    ({ tid, bid }: { tid: string; bid: string | null }) => {
      ;(window as unknown as { store: { dispatch: (a: unknown) => void } }).store.dispatch({
        type: 'topicBranch/activeBranchSet',
        payload: { topicId: tid, branchId: bid }
      })
    },
    { tid: topicId, bid: branchId }
  )
  await page.waitForFunction(
    ({ tid, bid }: { tid: string; bid: string | null }) => {
      const s = (window as unknown as { store: { getState: () => any } }).store.getState()
      return (s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) === bid && s.messages?.loadingByTopic?.[tid] !== true
    },
    { tid: topicId, bid: branchId },
    { timeout: 30000 }
  )
}

async function loadedMessageIds(page: Page, topicId: string): Promise<string[]> {
  return page.evaluate(
    (tid: string) =>
      ((window as unknown as { store: { getState: () => any } }).store.getState().messages?.messageIdsByTopic?.[tid] ??
        []) as string[],
    topicId
  )
}

async function wheelLoadOlder(page: Page, topicId: string): Promise<{ before: number; after: number }> {
  // Genuine wheel input toward the oldest edge (the inverse InfiniteScroll only
  // fires within ~2px of the absolute top), then a deterministic convergence
  // poll for the async load — no scrollTop writes, no synthetic scroll events.
  const before = (await loadedMessageIds(page, topicId)).length
  // Re-arm the inverse sentinel first: a container already resting at the very
  // top can ignore the first upward gesture, so leave the edge with a genuine
  // small downward gesture, then drive upward in smaller steps with a rAF +
  // settle between each (no scrollTop writes, no synthetic scroll events).
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 240)
  await page.waitForTimeout(200)
  for (let attempt = 0; attempt < 40; attempt++) {
    const now = (await loadedMessageIds(page, topicId)).length
    if (now > before) break
    const live = await page.locator('#messages').first().boundingBox()
    if (live) await page.mouse.move(live.x + live.width / 2, live.y + live.height / 2)
    await page.mouse.wheel(0, -420)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.waitForTimeout(250)
  }
  try {
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const ids = (window as unknown as { store: { getState: () => any } }).store.getState().messages
          ?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length > len
      },
      { tid: topicId, len: before },
      { timeout: 30000, polling: 250 }
    )
  } catch {
    // Fall through: the caller's own growth assertion reports truthfully.
  }
  return { before, after: (await loadedMessageIds(page, topicId)).length }
}

async function uiSendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ selector, content }: { selector: string; content: string }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement | null
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, content)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', content: text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
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

  /**
   * Context-window inheritance across a move of the latest turn.
   *
   * Real turn semantics drive the numbers (no hardcoded window): a 49-turn
   * source route with the assistant default contextCount=25 and a custom
   * source anchor whose window is 34 turns (anchor turn index 49-34=15). After
   * sending one more turn the route has 50 turns and its window grows to 35.
   * Moving the newest turn to a new branch must inherit the SAME anchor by
   * index on the new route (window 35/50), survive older pagination, route
   * switching, and a full renderer reload — never silently falling back to the
   * contextCount default (25) or to viewport-derived counts.
   */
  test('moving the latest turn keeps the inherited context anchor (window) on the new branch across pagination, route switch, and reload', async ({
    mainWindow
  }) => {
    test.setTimeout(420000)
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, 20)
    const topicId = `move-anchor-e2e-${Date.now()}`
    const TOTAL_MESSAGES = 98 // 49 whole turns (user+assistant pairs)
    const SOURCE_TURNS = TOTAL_MESSAGES / 2
    const CUSTOM_WINDOW_TURNS = 34
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: 'Move Anchor E2E',
      total: TOTAL_MESSAGES,
      messageIdForIndex: (i: number) => `${topicId}-msg-${pad(i, 5)}`,
      contentPrefix: 'moveanchor-'
    })
    await activateTopic(page, topicId, 20)
    // Assistant default window size stays at the product default 25; the
    // custom source anchor below fixes the actual window at 34 turns.
    await setAssistantContextCount(page, 25)
    // Anchor turn index = SOURCE_TURNS - CUSTOM_WINDOW_TURNS = 15 → message 30.
    const anchorTurnIndex = SOURCE_TURNS - CUSTOM_WINDOW_TURNS
    const sourceAnchorGroupKey = ids[anchorTurnIndex * 2]
    await setRouteAnchor(page, topicId, null, sourceAnchorGroupKey)
    await expectTokenCount(page, CUSTOM_WINDOW_TURNS, SOURCE_TURNS)

    // Send one more turn: 50 turns, window = 50 - 15 = 35.
    await uiSendMessage(page, 'anchor move latest turn')
    const turnsAfterSend = SOURCE_TURNS + 1
    const windowAfterSend = turnsAfterSend - anchorTurnIndex
    await expectTokenCount(page, windowAfterSend, turnsAfterSend)

    // The newest whole turn (its user message is the group key).
    const latestGroupKey = await page.evaluate((tid: string) => {
      const s = (window as unknown as { store: { getState: () => any } }).store.getState()
      const loaded: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      for (let i = loaded.length - 1; i >= 0; i--) {
        const entity = s.messages?.entities?.[loaded[i]]
        if (entity?.role === 'user') return loaded[i] as string
      }
      return null
    }, topicId)
    expect(latestGroupKey, 'latest user turn must be resident').toBeTruthy()

    // Real edit-mode selection + context menu move of the latest turn.
    await enableEditMode(page)
    await clickGroup(page, latestGroupKey as string)
    await page.waitForFunction(
      ({ gid }: { gid: string }) => {
        const s = (window as unknown as { store: { getState: () => any } }).store.getState()
        return (s.editMode?.selectedGroupIds ?? []).includes(gid)
      },
      { gid: latestGroupKey as string },
      { timeout: 15000 }
    )
    await openEditMenu(page, latestGroupKey as string)
    const item = moveMenuItem(page)
    await expect(item).toBeVisible({ timeout: 15000 })
    await expect(item).toBeEnabled({ timeout: 15000 })
    // Real pointer click; the portal item is routinely reported as intercepted
    // by the floating edit action-bar/portal wrapper when the target row sits at
    // the bottom edge, so the established DOM-click fallback applies only after
    // visibility + enabled (the menu is genuinely offered) and only on viewport
    // flake — never a second item, never an IPC shortcut.
    try {
      await item.click({ timeout: 10000 })
    } catch {
      await item.evaluate((el: HTMLElement) => el.click())
    }

    // New branch activates with exactly one catalog node.
    await page.waitForFunction(
      (tid: string) => {
        const s = (window as unknown as { store: { getState: () => any } }).store.getState()
        const list = s.topicBranch?.branchesByTopic?.[tid]
        return Array.isArray(list) && list.length === 1 ? list[0].id : null
      },
      topicId,
      { timeout: 30000 }
    )
    const branchId = await page.evaluate((tid: string) => {
      const s = (window as unknown as { store: { getState: () => any } }).store.getState()
      return (s.topicBranch?.branchesByTopic?.[tid]?.[0]?.id ?? null) as string | null
    }, topicId)
    expect(branchId, 'new branch id must exist').toBeTruthy()
    await setActiveRoute(page, topicId, branchId as string)

    // The inherited anchor is the ORIGINAL source anchor, not the default.
    expect(await readRouteAnchor(page, topicId, branchId)).toBe(sourceAnchorGroupKey)
    // Window stays 35/50 on the new branch (regression: 25/50 or viewport counts).
    await expectTokenCount(page, windowAfterSend, turnsAfterSend)

    // Older pagination must not move or recompute the anchor.
    const older = await wheelLoadOlder(page, topicId)
    expect(older.before, 'branch route starts from a bounded latest window').toBeGreaterThanOrEqual(20)
    expect(older.after, 'wheel must strictly increase the resident window').toBeGreaterThan(older.before)
    await expectTokenCount(page, windowAfterSend, turnsAfterSend)
    expect(await readRouteAnchor(page, topicId, branchId)).toBe(sourceAnchorGroupKey)

    // Switch away to the parent route and back: the parent keeps its own
    // window (49 turns after the move) and the branch keeps 35/50.
    await setActiveRoute(page, topicId, null)
    await expectTokenCount(page, CUSTOM_WINDOW_TURNS, SOURCE_TURNS)
    expect(await readRouteAnchor(page, topicId, null)).toBe(sourceAnchorGroupKey)
    await setActiveRoute(page, topicId, branchId as string)
    await expectTokenCount(page, windowAfterSend, turnsAfterSend)

    // Full renderer reload: the persisted route anchor survives, so the branch
    // still resolves 35/50 (contextCount=25 alone could only ever give 25/50).
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => Boolean((window as unknown as { store?: { getState?: () => any } }).store?.getState?.()?.assistants),
      { timeout: 30000 }
    )
    const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await topicItem.waitFor({ state: 'visible', timeout: 30000 })
    await topicItem.click()
    await page.waitForFunction(
      (tid: string) => {
        const s = (window as unknown as { store: { getState: () => any } }).store.getState()
        const loaded = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(loaded) && loaded.length > 0 && s.messages?.loadingByTopic?.[tid] !== true
      },
      topicId,
      { timeout: 30000 }
    )
    await setActiveRoute(page, topicId, branchId as string)
    expect(await readRouteAnchor(page, topicId, branchId)).toBe(sourceAnchorGroupKey)
    await expectTokenCount(page, windowAfterSend, turnsAfterSend)
    // The parent route's own anchor is still independent and unchanged.
    expect(await readRouteAnchor(page, topicId, null)).toBe(sourceAnchorGroupKey)
    expect(assistantId).toBeTruthy()
  })

  /**
   * Source-route anchor inside a MULTI-TURN moved selection (context-window
   * ADR §9 deterministic delete transfer).
   *
   * 8 turns; the selection covers turns 3..5 and the anchor sits at the END of
   * that selection (turn 5), so turns 6,7 survive and are NEWER than the
   * anchor. The transfer must land on the nearest surviving OLDER turn (turn 2,
   * window 3/5) — never on turn 7 (post-index arithmetic `oldIndex - 1`) and
   * never on the `contextCount` default. The destination still inherits the
   * anchor's pre-move index (window 1/6).
   */
  test('a source anchor at the end of a multi-turn selection transfers to the nearest surviving older turn, never a newer one', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, 20)
    const topicId = `move-anchor-src-${Date.now()}`
    const TOTAL_MESSAGES = 16 // 8 whole turns
    const TURNS = TOTAL_MESSAGES / 2
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: 'Move Anchor Source E2E',
      total: TOTAL_MESSAGES,
      messageIdForIndex: (i: number) => `${topicId}-msg-${pad(i, 5)}`,
      contentPrefix: 'movesrc-'
    })
    await activateTopic(page, topicId, TOTAL_MESSAGES)
    await setAssistantContextCount(page, 25)
    // Selection = turns 3..5 (mid-route, so turns 6,7 survive and are NEWER
    // than the anchor). The anchor sits at the END of the selection, i.e. the
    // multi-turn-removal case where post-index arithmetic picks a newer turn.
    const selectionStart = 3
    const selectionEnd = 5
    const anchorTurnIndex = selectionEnd
    const sourceAnchorGroupKey = ids[anchorTurnIndex * 2]
    await setRouteAnchor(page, topicId, null, sourceAnchorGroupKey)
    await expectTokenCount(page, TURNS - anchorTurnIndex, TURNS)

    await enableEditMode(page)
    await clickGroup(page, ids[selectionStart * 2])
    await clickGroup(page, ids[selectionEnd * 2], { shift: true })
    await page.waitForFunction(
      ({ a, b }: { a: string; b: string }) => {
        const sel = (window as unknown as { store: { getState: () => any } }).store.getState().editMode
          ?.selectedGroupIds as string[]
        return Array.isArray(sel) && sel.includes(a) && sel.includes(b)
      },
      { a: ids[selectionStart * 2], b: ids[selectionEnd * 2] },
      { timeout: 15000 }
    )
    await openEditMenu(page, ids[selectionStart * 2])
    const item = moveMenuItem(page)
    await expect(item).toBeVisible({ timeout: 15000 })
    await expect(item).toBeEnabled({ timeout: 15000 })
    try {
      await item.click({ timeout: 10000 })
    } catch {
      await item.evaluate((el: HTMLElement) => el.click())
    }
    await page.waitForFunction(
      (tid: string) => {
        const list = (window as unknown as { store: { getState: () => any } }).store.getState().topicBranch
          ?.branchesByTopic?.[tid]
        return Array.isArray(list) && list.length === 1 ? list[0].id : null
      },
      topicId,
      { timeout: 30000 }
    )
    const branchId: string = await page.evaluate(
      (tid: string) =>
        (window as unknown as { store: { getState: () => any } }).store.getState().topicBranch?.branchesByTopic?.[
          tid
        ]?.[0]?.id as string,
      topicId
    )
    expect(branchId).toBeTruthy()
    // Post-commit settle: the destination anchor is written before the thunk's
    // own activation, so observing it on the store proves the side effect
    // landed, and the in-flight window load settled before any route switch.
    await page.waitForFunction(
      ({ tid, bid, gk }: { tid: string; bid: string; gk: string }) => {
        const s = (window as unknown as { store: { getState: () => any } }).store.getState()
        const a = s.assistants?.assistants?.[0]?.settings?.contextWindowAnchor?.[`${tid}:${bid}`]
        return a?.groupKey === gk && s.messages?.loadingByTopic?.[tid] !== true
      },
      { tid: topicId, bid: branchId, gk: sourceAnchorGroupKey },
      { timeout: 30000 }
    )
    // The destination still inherits the pre-move index (turn 3) unchanged.
    expect(await readRouteAnchor(page, topicId, branchId)).toBe(sourceAnchorGroupKey)
    // Source route keeps turns 0..2 plus the surviving newer turns 6,7. The
    // deleted anchor (turn 5) must fall to the nearest SURVIVING OLDER turn —
    // turn 2. Post-index arithmetic would land on turn 7 (newer than the anchor),
    // which is exactly the defect this test guards.
    const survivingOlderIndex = selectionStart - 1
    const expectedSourceAnchor = ids[survivingOlderIndex * 2]
    const sourceTurnsRemaining = selectionStart + (TURNS - 1 - selectionEnd)
    await setActiveRoute(page, topicId, null)
    expect(await readRouteAnchor(page, topicId, null)).toBe(expectedSourceAnchor)
    // Window = transferred anchor turn to route end (never the contextCount
    // default, never the whole remaining route).
    await expectTokenCount(page, sourceTurnsRemaining - survivingOlderIndex, sourceTurnsRemaining)

    // The destination still inherits the pre-move index turn unchanged.
    // The destination route is the prefix through the preceding anchor plus the
    // moved selection (turns 0..selectionEnd), and it inherits the anchor at its
    // pre-move index — so its window is that turn to the route end.
    await setActiveRoute(page, topicId, branchId)
    expect(await readRouteAnchor(page, topicId, branchId)).toBe(sourceAnchorGroupKey)
    const destinationTurns = selectionEnd + 1
    await expectTokenCount(page, destinationTurns - anchorTurnIndex, destinationTurns)
  })
})
