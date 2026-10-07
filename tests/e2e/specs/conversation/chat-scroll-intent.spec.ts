/**
 * Chat scroll intent — answer-tab SWITCHING + send-from-reading reaches latest bottom.
 *
 * Two independently runnable regressions (same file, shared helpers, no
 * cross-test state): `answer-tab unequal-height repeated switches keep the
 * clicked tab stationary` (A1/A2/A3 + additional mid-topic A4; true-tail
 * covers the route bottom) and `send-from-reading reaches actual latest
 * bottom` (B + post-bottom wheel scroll-away). Each test seeds its own
 * disposable topic via setupScrollIntentTopic() — run either via `-g`.
 *
 * Bounded regression coverage ONLY. Real Electron DOM, shared fixture,
 * disposable profile, mock provider, deterministic assertions.
 *
 * Contract A (answer-tab SWITCHING, not reading-position restoration): from
 * a verified non-bottom Chat viewport on a topic whose mid-topic ask has two
 * model answers (unequal heights), clicking the actual
 * `answer-group-selector` tab at its recorded screen point must change the
 * AUTHORITATIVE selection (Redux `foldSelected` + read-only Main
 * `getRawTopic`, not merely DOM tab styling) while the CLICKED TAB stays at
 * its previous screen location: with no mouse reposition after the click,
 * the selected tab remains at the same viewport geometry (pixel/subpixel
 * rendering tolerance, never enough to hide a jump) and elementFromPoint at
 * the original click point still resolves to the same tab — never a jump to
 * a body anchor, another message, or global bottom. Raw `scrollTop`
 * invariance does NOT hold in column-reverse (a height swap below the
 * viewport necessarily changes `scrollTop` for the SAME tab position), so
 * tab geometry + hit-testing is primary. Covers long→short and short→long,
 * repeated switches without wheel repair between every click, a delayed
 * selection hold with observer churn (A1), and an additional mid-topic
 * switch (A4); the true-tail test covers the route bottom in both
 * directions. Painted transition frames are sampled where practical, not
 * only the eventual final.
 *
 * Contract B (send-from-reading): from a verified non-bottom reading position
 * (after loading the older window so the bootstrap is paginated), sending via
 * the real textarea/Enter through the mock provider must land the viewport at
 * the ACTUAL latest/bottom (column-reverse scrollTop ~= 0 + newest rows
 * visible + read-only `fetchMessagesWindow({ kind: 'latest' })` tail equals
 * the new reply) — never restored to the previous non-bottom position.
 *
 * Seams (existing only): #messages, [data-message-id],
 * [data-testid="answer-group-selector"], window.store (seed/introspection),
 * window.api.chatDb.ensureTopic/pasteMessagesToTopic/getRawTopic/
 * fetchMessagesWindow (seed/introspection), window.keyv scroll snapshot
 * (supporting only). UI actions (topic click, tab click, textarea/Enter,
 * wheel) always go through the real UI. Never dispatches scrollToBottom or
 * SEND_MESSAGE to fake a send.
 *
 * Geometry: #messages renders column-reverse, so bottom/newest is
 * scrollTop ~= 0 and the oldest edge is the most negative scrollTop.
 */
import type { Page } from '@playwright/test'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { SidebarPage } from '../../pages/sidebar.page'
import { waitForAppReady, waitForChatReady, waitForSettingsLoad } from '../../utils/wait-helpers'

const DISPLAY_COUNT = 10
const BOTTOM_TOL = 100
const OFFSET_TOL = 12
// Stationary rendering tolerance: subpixel/style budget only (~2px). A real
// jump must fail, never be absorbed. Transition frames get a marginally
// larger budget for one painted intermediate frame (still far below a jump).
const TAB_TOL = 2
const TRANSITION_TOL = 4
const RETAIN_SCROLL_DELTA = 120 // B-post settle only; never a retention gate for Contract A.
const NON_BOTTOM_MIN = 300

interface Reading {
  anchorId: string
  offset: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

async function ensureDisplayCount(page: Page, limit: number): Promise<void> {
  await page.evaluate((value: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: value })
  }, limit)
  const displayOk = await page.evaluate(() => (window as any).store.getState().messages.displayCount)
  expect(displayOk).toBe(limit)
}

async function ensureExpandedFoldMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as any).store
    store.dispatch({ type: 'settings/setFoldDisplayMode', payload: 'expanded' })
  })
  const foldOk = await page.evaluate(() => (window as any).store.getState().settings.foldDisplayMode)
  expect(foldOk).toBe('expanded')
}

