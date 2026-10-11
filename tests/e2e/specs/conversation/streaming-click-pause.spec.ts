/**
 * Streaming click-to-pause follow — E2E.
 *
 * Bounded user-visible contract (real Electron DOM, shared fixture,
 * disposable profile, mocked provider, deterministic assertions):
 *
 * - During an active slow-stream reply on the displayed topic/route, ANY
 *   primary mouse press inside #messages immediately leaves the current
 *   viewport/visible-text screen position unchanged (no wheel needed) and
 *   later continued stream growth does NOT pull the viewport to the bottom.
 *   Generation continues and completes normally after the pause. Message
 *   controls (copy button and, by unit-covered gate, links/buttons/tabs)
 *   keep their normal native action AND pause — the pause never prevents,
 *   stops, or rewrites the action.
 * - Resume via the existing bottom navigation restores follow; a genuine
 *   real-wheel return to the exact physical bottom during an active stream
 *   also resumes follow (no navigation control needed). A subsequent
 *   send/new stream follows again. Presses outside #messages are out of
 *   scope here (structural container wiring is unit-covered; no dedicated
 *   outside-press E2E).
 * - Right-click presses, non-streaming clicks, and clicks on another
 *   (non-streaming) route never pause or disturb the follow. Text selection
 *   stays native and never jumps the viewport.
 *
 * Seams (existing only): #messages, [data-message-id],
 * [data-testid="topic-item"], window.store (introspection),
 * window.api.chatDb.ensureTopic/pasteMessagesToTopic (seed), window.keyv
 * (supporting only). Sends go through the real textarea/Enter; all pointer
 * input goes through the real mouse. Never dispatches scrollToBottom or
 * SEND_MESSAGE to fake a gesture.
 *
 * Geometry: #messages renders column-reverse, so bottom/newest is
 * scrollTop ~= 0 and reading positions are negative scrollTop.
 */
import type { Page } from '@playwright/test'

import { clearRequestLog, expect, findProductRequest, test } from '../../fixtures/electron.fixture'
import {
  EXTENDED_SLOW_STREAM_MARKER,
  getExtendedSlowStreamReply,
  getSlowStreamReply,
  SLOW_STREAM_MARKER
} from '../../fixtures/mock-openai-server'

const MODEL = 'mock-model'
const BOTTOM_TOL = 100
const PAUSED_MIN = 200
const IMMEDIATE_TOL = 6
const ANCHOR_TOL = 12
/** Product gate for genuine physical-bottom arrival (column-reverse scrollTop ~= 0). */
const PRODUCT_BOTTOM_TOL = 1
/** Meaningful post-pause hold growth: multiple chunks, bounded to the finite mock budget. */
const HOLD_GROWTH = 500

interface Anchor {
  id: string
  offset: number
}

/** Type text into the real textarea and submit via Enter (production send path). */
async function uiSendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ selector, value }: { selector: string; value: string }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', value: text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

/** Assistant-scoped rendered Markdown (user messages also render `.markdown`). */
function assistantMarkdown(page: Page): ReturnType<Page['locator']> {
  return page.locator('#messages .message-assistant .markdown').first()
}

/** Length of the currently streaming main-text block (by id), or null. */
async function streamBlockState(page: Page, blockId: string): Promise<{ status: string; length: number } | null> {
  return page.evaluate((id: string) => {
    const s = (window as any).store?.getState()
    const block = s?.messageBlocks?.entities?.[id]
    if (!block || block.type !== 'main_text') return null
    return { status: block.status as string, length: (block.content as string)?.length ?? 0 }
  }, blockId)
}

/** Id of the longest streaming main-text block (the active slow stream). */
async function findStreamingBlockId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const s = (window as any).store?.getState()
    if (!s?.messageBlocks?.entities) return null
    let best: string | null = null
    let bestLen = -1
    for (const block of Object.values(s.messageBlocks.entities) as any[]) {
      if (block?.type === 'main_text' && block?.status === 'streaming' && typeof block?.content === 'string') {
        if (block.content.length > bestLen) {
          bestLen = block.content.length
          best = block.id
        }
      }
    }
    return best
  })
}

async function waitForStreamingContent(page: Page, minLength: number): Promise<string> {
  const blockId = await page.waitForFunction(
    (min: number) => {
      const s = (window as any).store?.getState()
      if (!s?.messageBlocks?.entities) return null
      for (const block of Object.values(s.messageBlocks.entities) as any[]) {
        if (block?.type === 'main_text' && block?.status === 'streaming' && block?.content?.length > min) {
          return block.id as string
        }
      }
      return null
    },
    minLength,
    { timeout: 30000 }
  )
  return (await blockId.jsonValue()) as string
}

async function waitForBlockGrowth(page: Page, blockId: string, minLength: number): Promise<void> {
  await page.waitForFunction(
    ({ id, min }: { id: string; min: number }) => {
      const s = (window as any).store?.getState()
      const block = s?.messageBlocks?.entities?.[id]
      return !!block && typeof block.content === 'string' && block.content.length >= min
    },
    { id: blockId, min: minLength },
    { timeout: 30000 }
  )
}

/** Finite slow-stream budget: 4145 chars / 152 content chunks / 60ms (~9120ms). */
function slowStreamTotalLength(): number {
  return getSlowStreamReply(MODEL).length
}

/**
 * Extended slow-stream budget (wheel/zoom legs only): ~2x default at the same
 * 60ms realistic pacing — 300 paragraphs / 302 chunks (~18120ms, ~8200 chars).
 * Arithmetic: default sampler (3.5s ~= 58 chunks * ~27 chars ~= 1566) + hold
 * 500 + wheel return while active + resume 500 fits with margin; the default
 * 4145-char tail (len 4128/4145) starved the exact-bottom driver. Default
 * stays byte-identical for every other spec.
 */
function extendedSlowStreamTotalLength(): number {
  return getExtendedSlowStreamReply(MODEL).length
}

/**
 * Budget-guarded growth wait (diagnostic numerics only — never raw content,
 * user data, or paths). Logs initial length/status/total/remaining before
 * waiting; on timeout re-reads final length/status and throws with the same
 * numerics so a budget-exhausted wait is distinguishable from a pause bug.
 * The caller passes the scenario-correct total (default vs extended); when
 * omitted the default total applies so non-XL legs keep their arithmetic.
 */
async function waitForBlockGrowthWithBudget(
  page: Page,
  blockId: string,
  target: number,
  label: string,
  scenarioTotal?: number
): Promise<void> {
  const total = scenarioTotal ?? slowStreamTotalLength()
  const initial = await streamBlockState(page, blockId)
  const initLen = initial?.length ?? -1
  const initStatus = initial?.status ?? '?'
  console.log(
    `[E2E] ${label} wait: initLen=${initLen} target=${target} total=${total} remaining=${total - initLen} status=${initStatus}`
  )
  try {
    await waitForBlockGrowth(page, blockId, target)
  } catch (e) {
    const final = await streamBlockState(page, blockId)
    throw new Error(
      `[E2E] ${label} growth wait failed: initLen=${initLen} target=${target} total=${total} ` +
        `remaining=${total - initLen} finalLen=${final?.length ?? -1} finalStatus=${final?.status ?? '?'}: ` +
        (e instanceof Error ? e.message : String(e))
    )
  }
  const done = await streamBlockState(page, blockId)
  console.log(`[E2E] ${label} wait done: finalLen=${done?.length ?? -1} finalStatus=${done?.status ?? '?'}`)
}

async function readScrollTop(page: Page): Promise<number> {
  return page.locator('#messages').evaluate((el) => el.scrollTop)
}

/** Crossing-first visible anchor + container-relative offset (repo convention).
 * Deduplicates by message id to the real content box (the element carrying
 * BOTH `id="message-<id>"` and `data-message-id`), mirroring the production
 * keeper resolution — duplicate wrappers must never flip the measured box
 * between samples. */
async function readAnchor(page: Page): Promise<Anchor | null> {
  return page.evaluate(() => {
    const container = document.querySelector('#messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const rows = Array.from(
      document.querySelectorAll('#messages [data-message-id]:not([data-testid="answer-group-selector"])')
    ) as HTMLElement[]
    const byId = new Map<string, HTMLElement[]>()
    for (const row of rows) {
      if (row.getAttribute('data-testid') === 'answer-group-selector') continue
      const id = row.getAttribute('data-message-id')
      if (!id) continue
      const list = byId.get(id)
      if (list) list.push(row)
      else byId.set(id, [row])
    }
    const cands: { id: string; top: number; bottom: number }[] = []
    for (const [id, els] of byId) {
      const box = els.find((el) => el.id === `message-${id}`) ?? els[0]
      const r = box.getBoundingClientRect()
      cands.push({ id, top: r.top, bottom: r.bottom })
    }
    if (cands.length === 0) return null
    const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
    const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
    return { id: picked.id, offset: picked.top - c.top }
  })
}

/**
 * A visible reading-content point: center of a paragraph fully inside
 * #messages. Controls inside the viewport ALSO pause under the corrected
 * contract (proven by the control test + unit gate below), so this helper
 * only prefers a non-control hit for the content-press legibility — it is
 * not an exclusion rule.
 */
async function findReadingPoint(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const paras = Array.from(document.querySelectorAll('#messages .markdown p')) as HTMLElement[]
    const interactive =
      'button,a,input,textarea,select,summary,video,audio,img,[contenteditable],[data-testid="answer-group-selector"],[role="button"],[role="menu"]'
    for (const p of paras) {
      const r = p.getBoundingClientRect()
      if (r.width < 40 || r.height < 8) continue
      if (r.top < c.top + 4 || r.bottom > c.bottom - 4) continue
      const x = r.x + r.width / 2
      const y = r.y + Math.min(r.height / 2, 20)
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      if (!hit) continue
      try {
        if (typeof hit.closest === 'function' && hit.closest(interactive)) continue
      } catch {
        continue
      }
      return { x, y }
    }
    return null
  })
}

interface VerifiedReadingTarget {
  x: number
  y: number
  head: string
  rowId: string | null
  pTop: number
  pBottom: number
}

