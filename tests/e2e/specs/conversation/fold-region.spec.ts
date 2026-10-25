/**
 * Fold expand/compress interaction-region stationary E2E (non-editor proof
 * of the shared region mechanism).
 *
 * The fold DisplayModeToggle lives OUTSIDE any single message row (group
 * scope) and its activation re-lays-out the whole group (compact avatar
 * strip ↔ expanded segmented list). The shared controller/keeper must keep
 * the toggle's viewport geometry stationary through both directions with
 * the pointer still hitting the toggle on every painted frame — via the
 * same scope+region+fingerprint+quiet gate as edits and tabs, never a
 * fold-dedicated compensator. A round trip must restore the stable route
 * snapshot (click→restore).
 *
 * Seams (existing only): #messages, [data-message-id],
 * [data-testid="fold-display-mode-toggle"], [data-stable-group-id],
 * .avatar-group/.segmented-list (mode proof), window.store,
 * window.api.chatDb (seed), window.keyv scroll snapshot (supporting only).
 * All actions go through the real UI (topic click, hover, physical pointer
 * click at recorded points, wheel). No direct state dispatch, no
 * scrollToBottom, no scrollTop writes.
 *
 * Geometry: #messages renders column-reverse (bottom/newest scrollTop ~= 0).
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const DISPLAY_COUNT = 10
const BOTTOM_TOL = 100
const OFFSET_TOL = 12
const REGION_TOL = 2
const TRANSITION_TOL = 4
const NON_BOTTOM_MIN = 300

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

interface Rect {
  x: number
  y: number
  top: number
  bottom: number
  left: number
  right: number
  width: number
  height: number
}

interface FoldGeometry {
  toggleCenter: { x: number; y: number }
  toggleOffset: number
  toggleRect: Rect
  containerRect: { top: number; bottom: number; height: number }
}

async function ensureDisplayCount(page: Page, limit: number): Promise<void> {
  await page.evaluate((value: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: value })
  }, limit)
  const displayOk = await page.evaluate(() => (window as any).store.getState().messages.displayCount)
  expect(displayOk).toBe(limit)
}

async function getLiveAssistantId(page: Page): Promise<string> {
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

/**
 * Seed: 3 single rounds + mid-topic user ask + TWO mid-topic assistant
 * answers sharing the ask (one fold group, first fold-selected) + 3 single
 * rounds. Total 15 authority rows. Mid-topic placement lets a verified
 * non-bottom viewport fully contain the group menu bar, so every toggle
 * click is a real physical pointer click with no test-induced auto-scroll.
 */
function buildFoldRegionEntries(topicId: string, assistantId: string) {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const stamp = '2026-01-01T00:00:00.000Z'
  const push = (index: number, role: string, content: string, extra: Record<string, unknown> = {}) => {
    const msgId = `${topicId}-msg-${pad(index, 5)}`
    const blockId = `${topicId}-block-${pad(index, 5)}`
    entries.push({
      message: {
        id: msgId,
        topicId,
        role,
        assistantId,
        createdAt: stamp,
        updatedAt: stamp,
        status: 'success',
        blocks: [blockId],
        sortOrder: index,
        ...extra
      },
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content,
          status: 'success',
          createdAt: stamp,
          updatedAt: stamp
        }
      ]
    })
    return msgId
  }
  for (let round = 0; round < 3; round++) {
    const userIndex = round * 2
    const assistantIndex = round * 2 + 1
    const userId = push(userIndex, 'user', `fr-fill-user-${round} ${'filler words '.repeat(30)}`)
    push(assistantIndex, 'assistant', `fr-fill-assistant-${round} ${'filler words '.repeat(30)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  const askId = push(6, 'user', `fr-target-ask ${'filler words '.repeat(10)}`)
  const firstAssistantId = push(
    7,
    'assistant',
    `fr-target-first\n\n${Array.from({ length: 8 }, (_, i) => `first paragraph ${pad(i, 3)} in-flow filler words`).join('\n\n')}`,
    {
      askId,
      foldSelected: true,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    }
  )
  const secondAssistantId = push(
    8,
    'assistant',
    `fr-target-second\n\n${Array.from({ length: 8 }, (_, i) => `second paragraph ${pad(i, 3)} in-flow filler words`).join('\n\n')}`,
    {
      askId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    }
  )
  for (let round = 3; round < 6; round++) {
    const userIndex = round * 2 + 3
    const assistantIndex = round * 2 + 4
    const userId = push(userIndex, 'user', `fr-fill-user-${round} ${'filler words '.repeat(30)}`)
    push(assistantIndex, 'assistant', `fr-fill-assistant-${round} ${'filler words '.repeat(30)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  return { entries, firstAssistantId, secondAssistantId }
}

async function seedTopicViaMainAuthority(
  page: Page,
  liveAssistantId: string,
  topicId: string,
  entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
): Promise<void> {
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
    { topicId, assistantId: liveAssistantId, name: `FoldRegion ${topicId}` }
  )
  expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)
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
      entries: unknown
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
    { topicId, assistantId: liveAssistantId, name: `FoldRegion ${topicId}`, entries }
  )
  expect(persist.ok, `Main authority seed failed: ${(persist as any).err}`).toBe(true)
}