async function getLiveAssistantId(page: Page): Promise<string> {
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

/**
 * Seed: 3 single rounds + mid-topic user ask with TWO assistant answers
 * sharing the ask (unequal heights: short vs tall) + 4 single rounds.
 * Total 17 authority rows. The mid-topic placement is deliberate: a
 * verified non-bottom reading viewport can fully contain the answer-group
 * header, so every tab click is a real Playwright pointer click with no
 * test-induced auto-scroll (a tail group exits the viewport as soon as the
 * viewport leaves bottom, making a real pointer click impossible).
 */
function buildScrollIntentEntries(topicId: string, assistantId: string) {
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
    const userId = push(userIndex, 'user', `csi-fill-user-${round} ${'filler words '.repeat(30)}`)
    push(assistantIndex, 'assistant', `csi-fill-assistant-${round} ${'filler words '.repeat(30)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  const askId = push(6, 'user', `csi-ask-tall-short ${'filler words '.repeat(10)}`)
  const shortId = push(7, 'assistant', `csi-short-answer-marker brief reply. ${'brief. '.repeat(10)}`, {
    askId,
    foldSelected: true,
    model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
    modelId: 'mock-model'
  })
  const tallParagraphs = Array.from({ length: 60 }, (_, i) => `tall paragraph ${pad(i, 3)} filler words`)
  const tallId = push(8, 'assistant', `csi-tall-answer-marker\n\n${tallParagraphs.join('\n\n')}`, {
    askId,
    foldSelected: false,
    model: { id: 'mock-model-tall', provider: 'mock-openai', name: 'Mock Tall Model', group: 'mock' },
    modelId: 'mock-model-tall'
  })
  for (let round = 3; round < 7; round++) {
    const userIndex = round * 2 + 3
    const assistantIndex = round * 2 + 4
    const userId = push(userIndex, 'user', `csi-fill-user-${round} ${'filler words '.repeat(30)}`)
    push(assistantIndex, 'assistant', `csi-fill-assistant-${round} ${'filler words '.repeat(30)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  return { entries, askId, shortId, tallId }
}

/**
 * True-tail variant: 7 single rounds + the LAST ask carrying TWO answers
 * (short selected vs tall) at the route bottom. Total 17 authority rows with
 * the answer group as the newest rows — the tab switch happens at the real
 * tail, where column-reverse bottom clamp applies, not at a mid-topic group
 * with four rounds after it.
 */
function buildTailScrollIntentEntries(topicId: string, assistantId: string) {
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
  for (let round = 0; round < 7; round++) {
    const userIndex = round * 2
    const assistantIndex = round * 2 + 1
    const userId = push(userIndex, 'user', `csi-tail-fill-user-${round} ${'filler words '.repeat(30)}`)
    push(assistantIndex, 'assistant', `csi-tail-fill-assistant-${round} ${'filler words '.repeat(30)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  const askId = push(14, 'user', `csi-tail-ask ${'filler words '.repeat(10)}`)
  const shortId = push(15, 'assistant', `csi-tail-short-marker brief reply. ${'brief. '.repeat(10)}`, {
    askId,
    foldSelected: true,
    model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
    modelId: 'mock-model'
  })
  const tallParagraphs = Array.from({ length: 60 }, (_, i) => `tail tall paragraph ${pad(i, 3)} filler words`)
  const tallId = push(16, 'assistant', `csi-tail-tall-marker\n\n${tallParagraphs.join('\n\n')}`, {
    askId,
    foldSelected: false,
    model: { id: 'mock-model-tall', provider: 'mock-openai', name: 'Mock Tall Model', group: 'mock' },
    modelId: 'mock-model-tall'
  })
  return { entries, askId, shortId, tallId }
}

/**
 * All-short total-height variant: one ask with TWO brief answers, total
 * content height below the viewport (no scrollable overflow). The switch is
 * trivially stationary (no scroll change) but must still flip authority and
 * keep the pointer over the tab.
 */
function buildAllShortEntries(topicId: string, assistantId: string) {
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
  const askId = push(0, 'user', 'csi-tiny-ask brief?')
  const shortId = push(1, 'assistant', 'csi-tiny-short-a brief reply one.', {
    askId,
    foldSelected: true,
    model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
    modelId: 'mock-model'
  })
  const shortBId = push(2, 'assistant', 'csi-tiny-short-b brief reply two.', {
    askId,
    foldSelected: false,
    model: { id: 'mock-model-tall', provider: 'mock-openai', name: 'Mock Tall Model', group: 'mock' },
    modelId: 'mock-model-tall'
  })
  return { entries, askId, shortId, tallId: shortBId }
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
    { topicId, assistantId: liveAssistantId, name: `ScrollIntent ${topicId}` }
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
    { topicId, assistantId: liveAssistantId, name: `ScrollIntent ${topicId}`, entries }
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

/** Crossing-first visible anchor + container-relative offset (repo convention). */
async function readAnchor(page: Page): Promise<{ id: string; offset: number } | null> {
  return page.evaluate(() => {
    const container = document.querySelector('#messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const rows = Array.from(
      document.querySelectorAll('#messages [data-message-id]:not([data-testid="answer-group-selector"])')
    ) as HTMLElement[]
    const cands: { id: string; top: number; bottom: number }[] = []
    for (const row of rows) {
      if (row.getAttribute('data-testid') === 'answer-group-selector') continue
      const r = row.getBoundingClientRect()
      const id = row.getAttribute('data-message-id')
      if (id) cands.push({ id, top: r.top, bottom: r.bottom })
    }
    if (cands.length === 0) return null
    const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
    const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
    return { id: picked.id, offset: picked.top - c.top }
  })
}

async function readScroll(page: Page): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return page.evaluate(() => {
    const el = document.getElementById('messages') as HTMLElement | null
    if (!el) throw new Error('#messages not found')
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
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

/**
 * Ordinary wheel to a verified non-bottom reading position. Both wheel signs
 * are probed so no column-reverse sign assumption is baked in; direct
 * scrollTop writes are never used to establish the saved position.
 */
async function wheelToReadingPosition(page: Page): Promise<Reading> {
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
  const anchor = await settledAnchor(page)
  const scroll = await readScroll(page)
  // Supporting evidence only: persisted snapshot agrees we are non-bottom.
  // Canonical route key first (`scroll:topic-<id>::main`), legacy
  // (`scroll:topic-<id>`) fallback only per production getLegacyMainSavedPosition.
  const snap = await page
    .evaluate(
      (tid: string) => {
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
      },
      await currentTopicId(page)
    )
    .catch(() => null)
  if (snap && typeof snap === 'object' && 'isAtBottom' in (snap as Record<string, unknown>)) {
    expect((snap as { isAtBottom: boolean }).isAtBottom, 'supporting snapshot must be non-bottom').toBe(false)
  }
  return {
    anchorId: anchor.id,
    offset: anchor.offset,
    scrollTop: scroll.scrollTop,
    scrollHeight: scroll.scrollHeight,
    clientHeight: scroll.clientHeight
  }
}

async function currentTopicId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).store.getState().messages?.currentTopicId as string)
}

/**
 * Reusable seed/activation: full 17-row multi-model topic (3 single rounds +
 * mid-topic two-answer ask with unequal heights + 4 single rounds),
 * displayCount=10 cold tail-window activation with bounded checks
 * (loaded >= DISPLAY_COUNT, < 17, tail members present, initial selection is
 * short). Each test calls this independently so A and B run standalone via
 * `-g`. No window.__csi* cross-test state.
 */
async function setupScrollIntentTopic(
  page: Page
): Promise<{ topicId: string; shortId: string; tallId: string; members: string[] }> {
  await ensureDisplayCount(page, DISPLAY_COUNT)
  await ensureExpandedFoldMode(page)
  const liveAssistantId = await getLiveAssistantId(page)
  const topicId = `csi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const built = buildScrollIntentEntries(topicId, liveAssistantId)
  await seedTopicViaMainAuthority(page, liveAssistantId, topicId, built.entries)
  await activateTopicCold(page, topicId, [built.shortId, built.tallId])
  const loaded = await page.evaluate(
    (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])] as string[],
    topicId
  )
  expect(loaded.length).toBeGreaterThanOrEqual(DISPLAY_COUNT)
  expect(loaded.length).toBeLessThan(17)
  expect(loaded).toContain(built.shortId)
  expect(loaded).toContain(built.tallId)
  expect(await authoritativeSelectedId(page, topicId, [built.shortId, built.tallId])).toBe(built.shortId)
  return { topicId, shortId: built.shortId, tallId: built.tallId, members: [built.shortId, built.tallId] }
}

/**
 * Reusable older-window pagination on the existing container (windowed R-03
 * pattern): ordinary mouse-wheel input toward the older edge until
 * InfiniteScroll merges the older window to the full 17 authority rows. Only
 * wheel input is used — no direct scrollTop write. Bounded (40+40 wheel
 * iterations + 15s poll), fails loudly if the older window never merges.
 */
async function paginateToFullHistory(page: Page, topicId: string): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const loadedCount = (tid: string): Promise<number> =>
    page.evaluate((id: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[id]?.length ?? 0, tid)
  for (let i = 0; i < 40; i++) {
    if ((await loadedCount(topicId)) >= 17) break
    await page.mouse.wheel(0, -640)
    await page.waitForTimeout(240)
  }
  if ((await loadedCount(topicId)) < 17) {
    for (let i = 0; i < 40; i++) {
      if ((await loadedCount(topicId)) >= 17) break
      await page.mouse.wheel(0, 640)
      await page.waitForTimeout(240)
    }
  }
  await expect.poll(async () => await loadedCount(topicId), { timeout: 15000 }).toBe(17)
  const paginatedScroll = await readScroll(page)
  expect(Math.abs(paginatedScroll.scrollTop), 'paginated older window must be non-bottom').toBeGreaterThan(
    NON_BOTTOM_MIN
  )
}

/** Authoritative selection from Redux entities (foldSelected), not DOM styling. */
async function authoritativeSelectedId(page: Page, topicId: string, memberIds: string[]): Promise<string | null> {
  return page.evaluate(
    ({ topicId, memberIds }: { topicId: string; memberIds: string[] }) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      for (const id of ids) {
        if (memberIds.includes(id) && s.messages.entities?.[id]?.foldSelected === true) return id
      }
      return null
    },
    { topicId, memberIds }
  )
}

/** Read-only Main authority selection proof via getRawTopic (no Redux mutation). */
async function authoritySelectedId(page: Page, topicId: string, memberIds: string[]): Promise<string | null> {
  const raw: any = await page.evaluate(
    async ({ topicId }: { topicId: string }) => await (window as any).api.chatDb.getRawTopic({ topicId }),
    { topicId }
  )
  expect(raw?.ok, `getRawTopic failed for ${topicId}`).toBe(true)
  const messages: any[] = raw?.value?.messages ?? []
  const selected = messages.filter((m: any) => memberIds.includes(m.id) && (m as any).foldSelected === true)
  return selected.length === 1 ? (selected[0].id as string) : null
}

interface TabGeometry {
  rect: {
    x: number
    y: number
    top: number
    bottom: number
    left: number
    right: number
    width: number
    height: number
  }
  center: { x: number; y: number }
  offset: number
  containerRect: { top: number; bottom: number; height: number }
}

/**
 * Tab geometry for the SWITCHING contract: the clicked tab's viewport rect,
 * pointer center, and container-relative offset (tab top − container top).
 * Fails when the tab is missing or has no box.
 */
async function captureTabGeometry(page: Page, messageId: string): Promise<TabGeometry> {
  return page.evaluate((id: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) throw new Error('#messages not found')
    const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(
      `[data-testid="answer-group-selector"][data-message-id="${esc}"]`
    ) as HTMLElement | null
    if (!el) throw new Error(`answer tab for ${id} not found`)
    const r = el.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) throw new Error(`answer tab for ${id} has no box`)
    return {
      rect: {
        x: r.x,
        y: r.y,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height
      },
      center: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
      offset: r.top - c.top,
      containerRect: { top: c.top, bottom: c.bottom, height: c.height }
    }
  }, messageId)
}

/** elementFromPoint at a screen point must resolve to the same answer tab. */
async function hitTestTabAtPoint(page: Page, point: { x: number; y: number }, messageId: string): Promise<boolean> {
  return page.evaluate(
    ({ x, y, id }: { x: number; y: number; id: string }) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      if (!hit) return false
      const tab = hit.closest?.('[data-testid="answer-group-selector"]') as HTMLElement | null
      if (!tab) return false
      return tab.getAttribute('data-message-id') === id
    },
    { x: point.x, y: point.y, id: messageId }
  )
}

/**
 * Real pointer click on a visible answer-group-selector tab at its recorded
 * screen point. The tab must already sit fully inside #messages so the click
 * performs no test-induced auto-scroll. Clicks via mouse at the recorded
 * center (not DOM el.click), leaves the pointer where it landed (no
 * reposition afterwards), and returns the pre-click geometry + click point
 * for the stationary-pointer assertion.
 */