/** Fresh geometry + identity for one fully-visible non-control paragraph (event-time trace source). */
async function readVerifiedReadingTarget(page: Page): Promise<VerifiedReadingTarget | null> {
  return page.evaluate(() => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const paras = Array.from(document.querySelectorAll('#messages .markdown p')) as HTMLElement[]
    const interactive =
      'button,a,input,textarea,select,summary,video,audio,img,[contenteditable],[data-testid="answer-group-selector"],[role="button"],[role="menu"]'
    for (const p of paras) {
      const r = p.getBoundingClientRect()
      if (r.width < 40 || r.height < 8) continue
      if (r.top < c.top + 4 || r.bottom > c.bottom - 4) continue
      const x = r.x + r.width / 2
      const y = r.y + Math.min(r.height / 2, 20)
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      if (!hit) continue
      try {
        if (typeof hit.closest === 'function' && hit.closest(interactive)) continue
      } catch {
        continue
      }
      const hitP =
        hit && typeof hit.closest === 'function' ? (hit.closest('#messages .markdown p') as HTMLElement | null) : null
      if (hitP !== p) continue
      const row = p.closest?.('#messages [data-message-id]') as HTMLElement | null
      return {
        x,
        y,
        head: (p.textContent ?? '').slice(0, 40),
        rowId: row?.getAttribute('data-message-id') ?? null,
        pTop: r.top,
        pBottom: r.bottom
      }
    }
    return null
  })
}

/**
 * Verified real press on a REAL event-time paragraph (native mouse only, no
 * programmatic pointer dispatch, no DOM.click). Stabilizes the known
 * paragraph identity: acquires a fresh target, moves the physical mouse to
 * its CURRENT geometry, re-verifies elementFromPoint still hits the SAME
 * paragraph identity, then presses immediately. Retries on continuous-growth
 * drift between read/move/down. Logs the event-time rect/hit precondition
 * for diagnosis; the sampler probe still resolves the ACTUAL hit at event
 * time and its null assertion is never weakened.
 */
async function pressVerifiedReadingPoint(page: Page, attempts = 6): Promise<VerifiedReadingTarget> {
  let last: VerifiedReadingTarget | null = null
  for (let i = 0; i < attempts; i++) {
    const target = await readVerifiedReadingTarget(page)
    if (!target || !target.rowId) {
      await page.waitForTimeout(120)
      continue
    }
    last = target
    await page.mouse.move(target.x, target.y)
    const fresh = await page.evaluate(
      ({ x, y, head }: { x: number; y: number; head: string }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null
        const p =
          hit && typeof hit.closest === 'function' ? (hit.closest('#messages .markdown p') as HTMLElement | null) : null
        const r = p?.getBoundingClientRect()
        const row = p?.closest?.('#messages [data-message-id]') as HTMLElement | null
        return {
          hasP: !!p,
          sameHead: (p?.textContent ?? '').slice(0, 40) === head,
          rowId: row?.getAttribute('data-message-id') ?? null,
          pTop: r?.top ?? NaN,
          pBottom: r?.bottom ?? NaN
        }
      },
      { x: target.x, y: target.y, head: target.head }
    )
    console.log(
      `[E2E] pause-press pre-press attempt=${i} x=${Math.round(target.x)} y=${Math.round(target.y)} ` +
        `head=${JSON.stringify(target.head.slice(0, 24))} row=${target.rowId} ` +
        `hasP=${fresh.hasP} sameHead=${fresh.sameHead} freshRow=${fresh.rowId} ` +
        `pTop=${Number(target.pTop).toFixed(1)}->${Number(fresh.pTop).toFixed(1)}`
    )
    if (!fresh.hasP || !fresh.sameHead || !fresh.rowId) {
      await page.waitForTimeout(120)
      continue
    }
    // Geometry verified fresh — press immediately with no further evaluate gap.
    await page.mouse.down()
    await page.mouse.up()
    return target
  }
  throw new Error(
    `[E2E] no verified reading paragraph stabilized after ${attempts} attempts ` +
      `(lastRow=${last?.rowId ?? 'null'} lastHead=${JSON.stringify(last?.head?.slice(0, 24) ?? 'null')})`
  )
}

async function currentTopicId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).store.getState().messages?.currentTopicId as string)
}

/**
 * Center of a genuinely visible user-message copy button (no auto-scroll):
 * hovers the owning user row to reveal the menubar, then returns the button
 * center ONLY when it is fully inside the #messages viewport and hit-tests
 * to itself. Returns null when no such button exists (caller fails loudly —
 * never scrolls a control into view for the press).
 */
async function findVisibleUserCopyPoint(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const btns = Array.from(
      document.querySelectorAll('#messages .message-user [data-testid="msg-copy-btn"]')
    ) as HTMLElement[]
    for (let i = btns.length - 1; i >= 0; i--) {
      const btn = btns[i]
      const r = btn.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      if (r.top < c.top + 2 || r.bottom > c.bottom - 2 || r.left < c.left + 2 || r.right > c.right - 2) continue
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      if (!hit) continue
      if (hit !== btn && !(typeof hit.closest === 'function' && hit.closest('[data-testid="msg-copy-btn"]'))) continue
      return { x, y }
    }
    return null
  })
}

/** Hover the newest user row so its menubar copy button reveals (no scroll). */
async function hoverNewestUserRow(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const container = document.getElementById('messages') as HTMLElement | null
    const c = container?.getBoundingClientRect()
    if (!c) return null
    const rows = Array.from(document.querySelectorAll('#messages .message-user')) as HTMLElement[]
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i].getBoundingClientRect()
      if (r.width < 60 || r.height < 8) continue
      const x = Math.min(Math.max(r.x + r.width / 2, c.left + 10), c.right - 10)
      const y = Math.min(Math.max(r.y + r.height / 2, c.top + 10), c.bottom - 10)
      if (x < c.left || x > c.right || y < c.top || y > c.bottom) continue
      return { x, y }
    }
    return null
  })
  if (!point) throw new Error('no visible user row to hover (no auto-scroll)')
  await page.mouse.move(point.x, point.y)
  await page.waitForTimeout(600)
}

/** Poll the repository clipboard seam until it contains `needle` (stale-safe). */
async function waitForClipboardToContain(page: Page, needle: string, timeoutMs = 8000): Promise<string> {
  const start = Date.now()
  let last: string | null = null
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(async () => {
      try {
        if ((window as any).api?.clipboard?.readText) return await (window as any).api.clipboard.readText()
        return await navigator.clipboard.readText()
      } catch {
        return null
      }
    })
    if (typeof last === 'string' && last.includes(needle)) return last
    await page.waitForTimeout(200)
  }
  throw new Error(`clipboard never contained "${needle.slice(0, 60)}" (last=${JSON.stringify(last)?.slice(0, 120)})`)
}

async function getLiveAssistantId(page: Page): Promise<string> {
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

/** Seed a small inert topic via Main authority (for the other-route check). */
async function seedInertTopic(page: Page, topicId: string): Promise<void> {
  const liveAssistantId = await getLiveAssistantId(page)
  const stamp = '2026-01-01T00:00:00.000Z'
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < 6; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    entries.push({
      message: {
        id: msgId,
        topicId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        assistantId: liveAssistantId,
        createdAt: stamp,
        updatedAt: stamp,
        status: 'success',
        blocks: [blockId],
        sortOrder: i
      },
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: `inert seed paragraph ${i} ${'filler words '.repeat(20)}`,
          status: 'success',
          createdAt: stamp,
          updatedAt: stamp
        }
      ]
    })
  }
  const addOk = await page.evaluate(
    ({ topicId, assistantId }: { topicId: string; assistantId: string }) => {
      try {
        const store = (window as any).store
        store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name: `Inert ${topicId}`,
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
    { topicId, assistantId: liveAssistantId }
  )
  expect(addOk.ok).toBe(true)
  const persist = await page.evaluate(
    async ({ topicId, assistantId, entries }: { topicId: string; assistantId: string; entries: unknown }) => {
      try {
        const chatDb = (window as any).api?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function')
          return { ok: false, err: 'chatDb missing' }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name: `Inert ${topicId}` })
        if (!ensured || ensured.ok !== true) return { ok: false, err: 'ensureTopic failed' }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: 'paste failed' }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, entries }
  )
  expect(persist.ok).toBe(true)
}

async function activateTopic(page: Page, topicId: string): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    (tid: string) => (window as any).store.getState().messages?.currentTopicId === tid,
    topicId,
    { timeout: 15000 }
  )
  await page.waitForFunction(
    (tid: string) =>
      document.querySelectorAll(`#messages [data-message-id]`).length > 0 &&
      (window as any).store.getState().messages?.currentTopicId === tid,
    topicId,
    { timeout: 30000 }
  )
}

interface PauseProbeFrame {
  t: number
  pTop: number
  pBottom: number
  pOffset: number
  scrollTop: number
  scrollHeight: number
  len: number
  status: string
  connected: boolean
  head: string
}

interface PauseProbe {
  event: any
  micro: any
  raf: any
  long: { frames: PauseProbeFrame[]; done: boolean }
}

/**
 * Shared atomic pause-press sampler (single implementation for all pause
 * tests): installs the native pointerdown CAPTURE probe resolving the ACTUAL
 * hit paragraph/row at event time, performs a VERIFIED real primary press on
 * a CURRENT-geometry paragraph (fresh acquire + hit re-verify, retry on
 * continuous-growth drift), waits the >=3s same-element rAF window, collects
 * and returns the log. The tracked length is the CURRENT topic block id
 * passed in (never a global max — a prior probe used a cross-topic counter
 * and reported negative growth). Observational only, no viewport mutation.
 * The optional point param is a hover hint only; the press itself always uses
 * fresh verified geometry so a stale findReadingPoint can never fake or null
 * the event row.
 */