async function activateTopicCold(page: Page, topicId: string, tailIds: string[]): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId, tailIds, minLoaded }: { topicId: string; tailIds: string[]; minLoaded: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      if (!Array.isArray(ids)) return false
      if (loading === true) return false
      if (ids.length < minLoaded) return false
      return tailIds.every((id) => ids.includes(id))
    },
    { topicId, tailIds, minLoaded: DISPLAY_COUNT },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (atLeast: number) => document.querySelectorAll('#messages [data-message-id]').length >= atLeast,
    DISPLAY_COUNT,
    { timeout: 30000 }
  )
}

async function setupFoldRegionTopic(page: Page): Promise<{ topicId: string; firstAssistantId: string }> {
  await ensureDisplayCount(page, DISPLAY_COUNT)
  const liveAssistantId = await getLiveAssistantId(page)
  const topicId = `fr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const built = buildFoldRegionEntries(topicId, liveAssistantId)
  await seedTopicViaMainAuthority(page, liveAssistantId, topicId, built.entries)
  await activateTopicCold(page, topicId, [built.firstAssistantId, built.secondAssistantId])
  const loaded = await page.evaluate(
    (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])] as string[],
    topicId
  )
  expect(loaded.length).toBeGreaterThanOrEqual(DISPLAY_COUNT)
  expect(loaded).toContain(built.firstAssistantId)
  return { topicId, firstAssistantId: built.firstAssistantId }
}

async function readScroll(page: Page): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return page.evaluate(() => {
    const el = document.getElementById('messages') as HTMLElement | null
    if (!el) throw new Error('#messages not found')
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
}

async function readAnchor(page: Page): Promise<{ id: string; offset: number } | null> {
  return page.evaluate(() => {
    const container = document.querySelector('#messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const rows = Array.from(
      document.querySelectorAll('#messages [data-message-id]:not([data-testid="answer-group-selector"])')
    ) as HTMLElement[]
    if (rows.length === 0) return null
    const crossing =
      rows
        .map((row) => ({ id: row.getAttribute('data-message-id') as string, r: row.getBoundingClientRect() }))
        .find((x) => x.r.top <= c.top && x.r.bottom > c.top) ?? null
    const picked =
      crossing ??
      rows
        .map((row) => ({ id: row.getAttribute('data-message-id') as string, r: row.getBoundingClientRect() }))
        .filter((x) => x.r.top >= c.top)
        .sort((a, b) => a.r.top - b.r.top)[0]
    if (!picked) return null
    return { id: picked.id, offset: picked.r.top - c.top }
  })
}

async function settledAnchor(page: Page): Promise<{ id: string; offset: number }> {
  let prev: { id: string; offset: number } | null = null
  let stable = 0
  const start = Date.now()
  let cur: { id: string; offset: number } | null = null
  while (Date.now() - start < 10000) {
    cur = await readAnchor(page)
    if (cur && prev && cur.id === prev.id && Math.abs(cur.offset - prev.offset) <= 2) {
      stable += 1
      if (stable >= 2) return cur
    } else {
      stable = 0
    }
    prev = cur
    await page.waitForTimeout(140)
  }
  throw new Error(`viewport failed to settle (last=${cur ? `${cur.id}@${cur.offset}` : 'null'})`)
}

async function wheelToReadingPosition(page: Page): Promise<{ scrollTop: number }> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const probe = () =>
    page.evaluate((minOff: number) => {
      const c = document.getElementById('messages') as HTMLElement | null
      if (!c) return { ok: false, st: NaN }
      const topExtreme = -(c.scrollHeight - c.clientHeight)
      const st = c.scrollTop
      return { ok: Math.abs(st) > minOff && Math.abs(st - topExtreme) > 200, st }
    }, NON_BOTTOM_MIN)
  for (let i = 0; i < 30; i++) {
    if ((await probe()).ok) break
    await page.mouse.wheel(0, -560)
    await page.waitForTimeout(220)
  }
  if (!(await probe()).ok) {
    for (let i = 0; i < 30; i++) {
      if ((await probe()).ok) break
      await page.mouse.wheel(0, 560)
      await page.waitForTimeout(220)
    }
  }
  const reached = await probe()
  expect(reached.ok, `must reach a verified non-bottom reading position (st=${reached.st})`).toBe(true)
  await settledAnchor(page)
  return { scrollTop: (await readScroll(page)).scrollTop }
}

function escId(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Current fold display mode proven from the live list structure. */
async function readFoldMode(page: Page): Promise<'expanded' | 'compact' | null> {
  return page
    .evaluate(() => {
      const toggle = document.querySelector('[data-testid="fold-display-mode-toggle"]') as HTMLElement | null
      if (!toggle) return null
      const scope =
        (toggle.closest('[data-stable-group-id]') as HTMLElement | null) ?? (document as unknown as HTMLElement)
      if (scope.querySelector('.segmented-list')) return 'expanded'
      if (scope.querySelector('.avatar-group')) return 'compact'
      return null
    })
    .catch(() => null)
}

async function captureToggleGeometry(page: Page): Promise<FoldGeometry> {
  return page.evaluate(() => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) throw new Error('#messages not found')
    const c = container.getBoundingClientRect()
    const toggle = document.querySelector('[data-testid="fold-display-mode-toggle"]') as HTMLElement | null
    if (!toggle) throw new Error('fold toggle not found')
    const tr = toggle.getBoundingClientRect()
    if (!(tr.width > 0 && tr.height > 0)) throw new Error('fold toggle has no box')
    const norm = (r: DOMRect) => ({
      x: r.x,
      y: r.y,
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height
    })
    return {
      toggleCenter: { x: tr.x + tr.width / 2, y: tr.y + tr.height / 2 },
      toggleOffset: tr.top - c.top,
      toggleRect: norm(tr),
      containerRect: { top: c.top, bottom: c.bottom, height: c.height }
    }
  })
}

async function readToggleOffset(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return NaN
      const toggle = document.querySelector('[data-testid="fold-display-mode-toggle"]') as HTMLElement | null
      if (!toggle) return NaN
      return toggle.getBoundingClientRect().top - container.getBoundingClientRect().top
    })
    .catch(() => NaN)
}

/** elementFromPoint at a screen point must still resolve to the fold toggle. */
async function hitTestToggleAtPoint(page: Page, point: { x: number; y: number }): Promise<boolean> {
  return page.evaluate(
    ({ x, y }: { x: number; y: number }) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      if (!hit) return false
      if (typeof hit.closest !== 'function') return false
      return !!hit.closest('[data-testid="fold-display-mode-toggle"]')
    },
    { x: point.x, y: point.y }
  )
}

async function readRouteSnapshot(page: Page, topicId: string): Promise<unknown> {
  return page
    .evaluate((tid: string) => {
      try {
        const keyv = (window as any).keyv
        const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
        for (const key of keys) {
          const val = keyv?.get?.(key) ?? null
          if (val && typeof val === 'object' && 'isAtBottom' in (val as Record<string, unknown>)) return val
        }
        return null
      } catch {
        return null
      }
    }, topicId)
    .catch(() => null)
}

async function waitForScrollQuiescence(page: Page): Promise<number> {
  let last = (await readScroll(page)).scrollTop
  const start = Date.now()
  while (Date.now() - start < 8000) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.waitForTimeout(350)
    const cur = (await readScroll(page)).scrollTop
    if (Math.abs(cur - last) <= 8) return cur
    last = cur
  }
  throw new Error(`scroll never reached quiescence (last=${last})`)
}

/** Toggle must sit fully inside #messages so the click causes no auto-scroll. */
async function isToggleInViewport(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return false
    const c = container.getBoundingClientRect()
    const toggle = document.querySelector('[data-testid="fold-display-mode-toggle"]') as HTMLElement | null
    if (!toggle) return false
    const r = toggle.getBoundingClientRect()
    return r.top >= c.top && r.bottom <= c.bottom && r.width > 0 && r.height > 0
  })
}

async function wheelUntilToggleVisible(page: Page, firstAssistantId: string): Promise<void> {
  await wheelToReadingPosition(page)
  const row = page.locator(`#message-${escId(firstAssistantId)}[data-message-id="${escId(firstAssistantId)}"]`).first()
  await row.hover().catch(() => {})
  if (await isToggleInViewport(page)) {
    const fresh = await readScroll(page)
    expect(Math.abs(fresh.scrollTop), 'fold target must stay non-bottom').toBeGreaterThan(NON_BOTTOM_MIN)
    return
  }
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, 280)
    await page.waitForTimeout(220)
    const scroll = await readScroll(page)
    if (Math.abs(scroll.scrollTop) <= NON_BOTTOM_MIN) break
    await row.hover().catch(() => {})
    if (await isToggleInViewport(page)) {
      const fresh = await readScroll(page)
      expect(Math.abs(fresh.scrollTop), 'nudge to reveal toggle must stay non-bottom').toBeGreaterThan(NON_BOTTOM_MIN)
      await settledAnchor(page)
      return
    }
  }
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -280)
    await page.waitForTimeout(220)
    const scroll = await readScroll(page)
    if (Math.abs(scroll.scrollTop) <= NON_BOTTOM_MIN) break
    await row.hover().catch(() => {})
    if (await isToggleInViewport(page)) {
      const fresh = await readScroll(page)
      expect(Math.abs(fresh.scrollTop), 'nudge to reveal toggle must stay non-bottom').toBeGreaterThan(NON_BOTTOM_MIN)
      await settledAnchor(page)
      return
    }
  }
  expect(await isToggleInViewport(page), 'fold toggle must be reachable at a non-bottom reading position').toBe(true)
}