async function clickAnswerTab(
  page: Page,
  messageId: string
): Promise<{ pre: TabGeometry; point: { x: number; y: number } }> {
  const tab = page.locator(`[data-testid="answer-group-selector"][data-message-id="${messageId}"]`)
  await expect(tab).toHaveCount(1)
  await expect(tab, `answer tab for ${messageId} must be visible for a real pointer click`).toBeVisible({
    timeout: 10000
  })
  const inViewport = await page.evaluate((id: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(
      `[data-testid="answer-group-selector"][data-message-id="${esc}"]`
    ) as HTMLElement | null
    if (!container || !el) return false
    const c = container.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.top >= c.top && r.bottom <= c.bottom && r.width > 0 && r.height > 0
  }, messageId)
  expect(
    inViewport,
    `answer tab for ${messageId} must sit fully inside #messages viewport so the pointer click causes no auto-scroll`
  ).toBe(true)
  const pre = await captureTabGeometry(page, messageId)
  const point = { x: pre.center.x, y: pre.center.y }
  await page.mouse.click(point.x, point.y)
  return { pre, point }
}

/**
 * Ordinary wheel-established reading viewport that additionally keeps the
 * target answer tab fully inside #messages without any direct scrollTop
 * write. Starts from wheelToReadingPosition(), then nudges toward the
 * newest/bottom edge (positive wheel step, matching the repo bottom-seeking
 * sign) in small increments until the tab is fully in-viewport. The returned
 * Reading is captured AFTER the nudge via settledAnchor/readScroll, so the
 * retention assertion measures the exact pre-click viewport. Fails if the
 * tab cannot be made visible while staying verified non-bottom.
 */
async function wheelToReadingPositionWithTabVisible(page: Page, messageId: string): Promise<Reading> {
  let pre = await wheelToReadingPosition(page)
  const isTabInViewport = (): Promise<boolean> =>
    page.evaluate((id: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(
        `[data-testid="answer-group-selector"][data-message-id="${esc}"]`
      ) as HTMLElement | null
      if (!container || !el) return false
      const c = container.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return r.top >= c.top && r.bottom <= c.bottom && r.width > 0 && r.height > 0
    }, messageId)
  if (await isTabInViewport()) return pre
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, 280)
    await page.waitForTimeout(220)
    const scroll = await readScroll(page)
    // Still a reading position: must not have collapsed back to bottom.
    if (Math.abs(scroll.scrollTop) <= NON_BOTTOM_MIN) break
    if (await isTabInViewport()) {
      const anchor = await settledAnchor(page)
      const fresh = await readScroll(page)
      expect(
        Math.abs(fresh.scrollTop),
        'nudge to reveal the answer tab must stay non-bottom (no bottom collapse)'
      ).toBeGreaterThan(NON_BOTTOM_MIN)
      return {
        anchorId: anchor.id,
        offset: anchor.offset,
        scrollTop: fresh.scrollTop,
        scrollHeight: fresh.scrollHeight,
        clientHeight: fresh.clientHeight
      }
    }
  }
  // Opposite-sign sweep before failing loudly (no column-reverse assumption).
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -280)
    await page.waitForTimeout(220)
    const scroll = await readScroll(page)
    if (Math.abs(scroll.scrollTop) <= NON_BOTTOM_MIN) break
    if (await isTabInViewport()) {
      const anchor = await settledAnchor(page)
      const fresh = await readScroll(page)
      expect(
        Math.abs(fresh.scrollTop),
        'nudge to reveal the answer tab must stay non-bottom (no bottom collapse)'
      ).toBeGreaterThan(NON_BOTTOM_MIN)
      return {
        anchorId: anchor.id,
        offset: anchor.offset,
        scrollTop: fresh.scrollTop,
        scrollHeight: fresh.scrollHeight,
        clientHeight: fresh.clientHeight
      }
    }
  }
  pre = await wheelToReadingPosition(page)
  const visible = await isTabInViewport()
  expect(visible, `answer tab for ${messageId} must be reachable at a non-bottom reading position`).toBe(true)
  return pre
}

/**
 * True-tail positioning: the LAST answer group sits at the route bottom, so
 * the cold landing is already at bottom (scrollTop ~= 0) with the tail tab
 * fully inside. A 300px-up non-bottom viewport would necessarily hide it, so
 * no wheel repositioning is required when the tab is already fully visible:
 * return the settled bottom reading directly. Only when the tab is not
 * visible, nudge minimally (both signs, small steps) until it becomes fully
 * visible. Fails loudly with measured geometry when physically impossible
 * (no tolerance inflation, no spacers).
 */
async function wheelToTailTabVisible(page: Page, messageId: string): Promise<Reading> {
  const isTabInViewport = (): Promise<boolean> =>
    page.evaluate((id: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(
        `[data-testid="answer-group-selector"][data-message-id="${esc}"]`
      ) as HTMLElement | null
      if (!container || !el) return false
      const c = container.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return r.top >= c.top && r.bottom <= c.bottom && r.width > 0 && r.height > 0
    }, messageId)
  if (await isTabInViewport()) {
    const anchor = await settledAnchor(page)
    const fresh = await readScroll(page)
    return {
      anchorId: anchor.id,
      offset: anchor.offset,
      scrollTop: fresh.scrollTop,
      scrollHeight: fresh.scrollHeight,
      clientHeight: fresh.clientHeight
    }
  }
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(200)
    if (await isTabInViewport()) {
      const anchor = await settledAnchor(page)
      const fresh = await readScroll(page)
      return {
        anchorId: anchor.id,
        offset: anchor.offset,
        scrollTop: fresh.scrollTop,
        scrollHeight: fresh.scrollHeight,
        clientHeight: fresh.clientHeight
      }
    }
  }
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(200)
    if (await isTabInViewport()) {
      const anchor = await settledAnchor(page)
      const fresh = await readScroll(page)
      return {
        anchorId: anchor.id,
        offset: anchor.offset,
        scrollTop: fresh.scrollTop,
        scrollHeight: fresh.scrollHeight,
        clientHeight: fresh.clientHeight
      }
    }
  }
  const finTab = await captureTabGeometry(page, messageId).catch(() => null)
  const finScroll = await readScroll(page).catch(
    () => ({ scrollTop: NaN, scrollHeight: NaN, clientHeight: NaN }) as never
  )
  throw new Error(
    `tail tab for ${messageId} unreachable (tab=${finTab ? `${Math.round(finTab.offset)}/${Math.round(finTab.rect.top)}x${Math.round(finTab.rect.height)} inH=${Math.round(finTab.containerRect.height)}` : 'missing'} st=${Math.round(finScroll.scrollTop)} h=${finScroll.scrollHeight}/${finScroll.clientHeight})`
  )
}

/**
 * Tail stationary assertion: same 2px tab geometry + mandatory hit + painted
 * transition budget as the mid-topic contract, but WITHOUT the non-bottom
 * gate — the true tail starts at bottom (scrollTop ~= 0) and staying at
 * bottom is correct (not a jump). Still guards the live scroll range.
 */
async function expectTailTabStationary(
  page: Page,
  label: string,
  messageId: string,
  pre: TabGeometry,
  point: { x: number; y: number },
  opts?: { members?: string[]; transitionWorst?: number; sampleCount?: number }
): Promise<void> {
  const post = await captureTabGeometry(page, messageId)
  const offsetDrift = Math.abs(post.offset - pre.offset)
  const centerDrift = Math.hypot(post.center.x - pre.center.x, post.center.y - pre.center.y)
  test.info().annotations.push({
    type: 'csi-tail-geometry',
    description: `${label} preOffset=${Math.round(pre.offset)} postOffset=${Math.round(post.offset)} drift=${offsetDrift.toFixed(1)} centerDrift=${centerDrift.toFixed(1)} preRect=${Math.round(pre.rect.top)},${Math.round(pre.rect.height)} postRect=${Math.round(post.rect.top)},${Math.round(post.rect.height)} point=${Math.round(point.x)},${Math.round(point.y)}`
  })
  expect(offsetDrift, `${label}: clicked tail tab stays at its previous viewport offset`).toBeLessThanOrEqual(TAB_TOL)
  expect(centerDrift, `${label}: clicked tail tab center stays`).toBeLessThanOrEqual(TAB_TOL)
  expect(
    await hitTestTabAtPoint(page, point, messageId),
    `${label}: stationary pointer still hits the same tail tab`
  ).toBe(true)
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  const repainted = await captureTabGeometry(page, messageId)
  expect(Math.abs(repainted.offset - pre.offset), `${label}: painted-frame tail offset stationary`).toBeLessThanOrEqual(
    TAB_TOL
  )
  expect(await hitTestTabAtPoint(page, point, messageId), `${label}: painted-frame hit still resolves`).toBe(true)
  if (typeof opts?.transitionWorst === 'number' && Number.isFinite(opts.transitionWorst)) {
    test.info().annotations.push({
      type: 'csi-tail-transition',
      description: `${label} worst=${opts.transitionWorst.toFixed(1)} n=${opts.sampleCount ?? '?'} preOffset=${Math.round(pre.offset)} postOffset=${Math.round(post.offset)}`
    })
    expect(opts.transitionWorst, `${label}: painted transition frames never jump`).toBeLessThanOrEqual(TRANSITION_TOL)
  }
  const members = opts?.members ?? []
  if (members.length >= 2) {
    await expectSameFoldGroup(page, await currentTopicId(page), members[0], members[1], label)
    expect(members, `${label}: stationary tail tab must be a same-group member`).toContain(messageId)
  }
  const scroll = await readScroll(page)
  const topExtreme = -(scroll.scrollHeight - scroll.clientHeight)
  expect(scroll.scrollTop, `${label}: post viewport stays inside the live scroll range`).toBeGreaterThanOrEqual(
    topExtreme - OFFSET_TOL
  )
  expect(scroll.scrollTop, `${label}: post viewport stays at/above bottom`).toBeLessThanOrEqual(OFFSET_TOL)
}

