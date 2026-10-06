/**
 * Chat scroll intent — answer-tab retention + send-from-reading reaches latest bottom.
 *
 * Two independently runnable regressions (same file, shared helpers, no
 * cross-test state): `answer-tab unequal-height repeated switches retain the
 * reading viewport` (A1/A2/A3) and `send-from-reading reaches actual latest
 * bottom` (B + post-bottom wheel scroll-away). Each test seeds its own
 * disposable topic via setupScrollIntentTopic() so a production drift block
 * at A1 no longer leaves send untested — run either via `-g`.
 *
 * Bounded regression coverage ONLY (no production fix here; sibling owns
 * renderer + unit tests). Real Electron DOM, shared fixture, disposable
 * profile, mock provider, deterministic assertions.
 *
 * Contract A (answer-tab retention): from a verified non-bottom Chat reading
 * viewport on a topic whose mid-topic ask has two model answers (unequal
 * heights), clicking the actual `answer-group-selector` tab must change the
 * AUTHORITATIVE selection (Redux `foldSelected` + read-only Main
 * `getRawTopic`, not merely DOM tab styling) while the viewport stays at the
 * same reading location (stable visible anchor identity — or same-group
 * replaced-answer transfer — + normalized offset within ±12px, no bottom
 * jump), including repeated switches in both height directions. Raw
 * `scrollTop` invariance does NOT hold here: in column-reverse a different
 * answer height below the viewport necessarily changes `scrollTop` for the
 * SAME visual anchor, so the raw counter is not the user '保持位置' contract;
 * geometry (anchor identity + normalized offset + non-bottom) is primary and
 * any scroll-range delta is supporting only.
 *
 * Normalization (production policy, mirrored here — no implementation-ID
 * assert): the held intra-row offset survives EXACTLY when the selected
 * visible answer's real box can still represent it as a readable position;
 * otherwise it clamps to the nearest valid visible in-row position
 * `normalizeFoldAnchorOffset(original, h, vh)` = clamp into
 * `[-h+12, vh-12]` (min-visible 12px). Tall→short shrink with a far-above
 * pre offset therefore lands deterministically clamped, never at an
 * impossible offset and never at an unrelated tail/bottom. The E2E asserts
 * the authoritative selected answer, same-group membership, visible portion
 * >= 12px (minus the existing 1px geometry tolerance), and actual offset
 * within ±12px of the deterministic expected value.
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
const FOLD_MIN_VISIBLE_PX = 12
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

/**
 * Real Playwright pointer click on a visible answer-group-selector tab.
 * The tab must already sit fully inside the #messages viewport so the click
 * performs no test-induced auto-scroll (Playwright skips scrollIntoView when
 * the target is already fully visible). There is no DOM el.click() fallback:
 * a non-visible tab fails instead of bypassing pointer hit-testing.
 * Callers must establish the reading viewport with
 * wheelToReadingPositionWithTabVisible() first. Returns the delivery path.
 */