async function performAtomicPauseProbe(
  page: Page,
  point: { x: number; y: number } | null,
  blockId: string
): Promise<PauseProbe> {
  if (point) {
    await page.mouse.move(point.x, point.y)
  }
  await page.evaluate((id: string) => {
    const w = window as any
    try {
      w.__pauseProbeCleanup?.()
    } catch {
      /* ignore stale cleanup */
    }
    delete w.__pauseProbe
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) throw new Error('#messages missing for pause probe')
    let clickedP: HTMLElement | null = null
    let clickedRow: HTMLElement | null = null
    const tuple = () => {
      const c = container.getBoundingClientRect()
      const pR = clickedP?.getBoundingClientRect()
      const rR = clickedRow?.getBoundingClientRect()
      return {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        cTop: c.top,
        pTop: pR?.top ?? NaN,
        pBottom: pR?.bottom ?? NaN,
        pOffset: pR ? pR.top - c.top : NaN,
        pTextLen: clickedP?.textContent?.length ?? -1,
        pTextHead: (clickedP?.textContent ?? '').slice(0, 80),
        rowId: clickedRow?.getAttribute('data-message-id') ?? null,
        rowTop: rR?.top ?? NaN,
        rowOffset: rR ? rR.top - c.top : NaN,
        dpr: window.devicePixelRatio ?? NaN
      }
    }
    const blockState = () => {
      const s = (window as any).store?.getState()
      const blk = s?.messageBlocks?.entities?.[id]
      return {
        len: typeof blk?.content === 'string' ? (blk.content as string).length : -1,
        status: blk?.status ?? '?'
      }
    }
    const log: any = { event: null, micro: null, raf: null, long: { frames: [], done: false } }
    const cleanup = () => {
      document.removeEventListener('pointerdown', onDown, true)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const t = e.target as HTMLElement | null
      const byTarget =
        t && typeof t.closest === 'function' ? (t.closest('#messages .markdown p') as HTMLElement | null) : null
      let p: HTMLElement | null = byTarget
      if (!p) {
        const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        p =
          hit && typeof hit.closest === 'function' ? (hit.closest('#messages .markdown p') as HTMLElement | null) : null
      }
      clickedP = p
      clickedRow = p?.closest?.('#messages [data-message-id]') as HTMLElement | null
      log.event = { ...tuple(), clientX: e.clientX, clientY: e.clientY }
      Promise.resolve().then(() => {
        log.micro = tuple()
      })
      requestAnimationFrame(() => {
        log.raf = tuple()
      })
      const t0 = performance.now()
      const head0 = (clickedP?.textContent ?? '').slice(0, 40)
      const step = () => {
        const now = performance.now()
        const c = container.getBoundingClientRect()
        const r = clickedP?.getBoundingClientRect()
        const bs = blockState()
        log.long.frames.push({
          t: now - t0,
          pTop: r?.top ?? NaN,
          pBottom: r?.bottom ?? NaN,
          pOffset: r ? r.top - c.top : NaN,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          len: bs.len,
          status: bs.status,
          connected: clickedP ? document.contains(clickedP) : false,
          head: (clickedP?.textContent ?? '').slice(0, 80)
        })
        void head0
        if (now - t0 < 3500) requestAnimationFrame(step)
        else log.long.done = true
      }
      requestAnimationFrame(step)
      cleanup()
    }
    document.addEventListener('pointerdown', onDown, true)
    w.__pauseProbe = log
    w.__pauseProbeCleanup = cleanup
  }, blockId)
  // Verified native press: fresh CURRENT-geometry paragraph, hit re-verified
  // before down (retry on drift). Probe captures the ACTUAL event-time hit.
  await pressVerifiedReadingPoint(page)
  await page.waitForFunction(() => !!(window as any).__pauseProbe?.raf, undefined, { timeout: 15000 })
  await page.waitForFunction(() => (window as any).__pauseProbe?.long?.done === true, undefined, {
    timeout: 30000
  })
  const probe = (await page.evaluate(() => {
    const w = window as any
    const log = w.__pauseProbe
    try {
      w.__pauseProbeCleanup?.()
    } catch {
      /* ignore stale cleanup */
    }
    delete w.__pauseProbe
    delete w.__pauseProbeCleanup
    return log
  })) as PauseProbe
  return probe
}

/** Live device-pixel quantum + wrapper extent (same wrapper the keeper writes). */
async function readWrapperQuantum(page: Page): Promise<{ dpr: number; inlineVar: string; height: number }> {
  return page.evaluate(() => {
    const container = document.getElementById('messages') as HTMLElement | null
    const wrapper = (container?.firstElementChild ?? null) as HTMLElement | null
    const r = wrapper?.getBoundingClientRect()
    return {
      dpr: window.devicePixelRatio ?? NaN,
      inlineVar: wrapper?.style.getPropertyValue('--messages-pixel-size') ?? '',
      height: r?.height ?? NaN
    }
  })
}