async function waitForSelection(page: Page, topicId: string, memberIds: string[], expectedId: string): Promise<void> {
  await page.waitForFunction(
    ({ topicId, memberIds, expectedId }: { topicId: string; memberIds: string[]; expectedId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      return memberIds.every((id) => {
        const m = s.messages?.entities?.[id]
        if (!m) return false
        return id === expectedId ? m.foldSelected === true : m.foldSelected === false
      })
    },
    { topicId, memberIds, expectedId },
    { timeout: 15000 }
  )
}

/**
 * Let the production 200ms scrollIntoView timer + smooth behavior settle,
 * then require scroll quiescence (two rAF-separated samples within 8px)
 * before the retention assertion — settlement is polled, never assumed.
 */
async function waitForScrollQuiescence(page: Page): Promise<number> {
  let last = (await readScroll(page)).scrollTop
  const samples = [Math.round(last)]
  const start = Date.now()
  while (Date.now() - start < 8000) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.waitForTimeout(350)
    const cur = (await readScroll(page)).scrollTop
    samples.push(Math.round(cur))
    if (Math.abs(cur - last) <= 8) return cur
    last = cur
  }
  const head = samples.slice(0, 4).join(',')
  const tail = samples.slice(-8).join(',')
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  // Let the drift run to its end-state (bounded) so the failure reports
  // WHERE the viewport landed, not just that it moved: single-shot anchor +
  // geometry after an extended settle, never a pass.
  await page.waitForTimeout(6000)
  const fin = await readAnchor(page).catch(() => null)
  const fscroll = await readScroll(page).catch(
    () => ({ scrollTop: NaN, scrollHeight: NaN, clientHeight: NaN }) as never
  )
  throw new Error(
    `scroll never reached quiescence (last=${last} n=${samples.length} min=${min} max=${max} head=[${head}] tail=[${tail}] final=${fin ? `${fin.id}@${Math.round(fin.offset)}` : 'null'} st=${Math.round(fscroll.scrollTop)} h=${fscroll.scrollHeight}/${fscroll.clientHeight})`
  )
}

/**
 * Painted transition tracking that starts BEFORE the pointer click and
 * continues through the IPC wait, selected layout, and stabilization —
 * never only the eventual final. The pointer is never repositioned during
 * tracking (evaluate-only sampling), so the original click point stays under
 * the cursor throughout. Returns extractable worst drift + sample count for
 * the return report (logs only on failure via the caller's stationary
 * assertion annotations).
 */
async function readTabOffset(page: Page, messageId: string): Promise<number> {
  return page
    .evaluate((id: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return NaN
      const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(
        `[data-testid="answer-group-selector"][data-message-id="${esc}"]`
      ) as HTMLElement | null
      if (!el) return NaN
      return el.getBoundingClientRect().top - container.getBoundingClientRect().top
    }, messageId)
    .catch(() => NaN)
}

async function clickAnswerTabAndTrack(
  page: Page,
  topicId: string,
  members: string[],
  messageId: string
): Promise<{ pre: TabGeometry; point: { x: number; y: number }; worst: number; samples: number[] }> {
  const pre = await captureTabGeometry(page, messageId)
  const point = { x: pre.center.x, y: pre.center.y }
  const samples: number[] = [0]
  // Sampling starts BEFORE the click (pre drift 0 counts as frame 1) and the
  // pointer never moves afterwards: mouse.click lands at the recorded center
  // and every later sample is evaluate-only.
  await page.mouse.click(point.x, point.y)
  // Poll through the async DB-first selection + selected layout commit:
  // each rAF-separated frame records drift; the loop exits only after the
  // authoritative selection flips AND four additional painted frames prove the
  // selected layout settled — never settling on the eventual final alone.
  let selectedSeen = false
  let settledExtra = 0
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    const cur = await readTabOffset(page, messageId)
    if (Number.isFinite(cur)) samples.push(Math.abs((cur as number) - pre.offset))
    const selected = await authoritativeSelectedId(page, topicId, members).catch(() => null)
    if (selected === messageId) {
      selectedSeen = true
      settledExtra += 1
      if (settledExtra >= 4) break
    } else {
      settledExtra = 0
    }
  }
  if (!selectedSeen) throw new Error(`selection never flipped to ${messageId} during transition tracking`)
  const worst = samples.length > 0 ? Math.max(...samples) : Number.NaN
  return { pre, point, worst, samples }
}

/**
 * Faithful delayed selection via the existing store.dispatch seam (same style
 * as route-settings-session installInFlightGate): contextBridge freezes
 * window.api.chatDb (writable:false/configurable:false), so the IPC function
 * cannot be wrapped — the dispatch boundary is the closest faithful point.
 * Holds thunk-function dispatches while armed; the already-held selection
 * thunk stays pending after disarm so unrelated dispatches pass while the
 * target projection commit is genuinely delayed. Everything is removed in
 * finally. No production delay hooks.
 */
async function installCsiSelectionGate(page: Page, key: string, topicId: string, targetId: string): Promise<void> {
  await page.evaluate(
    ({ k, tid, target }: { k: string; tid: string; target: string }) => {
      const w = window as unknown as Record<string, any>
      if (w[k]) throw new Error('csi selection gate already installed')
      const store = w.store
      if (!store || typeof store.dispatch !== 'function') throw new Error('store.dispatch unavailable for gate')
      const orig = store.dispatch.bind(store)
      const gate = {
        armed: true,
        tid,
        target,
        held: [] as Array<{
          action: unknown
          resolve: (v: unknown) => void
          reject: (e: unknown) => void
          heldAt: number
        }>,
        orig,
        installedAt: Date.now(),
        firstHeldAt: 0,
        releasedAt: 0,
        hit: 0
      }
      const wrapped = function (action: unknown, ...rest: unknown[]): unknown {
        const g = (window as unknown as Record<string, any>)[k] as typeof gate | undefined
        if (g && g.armed === true && typeof action === 'function') {
          if (g.firstHeldAt === 0) g.firstHeldAt = Date.now()
          g.hit += 1
          return new Promise<unknown>((resolve, reject) => {
            g.held.push({ action, resolve, reject, heldAt: Date.now() })
          })
        }
        const o = (g && (g as Record<string, unknown>).orig) || orig
        return (o as (...a: unknown[]) => unknown)(action, ...rest)
      }
      ;(wrapped as unknown as Record<string, unknown>).__csi_gate = true
      w[k] = gate
      store.dispatch = wrapped
    },
    { k: key, tid: topicId, target: targetId }
  )
  const installed = await page.evaluate((k: string) => {
    const w = window as unknown as Record<string, any>
    return w.store?.dispatch?.__csi_gate === true && Boolean(w[k]?.armed)
  }, key)
  expect(installed, 'csi selection gate must wrap store.dispatch while armed').toBe(true)
}

async function disarmCsiSelectionGate(page: Page, key: string): Promise<void> {
  await page.evaluate((k: string) => {
    const g = (window as unknown as Record<string, any>)[k]
    if (!g) throw new Error('csi selection gate missing at disarm')
    g.armed = false
  }, key)
}

async function releaseCsiSelectionGate(
  page: Page,
  key: string
): Promise<{
  total: number
  errors: string[]
  installedAt: number
  firstHeldAt: number
  releasedAt: number
  heldMs: number
}> {
  return await page.evaluate(async (k: string) => {
    const g = (window as unknown as Record<string, any>)[k] as
      | {
          armed: boolean
          held: Array<{ action: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }>
          orig: (action: unknown) => Promise<unknown>
          installedAt: number
          firstHeldAt: number
          releasedAt: number
        }
      | undefined
    if (!g) throw new Error('csi selection gate missing at release')
    g.armed = false
    g.releasedAt = Date.now()
    const heldMs = g.firstHeldAt > 0 ? g.releasedAt - g.firstHeldAt : 0
    const queue = g.held.splice(0)
    const errors: string[] = []
    for (const h of queue) {
      try {
        const value = await g.orig(h.action)
        h.resolve(value)
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
        h.reject(e)
      }
    }
    return {
      total: queue.length,
      errors,
      installedAt: g.installedAt,
      firstHeldAt: g.firstHeldAt,
      releasedAt: g.releasedAt,
      heldMs
    }
  }, key)
}