async function clickAnswerTab(page: Page, messageId: string): Promise<'pointer'> {
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
  await tab.click({ timeout: 10000 })
  return 'pointer'
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
 * Production-policy mirror (pure geometry, no implementation ID): clamps the
 * held intra-row offset into the visible range the replacement real box can
 * represent, `[-h+12, vh-12]` with 12px min-visible. Feasible offsets return
 * the EXACT original; infeasible ones clamp to the nearest valid visible
 * in-row position. Non-finite/non-positive geometry returns the original
 * fail-closed (caller holds nothing new) — same as production.
 */
function normalizeFoldAnchorOffset(originalOffset: number, replacementHeight: number, viewportHeight: number): number {
  if (!Number.isFinite(originalOffset)) return originalOffset
  if (!Number.isFinite(replacementHeight) || replacementHeight <= 0) return originalOffset
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return originalOffset
  const lower = -replacementHeight + FOLD_MIN_VISIBLE_PX
  const upper = viewportHeight - FOLD_MIN_VISIBLE_PX
  if (originalOffset < lower) return lower
  if (originalOffset > upper) return upper
  return originalOffset
}

/**
 * Real-box geometry of the selected visible answer: actual rendered box
 * height `h`, viewport height `vh`, visible portion, and live offset. Uses
 * the same any-candidate resolution as isRowVisibleInMessages (disambiguated
 * row selector first, then any data-message-id row, then the bare id) and
 * reports the intersecting visible candidate's real box — never a hidden or
 * box-less duplicate.
 */
async function measureFoldGeometry(
  page: Page,
  messageId: string
): Promise<{ h: number; vh: number; visible: number; offset: number; found: boolean }> {
  return page.evaluate((id: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return { h: NaN, vh: NaN, visible: 0, offset: NaN, found: false }
    const c = container.getBoundingClientRect()
    const vh = Number.isFinite(container.clientHeight) && container.clientHeight > 0 ? container.clientHeight : c.height
    const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const seen = new Set<Element>()
    const cands: HTMLElement[] = []
    const collect = (list: ArrayLike<Element>): void => {
      for (let i = 0; i < list.length; i++) {
        const el = list[i]
        if (el && !seen.has(el)) {
          seen.add(el)
          if (el instanceof HTMLElement) cands.push(el)
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
    let best: { h: number; visible: number; offset: number } | null = null
    for (const el of cands) {
      if (!el.isConnected) continue
      if (el.getAttribute('data-testid') === 'answer-group-selector') continue
      if (window.getComputedStyle(el).display === 'none') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      const visible = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)
      if (!(visible > 0)) continue
      const offset = r.top - c.top
      if (!best || visible > best.visible) best = { h: r.height, visible, offset }
    }
    if (!best) return { h: NaN, vh, visible: 0, offset: NaN, found: false }
    return { h: best.h, vh, visible: best.visible, offset: best.offset, found: true }
  }, messageId)
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

async function expectReadingRetained(
  page: Page,
  label: string,
  pre: Reading,
  opts?: { members?: string[]; selectedId?: string }
): Promise<void> {
  const anchor = await settledAnchor(page)
  const scroll = await readScroll(page)
  // Legitimate visible replacement only: if the pre-click anchor IS the replaced
  // (now hidden) answer of the same answer group, the keeper transfers it to the
  // selected visible sibling with production-policy normalization. Unrelated
  // visible rows must stay identical. Feasible offsets keep the EXACT original
  // (±12px); infeasible tall→short offsets clamp deterministically to the
  // nearest visible in-row position — never an unrelated tail/bottom.
  const members = opts?.members ?? []
  const selectedId = opts?.selectedId
  const isReplacedAnswer = !!selectedId && members.includes(pre.anchorId) && pre.anchorId !== selectedId
  const expectedId = isReplacedAnswer ? selectedId! : pre.anchorId
  if (isReplacedAnswer) {
    // Transfer precondition without first-match ambiguity: the replaced
    // answer must leave NO visible row (any-candidate resolution, same as
    // the visibility gate below) before the selected sibling may inherit
    // the anchor.
    const preStillVisible = await isRowVisibleInMessages(page, pre.anchorId)
    expect(preStillVisible, `${label}: pre anchor must be the hidden replaced answer to allow transfer`).toBe(false)
    const visible = await isRowVisibleInMessages(page, expectedId)
    expect(visible, `${label}: transferred anchor must be the visible selected answer`).toBe(true)
  }
  // Deterministic normalized expectation against the ACTUAL selected visible
  // box: clamp the old offset with the real replacement height h and the live
  // viewport vh (min-visible 12px). Feasible (A1/A3 short→tall) keeps the
  // previous exact-offset expectation; infeasible (A2 tall→short) expects the
  // clamped value. Geometry comes from the live DOM — narrow, never an
  // arbitrary range broad enough to hide a jump.
  const geo = await measureFoldGeometry(page, expectedId)
  expect(geo.found, `${label}: selected answer must have a measurable visible real box`).toBe(true)
  const expectedOffset = normalizeFoldAnchorOffset(pre.offset, geo.h, geo.vh)
  const clamped = expectedOffset !== pre.offset
  test.info().annotations.push({
    type: 'csi-normalized-offset',
    description: `${label} pre=${Math.round(pre.offset)} h=${Math.round(geo.h)} vh=${Math.round(geo.vh)} expected=${Math.round(expectedOffset)} clamped=${clamped} visible=${Math.round(geo.visible)}`
  })
  expect(anchor.id, `${label}: anchor identity retained`).toBe(expectedId)
  expect(
    Math.abs(anchor.offset - expectedOffset),
    `${label}: normalized anchor offset retained (expected=${Math.round(expectedOffset)} actual=${Math.round(anchor.offset)})`
  ).toBeLessThanOrEqual(OFFSET_TOL)
  // Same-group proof (production-policy min-visible, not an arbitrary ID):
  // the retained anchor must be the authoritative selected answer in the same
  // fold group — never an unrelated tail/bottom row.
  if (selectedId && members.length >= 2) {
    await expectSameFoldGroup(page, await currentTopicId(page), members[0], members[1], label)
    expect(members, `${label}: retained anchor must be a same-group member`).toContain(anchor.id)
  }
  // Known production-policy min-visible: the selected answer keeps a readable
  // visible portion (12px minus the existing 1px geometry tolerance).
  expect(
    geo.visible,
    `${label}: selected answer keeps min-visible readable portion (h=${Math.round(geo.h)} vh=${Math.round(geo.vh)})`
  ).toBeGreaterThanOrEqual(FOLD_MIN_VISIBLE_PX - 1)
  expect(Math.abs(scroll.scrollTop), `${label}: must remain non-bottom (no bottom jump)`).toBeGreaterThan(BOTTOM_TOL)
  // Painted-frame re-observation: after quiescence + settled anchor, two
  // rAF-separated frames must still report the same visible anchor/offset —
  // the retention is painted, not a transient layout sample. No raw
  // `scrollTop` invariance is asserted here: in column-reverse a different
  // answer height below the viewport necessarily changes `scrollTop` for the
  // SAME visual anchor, so the raw counter cannot define '保持位置'.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  const repainted = await readAnchor(page)
  expect(repainted?.id, `${label}: painted-frame anchor identity retained`).toBe(expectedId)
  expect(
    Math.abs((repainted?.offset ?? NaN) - expectedOffset),
    `${label}: painted-frame normalized anchor offset retained`
  ).toBeLessThanOrEqual(OFFSET_TOL)
  // Supporting metric only (geometry primary): explained scroll-range delta.
  // Height growth from the unequal-height answer swap shifts the valid
  // scroll range; report the range shift alongside the raw scroll shift so a
  // same-anchor retention with large `scrollTop` movement stays diagnosable
  // without gating on it. The only hard range gate is containment: the post
  // viewport must remain inside the live scroll range (no forced jump).
  const heightDelta = scroll.scrollHeight - pre.scrollHeight
  const scrollDelta = scroll.scrollTop - pre.scrollTop
  const topExtreme = -(scroll.scrollHeight - scroll.clientHeight)
  test.info().annotations.push({
    type: 'csi-retention-range',
    description: `${label} scrollDelta=${Math.round(scrollDelta)} heightDelta=${Math.round(heightDelta)} preTop=${Math.round(pre.scrollTop)} postTop=${Math.round(scroll.scrollTop)}`
  })
  expect(
    scroll.scrollTop,
    `${label}: post viewport stays inside the live scroll range (supporting)`
  ).toBeGreaterThanOrEqual(topExtreme - OFFSET_TOL)
  expect(scroll.scrollTop, `${label}: post viewport stays at/b above bottom (supporting)`).toBeLessThanOrEqual(
    OFFSET_TOL
  )
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

  test('answer-tab unequal-height repeated switches retain the reading viewport', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CHAT SCROLL INTENT A: real answer-group-selector pointer clicks flip authoritative foldSelected (Redux + read-only Main getRawTopic) with stable anchor identity/offset and no bottom jump across repeated unequal-height switches (short->tall, tall->short, short->tall repeat).'
    })
    const page: Page = mainWindow

    const { topicId, shortId, tallId, members } =
      await test.step('seed multi-model topic (17 rows) with displayCount=10 and cold-activate the tail window', async () =>
        await setupScrollIntentTopic(page))
    const tail = { shortId, tallId }

    await test.step('A1: switch short->tall from a verified non-bottom reading viewport without bottom jump', async () => {
      const pre = await wheelToReadingPositionWithTabVisible(page, tail.tallId)
      const delivery = await clickAnswerTab(page, tail.tallId)
      test.info().annotations.push({ type: 'csi-a1-delivery', description: `tab click delivery=${delivery}` })
      await waitForSelection(page, topicId, members, tail.tallId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.tallId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.tallId)
      await expectTabSelectionRendered(page, tail.tallId, tail.shortId)
      await expect(page.locator('#messages')).toContainText('csi-tall-answer-marker')
      await expectReadingRetained(page, 'A1 short->tall', pre, { members, selectedId: tail.tallId })
    })

    await test.step('A2: switch tall->short (unequal height reverse) retains the reading viewport', async () => {
      const pre = await wheelToReadingPositionWithTabVisible(page, tail.shortId)
      const delivery = await clickAnswerTab(page, tail.shortId)
      test.info().annotations.push({ type: 'csi-a2-delivery', description: `tab click delivery=${delivery}` })
      await waitForSelection(page, topicId, members, tail.shortId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.shortId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.shortId)
      await expectTabSelectionRendered(page, tail.shortId, tail.tallId)
      await expect(page.locator('#messages')).toContainText('csi-short-answer-marker')
      await expectReadingRetained(page, 'A2 tall->short', pre, { members, selectedId: tail.shortId })
    })

    await test.step('A2-snapshot: Settings roundtrip retains the normalized reconciled position', async () => {
      // The keeper transfers/normalizes the held live anchor, but the stored
      // route-key snapshot still refers to the old hidden answer until a
      // departure capture runs. This ordinary Chat→Settings→Chat roundtrip
      // (actual sidebar, existing seams only) proves the return shows the
      // current reconciled normalized position — same selected identity +
      // normalized offset — not a stale hidden snapshot.
      const stable = await settledAnchor(page)
      expect(stable.id, 'A2-snapshot precondition: reconciled anchor is the selected short answer').toBe(tail.shortId)
      const geoBefore = await measureFoldGeometry(page, tail.shortId)
      expect(geoBefore.found, 'A2-snapshot precondition: selected short answer has a visible real box').toBe(true)
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
      const after = await settledAnchor(page)
      expect(after.id, 'A2-snapshot: return keeps the reconciled selected identity').toBe(tail.shortId)
      expect(
        Math.abs(after.offset - stable.offset),
        `A2-snapshot: return keeps the normalized offset (before=${Math.round(stable.offset)} after=${Math.round(after.offset)})`
      ).toBeLessThanOrEqual(OFFSET_TOL)
      const geoAfter = await measureFoldGeometry(page, tail.shortId)
      expect(geoAfter.found, 'A2-snapshot: selected short answer still has a visible real box').toBe(true)
      expect(
        geoAfter.visible,
        'A2-snapshot: selected answer keeps min-visible readable portion'
      ).toBeGreaterThanOrEqual(FOLD_MIN_VISIBLE_PX - 1)
      const scrollAfter = await readScroll(page)
      expect(Math.abs(scrollAfter.scrollTop), 'A2-snapshot: return stays non-bottom').toBeGreaterThan(BOTTOM_TOL)
      // Supporting only: departure capture persists the reconciled snapshot.
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
        description: `return anchor=${after.id}@${Math.round(after.offset)} visible=${Math.round(geoAfter.visible)} snap=${snap ? JSON.stringify(snap).slice(0, 300) : 'null'}`
      })
    })

    await test.step('A3: repeated switch short->tall still retains the reading viewport', async () => {
      const pre = await wheelToReadingPositionWithTabVisible(page, tail.tallId)
      await clickAnswerTab(page, tail.tallId)
      await waitForSelection(page, topicId, members, tail.tallId)
      await waitForScrollQuiescence(page)
      expect(await authoritativeSelectedId(page, topicId, members)).toBe(tail.tallId)
      expect(await authoritySelectedId(page, topicId, members)).toBe(tail.tallId)
      await expectTabSelectionRendered(page, tail.tallId, tail.shortId)
      await expectReadingRetained(page, 'A3 short->tall repeat', pre, { members, selectedId: tail.tallId })
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