test.describe('Fold expand/compress interaction-region stationary', () => {
  test.setTimeout(300000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('fold expand then compress keeps the toggle region stationary and restores the snapshot', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'FOLD REGION ROUND TRIP: from a verified non-bottom reading viewport with the group expand/compress toggle fully in-viewport, a real physical pointer click must keep the SAME toggle interaction region at its previous viewport geometry with the stationary pointer still hitting the toggle — in BOTH directions (expand→compress or compress→expand from the live default) — never jumping. Painted transition frames sampled from BEFORE each click through settle; final collapse must restore the pre-expand stable route snapshot (click→restore).'
    })
    const page: Page = mainWindow
    const { topicId, firstAssistantId } = await test.step('seed mid-topic fold group and cold-activate', async () =>
      setupFoldRegionTopic(page))
    await test.step('wheel to a verified non-bottom reading position with toggle visible', async () =>
      wheelUntilToggleVisible(page, firstAssistantId))
    const preReading = await readScroll(page)
    const preSnap = await readRouteSnapshot(page, topicId)
    const preMode = await readFoldMode(page)
    expect(preMode, 'fold display mode must be provable before the round trip').not.toBeNull()
    const pre = await captureToggleGeometry(page)
    const point = { ...pre.toggleCenter }
    expect(await hitTestToggleAtPoint(page, point), 'precondition: click point hits the fold toggle').toBe(true)

    const clickDirectionAndTrack = async (
      label: string,
      referenceOffset: number
    ): Promise<{ geom: FoldGeometry; worst: number; mode: 'expanded' | 'compact' | null }> => {
      // Read the mode BEFORE the click: the flip commits asynchronously, so
      // a post-click read cannot serve as the baseline.
      const startMode = await readFoldMode(page)
      expect(startMode, `${label}: mode must be provable before the click`).not.toBeNull()
      const samples: number[] = [0]
      await page.mouse.click(point.x, point.y)
      let flippedMode: 'expanded' | 'compact' | null = null
      let settledExtra = 0
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        )
        const cur = await readToggleOffset(page)
        if (Number.isFinite(cur)) samples.push(Math.abs(cur - referenceOffset))
        const mode = await readFoldMode(page).catch(() => null)
        if (mode !== null && mode !== startMode) {
          flippedMode = mode
          settledExtra += 1
          if (settledExtra >= 4) break
        } else {
          settledExtra = 0
        }
      }
      expect(flippedMode, `${label}: fold display mode must flip after the real toggle click`).not.toBeNull()
      const worst = samples.length > 0 ? Math.max(...samples) : Number.NaN
      await waitForScrollQuiescence(page)
      const geom = await captureToggleGeometry(page)
      return { geom, worst, mode: await readFoldMode(page) }
    }

    // Direction 1: whatever the live default is, flip once.
    const first = await test.step('first toggle direction keeps the region stationary', async () =>
      clickDirectionAndTrack('expand/compress-1', pre.toggleOffset))
    const firstDrift = Math.abs(first.geom.toggleOffset - pre.toggleOffset)
    const firstHit = await hitTestToggleAtPoint(page, point)
    console.log(
      `[E2E] fold-1 preOff=${Math.round(pre.toggleOffset)} postOff=${Math.round(first.geom.toggleOffset)} drift=${firstDrift.toFixed(1)} hit=${firstHit} worst=${Number.isFinite(first.worst) ? first.worst.toFixed(1) : 'NaN'} preScroll=${Math.round(preReading.scrollTop)} mode=${preMode}->${first.mode}`
    )
    test.info().annotations.push({
      type: 'fold-1-geometry',
      description: `preOff=${Math.round(pre.toggleOffset)} postOff=${Math.round(first.geom.toggleOffset)} drift=${firstDrift.toFixed(1)} hit=${firstHit} worst=${Number.isFinite(first.worst) ? first.worst.toFixed(1) : 'NaN'} n/a preScroll=${Math.round(preReading.scrollTop)} mode=${preMode}->${first.mode}`
    })
    expect(
      firstDrift,
      'fold direction 1: toggle interaction region stays at its previous viewport offset'
    ).toBeLessThanOrEqual(REGION_TOL)
    expect(firstHit, 'fold direction 1: stationary pointer still hits the toggle').toBe(true)
    expect(first.worst, 'fold direction 1: painted transition frames never jump').toBeLessThanOrEqual(TRANSITION_TOL)

    // Direction 2: flip back. The pointer is never repositioned; the toggle
    // must still be under it (proven by firstHit above), so the same point
    // is clicked again.
    const second = await test.step('second toggle direction returns to the pre-expand region', async () =>
      clickDirectionAndTrack('expand/compress-2', pre.toggleOffset))
    const returnDrift = Math.abs(second.geom.toggleOffset - pre.toggleOffset)
    const secondHit = await hitTestToggleAtPoint(page, point)
    const postScroll = await readScroll(page)
    const postSnap = await readRouteSnapshot(page, topicId)
    console.log(
      `[E2E] fold-2 preOff=${Math.round(pre.toggleOffset)} postOff=${Math.round(second.geom.toggleOffset)} returnDrift=${returnDrift.toFixed(1)} hit=${secondHit} worst=${Number.isFinite(second.worst) ? second.worst.toFixed(1) : 'NaN'} postScroll=${Math.round(postScroll.scrollTop)} mode=${first.mode}->${second.mode} snap=${JSON.stringify(postSnap)?.slice(0, 200) ?? 'null'}`
    )
    test.info().annotations.push({
      type: 'fold-2-geometry',
      description: `preOff=${Math.round(pre.toggleOffset)} postOff=${Math.round(second.geom.toggleOffset)} returnDrift=${returnDrift.toFixed(1)} hit=${secondHit} worst=${Number.isFinite(second.worst) ? second.worst.toFixed(1) : 'NaN'} postScroll=${Math.round(postScroll.scrollTop)} mode=${first.mode}->${second.mode} preSnap=${JSON.stringify(preSnap)?.slice(0, 200) ?? 'null'} postSnap=${JSON.stringify(postSnap)?.slice(0, 200) ?? 'null'}`
    })
    expect(second.mode, 'round trip must restore the original display mode').toBe(preMode)
    expect(
      returnDrift,
      'fold direction 2: toggle region returns to its pre-expand viewport offset'
    ).toBeLessThanOrEqual(REGION_TOL)
    expect(secondHit, 'fold direction 2: stationary pointer still hits the toggle').toBe(true)
    expect(second.worst, 'fold direction 2: painted transition frames never jump').toBeLessThanOrEqual(TRANSITION_TOL)
    expect(Math.abs(postScroll.scrollTop), 'fold round trip: must remain non-bottom (no bottom jump)').toBeGreaterThan(
      BOTTOM_TOL
    )
    const topExtreme = -(postScroll.scrollHeight - postScroll.clientHeight)
    expect(
      postScroll.scrollTop,
      'fold round trip: post viewport stays inside the live scroll range'
    ).toBeGreaterThanOrEqual(topExtreme - OFFSET_TOL)
    expect(postScroll.scrollTop, 'fold round trip: post viewport stays at/above bottom').toBeLessThanOrEqual(OFFSET_TOL)
    // Click→restore: the round trip restores the pre-expand stable route
    // snapshot (same reading identity, same intra-row offset, same scroll).
    // The reading scrolls above guarantee a pre snapshot exists.
    expect(preSnap, 'precondition: route snapshot must exist after the reading scrolls').not.toBeNull()
    const preRec = (preSnap ?? {}) as Record<string, unknown>
    const postRec = (postSnap ?? {}) as Record<string, unknown>
    expect(postRec.messageId ?? postRec.anchorId ?? null, 'round trip restores the snapshot message identity').toBe(
      preRec.messageId ?? preRec.anchorId ?? null
    )
    const preIntra = typeof preRec.intraRowOffset === 'number' ? (preRec.intraRowOffset as number) : NaN
    const postIntra = typeof postRec.intraRowOffset === 'number' ? (postRec.intraRowOffset as number) : NaN
    expect(Math.abs(postIntra - preIntra), 'round trip restores the snapshot intra-row offset').toBeLessThanOrEqual(
      REGION_TOL
    )
    const preTop = typeof preRec.scrollTop === 'number' ? (preRec.scrollTop as number) : NaN
    const postTop = typeof postRec.scrollTop === 'number' ? (postRec.scrollTop as number) : NaN
    expect(Math.abs(postTop - preTop), 'round trip restores the snapshot scrollTop').toBeLessThanOrEqual(OFFSET_TOL)
  })
})