async function removeCsiSelectionGate(page: Page, key: string): Promise<boolean> {
  return await page
    .evaluate(async (k: string) => {
      const g = (window as unknown as Record<string, any>)[k] as
        | {
            armed: boolean
            held: Array<{ action: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }>
            orig: (...args: unknown[]) => unknown
          }
        | undefined
      try {
        if (g) {
          g.armed = false
          const queue = g.held.splice(0)
          for (const h of queue) {
            try {
              const value = await g.orig(h.action)
              h.resolve(value)
            } catch (e) {
              h.reject(e)
            }
          }
          try {
            const store = (window as unknown as Record<string, any>).store
            if (store && (store.dispatch as unknown as Record<string, unknown>).__csi_gate) {
              store.dispatch = g.orig
            }
          } catch {}
        }
      } finally {
        delete (window as unknown as Record<string, any>)[k]
      }
      const store = (window as unknown as Record<string, any>).store
      return (
        !(window as unknown as Record<string, any>)[k] &&
        !(store?.dispatch as unknown as Record<string, unknown> | undefined)?.__csi_gate
      )
    }, key)
    .catch(() => false)
}

interface CsiSample {
  t: number
  offset: number
  drift: number
  selected: boolean
  hit: boolean
}

/**
 * In-renderer rAF sampler: starts BEFORE the pointer click and records every
 * painted frame through the held pending interval, release, first paint and
 * settle. Node-side polling alone would swallow the gap; the renderer loop
 * runs independently of the Node wait for the held thunk.
 */
async function startCsiSampler(
  page: Page,
  targetId: string,
  point: { x: number; y: number },
  preOffset: number
): Promise<void> {
  await page.evaluate(
    ({ targetId, px, py, preOffset }: { targetId: string; px: number; py: number; preOffset: number }) => {
      const w = window as unknown as Record<string, any>
      w.__csiA1Samples = []
      w.__csiA1Stop = false
      w.__csiA1Meta = { targetId, px, py, preOffset }
      const step = (): void => {
        try {
          const ww = window as unknown as Record<string, any>
          if (ww.__csiA1Stop === true) return
          const meta = ww.__csiA1Meta as { targetId: string; px: number; py: number; preOffset: number }
          const container = document.getElementById('messages') as HTMLElement | null
          let offset = NaN
          let drift = NaN
          if (container) {
            const esc =
              typeof CSS !== 'undefined' && (CSS as unknown as { escape: (v: string) => string }).escape
                ? (CSS as unknown as { escape: (v: string) => string }).escape(meta.targetId)
                : meta.targetId
            const el = document.querySelector(
              '[data-testid="answer-group-selector"][data-message-id="' + esc + '"]'
            ) as HTMLElement | null
            if (el) {
              const c = container.getBoundingClientRect()
              const r = el.getBoundingClientRect()
              offset = r.top - c.top
              drift = Math.abs(offset - meta.preOffset)
            }
          }
          let hit = false
          try {
            const h = document.elementFromPoint(meta.px, meta.py) as HTMLElement | null
            const tab =
              h && h.closest ? (h.closest('[data-testid="answer-group-selector"]') as HTMLElement | null) : null
            hit = !!tab && tab.getAttribute('data-message-id') === meta.targetId
          } catch {}
          let selected = false
          try {
            selected =
              (window as unknown as Record<string, any>).store?.getState()?.messages?.entities?.[meta.targetId]
                ?.foldSelected === true
          } catch {}
          ;(ww.__csiA1Samples as CsiSample[]).push({ t: Date.now(), offset, drift, selected, hit })
        } catch {}
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    },
    { targetId, px: point.x, py: point.y, preOffset }
  )
}

async function readCsiSampler(page: Page): Promise<CsiSample[]> {
  return await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    return (Array.isArray(w.__csiA1Samples) ? w.__csiA1Samples.slice() : []) as CsiSample[]
  })
}

async function stopCsiSampler(page: Page): Promise<CsiSample[]> {
  return await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    w.__csiA1Stop = true
    return (Array.isArray(w.__csiA1Samples) ? w.__csiA1Samples.slice() : []) as CsiSample[]
  })
}

async function clearCsiSampler(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      try {
        delete (window as unknown as Record<string, any>).__csiA1Samples
      } catch {}
      try {
        delete (window as unknown as Record<string, any>).__csiA1Stop
      } catch {}
      try {
        delete (window as unknown as Record<string, any>).__csiA1Meta
      } catch {}
      try {
        delete (window as unknown as Record<string, any>).__csiChurnPrev
      } catch {}
    })
    .catch(() => {})
}

/** Same-group proof: both answers share one ask (Redux entities + Main authority). */
async function expectSameFoldGroup(
  page: Page,
  topicId: string,
  idA: string,
  idB: string,
  label: string
): Promise<void> {
  const askIds = await page.evaluate(
    ({ idA, idB }: { idA: string; idB: string }) => {
      const s = (window as any).store?.getState()
      return {
        a: (s?.messages?.entities?.[idA] as any)?.askId ?? null,
        b: (s?.messages?.entities?.[idB] as any)?.askId ?? null
      }
    },
    { idA, idB }
  )
  expect(askIds.a, `${label}: first answer must carry an askId`).toBeTruthy()
  expect(askIds.b, `${label}: second answer must carry an askId`).toBeTruthy()
  expect(askIds.a, `${label}: both answers must share one ask (same group)`).toBe(askIds.b)
  const raw: any = await page.evaluate(
    async ({ topicId }: { topicId: string }) => await (window as any).api.chatDb.getRawTopic({ topicId }),
    { topicId }
  )
  expect(raw?.ok, `getRawTopic failed for ${topicId}`).toBe(true)
  const messages: any[] = raw?.value?.messages ?? []
  const aAsk = messages.find((m: any) => m.id === idA)?.askId ?? null
  const bAsk = messages.find((m: any) => m.id === idB)?.askId ?? null
  expect(aAsk, `${label}: Main authority first askId`).toBeTruthy()
  expect(bAsk, `${label}: Main authority second askId`).toBeTruthy()
  expect(aAsk, `${label}: Main authority same group`).toBe(bAsk)
}

async function expectTabStationary(
  page: Page,
  label: string,
  messageId: string,
  pre: TabGeometry,
  point: { x: number; y: number },
  opts?: { members?: string[]; transitionWorst?: number; sampleCount?: number }
): Promise<void> {
  // No mouse reposition happened after the click by construction (callers
  // never move the mouse between clickAnswerTab and here): the stationary
  // pointer must still be over the clicked tab.
  const post = await captureTabGeometry(page, messageId)
  const offsetDrift = Math.abs(post.offset - pre.offset)
  const centerDrift = Math.hypot(post.center.x - pre.center.x, post.center.y - pre.center.y)
  test.info().annotations.push({
    type: 'csi-tab-geometry',
    description: `${label} preOffset=${Math.round(pre.offset)} postOffset=${Math.round(post.offset)} drift=${offsetDrift.toFixed(1)} centerDrift=${centerDrift.toFixed(1)} preRect=${Math.round(pre.rect.top)},${Math.round(pre.rect.height)} postRect=${Math.round(post.rect.top)},${Math.round(post.rect.height)}`
  })
  expect(offsetDrift, `${label}: clicked tab stays at its previous viewport offset`).toBeLessThanOrEqual(TAB_TOL)
  expect(centerDrift, `${label}: clicked tab center stays at its previous screen point`).toBeLessThanOrEqual(TAB_TOL)
  const hit = await hitTestTabAtPoint(page, point, messageId)
  expect(hit, `${label}: stationary pointer at the original click point still hits the same tab`).toBe(true)
  // Painted-frame re-observation: two rAF-separated frames must still report
  // the same tab geometry — the hold is painted, not a transient sample.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  const repainted = await captureTabGeometry(page, messageId)
  expect(Math.abs(repainted.offset - pre.offset), `${label}: painted-frame tab offset stationary`).toBeLessThanOrEqual(
    TAB_TOL
  )
  const repaintedHit = await hitTestTabAtPoint(page, point, messageId)
  expect(repaintedHit, `${label}: painted-frame hit test still resolves to the same tab`).toBe(true)
  if (typeof opts?.transitionWorst === 'number' && Number.isFinite(opts.transitionWorst)) {
    const count = typeof opts?.sampleCount === 'number' ? ` n=${opts.sampleCount}` : ''
    test.info().annotations.push({
      type: 'csi-tab-transition',
      description: `${label} worst painted transition drift=${opts.transitionWorst.toFixed(1)}${count} preOffset=${Math.round(pre.offset)} postOffset=${Math.round(post.offset)} point=${Math.round(point.x)},${Math.round(point.y)}`
    })
    expect(opts.transitionWorst, `${label}: painted transition frames never jump`).toBeLessThanOrEqual(TRANSITION_TOL)
  }
  // Same-group proof: the selected tab is the authoritative answer in the
  // same fold group — never an unrelated tail/bottom row.
  const members = opts?.members ?? []
  if (members.length >= 2) {
    await expectSameFoldGroup(page, await currentTopicId(page), members[0], members[1], label)
    expect(members, `${label}: stationary tab must be a same-group member`).toContain(messageId)
  }
  // Never a jump to global bottom.
  const scroll = await readScroll(page)
  expect(Math.abs(scroll.scrollTop), `${label}: must remain non-bottom (no bottom jump)`).toBeGreaterThan(BOTTOM_TOL)
  const topExtreme = -(scroll.scrollHeight - scroll.clientHeight)
  expect(scroll.scrollTop, `${label}: post viewport stays inside the live scroll range`).toBeGreaterThanOrEqual(
    topExtreme - OFFSET_TOL
  )
  expect(scroll.scrollTop, `${label}: post viewport stays at/above bottom`).toBeLessThanOrEqual(OFFSET_TOL)
}