test.describe('Streaming click-to-pause follow', () => {
  test('primary content press pauses follow without moving text; resume and controls hold', async ({ mainWindow }) => {
    test.setTimeout(240000)
    const page = mainWindow
    clearRequestLog()

    // Seed the inert other-route topic BEFORE streaming (no race with growth).
    const inertTopicId = `inert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedInertTopic(page, inertTopicId)

    // ═══════════════════════════════════════════════════════════════════
    // STREAM A — follow-preservation checks (no pause yet)
    // ═══════════════════════════════════════════════════════════════════
    await uiSendMessage(page, `first slow stream ${SLOW_STREAM_MARKER}`)
    const topicA = await currentTopicId(page)
    let blockA = await waitForStreamingContent(page, 2000)
    const productReq: unknown = findProductRequest()
    expect(productReq).not.toBeNull()

    // Deterministic bottom-follow baseline: scrollable and pinned to bottom.
    await page.waitForFunction(
      (tol: number) => {
        const el = document.getElementById('messages') as HTMLElement | null
        if (!el) return false
        return el.scrollHeight - el.clientHeight > 500 && Math.abs(el.scrollTop) <= tol
      },
      BOTTOM_TOL,
      { timeout: 30000 }
    )

    // ── Right-click never pauses: still following after further growth. ──
    const rightPoint = await findReadingPoint(page)
    expect(rightPoint, 'visible reading point for right-click must exist').not.toBeNull()
    const lenBeforeRight = (await streamBlockState(page, blockA))?.length ?? 0
    await page.mouse.click(rightPoint!.x, rightPoint!.y, { button: 'right' })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await waitForBlockGrowth(page, blockA, lenBeforeRight + 800)
    expect(await readScrollTop(page), 'right-click must not pause follow').toBeLessThanOrEqual(BOTTOM_TOL)

    // ── Other-route clicks never disturb this route's follow. ──
    await activateTopic(page, inertTopicId)
    const inertPoint = await findReadingPoint(page)
    expect(inertPoint, 'visible reading point on the inert route must exist').not.toBeNull()
    await page.mouse.click(inertPoint!.x, inertPoint!.y)
    await page.waitForTimeout(400)
    await activateTopic(page, topicA)
    const stillStreamingA = await findStreamingBlockId(page)
    expect(stillStreamingA, 'stream A must still be active after the other-route detour').not.toBeNull()
    blockA = stillStreamingA as string
    expect(await readScrollTop(page), 'other-route clicks must not disturb follow').toBeLessThanOrEqual(BOTTOM_TOL)

    // Stream A completes normally (no pause was ever engaged).
    const expectedA = getSlowStreamReply(MODEL)
    await page.waitForFunction(
      (expected: string) => {
        const s = (window as any).store?.getState()
        if (!s?.messageBlocks?.entities) return false
        for (const block of Object.values(s.messageBlocks.entities) as any[]) {
          if (block?.type === 'main_text' && block?.content === expected && block?.status === 'success') return true
        }
        return false
      },
      expectedA,
      { timeout: 60000 }
    )
    await expect(assistantMarkdown(page)).toContainText('tail-marker-END', { timeout: 10000 })

    // ── Non-streaming click is a no-op (no pause state to enter). ──
    const idleTop = await readScrollTop(page)
    const idlePoint = await findReadingPoint(page)
    expect(idlePoint, 'visible reading point after completion must exist').not.toBeNull()
    await page.mouse.click(idlePoint!.x, idlePoint!.y)
    await page.waitForTimeout(500)
    expect(Math.abs((await readScrollTop(page)) - idleTop), 'non-streaming click changes nothing').toBeLessThanOrEqual(
      BOTTOM_TOL
    )

    // ═══════════════════════════════════════════════════════════════════
    // STREAM B — pause / selection / controls / resume
    // ═══════════════════════════════════════════════════════════════════
    await uiSendMessage(page, `second slow stream ${SLOW_STREAM_MARKER}`)
    const blockB = await waitForStreamingContent(page, 2000)
    await page.waitForFunction(
      (tol: number) => {
        const el = document.getElementById('messages') as HTMLElement | null
        if (!el) return false
        return el.scrollHeight - el.clientHeight > 500 && Math.abs(el.scrollTop) <= tol
      },
      BOTTOM_TOL,
      { timeout: 30000 }
    )

    // ── Primary press pauses: viewport/text unmoved at once, growth never pulls to bottom. ──
    // Atomic event-time probe (strictly observational): a native pointerdown
    // CAPTURE listener records the container + the ACTUAL hit paragraph/row
    // (same DOM element) at event time, then re-samples the SAME element in a
    // microtask (after the synchronous React handler) and on the first rAF
    // (after paint). All immediate assertions compare these synchronous
    // tuples — never two separate wire reads across stream chunks. Threshold
    // IMMEDIATE_TOL is unchanged; raw scroll is only guarded with growth
    // compensation, paint stability is the real claim.
    const pauseHint = await findReadingPoint(page)
    expect(pauseHint, 'visible reading point for pause must exist').not.toBeNull()
    const lenAtPause = (await streamBlockState(page, blockB))?.length ?? 0
    if (pauseHint) {
      await page.mouse.move(pauseHint.x, pauseHint.y)
    }
    await page.evaluate((blockId: string) => {
      const w = window as any
      try {
        w.__pauseProbeCleanup?.()
      } catch {
        /* ignore stale cleanup */
      }
      delete w.__pauseProbe
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) throw new Error('#messages missing for pause probe')
      let clickedP: HTMLElement | null = null
      let clickedRow: HTMLElement | null = null
      const tuple = () => {
        const c = container.getBoundingClientRect()
        const pR = clickedP?.getBoundingClientRect()
        const rR = clickedRow?.getBoundingClientRect()
        return {
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
          cTop: c.top,
          pTop: pR?.top ?? NaN,
          pBottom: pR?.bottom ?? NaN,
          pOffset: pR ? pR.top - c.top : NaN,
          pTextLen: clickedP?.textContent?.length ?? -1,
          pTextHead: (clickedP?.textContent ?? '').slice(0, 80),
          rowId: clickedRow?.getAttribute('data-message-id') ?? null,
          rowTop: rR?.top ?? NaN,
          rowOffset: rR ? rR.top - c.top : NaN,
          dpr: window.devicePixelRatio ?? NaN
        }
      }
      const blockState = () => {
        const s = (window as any).store?.getState()
        const blk = s?.messageBlocks?.entities?.[blockId]
        return {
          len: typeof blk?.content === 'string' ? (blk.content as string).length : -1,
          status: blk?.status ?? '?'
        }
      }
      const log: any = { event: null, micro: null, raf: null, long: { frames: [], done: false } }
      const cleanup = () => {
        document.removeEventListener('pointerdown', onDown, true)
      }
      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return
        const t = e.target as HTMLElement | null
        const byTarget =
          t && typeof t.closest === 'function' ? (t.closest('#messages .markdown p') as HTMLElement | null) : null
        let p: HTMLElement | null = byTarget
        if (!p) {
          const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
          p =
            hit && typeof hit.closest === 'function'
              ? (hit.closest('#messages .markdown p') as HTMLElement | null)
              : null
        }
        clickedP = p
        clickedRow = p?.closest?.('#messages [data-message-id]') as HTMLElement | null
        log.event = { ...tuple(), clientX: e.clientX, clientY: e.clientY }
        Promise.resolve().then(() => {
          log.micro = tuple()
        })
        requestAnimationFrame(() => {
          log.raf = tuple()
        })
        // Persistent VISIBLE completed-paragraph sampler on the SAME hit
        // paragraph element (same DOM identity): rAF top over >=3s while the
        // slow stream keeps growing elsewhere. Observational only — no
        // mutation of controller/viewport state.
        const t0 = performance.now()
        const head0 = (clickedP?.textContent ?? '').slice(0, 40)
        const step = () => {
          const now = performance.now()
          const c = container.getBoundingClientRect()
          const r = clickedP?.getBoundingClientRect()
          const bs = blockState()
          log.long.frames.push({
            t: now - t0,
            pTop: r?.top ?? NaN,
            pBottom: r?.bottom ?? NaN,
            pOffset: r ? r.top - c.top : NaN,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            len: bs.len,
            status: bs.status,
            connected: clickedP ? document.contains(clickedP) : false,
            head: (clickedP?.textContent ?? '').slice(0, 80)
          })
          void head0
          if (now - t0 < 3500) requestAnimationFrame(step)
          else log.long.done = true
        }
        requestAnimationFrame(step)
        cleanup()
      }
      document.addEventListener('pointerdown', onDown, true)
      w.__pauseProbe = log
      w.__pauseProbeCleanup = cleanup
    }, blockB)
    // Verified native press (no DOM.click, no synthetic dispatch): fresh
    // CURRENT-geometry paragraph with hit re-verified before down; the probe
    // still resolves the ACTUAL hit paragraph/row at event time (null
    // assertion unchanged) so drift can never fake the baseline.
    await pressVerifiedReadingPoint(page)
    await page.waitForFunction(() => !!(window as any).__pauseProbe?.raf, undefined, { timeout: 15000 })
    // Long-window sampler: >=3s of rAF frames on the SAME paragraph while
    // the stream is still actively growing (meaningful growth, not tail).
    await page.waitForFunction(() => (window as any).__pauseProbe?.long?.done === true, undefined, {
      timeout: 30000
    })
    const probe = await page.evaluate(() => {
      const w = window as any
      const log = w.__pauseProbe
      try {
        w.__pauseProbeCleanup?.()
      } catch {
        /* ignore stale cleanup */
      }
      delete w.__pauseProbe
      delete w.__pauseProbeCleanup
      return log
    })
    expect(probe?.event, 'pause probe must capture the pointerdown event tuple').toBeTruthy()
    expect(probe?.micro, 'pause probe must capture the post-handler microtask tuple').toBeTruthy()
    expect(probe?.raf, 'pause probe must capture the first-rAF paint tuple').toBeTruthy()
    expect(probe.event.rowId, 'pause press must hit a real reading row').toBeTruthy()
    expect(probe.event.pTextLen, 'pause press must hit a real paragraph').toBeGreaterThan(0)
    // Same DOM element / paragraph value: append-only growth is legitimate,
    // re-render replacement is not.
    for (const key of ['micro', 'raf'] as const) {
      expect(probe[key].rowId, `same hit row at ${key}`).toBe(probe.event.rowId)
      expect(probe[key].pTextLen, `paragraph text never shrinks at ${key}`).toBeGreaterThanOrEqual(probe.event.pTextLen)
      expect(probe[key].pTextHead.slice(0, 40), `paragraph value preserved at ${key}`).toBe(
        probe.event.pTextHead.slice(0, 40)
      )
    }
    // Paint stability at the actual hit: the ONLY legitimate motion is keeper
    // compensation for real growth; raw scroll is guarded with that
    // compensation, paragraph/row paint offsets must simply hold.
    for (const key of ['micro', 'raf'] as const) {
      const growth = Math.abs(probe[key].scrollHeight - probe.event.scrollHeight)
      expect(
        Math.abs(probe[key].scrollTop - probe.event.scrollTop),
        `pause press never repositions the viewport beyond stream growth (${key})`
      ).toBeLessThanOrEqual(growth + IMMEDIATE_TOL)
      expect(
        Math.abs(probe[key].pOffset - probe.event.pOffset),
        `pause press never moves the pressed paragraph paint (${key})`
      ).toBeLessThanOrEqual(IMMEDIATE_TOL)
      expect(
        Math.abs(probe[key].rowOffset - probe.event.rowOffset),
        `pause press never moves the pressed row paint (${key})`
      ).toBeLessThanOrEqual(IMMEDIATE_TOL)
    }
    console.log(
      `[E2E] pause-press atomic: row=${probe.event.rowId} ` +
        `event{top=${Math.round(probe.event.scrollTop)} h=${probe.event.scrollHeight} pOff=${probe.event.pOffset.toFixed(1)}} ` +
        `micro{top=${Math.round(probe.micro.scrollTop)} h=${probe.micro.scrollHeight} pOff=${probe.micro.pOffset.toFixed(1)}} ` +
        `raf{top=${Math.round(probe.raf.scrollTop)} h=${probe.raf.scrollHeight} pOff=${probe.raf.pOffset.toFixed(1)}}`
    )
    // ── Long-window 1px-jitter regression: SAME completed paragraph element ──
    // rAF pTop over >=3s with >=500 chars of ongoing streaming growth. The
    // hit paragraph is a fully-visible already-rendered paragraph (not the
    // growing tail, not the root row): its paint top must hold within one
    // Chromium layout quantum (1/64 CSS px, exact) at DPR1 provenance. Any
    // re-render replacement or fractional root-start walk shows up here as
    // element detachment, text-prefix churn, or multi-quantum drift. A second
    // DPR point is NOT claimed: the shared Electron fixture exposes no
    // supported DPR control (CDP emulation would not be native DPR), so the
    // single DPR1 point below carries the provenance label.
    expect(probe?.long?.done, 'long sampler must complete its >=3s window').toBe(true)
    const frames = (probe.long.frames ?? []) as Array<{
      t: number
      pTop: number
      pBottom: number
      pOffset: number
      scrollTop: number
      scrollHeight: number
      len: number
      status: string
      connected: boolean
      head: string
    }>
    expect(frames.length, 'long sampler must hold many rAF frames').toBeGreaterThan(60)
    const duration = frames.length > 0 ? frames[frames.length - 1].t : 0
    expect(duration, 'long sampler window must span >=3000ms').toBeGreaterThanOrEqual(3000)
    for (const f of frames) {
      expect(f.connected, 'same paragraph DOM identity stays connected').toBe(true)
      expect(f.head.slice(0, 40), 'same paragraph text prefix preserved (no chunk replacement)').toBe(
        probe.event.pTextHead.slice(0, 40)
      )
    }
    const lens = frames.map((f) => f.len)
    const growth = Math.max(...lens) - Math.min(...lens)
    expect(
      growth,
      'sampler window must include meaningful ongoing growth (>=500 chars, not tail)'
    ).toBeGreaterThanOrEqual(500)
    // Multiple growth steps (not one jump): stream stayed active through the body.
    let growthSteps = 0
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].len > frames[i - 1].len) growthSteps++
    }
    expect(growthSteps, 'growth must arrive in multiple chunks while sampling').toBeGreaterThanOrEqual(2)
    expect(frames[0].status, 'stream still active at sampler start').toBe('streaming')
    const tops = frames.map((f) => f.pTop)
    const pTopMin = Math.min(...tops)
    const pTopMax = Math.max(...tops)
    const pTopRange = pTopMax - pTopMin
    const dpr = probe.event.dpr as number
    console.log(
      `[E2E] pause-long: frames=${frames.length} dur=${Math.round(duration)}ms dpr=${dpr} ` +
        `growth=${growth} steps=${growthSteps} pTopMin=${pTopMin} pTopMax=${pTopMax} range=${pTopRange} ` +
        `scrollTopFirst=${Math.round(frames[0].scrollTop)} scrollTopLast=${Math.round(frames[frames.length - 1].scrollTop)}`
    )
    // Chromium layout quantum is exactly 1/64 CSS px; a tiny float epsilon
    // covers binary rounding only — not a relaxed tolerance.
    expect(
      pTopRange,
      `held completed paragraph never jitters beyond one layout quantum at DPR1 (dpr=${dpr} range=${pTopRange})`
    ).toBeLessThanOrEqual(1 / 64 + 1e-6)
    // Hold baseline (paused viewport, race-free): fresh anchor read AFTER the
    // press; the racy pre-press anchor is gone — no separate-wire pre/post claim.
    const postAnchor = await readAnchor(page)
    expect(postAnchor, 'anchor must still resolve immediately after the pause press').not.toBeNull()
    // Continued growth must NOT pull the viewport back to the bottom. Uses the
    // already-observed sampler-end length + HOLD_GROWTH (not lenAtPause+2000):
    // the >=3.5s sampler already consumed ~1500 chars of the finite 4145-char
    // budget, so a redundant +2000 from the stale pre-press length is
    // arithmetically unreachable once lenAtPause exceeds ~2145.
    const samplerEndLenB = frames[frames.length - 1].len
    const samplerEndStatusB = frames[frames.length - 1].status
    console.log(
      `[E2E] pause-hold budget: lenAtPause=${lenAtPause} samplerEndLen=${samplerEndLenB} ` +
        `samplerEndStatus=${samplerEndStatusB} total=${slowStreamTotalLength()} ` +
        `target=${samplerEndLenB + HOLD_GROWTH}`
    )
    expect(samplerEndStatusB, 'stream still active at sampler end (remaining budget for hold)').toBe('streaming')
    await waitForBlockGrowthWithBudget(page, blockB, samplerEndLenB + HOLD_GROWTH, 'pause-hold')
    const pausedTop = await readScrollTop(page)
    expect(Math.abs(pausedTop), 'continued growth after pause never pulls to bottom').toBeGreaterThan(PAUSED_MIN)
    const pausedAnchor = await readAnchor(page)
    expect(pausedAnchor, 'anchor must still resolve while paused').not.toBeNull()
    expect(pausedAnchor!.id, 'pause holds the pressed reading row').toBe(postAnchor!.id)
    expect(Math.abs(pausedAnchor!.offset - postAnchor!.offset), 'held reading row stays put').toBeLessThanOrEqual(
      ANCHOR_TOL
    )
    // Generation was never stopped by the pause.
    const pausedState = await streamBlockState(page, blockB)
    expect(pausedState?.status, 'generation continues after pause').toBe('streaming')

    // ── Text selection stays native and never jumps. ──
    // Select inside the STATIC user message: the streaming reply re-renders
    // on every chunk, which can collapse a range anchored in it. Wheel the
    // user message into view first with genuine scrolls (pause persists
    // through ordinary scroll-aways by design).
    const findUserTextPoint = (): Promise<{ x: number; y: number } | null> =>
      page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('#messages .message-user .markdown')) as HTMLElement[]
        if (els.length === 0) return null
        const container = document.getElementById('messages') as HTMLElement | null
        const c = container?.getBoundingClientRect()
        if (!c) return null
        // Newest user message first: the paused viewport sits near the stream
        // tail, so earlier user messages are out of view.
        for (let i = els.length - 1; i >= 0; i--) {
          const r = els[i].getBoundingClientRect()
          if (r.width < 60 || r.height < 8) continue
          const x = r.x + Math.min(20, r.width / 4)
          const y = r.y + r.height / 2
          if (x < c.left || x > c.right || y < c.top + 4 || y > c.bottom - 4) continue
          return { x, y }
        }
        return null
      })
    let userTextPoint: { x: number; y: number } | null = null
    // Dense small strides: a large wheel step can stride clean over the
    // short user message between samples. Stop at the oldest extreme.
    for (let i = 0; i < 60; i++) {
      userTextPoint = await findUserTextPoint()
      if (userTextPoint) break
      const atOldest = await page.evaluate(() => {
        const el = document.getElementById('messages') as HTMLElement | null
        if (!el) return true
        return Math.abs(el.scrollTop + (el.scrollHeight - el.clientHeight)) <= 4
      })
      if (atOldest) break
      await page.mouse.wheel(0, -160)
      await page.waitForTimeout(200)
    }
    if (!userTextPoint) {
      const dump = await page.evaluate(() => {
        const container = document.getElementById('messages') as HTMLElement | null
        const c = container?.getBoundingClientRect()
        const userRows = Array.from(document.querySelectorAll('#messages .message-user')).map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect()
          return { cls: (el as HTMLElement).className.slice(0, 80), top: Math.round(r.top), h: Math.round(r.height) }
        })
        const marks = Array.from(document.querySelectorAll('#messages .message-user .markdown')).map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect()
          return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }
        })
        return {
          userRows: userRows.length,
          userRowTops: userRows.slice(0, 6),
          marks: marks.length,
          markRects: marks.slice(0, 6),
          container: c ? { top: Math.round(c.top), bottom: Math.round(c.bottom) } : null,
          scrollTop: container?.scrollTop ?? NaN
        }
      })
      console.log(`[E2E] user-text search dump: ${JSON.stringify(dump)}`)
    }
    expect(userTextPoint, 'visible user-message text point must exist').not.toBeNull()
    expect(Math.abs(await readScrollTop(page)), 'ordinary scroll-away stays paused').toBeGreaterThan(PAUSED_MIN)
    const selPreAnchor = await readAnchor(page)
    await page.mouse.move(userTextPoint!.x, userTextPoint!.y)
    await page.mouse.down()
    await page.mouse.move(userTextPoint!.x + 100, userTextPoint!.y, { steps: 6 })
    await page.mouse.up()
    const selectedLength = await page.evaluate(() => (window.getSelection()?.toString() ?? '').length)
    expect(selectedLength, 'text selection stays usable while paused').toBeGreaterThan(0)
    const selAnchor = await readAnchor(page)
    expect(selAnchor, 'anchor must still resolve after selection').not.toBeNull()
    expect(selAnchor!.id, 'selection never jumps the held row').toBe(selPreAnchor!.id)
    expect(
      Math.abs(selAnchor!.offset - selPreAnchor!.offset),
      'selection never jumps visible text'
    ).toBeLessThanOrEqual(ANCHOR_TOL)

    // ── Controls inside the viewport keep their action AND stay paused. ──
    // The copy button is already in view from the selection setup, so the
    // press itself needs no auto-scroll and must move nothing. The real
    // toolbar action still fires (clipboard holds the user text) while the
    // held row stays paused through further growth.
    const ctrlPreAnchor = await readAnchor(page)
    await hoverNewestUserRow(page)
    const ctrlPoint = await findVisibleUserCopyPoint(page)
    expect(ctrlPoint, 'visible user copy button must exist without auto-scroll').not.toBeNull()
    await page.mouse.move(ctrlPoint!.x, ctrlPoint!.y)
    await page.waitForTimeout(200)
    await page.mouse.down()
    await page.mouse.up()
    const clipboardText = await waitForClipboardToContain(page, 'second slow stream')
    expect(clipboardText.includes('second slow stream'), 'copy action still fires while paused').toBe(true)
    // Hold through completion: by this point the fixed-budget slow stream
    // (≈4145 chars total) is nearly exhausted (pause probe + selection
    // consumed it), so a further +800 growth wait is arithmetically
    // unreachable — the dedicated control test below proves pause through
    // +2000 ongoing growth instead. Here the press must hold the row
    // through whatever growth remains until normal completion (same
    // thresholds, no loosening).
    await page.waitForFunction(
      (id: string) => {
        const s = (window as any).store?.getState()
        const block = s?.messageBlocks?.entities?.[id]
        return !!block && block.status === 'success'
      },
      blockB,
      { timeout: 60000 }
    )
    expect(Math.abs(await readScrollTop(page)), 'control presses stay paused').toBeGreaterThan(PAUSED_MIN)
    const ctrlAnchor = await readAnchor(page)
    expect(ctrlAnchor, 'anchor must still resolve after the control press').not.toBeNull()
    expect(ctrlAnchor!.id, 'control presses never move the held row').toBe(ctrlPreAnchor!.id)
    expect(Math.abs(ctrlAnchor!.offset - ctrlPreAnchor!.offset), 'control presses never jump text').toBeLessThanOrEqual(
      ANCHOR_TOL
    )

    // ── Existing bottom navigation resumes follow. ──
    // The navigation rail is settings-gated (default off): enable it through
    // the settings seam (same state as a user toggle), then drive the real
    // bottom button. The reveal trigger shifts left when the topic list is
    // shown, so probe both the narrow and wide trigger spots.
    await page.evaluate(() => {
      ;(window as any).store.dispatch({ type: 'settings/setMessageNavigation', payload: true })
    })
    await page.waitForFunction(() => !!document.querySelector('button[aria-label="Back to bottom"]'), undefined, {
      timeout: 15000
    })
    const winSize = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    const bottomBtn = page.getByRole('button', { name: 'Back to bottom' })
    await page.mouse.move(winSize.w - 28, winSize.h * 0.5)
    await page.waitForTimeout(500)
    let navVisible = await bottomBtn.isVisible().catch(() => false)
    if (!navVisible) {
      await page.mouse.move(winSize.w - 320, winSize.h * 0.5)
      await page.waitForTimeout(500)
      navVisible = await bottomBtn.isVisible().catch(() => false)
    }
    expect(navVisible, 'bottom navigation must reveal on trigger hover').toBe(true)
    // DOM click on the real rail button: a hover tooltip overlay covers the
    // button center for synthetic pointer clicks, while the pause-relevant
    // pointer path (inside #messages) is already proven with the real mouse
    // above. This still exercises the full production resume chain
    // (rail onClick → scrollToBottom suspension → bottom navigate → keeper
    // bottom-hold → follow).
    const resumeDiag = await page.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      return { top: el?.scrollTop ?? NaN, h: el?.scrollHeight ?? NaN }
    })
    console.log(`[E2E] resume pre-click: scrollTop=${Math.round(resumeDiag.top)} h=${resumeDiag.h}`)
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Back to bottom"]') as HTMLElement | null
      if (!btn) throw new Error('bottom button missing at click time')
      btn.click()
    })
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500)
      const sample = await page.evaluate(() => {
        const el = document.getElementById('messages') as HTMLElement | null
        return el?.scrollTop ?? NaN
      })
      console.log(`[E2E] resume post-click t=${(i + 1) * 500}ms scrollTop=${Math.round(sample)}`)
    }
    await page.waitForFunction(
      (tol: number) => {
        const el = document.getElementById('messages') as HTMLElement | null
        return !!el && Math.abs(el.scrollTop) <= tol
      },
      BOTTOM_TOL,
      { timeout: 15000 }
    )
    // Follow resumes continuously, not one-shot: further stream growth while
    // resumed stays pinned to the bottom (skipped when the stream already
    // finished exactly at resume — then there is no growth left to follow).
    const resumeLen = (await streamBlockState(page, blockB))?.length ?? 0
    const resumeState = await streamBlockState(page, blockB)
    if (resumeState?.status === 'streaming') {
      await waitForBlockGrowth(page, blockB, resumeLen + 800)
      expect(await readScrollTop(page), 'resumed follow stays pinned through growth').toBeLessThanOrEqual(BOTTOM_TOL)
    }

    // Stream B completes normally after pause + resume.
    const expectedB = getSlowStreamReply(MODEL)
    await page.waitForFunction(
      (expected: string) => {
        const s = (window as any).store?.getState()
        if (!s?.messageBlocks?.entities) return false
        for (const block of Object.values(s.messageBlocks.entities) as any[]) {
          if (block?.type === 'main_text' && block?.content === expected && block?.status === 'success') return true
        }
        return false
      },
      expectedB,
      { timeout: 60000 }
    )
    const markdownB = assistantMarkdown(page)
    await expect(markdownB).toContainText('tail-marker-END', { timeout: 10000 })
    await expect(markdownB).toContainText('paragraph-149', { timeout: 10000 })
  })

  test('control press inside the viewport pauses follow while its action still fires', async ({ mainWindow }) => {
    test.setTimeout(240000)
    const page = mainWindow
    clearRequestLog()

    // CONTROL-FIRST proof: the FIRST primary press inside #messages in this
    // test is the copy-button press itself, issued EARLY while the assistant
    // stream is still small and the just-sent user row + its copy button are
    // genuinely inside the viewport before overflow — no content freeze press
    // first, no wheel, no DOM scroll, no direct controller call. A live guard
    // counter asserts zero prior #messages presses/wheels, and a native
    // pointerdown CAPTURE probe records the ACTUAL button target at event
    // time. The press must both pause follow (held through +2000 ongoing
    // growth) and fire its native copy action.
    const needle = `control slow stream ${SLOW_STREAM_MARKER}`
    await uiSendMessage(page, needle)

    // Live guard (page state, not a snapshot): counts real #messages primary
    // presses + wheels from here until the control press. Must stay zero
    // before it — proving no prior pause/wheel path in this test.
    await page.evaluate(() => {
      const w = window as any
      try {
        w.__ctrlFirstGuardCleanup?.()
      } catch {
        /* ignore stale cleanup */
      }
      w.__ctrlFirstGuard = { presses: 0, wheels: 0 }
      const onDown = (e: PointerEvent) => {
        const t = e.target as HTMLElement | null
        if (e.button === 0 && t && typeof t.closest === 'function' && t.closest('#messages')) {
          w.__ctrlFirstGuard.presses++
        }
      }
      const onWheel = () => {
        w.__ctrlFirstGuard.wheels++
      }
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('wheel', onWheel, true)
      w.__ctrlFirstGuardCleanup = () => {
        document.removeEventListener('pointerdown', onDown, true)
        document.removeEventListener('wheel', onWheel, true)
      }
    })

    // The user row appears on Enter immediately (poll, no artificial
    // pause) — BEFORE the first assistant chunk. Target it at once with the
    // same row-center-clamped targeting as hoverNewestUserRow, but WITHOUT
    // its frozen-viewport 600ms settle: at full stream speed the row scrolls
    // out within ~1s, so the mouse must already be over the row while the
    // layout is still static. Hovers never press, so this keeps the
    // FIRST-press claim intact. The menubar is opacity-revealed by CSS
    // :hover and the copy button is hit-testable regardless of opacity, so
    // poll button-visibility and early-stream liveness together with no
    // further mouse moves, then press the instant both hold.
    await page.waitForFunction(() => document.querySelectorAll('#messages .message-user').length > 0, undefined, {
      timeout: 15000
    })
    const rowPoint = await page.evaluate(() => {
      const container = document.getElementById('messages') as HTMLElement | null
      const c = container?.getBoundingClientRect()
      if (!c) return null
      const rows = Array.from(document.querySelectorAll('#messages .message-user')) as HTMLElement[]
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i].getBoundingClientRect()
        if (r.width < 60 || r.height < 8) continue
        const x = Math.min(Math.max(r.x + r.width / 2, c.left + 10), c.right - 10)
        const y = Math.min(Math.max(r.y + r.height / 2, c.top + 10), c.bottom - 10)
        if (x < c.left || x > c.right || y < c.top || y > c.bottom) continue
        return { x, y }
      }
      return null
    })
    expect(rowPoint, 'newest user row must be hover-targetable before the stream starts').not.toBeNull()
    await page.mouse.move(rowPoint!.x, rowPoint!.y)
    // Tight poll (no settle sleep): the FIRST moment the copy button is
    // genuinely in-viewport AND the assistant stream is live-early is the
    // press moment. Pre-stream iterations are static-layout waits; the loop
    // exits within ~100ms of stream start, long before visual overflow, so
    // the viewport is near-static and the button cannot treadmill away.
    const EARLY_MAX = 600
    let controlPoint: { x: number; y: number } | null = null
    let blockC: string | null = null
    let lenAtPress = -1
    let pollRounds = 0
    const pollStart = Date.now()
    while (Date.now() - pollStart < 20000) {
      pollRounds++
      const bid = await findStreamingBlockId(page)
      if (bid) {
        const st = await streamBlockState(page, bid)
        const len = st?.length ?? -1
        if (len >= EARLY_MAX) {
          lenAtPress = len
          break // early window missed — fail loudly below, never a false proof
        }
        if (st?.status === 'streaming' && len > 0) {
          const pt = await findVisibleUserCopyPoint(page)
          if (pt) {
            blockC = bid
            lenAtPress = len
            controlPoint = pt
            break
          }
        }
      }
      await page.waitForTimeout(50)
    }
    console.log(
      `[E2E] control-first poll: rounds=${pollRounds} elapsed=${Date.now() - pollStart}ms ` +
        `block=${blockC} lenAtPress=${lenAtPress} point=${controlPoint ? `${Math.round(controlPoint.x)},${Math.round(controlPoint.y)}` : 'null'}`
    )
    expect(blockC, 'live early stream must exist while the copy button is visible').not.toBeNull()
    expect(controlPoint, 'visible user copy button must exist without auto-scroll').not.toBeNull()
    expect(lenAtPress, 'control press must land on a live early stream').toBeGreaterThan(0)
    expect(
      lenAtPress,
      `stream still small (<${EARLY_MAX}) at the control press — else the early window was missed, fail loudly`
    ).toBeLessThan(EARLY_MAX)
    const pressBlock = blockC as string
    const pressPoint = controlPoint as { x: number; y: number }

    // Native button-target probe (observational only): resolves the ACTUAL
    // hit button at event time via the event target + elementFromPoint.
    await page.evaluate(() => {
      const w = window as any
      try {
        w.__ctrlFirstProbeCleanup?.()
      } catch {
        /* ignore stale cleanup */
      }
      delete w.__ctrlFirstProbe
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) throw new Error('#messages missing for control-first probe')
      const log: any = { event: null }
      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return
        const t = e.target as HTMLElement | null
        const btn =
          t && typeof t.closest === 'function'
            ? (t.closest('[data-testid="msg-copy-btn"]') as HTMLElement | null)
            : null
        const row = btn?.closest?.('#messages [data-message-id]') as HTMLElement | null
        const c = container.getBoundingClientRect()
        const rR = row?.getBoundingClientRect()
        const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        log.event = {
          button: e.button,
          clientX: e.clientX,
          clientY: e.clientY,
          insideMessages: !!(t && typeof t.closest === 'function' && t.closest('#messages')),
          hasButton: !!btn,
          btnTestId: btn?.getAttribute('data-testid') ?? null,
          hitIsButton:
            !!hit &&
            (hit === btn || !!(typeof hit.closest === 'function' && hit.closest('[data-testid="msg-copy-btn"]'))),
          rowId: row?.getAttribute('data-message-id') ?? null,
          rowOffset: rR ? rR.top - c.top : NaN,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight
        }
      }
      document.addEventListener('pointerdown', onDown, true)
      w.__ctrlFirstProbe = log
      w.__ctrlFirstProbeCleanup = () => {
        document.removeEventListener('pointerdown', onDown, true)
      }
    })
    // Live pre-press basis (no stale snapshot): still following at the
    // physically clamped bottom, zero prior presses/wheels, anchor resolves.
    const prePressTop = await readScrollTop(page)
    expect(prePressTop, 'control leg starts following at the bottom (no prior pause)').toBeLessThanOrEqual(BOTTOM_TOL)
    const guardBefore = (await page.evaluate(() => ({ ...(window as any).__ctrlFirstGuard }))) as {
      presses: number
      wheels: number
    }
    expect(guardBefore.presses, 'no prior #messages press before the control press').toBe(0)
    expect(guardBefore.wheels, 'no prior wheel before the control press').toBe(0)
    const preAnchor = await readAnchor(page)
    expect(preAnchor, 'anchor must resolve before the control press').not.toBeNull()

    // Real primary press on the control: ordinary mouse move + down/up with
    // no gap (no modifiers, no preventDefault, no auto-scroll, no DOM scroll).
    await page.mouse.move(pressPoint.x, pressPoint.y)
    await page.mouse.down()
    await page.mouse.up()
    const probe = await page.evaluate(() => {
      const w = window as any
      const log = w.__ctrlFirstProbe
      try {
        w.__ctrlFirstProbeCleanup?.()
      } catch {
        /* ignore stale cleanup */
      }
      delete w.__ctrlFirstProbe
      return log
    })
    const guardAfter = (await page.evaluate(() => {
      const w = window as any
      const g = { ...(w.__ctrlFirstGuard as { presses: number; wheels: number }) }
      try {
        w.__ctrlFirstGuardCleanup?.()
      } catch {
        /* ignore stale cleanup */
      }
      delete w.__ctrlFirstGuard
      delete w.__ctrlFirstGuardCleanup
      return g
    })) as { presses: number; wheels: number }
    expect(probe?.event, 'control-first probe must capture the pointerdown event').toBeTruthy()
    expect(probe.event.button, 'primary press only').toBe(0)
    expect(probe.event.insideMessages, 'press lands inside #messages').toBe(true)
    expect(probe.event.hasButton, 'event target is the real copy button').toBe(true)
    expect(probe.event.btnTestId, 'copy button carries its testid').toBe('msg-copy-btn')
    expect(probe.event.hitIsButton, 'hit-test lands on the button at event time').toBe(true)
    expect(probe.event.rowId, 'button owns a real message row').toBeTruthy()
    expect(guardAfter.presses, 'exactly this first #messages press caused the pause').toBe(1)
    expect(guardAfter.wheels, 'no wheel anywhere on the control-first path').toBe(0)
    console.log(
      `[E2E] control-first: btn=${probe.event.btnTestId} row=${probe.event.rowId} ` +
        `at=(${Math.round(probe.event.clientX)},${Math.round(probe.event.clientY)}) ` +
        `startTop=${Math.round(probe.event.scrollTop)} h=${probe.event.scrollHeight} ` +
        `rowOff=${Number(probe.event.rowOffset).toFixed(1)} lenAtPress=${lenAtPress}`
    )
    const clipboardText = await waitForClipboardToContain(page, 'control slow stream')
    expect(clipboardText.includes('control slow stream'), 'copy action fires on the pausing press').toBe(true)
    const pressState = await streamBlockState(page, pressBlock)
    expect(pressState?.status, 'generation continues after the control press').toBe('streaming')

    // Continued growth never pulls back to the bottom; the held row stays put.
    // Early-press budget: lenAtPress < 600 so lenAtPress+2000 (~2600) fits the
    // finite 4145-char budget with margin; budget-guarded wait for numerics.
    await waitForBlockGrowthWithBudget(page, pressBlock, lenAtPress + 2000, 'control-hold')
    expect(Math.abs(await readScrollTop(page)), 'control press pauses follow').toBeGreaterThan(PAUSED_MIN)
    const heldAnchor = await readAnchor(page)
    expect(heldAnchor, 'anchor must still resolve while control-paused').not.toBeNull()
    expect(heldAnchor!.id, 'control press holds the reading row').toBe(preAnchor!.id)
    expect(Math.abs(heldAnchor!.offset - preAnchor!.offset), 'held reading row stays put').toBeLessThanOrEqual(
      ANCHOR_TOL
    )
    expect((await streamBlockState(page, pressBlock))?.status, 'stream still active after the hold').toBe('streaming')

    // Isolate later specs: let this stream complete normally.
    const expectedC = getSlowStreamReply(MODEL)
    await page.waitForFunction(
      (expected: string) => {
        const s = (window as any).store?.getState()
        if (!s?.messageBlocks?.entities) return false
        for (const block of Object.values(s.messageBlocks.entities) as any[]) {
          if (block?.type === 'main_text' && block?.content === expected && block?.status === 'success') return true
        }
        return false
      },
      expectedC,
      { timeout: 60000 }
    )
  })

  test('real wheel return to the exact bottom resumes follow during an active stream', async ({ mainWindow }) => {
    test.setTimeout(240000)
    const page = mainWindow
    clearRequestLog()

    // Early pause via a real content press (no auto-scroll, no DOM writes):
    // at ~2000 chars the just-sent user row has already scrolled out of
    // view under bottom follow, so a control press would need auto-scroll
    // (forbidden) — content-point pausing is the correct early mechanism
    // here (control pausing is covered by the dedicated control test). Then
    // a genuine wheel return to the exact bottom resumes follow — no
    // navigation button, no DOM scrollTop write, no scrollIntoView, no
    // forced scroll.
    // XL budget for this leg only: ~8200 chars / 302 chunks / 60ms (~18s)
    // so the 3.5s-class pause + genuine wheel return + 500 resume hold all
    // land while streaming. Default 4145 stays for every other spec.
    const needle = `wheel resume slow stream ${EXTENDED_SLOW_STREAM_MARKER}`
    await uiSendMessage(page, needle)
    const blockW = await waitForStreamingContent(page, 2000)
    expect(await readScrollTop(page), 'wheel leg starts following at the bottom').toBeLessThanOrEqual(BOTTOM_TOL)

    const wheelCenter = await page.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    if (wheelCenter) {
      await page.mouse.move(wheelCenter.x, wheelCenter.y)
      await page.waitForTimeout(600)
    }
    const wheelPauseHint = await findReadingPoint(page)
    expect(wheelPauseHint, 'visible reading point for wheel-leg pause must exist').not.toBeNull()
    const lenAtPress = (await streamBlockState(page, blockW))?.length ?? 0
    const wheelPreAnchor = await readAnchor(page)
    expect(wheelPreAnchor, 'anchor must resolve before the wheel-leg pause').not.toBeNull()
    // Verified native paragraph press (no auto-scroll, no DOM writes).
    await pressVerifiedReadingPoint(page)
    const pressStateW = await streamBlockState(page, blockW)
    expect(pressStateW?.status, 'generation continues after the wheel-leg pause').toBe('streaming')
    // XL-bounded hold: pause at ~2000 + 500 hold + wheel return + 500 resume
    // fits the ~8200-char XL budget with margin.
    await waitForBlockGrowthWithBudget(
      page,
      blockW,
      lenAtPress + 500,
      'wheel-leg-hold',
      extendedSlowStreamTotalLength()
    )
    expect(Math.abs(await readScrollTop(page)), 'content press pauses follow').toBeGreaterThan(PAUSED_MIN)
    const wheelHeld = await readAnchor(page)
    expect(wheelHeld, 'anchor must still resolve while wheel-leg paused').not.toBeNull()
    expect(wheelHeld!.id, 'wheel-leg pause holds the reading row').toBe(wheelPreAnchor!.id)

    // Genuine wheel return: real wheel events over #messages only (the mouse
    // stays inside the viewport; positive deltaY drives toward the
    // column-reverse bottom). Never clicks the Back-to-bottom rail, never
    // writes scrollTop, never calls scrollIntoView, never forces adoption.
    // Driver targets the exact physical bottom (product gate <= 1): the old
    // <= 100 break stopped at e.g. -81 and later growth carried the viewport
    // to 852 before the pin check, while a true 0 landing passed — so the
    // driver must keep wheeling with settle stabilization until <= 1.
    const center = await page.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    expect(center, '#messages center must resolve').not.toBeNull()
    await page.mouse.move(center!.x, center!.y)
    await page.waitForTimeout(300)
    let landedTop = await readScrollTop(page)
    let wheelSteps = 0
    let bottomedExact = Math.abs(landedTop) <= PRODUCT_BOTTOM_TOL
    for (let i = 0; i < 40 && !bottomedExact; i++) {
      const state = await streamBlockState(page, blockW)
      if (state?.status !== 'streaming') break
      // Meaningful large stride to overcome concurrent 60ms growth without a
      // tiny-step chase + state-based settle: one frame for the wheel to
      // apply, one more for stream-growth interleaving to settle.
      await page.mouse.wheel(0, 640)
      await page.waitForTimeout(150)
      await page.waitForTimeout(150)
      landedTop = await readScrollTop(page)
      wheelSteps++
      console.log(
        `[E2E] wheel-resume step=${wheelSteps} scrollTop=${landedTop} len=${state?.length ?? -1} status=${state?.status ?? '?'}`
      )
      if (Math.abs(landedTop) <= PRODUCT_BOTTOM_TOL) {
        // Stabilization confirm: one more frame with no new input; growth
        // while resumed must keep the viewport pinned, not drift away.
        await page.waitForTimeout(150)
        landedTop = await readScrollTop(page)
        if (Math.abs(landedTop) <= PRODUCT_BOTTOM_TOL) bottomedExact = true
      }
    }
    console.log(`[E2E] wheel-resume landed: scrollTop=${landedTop} steps=${wheelSteps}`)
    expect(
      bottomedExact,
      `genuine wheel must reach the exact physical bottom (<=${PRODUCT_BOTTOM_TOL}) while streaming (landed=${landedTop})`
    ).toBe(true)
    // Exact physical arrival oracle (product gate), asserted BEFORE any growth
    // pinning below. The near-bottom BOTTOM_TOL follow checks elsewhere keep
    // their existing negative semantics; this is the strict arrival proof.
    expect(Math.abs(landedTop), 'wheel resume lands at the exact physical bottom').toBeLessThanOrEqual(
      PRODUCT_BOTTOM_TOL
    )

    // Continued growth (500+ chars, still streaming) stays pinned to the
    // bottom through the resumed follow; the stream completes normally.
    // Near-bottom BOTTOM_TOL pin semantics unchanged (negative-away check is
    // the paused oracle; pinned-follow keeps the wide gate here).
    const lenAtResume = (await streamBlockState(page, blockW))?.length ?? 0
    const resumeStatus = (await streamBlockState(page, blockW))?.status ?? '?'
    console.log(
      `[E2E] wheel-resume budget: lenAtResume=${lenAtResume} status=${resumeStatus} ` +
        `total=${extendedSlowStreamTotalLength()} target=${lenAtResume + HOLD_GROWTH}`
    )
    await waitForBlockGrowthWithBudget(
      page,
      blockW,
      lenAtResume + HOLD_GROWTH,
      'wheel-resume',
      extendedSlowStreamTotalLength()
    )
    expect(Math.abs(await readScrollTop(page)), 'resumed wheel follow stays pinned through growth').toBeLessThanOrEqual(
      BOTTOM_TOL
    )
    const expectedW = getExtendedSlowStreamReply(MODEL)
    await page.waitForFunction(
      (expected: string) => {
        const s = (window as any).store?.getState()
        if (!s?.messageBlocks?.entities) return false
        for (const block of Object.values(s.messageBlocks.entities) as any[]) {
          if (block?.type === 'main_text' && block?.content === expected && block?.status === 'success') return true
        }
        return false
      },
      expectedW,
      { timeout: 60000 }
    )
    expect((await streamBlockState(page, blockW))?.status, 'wheel-resumed stream completes').toBe('success')
  })

  test('paused stream holds one quantum at 1.25 effective zoom (native DPR provenance)', async ({
    mainWindow,
    electronApp
  }) => {
    test.setTimeout(240000)
    const page = mainWindow
    clearRequestLog()
    // Owned window zoom/size (separate from shared fixture settings; no IPC
    // persisted settings; fixture untouched). Captured for finally-revert.
    const initial = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = (BrowserWindow as any).getAllWindows()[0]
      const size = win.getSize() as [number, number]
      return { zoom: win.webContents.getZoomFactor() as number, w: size[0], h: size[1] }
    })
    try {
      // XL budget for this leg only (same rationale as the wheel leg).
      await uiSendMessage(page, `zoom slow stream ${EXTENDED_SLOW_STREAM_MARKER}`)
      const topicZoom = await currentTopicId(page)
      const blockZoom = await waitForStreamingContent(page, 1500)
      // Deterministic bottom-follow baseline before the zoom change.
      await page.waitForFunction(
        (tol: number) => {
          const el = document.getElementById('messages') as HTMLElement | null
          if (!el) return false
          return el.scrollHeight - el.clientHeight > 500 && Math.abs(el.scrollTop) <= tol
        },
        BOTTOM_TOL,
        { timeout: 30000 }
      )
      // Change effective zoom AFTER app ready so the EXISTING keeper RO +
      // layout path updates the CSS geometry units with no new render state,
      // no new listeners, no persisted settings.
      await electronApp.evaluate(({ BrowserWindow }, factor: number) => {
        const win = (BrowserWindow as any).getAllWindows()[0]
        win.webContents.setZoomFactor(factor)
      }, 1.25)
      // Correct setSize args are (width, height) numbers — not an object.
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = (BrowserWindow as any).getAllWindows()[0]
        const size = win.getSize() as [number, number]
        win.setSize(size[0], size[1])
      })
      // Let the existing observers/layout converge on the new quantum.
      await page.waitForFunction(
        () => {
          const container = document.getElementById('messages') as HTMLElement | null
          const wrapper = (container?.firstElementChild ?? null) as HTMLElement | null
          if (!wrapper) return false
          return wrapper.style.getPropertyValue('--messages-pixel-size').length > 0
        },
        undefined,
        { timeout: 15000 }
      )
      await page.waitForTimeout(800)
      const geo = await readWrapperQuantum(page)
      expect(Number.isFinite(geo.dpr) && geo.dpr > 0, 'actual window.devicePixelRatio must be finite positive').toBe(
        true
      )
      const expectedQuantum = 1 / geo.dpr
      const parsedVar = parseFloat(geo.inlineVar)
      console.log(
        `[E2E] zoom-provenance: effectiveZoom=1.25 actualDPR=${geo.dpr} (physical machine factor 1 is a separate label, not the asserted value) ` +
          `var=${geo.inlineVar} expected=${expectedQuantum}px height=${geo.height}`
      )
      // CSS variable quantum matches the ACTUAL DPR — never a pretend native DPR2 (0.5px).
      expect(Math.abs(parsedVar - expectedQuantum), 'keeper quantum matches actual DPR').toBeLessThanOrEqual(1e-6)
      if (Math.abs(geo.dpr - 2) > 1e-3) {
        expect(Math.abs(parsedVar - 0.5), 'quantum is not a pretend DPR2 constant').toBeGreaterThan(1e-3)
      }
      // Wrapper extent is a multiple of the live quantum (browser layout
      // quantum tolerance 1/64 CSS px + float epsilon).
      if (Number.isFinite(geo.height) && geo.height > 0) {
        const multiples = geo.height / expectedQuantum
        const errPx = Math.abs(multiples - Math.round(multiples)) * expectedQuantum
        expect(errPx, 'wrapper extent is a quantum multiple').toBeLessThanOrEqual(1 / 64 + 1e-6)
      }
      // Bottom follow resumes correctly through the zoom change (no new state).
      expect(await readScrollTop(page), 'bottom follow resumes after zoom').toBeLessThanOrEqual(BOTTOM_TOL)

      // Pause via the shared atomic sampler on the CURRENT topic block.
      // Hover-settle first: moving over #messages reveals row menubars, so
      // the point found afterwards already excludes menubar-covered spots
      // (the press must hit a real paragraph, never a hover overlay).
      const zoomCenter = await page.evaluate(() => {
        const el = document.getElementById('messages') as HTMLElement | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      if (zoomCenter) {
        await page.mouse.move(zoomCenter.x, zoomCenter.y)
        await page.waitForTimeout(600)
      }
      const pauseHint = await findReadingPoint(page)
      expect(pauseHint, 'visible reading point for zoom pause must exist').not.toBeNull()
      const lenAtPause = (await streamBlockState(page, blockZoom))?.length ?? 0
      // Shared sampler now presses a freshly-verified CURRENT-geometry
      // paragraph (event-time ACTUAL hit, null assertion unchanged).
      const probe = await performAtomicPauseProbe(page, pauseHint, blockZoom)
      expect(probe?.event, 'zoom pause probe must capture the pointerdown tuple').toBeTruthy()
      expect(probe?.micro, 'zoom pause probe must capture the microtask tuple').toBeTruthy()
      expect(probe?.raf, 'zoom pause probe must capture the first-rAF tuple').toBeTruthy()
      expect(probe.event.rowId, 'zoom pause press must hit a real reading row').toBeTruthy()
      // Same DOM element / paragraph value (append-only growth is legitimate).
      for (const key of ['micro', 'raf'] as const) {
        expect(probe[key].rowId, `same hit row at ${key}`).toBe(probe.event.rowId)
        expect(probe[key].pTextLen, `paragraph text never shrinks at ${key}`).toBeGreaterThanOrEqual(
          probe.event.pTextLen
        )
      }
      // Immediate paint stability at the actual hit (growth-compensated scroll,
      // exact paragraph/row offsets — same strictness as the DPR1 main test).
      for (const key of ['micro', 'raf'] as const) {
        const growth = Math.abs(probe[key].scrollHeight - probe.event.scrollHeight)
        expect(
          Math.abs(probe[key].scrollTop - probe.event.scrollTop),
          `zoom pause never repositions beyond growth (${key})`
        ).toBeLessThanOrEqual(growth + IMMEDIATE_TOL)
        expect(
          Math.abs(probe[key].pOffset - probe.event.pOffset),
          `zoom pause never moves the pressed paragraph (${key})`
        ).toBeLessThanOrEqual(IMMEDIATE_TOL)
      }
      // Long-window hold: SAME completed paragraph, >=3s, ongoing CURRENT-block
      // growth >=500 in multiple chunks (never a cross-topic global max — that
      // prior probe counter bug reported negative growth).
      expect(probe?.long?.done, 'zoom long sampler must complete its >=3s window').toBe(true)
      const frames = probe.long.frames
      expect(frames.length, 'zoom long sampler must hold many rAF frames').toBeGreaterThan(60)
      const duration = frames.length > 0 ? frames[frames.length - 1].t : 0
      expect(duration, 'zoom long sampler window must span >=3000ms').toBeGreaterThanOrEqual(3000)
      for (const f of frames) {
        expect(f.connected, 'same paragraph DOM identity stays connected').toBe(true)
        expect(f.head.slice(0, 40), 'same paragraph text prefix preserved').toBe(probe.event.pTextHead.slice(0, 40))
      }
      const lens = frames.map((f) => f.len)
      const growth = Math.max(...lens) - Math.min(...lens)
      expect(growth, 'zoom window must include ongoing CURRENT-block growth (>=500)').toBeGreaterThanOrEqual(500)
      let growthSteps = 0
      for (let i = 1; i < frames.length; i++) {
        if (frames[i].len > frames[i - 1].len) growthSteps++
      }
      expect(growthSteps, 'zoom growth must arrive in multiple chunks').toBeGreaterThanOrEqual(2)
      expect(frames[0].status, 'zoom stream still active at sampler start').toBe('streaming')
      const tops = frames.map((f) => f.pTop)
      const pTopRange = Math.max(...tops) - Math.min(...tops)
      console.log(
        `[E2E] zoom-pause-long: frames=${frames.length} dur=${Math.round(duration)}ms dpr=${probe.event.dpr} actualDPR=${geo.dpr} ` +
          `growth=${growth} steps=${growthSteps} pTopRange=${pTopRange} ` +
          `scrollTopFirst=${Math.round(frames[0].scrollTop)} scrollTopLast=${Math.round(frames[frames.length - 1].scrollTop)}`
      )
      expect(
        pTopRange,
        `held paragraph never jitters beyond one layout quantum at zoom (actualDPR=${geo.dpr} range=${pTopRange})`
      ).toBeLessThanOrEqual(1 / 64 + 1e-6)
      // Held pause: background scroll is negative (column-reverse reading
      // position, not bottom) and business state is preserved, never rewritten
      // to a missing value. Uses the already-observed sampler-end length +
      // HOLD_GROWTH on the XL ~8200-char budget (not lenAtPause+2000 on the
      // default 4145): the >=3.5s sampler consumes ~1500 chars. The
      // every-frame quantum geometry above stays intact (exact 1/64 quantum,
      // no widened positions/quiet tolerance); late generation end is never
      // hidden by loosening.
      const postAnchor = await readAnchor(page)
      expect(postAnchor, 'anchor must still resolve immediately after the zoom pause').not.toBeNull()
      const samplerEndLenZ = frames[frames.length - 1].len
      const samplerEndStatusZ = frames[frames.length - 1].status
      console.log(
        `[E2E] zoom-hold budget: lenAtPause=${lenAtPause} samplerEndLen=${samplerEndLenZ} ` +
          `samplerEndStatus=${samplerEndStatusZ} total=${extendedSlowStreamTotalLength()} ` +
          `target=${samplerEndLenZ + HOLD_GROWTH}`
      )
      expect(samplerEndStatusZ, 'zoom stream still active at sampler end (remaining budget for hold)').toBe('streaming')
      await waitForBlockGrowthWithBudget(
        page,
        blockZoom,
        samplerEndLenZ + HOLD_GROWTH,
        'zoom-hold',
        extendedSlowStreamTotalLength()
      )
      const pausedTop = await readScrollTop(page)
      expect(pausedTop, 'paused background scroll stays negative (column-reverse reading position)').toBeLessThan(0)
      expect(Math.abs(pausedTop), 'continued zoom growth never pulls to bottom').toBeGreaterThan(PAUSED_MIN)
      expect(await currentTopicId(page), 'topic business state preserved (no rewrite)').toBe(topicZoom)
      const pausedAnchor = await readAnchor(page)
      expect(pausedAnchor, 'anchor must still resolve while zoom-paused').not.toBeNull()
      expect(pausedAnchor!.id, 'zoom pause holds the pressed reading row').toBe(postAnchor!.id)
      expect(Math.abs(pausedAnchor!.offset - postAnchor!.offset), 'zoom held row stays put').toBeLessThanOrEqual(
        ANCHOR_TOL
      )
      const pausedState = await streamBlockState(page, blockZoom)
      expect(pausedState, 'CURRENT-block business state still present (not missing)').not.toBeNull()
      expect(pausedState?.status, 'generation continues after zoom pause').toBe('streaming')
      // Native copy/selection/control/resume stay covered by the standard main
      // test above; this scaled test proves only the quantum hold + resume of
      // follow via ordinary bottom proximity below.
    } finally {
      // Revert the owned window zoom/size so the shared fixture is untouched
      // for later specs.
      try {
        await electronApp.evaluate(({ BrowserWindow }, init: { zoom: number; w: number; h: number }) => {
          const win = (BrowserWindow as any).getAllWindows()[0]
          try {
            win.webContents.setZoomFactor(init.zoom)
          } catch {}
          try {
            win.setSize(init.w, init.h)
          } catch {}
        }, initial)
      } catch {}
    }
  })
})