async function expectTabSelectionRendered(page: Page, selectedId: string, hiddenId: string): Promise<void> {
  // Production reuses message IDs across seams (MessageWrapper id=`message-X`
  // + inner MessageContainer id=`message-X` data-message-id=X + tab
  // data-message-id=X), so bare ID or bare data-message-id is ambiguous.
  // Disambiguate without relaxing: the message row carries BOTH.
  await expect(page.locator(`#message-${selectedId}[data-message-id="${selectedId}"]`)).toBeVisible({
    timeout: 10000
  })
  await expect(page.locator(`#message-${selectedId}.selected`)).toBeVisible({ timeout: 10000 })
  await expect(page.locator(`#message-${hiddenId}[data-message-id="${hiddenId}"]`)).toBeHidden({ timeout: 10000 })
}

async function uiSendMessage(page: Page, text: string): Promise<void> {
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

async function assistantCount(page: Page, topicId: string): Promise<number> {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[tid] || []
    let count = 0
    for (const id of msgIds) {
      if (s.messages.entities[id]?.role === 'assistant') count++
    }
    return count
  }, topicId)
}

async function waitForAssistantResponseComplete(
  page: Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<void> {
  await page.waitForFunction(
    ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let count = 0
      for (const id of msgIds) {
        if (s.messages.entities?.[id]?.role === 'assistant') count++
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
        if (s.messages.entities?.[msgIds[i]]?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages.entities[latestAssistantId]
      if (assistantMsg.status !== 'success' && assistantMsg.status !== 'error') return false
      const blocks = assistantMsg.blocks || []
      if (blocks.length === 0) return false
      return blocks.every((blockId: string) => {
        const block = s.messageBlocks?.entities?.[blockId]
        return block && (block.status === 'success' || block.status === 'error')
      })
    },
    { topicId },
    { timeout }
  )
}

async function isRowVisibleInMessages(page: Page, messageId: string): Promise<boolean> {
  // Production reuses message IDs across seams (MessageWrapper id +
  // inner MessageContainer id + transient send-flow twins), so bare
  // getElementById first-match can resolve a hidden/box-less duplicate while
  // the rendered row is on screen (stable 15s user-row invisibility with the
  // reply visible and both rows painted). Resolve EVERY candidate carrying
  // the identity — disambiguated row selector first (same convention as
  // expectTabSelectionRendered), then any data-message-id row, then the bare
  // id — and report visible if ANY connected, displayed candidate with a
  // real box intersects the #messages viewport.
  return page.evaluate((id: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return false
    const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const seen = new Set<Element>()
    const cands: Element[] = []
    const collect = (list: ArrayLike<Element>): void => {
      for (let i = 0; i < list.length; i++) {
        const el = list[i]
        if (el && !seen.has(el)) {
          seen.add(el)
          cands.push(el)
        }
      }
    }
    try {
      collect(
        document.querySelectorAll(
          `#message-${esc}[data-message-id="${esc}"]:not([data-testid="answer-group-selector"])`
        )
      )
    } catch {}
    try {
      collect(
        document.querySelectorAll(`#messages [data-message-id="${esc}"]:not([data-testid="answer-group-selector"])`)
      )
    } catch {}
    const byId = document.getElementById(`message-${esc}`)
    if (byId) collect([byId])
    const c = container.getBoundingClientRect()
    for (const el of cands) {
      if (!(el instanceof HTMLElement)) continue
      if (!el.isConnected) continue
      if (el.getAttribute('data-testid') === 'answer-group-selector') continue
      if (window.getComputedStyle(el).display === 'none') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0) return true
    }
    return false
  }, messageId)
}

test.describe('Chat scroll intent — answer-tab retention + send reaches latest bottom', () => {
  test.setTimeout(300000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('answer-tab unequal-height repeated switches keep the clicked tab stationary', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CHAT SCROLL INTENT A: real answer-group-selector pointer clicks at recorded screen points flip authoritative foldSelected (Redux + read-only Main getRawTopic) while the clicked tab stays at its previous viewport geometry with the stationary pointer still hitting the same tab (short->tall, tall->short, immediate repeat without wheel repair, additional mid-topic; true-tail covers bottom).'
    })
    const page: Page = mainWindow

    const { topicId, shortId, tallId, members } =
      await test.step('seed multi-model topic (17 rows) with displayCount=10 and cold-activate the tail window', async () =>
        await setupScrollIntentTopic(page))
    const tail = { shortId, tallId }

    await test.step('A1: delayed short->tall with observer churn keeps the clicked tab stationary', async () => {
      // Faithful delayed selection via the store.dispatch seam (frozen
      // window.api.chatDb cannot be wrapped): arm the gate BEFORE the
      // gesture, hold the actual selection thunk ~900ms with unrelated real
      // RO/MO churn INSIDE the gap, sample in-renderer from BEFORE the click
      // through release + first paint + settle with the pointer never
      // repositioned. Proves the seam was reached (held>=1, timestamps),
      // the target stayed unselected throughout the hold, and Redux + Main
      // both flip only after release.
      await wheelToReadingPositionWithTabVisible(page, tail.tallId)
      const gateKey = '__csi_a1_gate'
      const HOLD_MS = 900
      let pre: TabGeometry | null = null
      let point: { x: number; y: number } | null = null
      let gateRemoved = false
      try {
        await installCsiSelectionGate(page, gateKey, topicId, tail.tallId)
        const installedAt = await page.evaluate(
          (k: string) => (window as unknown as Record<string, any>)[k]?.installedAt ?? 0,
          gateKey
        )
        expect(installedAt, 'A1 gate installed timestamp must exist').toBeGreaterThan(0)
        pre = await captureTabGeometry(page, tail.tallId)
        point = { x: pre.center.x, y: pre.center.y }
        expect(await hitTestTabAtPoint(page, point, tail.tallId), 'A1 precondition: click point hits tall tab').toBe(
          true
        )
        await startCsiSampler(page, tail.tallId, point, pre.offset)
        await page.mouse.click(point.x, point.y)
        await page.waitForFunction(
          (k: string) => {
            const g = (window as unknown as Record<string, any>)[k]
            return Boolean(g) && (g.held?.length ?? 0) >= 1 && (g.firstHeldAt ?? 0) > 0
          },
          gateKey,
          { timeout: 15000 }
        )
        const firstHeldAt = await page.evaluate(
          (k: string) => (window as unknown as Record<string, any>)[k]?.firstHeldAt ?? 0,
          gateKey
        )
        const hitCount = await page.evaluate(
          (k: string) => (window as unknown as Record<string, any>)[k]?.hit ?? 0,
          gateKey
        )
        expect(hitCount, 'A1 gate must have intercepted the selection thunk').toBeGreaterThanOrEqual(1)
        expect(
          await authoritativeSelectedId(page, topicId, members),
          'A1 held: target stays unselected while held'
        ).not.toBe(tail.tallId)
        // Disarm so unrelated dispatches pass; the already-held selection stays pending.
        await disarmCsiSelectionGate(page, gateKey)
        // Unrelated real RO/MO churn INSIDE the held gap (not inside IPC).
        await page.evaluate(() => {
          const c = document.getElementById('messages') as HTMLElement | null
          if (!c) return
          ;(window as unknown as Record<string, any>).__csiChurnPrev = c.style.minHeight
          c.style.minHeight = '5px'
          void c.offsetHeight
        })
        await page.waitForTimeout(120)
        await page.evaluate(() => {
          const c = document.getElementById('messages') as HTMLElement | null
          if (c) {
            c.style.minHeight = ((window as unknown as Record<string, any>).__csiChurnPrev as string | undefined) ?? ''
            void c.offsetHeight
          }
          try {
            delete (window as unknown as Record<string, any>).__csiChurnPrev
          } catch {}
        })
        const remaining = HOLD_MS - (Date.now() - firstHeldAt)
        if (remaining > 0) await page.waitForTimeout(remaining)
        expect(
          await authoritativeSelectedId(page, topicId, members),
          'A1 held: target still unselected after churn hold'
        ).not.toBe(tail.tallId)
        const pendingView = await readCsiSampler(page)
        const pendingFrames = pendingView.filter((s) => s.selected !== true)
        expect(pendingFrames.length, 'A1 sampler must capture pending frames before release').toBeGreaterThan(0)
        const release = await releaseCsiSelectionGate(page, gateKey)
        expect(release.total, 'A1 release must flush the held selection thunk').toBeGreaterThanOrEqual(1)
        expect(release.errors, 'A1 release must resolve without transport error').toEqual([])
        expect(release.heldMs, 'A1 held interval must be meaningful (~900ms)').toBeGreaterThanOrEqual(700)
        test.info().annotations.push({
          type: 'csi-a1-delivery',
          description: `click at ${Math.round(point.x)},${Math.round(point.y)} heldMs=${release.heldMs} hit=${hitCount} pendingFrames=${pendingFrames.length} preOffset=${Math.round(pre.offset)}`
        })
        await waitForSelection(page, topicId, members, tail.tallId)
        expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.tallId)
        expect(await authoritySelectedId(page, topicId, members)).toBe(tail.tallId)
        await expectTabSelectionRendered(page, tail.tallId, tail.shortId)
        await expect(page.locator('#messages')).toContainText('csi-tall-answer-marker')
        await waitForScrollQuiescence(page)
        const all = await stopCsiSampler(page)
        const finite = all.filter((s) => Number.isFinite(s.drift))
        expect(finite.length, 'A1 sampler must record frames (n>5, time not count alone)').toBeGreaterThan(5)
        const elapsed = finite.length >= 2 ? finite[finite.length - 1].t - finite[0].t : 0
        expect(elapsed, 'A1 sampler must span the held interval').toBeGreaterThanOrEqual(700)
        const worst = finite.length > 0 ? Math.max(...finite.map((s) => s.drift as number)) : Number.NaN
        const post = await captureTabGeometry(page, tail.tallId)
        const finalDrift = Math.abs(post.offset - (pre as TabGeometry).offset)
        expect(finalDrift, 'A1 final tab offset stationary').toBeLessThanOrEqual(TAB_TOL)
        expect(worst, 'A1 painted transition frames never jump').toBeLessThanOrEqual(TRANSITION_TOL)
        expect(
          await hitTestTabAtPoint(page, point as { x: number; y: number }, tail.tallId),
          'A1 stationary pointer still hits tall tab'
        ).toBe(true)
        await expectTabStationary(
          page,
          'A1 short->tall',
          tail.tallId,
          pre as TabGeometry,
          point as { x: number; y: number },
          {
            members,
            transitionWorst: worst,
            sampleCount: finite.length
          }
        )
      } finally {
        await stopCsiSampler(page).catch(() => [])
        gateRemoved = await removeCsiSelectionGate(page, gateKey)
        await clearCsiSampler(page)
      }
      expect(gateRemoved, 'A1 gate must restore store.dispatch exactly').toBe(true)
      // Post-switch handoff proof: live anchor + snapshot now carry the
      // CURRENT post-switch visible geometry (tall), not the old short body.
      const snapA1: any = await page
        .evaluate((tid: string) => {
          try {
            return (window as any).keyv?.get?.(`scroll:topic-${tid}::main`) ?? null
          } catch {
            return null
          }
        }, topicId)
        .catch(() => null)
      test.info().annotations.push({
        type: 'csi-a1-handoff',
        description: `snap=${snapA1 ? JSON.stringify(snapA1).slice(0, 300) : 'null'}`
      })
      if (snapA1 && typeof snapA1 === 'object' && 'messageId' in (snapA1 as Record<string, unknown>)) {
        expect(
          (snapA1 as { messageId: unknown }).messageId,
          'A1 handoff snapshot carries the post-switch tall answer'
        ).toBe(tail.tallId)
      }
    })

    await test.step('A2: switch tall->short (unequal height reverse) keeps the clicked tab stationary', async () => {
      await wheelToReadingPositionWithTabVisible(page, tail.shortId)
      const tracked = await clickAnswerTabAndTrack(page, topicId, members, tail.shortId)
      test.info().annotations.push({
        type: 'csi-a2-delivery',
        description: `tab click at ${Math.round(tracked.point.x)},${Math.round(tracked.point.y)} n=${tracked.samples.length}`
      })
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.shortId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.shortId)
      await expectTabSelectionRendered(page, tail.shortId, tail.tallId)
      await expect(page.locator('#messages')).toContainText('csi-short-answer-marker')
      await expectTabStationary(page, 'A2 tall->short', tail.shortId, tracked.pre, tracked.point, {
        members,
        transitionWorst: tracked.worst,
        sampleCount: tracked.samples.length
      })
    })

    await test.step('A3: immediate repeats without wheel repair keep each clicked tab stationary', async () => {
      // No wheel repair between these clicks: directly after the converged
      // A2 viewport, the tall tab sits in the same strip and must be
      // clickable, then the short tab clickable again. The pointer stays over
      // each clicked tab through its own switch (no reposition between the
      // two clicks except the second click's own landing). Each click tracks
      // from BEFORE its click through its own selection + settle.
      const r1 = await clickAnswerTabAndTrack(page, topicId, members, tail.tallId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.tallId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.tallId)
      await expectTabSelectionRendered(page, tail.tallId, tail.shortId)
      await expectTabStationary(page, 'A3 repeat short->tall', tail.tallId, r1.pre, r1.point, {
        members,
        transitionWorst: r1.worst,
        sampleCount: r1.samples.length
      })

      const r2 = await clickAnswerTabAndTrack(page, topicId, members, tail.shortId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.shortId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.shortId)
      await expectTabSelectionRendered(page, tail.shortId, tail.tallId)
      await expectTabStationary(page, 'A3 repeat tall->short', tail.shortId, r2.pre, r2.point, {
        members,
        transitionWorst: r2.worst,
        sampleCount: r2.samples.length
      })
    })

    await test.step('A2-snapshot: Settings roundtrip keeps the stable tab view', async () => {
      // The departure freeze captures the converged tab-stable geometry; the
      // return must show the same selected tab at the same viewport geometry
      // with the pointer position still hitting it — not a stale body anchor.
      const preTab = await captureTabGeometry(page, tail.shortId)
      const sidebar = new SidebarPage(page)
      await sidebar.goToSettings()
      await waitForSettingsLoad(page)
      await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
      await sidebar.goToHome()
      await waitForChatReady(page)
      await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.shortId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.shortId)
      await expectTabSelectionRendered(page, tail.shortId, tail.tallId)
      const postTab = await captureTabGeometry(page, tail.shortId)
      expect(
        Math.abs(postTab.offset - preTab.offset),
        `A2-snapshot: return keeps the stable tab offset (before=${Math.round(preTab.offset)} after=${Math.round(postTab.offset)})`
      ).toBeLessThanOrEqual(TAB_TOL)
      const scrollAfter = await readScroll(page)
      expect(Math.abs(scrollAfter.scrollTop), 'A2-snapshot: return stays non-bottom').toBeGreaterThan(BOTTOM_TOL)
      const snap = await page
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
      test.info().annotations.push({
        type: 'csi-a2-snapshot',
        description: `return tabOffset=${Math.round(postTab.offset)} snap=${snap ? JSON.stringify(snap).slice(0, 300) : 'null'}`
      })
    })

    await test.step('A4: additional mid-topic short->tall keeps the clicked tab stationary', async () => {
      // Additional mid-topic switch (not a near-bottom geometry claim): the
      // true-tail test below covers the route bottom in both directions, so
      // this step only proves another mid-topic switch stays stationary.
      await wheelToReadingPositionWithTabVisible(page, tail.tallId)
      const tracked = await clickAnswerTabAndTrack(page, topicId, members, tail.tallId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.tallId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.tallId)
      await expectTabSelectionRendered(page, tail.tallId, tail.shortId)
      await expectTabStationary(page, 'A4 mid-topic short->tall', tail.tallId, tracked.pre, tracked.point, {
        members,
        transitionWorst: tracked.worst,
        sampleCount: tracked.samples.length
      })
    })
  })

  test('answer-tab true-tail group switches keep the clicked tab stationary', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CHAT SCROLL INTENT TAIL: the LAST answer group at the route bottom (true tail, not mid-topic) flips authoritative foldSelected both directions with the clicked tab stationary and the pointer still hitting it; plus an all-short total-height (no-overflow) switch. Scoped deterministic tail fixtures via shared helpers; mid-topic coverage above is unchanged (not renamed to tail).'
    })
    const page: Page = mainWindow
    await ensureDisplayCount(page, DISPLAY_COUNT)
    await ensureExpandedFoldMode(page)
    const liveAssistantId = await getLiveAssistantId(page)
    const tailTopicId = `csi-tail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const builtTail = buildTailScrollIntentEntries(tailTopicId, liveAssistantId)
    await seedTopicViaMainAuthority(page, liveAssistantId, tailTopicId, builtTail.entries)
    await activateTopicCold(page, tailTopicId, [builtTail.shortId, builtTail.tallId])
    const tailMembers = [builtTail.shortId, builtTail.tallId]
    expect(await authoritativeSelectedId(page, tailTopicId, tailMembers)).toBe(builtTail.shortId)

    await test.step('TAIL short->long keeps the clicked tab stationary', async () => {
      await wheelToTailTabVisible(page, builtTail.tallId)
      const placed = await captureTabGeometry(page, builtTail.tallId)
      test.info().annotations.push({
        type: 'csi-tail-placement',
        description: `tail tab offset=${Math.round(placed.offset)} containerH=${Math.round(placed.containerRect.height)}`
      })
      const tracked = await clickAnswerTabAndTrack(page, tailTopicId, tailMembers, builtTail.tallId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, tailTopicId, tailMembers)).toBe(builtTail.tallId)
      expect(await authoritySelectedId(page, tailTopicId, tailMembers)).toBe(builtTail.tallId)
      await expectTabSelectionRendered(page, builtTail.tallId, builtTail.shortId)
      await expect(page.locator('#messages')).toContainText('csi-tail-tall-marker')
      await expectTailTabStationary(page, 'TAIL short->long', builtTail.tallId, tracked.pre, tracked.point, {
        members: tailMembers,
        transitionWorst: tracked.worst,
        sampleCount: tracked.samples.length
      })
    })

    await test.step('TAIL long->short keeps the clicked tab stationary', async () => {
      await wheelToTailTabVisible(page, builtTail.shortId)
      const tracked = await clickAnswerTabAndTrack(page, tailTopicId, tailMembers, builtTail.shortId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, tailTopicId, tailMembers)).toBe(builtTail.shortId)
      expect(await authoritySelectedId(page, tailTopicId, tailMembers)).toBe(builtTail.shortId)
      await expectTabSelectionRendered(page, builtTail.shortId, builtTail.tallId)
      await expect(page.locator('#messages')).toContainText('csi-tail-short-marker')
      await expectTailTabStationary(page, 'TAIL long->short', builtTail.shortId, tracked.pre, tracked.point, {
        members: tailMembers,
        transitionWorst: tracked.worst,
        sampleCount: tracked.samples.length
      })
    })

    await test.step('TAIL all-short no-overflow switch keeps the clicked tab stationary', async () => {
      const tinyTopicId = `csi-tiny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const builtTiny = buildAllShortEntries(tinyTopicId, liveAssistantId)
      await seedTopicViaMainAuthority(page, liveAssistantId, tinyTopicId, builtTiny.entries)
      const tinyItem = page.locator(`[data-testid="topic-item"][data-topic-id="${tinyTopicId}"]`)
      await tinyItem.waitFor({ state: 'attached', timeout: 15000 })
      await tinyItem.scrollIntoViewIfNeeded()
      await tinyItem.click()
      await page.waitForFunction(
        ({ topicId, tailIds }: { topicId: string; tailIds: string[] }) => {
          const s = (window as any).store.getState()
          const ids = s.messages?.messageIdsByTopic?.[topicId]
          if (!Array.isArray(ids)) return false
          return tailIds.every((id) => ids.includes(id))
        },
        { topicId: tinyTopicId, tailIds: [builtTiny.shortId, builtTiny.tallId] },
        { timeout: 30000 }
      )
      const tinyMembers = [builtTiny.shortId, builtTiny.tallId]
      expect(await authoritativeSelectedId(page, tinyTopicId, tinyMembers)).toBe(builtTiny.shortId)
      // No wheel positioning: total height is below the viewport, every row
      // is already fully visible. The click is still a real pointer click at
      // the recorded point with the pointer left in place.
      const tracked = await clickAnswerTabAndTrack(page, tinyTopicId, tinyMembers, builtTiny.tallId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, tinyTopicId, tinyMembers)).toBe(builtTiny.tallId)
      expect(await authoritySelectedId(page, tinyTopicId, tinyMembers)).toBe(builtTiny.tallId)
      const post = await captureTabGeometry(page, builtTiny.tallId)
      const drift = Math.abs(post.offset - tracked.pre.offset)
      const centerDrift = Math.hypot(post.center.x - tracked.pre.center.x, post.center.y - tracked.pre.center.y)
      test.info().annotations.push({
        type: 'csi-tiny-geometry',
        description: `tiny preOffset=${Math.round(tracked.pre.offset)} postOffset=${Math.round(post.offset)} drift=${drift.toFixed(1)} centerDrift=${centerDrift.toFixed(1)} worst=${tracked.worst.toFixed(1)} n=${tracked.samples.length}`
      })
      expect(drift, 'tiny: clicked tab stays at its previous viewport offset').toBeLessThanOrEqual(TAB_TOL)
      expect(centerDrift, 'tiny: clicked tab center stays').toBeLessThanOrEqual(TAB_TOL)
      expect(await hitTestTabAtPoint(page, tracked.point, builtTiny.tallId)).toBe(true)
      expect(tracked.worst, 'tiny: painted transition frames never jump').toBeLessThanOrEqual(TRANSITION_TOL)
    })
  })

  test('send-from-reading reaches actual latest bottom', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CHAT SCROLL INTENT B: a real textarea/Enter send from the older paginated window lands at actual latest/bottom (scrollTop~=0, newest rows visible, latest-window tail equals the new reply), never restored to the prior non-bottom position; a post-bottom real user wheel scroll-away stays reading (no forced bottom stick). Route-boundary send/switch race omitted: no deterministic bounded seam without mid-stream timing control (would need arbitrary delays/harness changes).'
    })
    const page: Page = mainWindow

    const { topicId } =
      await test.step('seed multi-model topic (17 rows) with displayCount=10 and cold-activate the tail window', async () =>
        await setupScrollIntentTopic(page))

    await test.step('B: load the older window, then send from non-bottom and reach actual latest bottom', async () => {
      await paginateToFullHistory(page, topicId)
      const preSend = await wheelToReadingPosition(page)
      const prevCount = await assistantCount(page, topicId)
      const sendText = `csi-send-bottom-${Date.now()}`
      clearRequestLog()
      const seqBefore = getRequestSequence()
      await uiSendMessage(page, sendText)
      await waitForAssistantResponseComplete(page, topicId, prevCount)
      const request = findProductRequestAfter(seqBefore)
      expect(request).not.toBeNull()
      expect(request!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))

      const tailIds = await page.evaluate((tid: string) => {
        const s = (window as any).store.getState()
        const ids: string[] = [...(s.messages?.messageIdsByTopic?.[tid] ?? [])]
        const roles: Record<string, string> = {}
        for (const id of ids) roles[id] = s.messages.entities?.[id]?.role ?? ''
        return { ids, roles }
      }, topicId)
      expect(tailIds.ids.length).toBe(19)
      const newUserId = tailIds.ids[tailIds.ids.length - 2]
      const newAssistantId = tailIds.ids[tailIds.ids.length - 1]
      expect(tailIds.roles[newUserId]).toBe('user')
      expect(tailIds.roles[newAssistantId]).toBe('assistant')

      // Viewport must be at the ACTUAL latest/bottom: column-reverse
      // scrollTop ~= 0 with the newest user + reply visible — and it must
      // not have been restored to the prior non-bottom position.
      await page.waitForFunction(
        (tol: number) => {
          const el = document.getElementById('messages') as HTMLElement | null
          return el ? Math.abs(el.scrollTop) <= tol : false
        },
        BOTTOM_TOL,
        { timeout: 15000 }
      )
      // Settle the post-stream glide before geometry reads: the bottom gate
      // above fires the instant scrollTop passes within tolerance (possibly
      // mid-glide of the production bottom settle), so single-shot row
      // visibility reads right after it race the glide — the reply (nearer
      // the bottom edge) can read visible while the user row above it has
      // not entered yet. Quiescence first (fail-loud drift report), then
      // auto-retrying visibility for residual micro-motion. Same predicates,
      // synchronized — never weakened.
      await waitForScrollQuiescence(page)
      const postScroll = await readScroll(page)
      expect(Math.abs(postScroll.scrollTop)).toBeLessThanOrEqual(BOTTOM_TOL)
      expect(Math.abs(postScroll.scrollTop - preSend.scrollTop)).toBeGreaterThan(200)
      await expect.poll(async () => await isRowVisibleInMessages(page, newAssistantId), { timeout: 15000 }).toBe(true)
      await expect.poll(async () => await isRowVisibleInMessages(page, newUserId), { timeout: 15000 }).toBe(true)

      // Read-only Main authority: latest window tail is the new reply, so
      // bottom means latest — not the previous window edge.
      const latest: any = await page.evaluate(
        async ({ topicId, limit }: { topicId: string; limit: number }) =>
          await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, limit }),
        { topicId, limit: DISPLAY_COUNT }
      )
      expect(latest?.ok).toBe(true)
      expect((latest.value as any)?.window?.lastMessageId).toBe(newAssistantId)
    })

    await test.step('B-post: real user wheel scroll-away from bottom stays reading', async () => {
      // Post-bottom user takeover via the same ordinary wheel seam: after the
      // send lands at bottom, a real wheel gesture must reach a verified
      // non-bottom reading position and settle there (no forced bottom
      // stick). Bounded via wheelToReadingPosition; no scrollTop writes.
      const away = await wheelToReadingPosition(page)
      const scroll = await readScroll(page)
      expect(Math.abs(scroll.scrollTop), 'post-bottom wheel scroll-away must leave bottom').toBeGreaterThan(
        NON_BOTTOM_MIN
      )
      expect(Math.abs(scroll.scrollTop - away.scrollTop), 'scroll-away position must settle').toBeLessThanOrEqual(
        RETAIN_SCROLL_DELTA
      )
    })
  })
})
