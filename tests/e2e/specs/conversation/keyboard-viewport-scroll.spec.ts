/**
 * Keyboard viewport scroll — real PageUp/PageDown after an ordinary message click.
 *
 * FOCUSED E2E (real UI, real IPC, shared fixture, disposable profile, mock
 * provider, fresh build). Bounded reproduction + regression authoring ONLY:
 * no production edits, no tabIndex/scrollTop/intent injection, no
 * controller-internal calls to manufacture intent.
 *
 * Reported symptom: chat PageUp/PageDown scroll feels suppressed.
 * Suspects (unproven, runtime evidence pending): the keydown target after an
 * ordinary viewport click sits outside #messages (body) so the
 * container-scoped capture listener never declares intent; native smooth
 * paging outlives the keyup/scrollend intent window; column-reverse native
 * default vs keeper compensation.
 *
 * Contract (test 1, expected RED until fixed): from a verified middle reading
 * position on a fully-loaded (no-pagination) topic, an ordinary real click on
 * a message row followed by real PageDown / PageUp key presses must move
 * #messages by a FULL native page (~0.9 x clientHeight, never a truncated
 * ~230px stub) in opposite directions, survive settling with zero app
 * writes, and commit a snapshot whose stable anchor matches the live
 * crossing-first anchor. Bottom and near-bottom legs extend the same contract
 * to the edges: from true physical bottom one PageUp must page the full
 * native amount with zero app writes and no pullback, and a last-page
 * PageDown from within one page of the bottom must reach physical bottom
 * in ONE press (no stuck midpoint).
 * The SAME keyboard-established anchor must then
 * survive a Settings roundtrip and a topic away/back (stable snapshot +
 * page/route restoration for keyboard input, not only wheel). PageDown with
 * textarea focus must not page #messages (negative assertion with a focus
 * precondition so it cannot pass vacuously). The probe records activeElement, key target +
 * defaultPrevented (window bubble, i.e. after propagation), container
 * keydown passthrough, scrollend count, per-frame #messages vs document
 * scrollTop (distinguishes scroller movement / reversal / missed intent /
 * normal native focus behavior where the document scrolls instead),
 * viewport phase, and snapshot metadata (ids/offsets only, never contents).
 *
 * Control (test 2, expected GREEN): the same wheel-established middle
 * position survives a Settings roundtrip, proving the snapshot/restore
 * machinery works and isolating any test-1 failure to the keyboard path.
 *
 * Seams only (established public test surface): #messages,
 * [data-message-id], window.keyv scroll keys, window.store (reads),
 * ordinary mouse wheel / click / keyboard. Never writes scrollTop, never
 * sets tabIndex, never dispatches intent/declaration actions.
 */
import type { Page } from '@playwright/test'
import { expect, test } from '../../fixtures/electron.fixture'
import { SidebarPage } from '../../pages/sidebar.page'
import { waitForAppReady, waitForChatReady, waitForSettingsLoad } from '../../utils/wait-helpers'
import {
  activateTopic,
  pad,
  prepareAssistant,
  seedSmallTopic,
  seedSourceTopic,
  uuidLike
} from '../../utils/branch-route-setup'

const TOTAL = 30
const OFFSET_TOL = 12

interface Anchor {
  id: string
  offset: number
}

interface ScrollState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  phase: string
}

interface KeySight {
  key: string
  target: string
  defaultPrevented: boolean
  atBubble: boolean
  /** performance.now() at observation (causal ordering vs scrollend/writes). */
  t: number
}

interface ProbeReport {
  capture: Array<{ key: string; target: string; t: number }>
  bubble: Array<{ key: string; target: string; defaultPrevented: boolean; t: number }>
  containerPass: number
  scrollEnds: number
  /** performance.now() per scrollend (attributes old-wheel tail vs key gesture). */
  scrollEndTimes: number[]
  /** passive scroll-event timestamps on #messages (movement vs stale tail). */
  scrollTimes: number[]
}

interface KeyLeg {
  key: string
  startTop: number
  minTop: number
  maxTop: number
  endTop: number
  docStart: number
  docEnd: number
  clientHeight: number
  delta: number
  docDelta: number
  maxExcursion: number
  finalFromPeak: number
}

function contentForIndex(i: number): string {
  return `kb-scroll-${pad(i, 5)} ${'filler words '.repeat(25)}`
}

/**
 * Long single-message Markdown (user + 1 assistant LONG): multi-screen at
 * 1706x967 (ch~769 / sh~5360 in dev). Synthetic neutral filler only.
 * Titles/paragraphs/lists/strong/hr exercise real layout without pagination.
 */
function buildLongMarkdown(): string {
  const para = 'Synthetic paragraph with neutral filler words for layout measurement. '.repeat(8)
  const strong = '**synthetic strong emphasis**'
  let md = '# Synthetic Report Alpha\n\n' + para + ' ' + strong + '\n\n'
  md += '## Overview Section\n\n' + para + '\n\n'
  md += '- unordered item alpha filler\n- unordered item beta filler\n- unordered item gamma filler\n\n'
  md += '1. ordered first filler\n2. ordered second filler\n3. ordered third filler\n\n---\n\n'
  for (let s = 1; s <= 7; s++) {
    md += `## Synthetic Section ${s}\n\n` + para + ' ' + strong + '\n\n'
    md += `### Subsection ${s}.1\n\n` + para + '\n\n'
    md += '- list one filler\n- list two filler\n- list three filler\n\n'
    md += `1. step one ${s}\n2. step two ${s}\n\n---\n\n` + para + '\n\n'
  }
  md += '# Closing Notes\n\n' + para + ' ' + strong + '\n'
  return md
}

async function seedLongMarkdownTopic(page: Page, assistantId: string, topicId: string): Promise<string[]> {
  const userId = uuidLike(1)
  const asstId = uuidLike(2)
  const md = buildLongMarkdown()
  const entries = [
    {
      message: {
        id: userId,
        topicId,
        role: 'user',
        assistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [`${topicId}-b0`],
        sortOrder: 0
      },
      blocks: [
        {
          id: `${topicId}-b0`,
          messageId: userId,
          type: 'main_text',
          content: 'Synthetic user question neutral.',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    },
    {
      message: {
        id: asstId,
        topicId,
        role: 'assistant',
        assistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [`${topicId}-b1`],
        sortOrder: 1,
        model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
        modelId: 'mock-model',
        askId: userId
      },
      blocks: [
        {
          id: `${topicId}-b1`,
          messageId: asstId,
          type: 'main_text',
          content: md,
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    }
  ]
  const addOk = await page.evaluate(
    ({ tid, aid }: { tid: string; aid: string }) => {
      try {
        ;(window as any).store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId: aid,
            topic: {
              id: tid,
              assistantId: aid,
              name: `KbLong ${tid}`,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        return { ok: true }
      } catch (e) {
        return { ok: false }
      }
    },
    { tid: topicId, aid: assistantId }
  )
  expect(addOk.ok).toBe(true)
  const persist = await page.evaluate(
    async ({ tid, aid, name, entries }: { tid: string; aid: string; name: string; entries: unknown }) => {
      try {
        const api: any = (window as any).api.chatDb
        const e1 = await api.ensureTopic({ topicId: tid, assistantId: aid, name })
        if (!e1 || e1.ok !== true) return { ok: false }
        const p2 = await api.pasteMessagesToTopic({ topicId: tid, entries })
        if (!p2 || p2.ok !== true) return { ok: false }
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
    { tid: topicId, aid: assistantId, name: `KbLong ${topicId}`, entries }
  )
  expect(persist.ok).toBe(true)
  return [userId, asstId]
}

async function readAnchor(page: Page): Promise<Anchor | null> {
  return page.evaluate(() => {
    const container = document.querySelector('#messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
    const cands: { id: string; top: number; bottom: number }[] = []
    for (const row of rows) {
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

async function settledOrThrow(page: Page): Promise<Anchor> {
  let prev: Anchor | null = null
  let stable = 0
  const start = Date.now()
  let cur: Anchor | null = null
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
  throw new Error(`viewport failed to settle within 10s (last=${cur ? `${cur.id}@${cur.offset}` : 'null'})`)
}

async function readScrollState(page: Page): Promise<ScrollState> {
  return page.evaluate(() => {
    const c = document.querySelector('#messages') as HTMLElement | null
    return {
      scrollTop: c ? c.scrollTop : NaN,
      scrollHeight: c ? c.scrollHeight : NaN,
      clientHeight: c ? c.clientHeight : NaN,
      phase: c?.getAttribute('data-viewport-phase') ?? ''
    }
  })
}

async function readSnapId(page: Page, topicId: string): Promise<string> {
  return page.evaluate((tid: string) => {
    const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
    for (const key of keys) {
      try {
        const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
        if (!raw || typeof raw !== 'object') continue
        const mid =
          typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
            ? (raw.messageId as string)
            : typeof raw.anchorId === 'string'
              ? (raw.anchorId as string)
              : ''
        if (mid) return mid
      } catch {
        continue
      }
    }
    return ''
  }, topicId)
}

async function readSnapMeta(page: Page, topicId: string): Promise<string> {
  return page.evaluate((tid: string) => {
    const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
    const parts: string[] = []
    for (const key of keys) {
      try {
        const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
        if (!raw || typeof raw !== 'object') {
          parts.push(`${key}=(empty)`)
          continue
        }
        const mid =
          typeof raw.messageId === 'string'
            ? (raw.messageId as string)
            : typeof raw.anchorId === 'string'
              ? (raw.anchorId as string)
              : '(none)'
        parts.push(
          `${key} id=${mid.slice(0, 8)}… st=${typeof raw.scrollTop === 'number' ? Math.round(raw.scrollTop as number) : '?'} bottom=${String((raw as Record<string, unknown>).isAtBottom)}`
        )
      } catch (e) {
        parts.push(`${key}=(err)`)
      }
    }
    return parts.join(' | ')
  }, topicId)
}

async function readSnapFull(
  page: Page,
  topicId: string
): Promise<{ id: string; scrollTop: number | null; intraRowOffset: number | null; isAtBottom: boolean } | null> {
  return page.evaluate((tid: string) => {
    const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
    for (const key of keys) {
      try {
        const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
        if (!raw || typeof raw !== 'object' || !('scrollTop' in raw)) continue
        const mid =
          typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
            ? (raw.messageId as string)
            : typeof raw.anchorId === 'string'
              ? (raw.anchorId as string)
              : ''
        if (!mid) continue
        const st =
          typeof raw.scrollTop === 'number' && Number.isFinite(raw.scrollTop) ? (raw.scrollTop as number) : null
        const off =
          typeof (raw as Record<string, unknown>).intraRowOffset === 'number' &&
          Number.isFinite((raw as Record<string, unknown>).intraRowOffset as number)
            ? ((raw as Record<string, unknown>).intraRowOffset as number)
            : null
        return {
          id: mid,
          scrollTop: st,
          intraRowOffset: off,
          isAtBottom: (raw as Record<string, unknown>).isAtBottom === true
        }
      } catch {
        continue
      }
    }
    return null
  }, topicId)
}

/**
 * Narrow ADR measurement: the DOM row for the SAVED snapshot identity itself
 * (never the crossing-first live helper, never any-of-30 rows). After a
 * topic-switch re-layout the container-top pixel may legitimately resolve to
 * a neighbor row via the crossing-first helper, so the equivalent viewport is
 * proven here by the requested target's own rect at its saved intra-row
 * offset — not by requiring the crossing-first pick to equal another helper.
 */
async function measureTargetRow(
  page: Page,
  id: string
): Promise<{
  found: boolean
  height: number
  offset: number
  containerHeight: number
  visibleHeight: number
  rectTop: number
  contTop: number
  outerOffset: number
  layerGap: number
} | null> {
  return page.evaluate((mid: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const inner = document.querySelector(`#messages [data-message-id="${mid}"]`) as HTMLElement | null
    const outer = document.getElementById(`message-${mid}`) as HTMLElement | null
    // Dual-layer diagnostic (read-only, never changes the oracle): production
    // capture/restore geometry uses the canonical outer row
    // (`getElementById('message-<id>')`, domVisibility registry membership),
    // while the oracle below reads the inner content box when present. For
    // plain single-box messages both queries resolve to the same element
    // (layerGap 0); a nonzero layerGap on failure proves an oracle-layer
    // mismatch instead of a restore miss.
    const outerOffset = outer && outer.isConnected ? outer.getBoundingClientRect().top - c.top : Number.NaN
    const row = inner ?? outer
    if (!row || !row.isConnected)
      return {
        found: false,
        height: 0,
        offset: NaN,
        containerHeight: c.height,
        visibleHeight: 0,
        rectTop: NaN,
        contTop: c.top,
        outerOffset,
        layerGap: NaN
      }
    if (window.getComputedStyle(row).display === 'none')
      return {
        found: false,
        height: 0,
        offset: NaN,
        containerHeight: c.height,
        visibleHeight: 0,
        rectTop: NaN,
        contTop: c.top,
        outerOffset,
        layerGap: NaN
      }
    const r = row.getBoundingClientRect()
    const visibleHeight = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)
    const offset = r.top - c.top
    return {
      found: true,
      height: r.height,
      offset,
      containerHeight: c.height,
      visibleHeight,
      rectTop: r.top,
      contTop: c.top,
      outerOffset,
      layerGap: Number.isFinite(offset) && Number.isFinite(outerOffset) ? Math.abs(offset - outerOffset) : NaN
    }
  }, id)
}

async function waitSnapMatchesLive(page: Page, topicId: string, allowed: string[], timeout = 15000): Promise<void> {
  await page.waitForFunction(
    ({ tid, ok }: { tid: string; ok: string[] }) => {
      const keys = [`scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
      let sid = ''
      for (const key of keys) {
        try {
          const raw = (window as any).keyv?.get?.(key) as Record<string, unknown> | undefined
          if (!raw || typeof raw !== 'object') continue
          const mid =
            typeof raw.messageId === 'string' && (raw.messageId as string).length > 0
              ? (raw.messageId as string)
              : typeof raw.anchorId === 'string'
                ? (raw.anchorId as string)
                : ''
          if (mid && (ok as string[]).includes(mid)) {
            sid = mid
            break
          }
        } catch {
          continue
        }
      }
      if (!sid) return false
      const container = document.querySelector('#messages') as HTMLElement | null
      if (!container) return false
      const c = container.getBoundingClientRect()
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
      const cands: { id: string; top: number; bottom: number }[] = []
      for (const row of rows) {
        const r = row.getBoundingClientRect()
        const id = row.getAttribute('data-message-id')
        if (id) cands.push({ id, top: r.top, bottom: r.bottom })
      }
      if (cands.length === 0) return false
      const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
      const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
      return picked.id === sid
    },
    { tid: topicId, ok: allowed },
    { timeout }
  )
}

/** Ordinary wheel to a verified middle reading position; never writes scrollTop. */
async function wheelToMiddle(page: Page, ids: string[]): Promise<Anchor> {
  const focusMessages = async (): Promise<void> => {
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }
  const wheel = async (dy: number): Promise<void> => {
    await focusMessages()
    await page.mouse.wheel(0, dy)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.waitForTimeout(220)
  }
  const isMiddle = async (): Promise<boolean> => {
    const cur = await readAnchor(page)
    if (!cur) return false
    const idx = ids.indexOf(cur.id)
    if (idx < Math.floor(TOTAL / 3) || idx > Math.floor((TOTAL * 2) / 3)) return false
    const st = await readScrollState(page)
    const topExtreme = -(st.scrollHeight - st.clientHeight)
    if (Math.abs(st.scrollTop) < 500) return false
    if (Math.abs(st.scrollTop - topExtreme) < 500) return false
    return true
  }
  // Sweep one sign fully first (accumulating travel), then the reverse sweep
  // with no column-reverse sign assumption — never alternating per round,
  // which would oscillate around the start and never accumulate.
  for (let i = 0; i < 30; i++) {
    if (await isMiddle()) break
    await wheel(-560)
  }
  if (!(await isMiddle())) {
    for (let i = 0; i < 30; i++) {
      if (await isMiddle()) break
      await wheel(560)
    }
  }
  expect(await isMiddle(), 'must reach a verified middle reading position (|st|>500 from both extremes)').toBe(true)
  return settledOrThrow(page)
}
/**
 * Ordinary wheel to a verified middle position proven by the SCROLL RANGE
 * itself, for fixtures that are not a list of indexable rows (e.g. one tall
 * long-markdown answer): the viewport must sit at least four client heights
 * away from BOTH physical extremes, so three full native pages in each
 * direction have real room before any clamped edge is reached. Never writes
 * scrollTop.
 */
async function wheelToMiddleByRange(page: Page): Promise<ScrollState> {
  const focusMessages = async (): Promise<void> => {
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }
  const wheel = async (dy: number): Promise<void> => {
    await focusMessages()
    await page.mouse.wheel(0, dy)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.waitForTimeout(220)
  }
  const clearance = 4
  const isMiddle = async (): Promise<boolean> => {
    const st = await readScrollState(page)
    const range = st.scrollHeight - st.clientHeight
    if (!Number.isFinite(range) || range < (2 * clearance + 1) * st.clientHeight) return false
    return (
      Math.abs(st.scrollTop) >= clearance * st.clientHeight &&
      range - Math.abs(st.scrollTop) >= clearance * st.clientHeight
    )
  }
  // Sweep one sign fully first (accumulating travel), then the reverse sweep.
  for (let i = 0; i < 40; i++) {
    if (await isMiddle()) break
    await wheel(-560)
  }
  if (!(await isMiddle())) {
    for (let i = 0; i < 40; i++) {
      if (await isMiddle()) break
      await wheel(560)
    }
  }
  const reached = await readScrollState(page)
  // eslint-disable-next-line no-console
  console.log(
    `[E2E] kb-range-middle st=${Math.round(reached.scrollTop)} sh=${Math.round(reached.scrollHeight)} ch=${Math.round(reached.clientHeight)} range=${Math.round(reached.scrollHeight - reached.clientHeight)}`
  )
  expect(
    await isMiddle(),
    `must reach a verified middle scroll range (>= ${clearance} client heights from both extremes; st=${Math.round(reached.scrollTop)} range=${Math.round(reached.scrollHeight - reached.clientHeight)} ch=${Math.round(reached.clientHeight)})`
  ).toBe(true)
  return reached
}

/**
 * Test-setup focus for the long-markdown fixture (NOT product compensation): a
 * real pointer click on the real visible centre of `#messages` (nudged off any
 * link/button), then an explicit container focus, then a readback proving focus
 * landed inside `#messages` — native PageUp/PageDown page the focused scroll
 * host, so without this the keys never reach the message viewport.
 */
async function focusMessagesForNativePaging(page: Page): Promise<string> {
  const point = await page.evaluate(() => {
    const c = document.querySelector('#messages') as HTMLElement | null
    if (!c) return null
    const r = c.getBoundingClientRect()
    let x = r.x + r.width / 2
    let y = r.y + r.height / 2
    try {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      if (hit && hit.closest && hit.closest('a,button')) y = r.y + r.height * 0.35
    } catch {}
    return { x, y }
  })
  expect(point, 'long-topic #messages visible centre must be clickable').not.toBeNull()
  await page.mouse.click(point!.x, point!.y)
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    const c = document.querySelector('#messages') as HTMLElement | null
    try {
      c?.focus({ preventScroll: true } as FocusOptions)
    } catch {
      c?.focus()
    }
  })
  await page.waitForTimeout(300)
  const focus = await describeActiveElement(page)
  expect(focus, 'keyboard paging setup must focus inside #messages').toMatch(/:in-messages/)
  return focus
}

async function installKeyProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__kbProbe) {
      // Re-entrant install after a prior spec revision: backfill timestamp
      // arrays so causal slicing never observes undefined.
      const rec = w.__kbProbe as Record<string, any>
      if (!Array.isArray(rec.scrollEndTimes)) rec.scrollEndTimes = []
      if (!Array.isArray(rec.scrollTimes)) rec.scrollTimes = []
      return
    }
    const describe = (t: EventTarget | null): string => {
      const el = t as HTMLElement | null
      if (!el || !(el as HTMLElement).tagName) return String((t as Node | null)?.nodeName ?? 'unknown')
      const tag = (el.tagName ?? '').toLowerCase()
      const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : ''
      const mid = el.getAttribute?.('data-message-id')
        ? `[msg=${el.getAttribute('data-message-id')!.slice(0, 8)}…]`
        : ''
      let inside = false
      try {
        inside = !!document.querySelector('#messages')?.contains(el)
      } catch {
        inside = false
      }
      return `${tag}${id}${mid}${inside ? ':in-messages' : ':outside-messages'}`
    }
    const rec = {
      capture: [] as Array<{ key: string; target: string; t: number }>,
      bubble: [] as KeySight[],
      containerPass: 0,
      scrollEnds: 0,
      scrollEndTimes: [] as number[],
      scrollTimes: [] as number[]
    }
    w.__kbProbe = rec
    w.__kbCapH = (e: KeyboardEvent) => {
      if (['PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) {
        rec.capture.push({ key: e.key, target: describe(e.target), t: Math.round(performance.now() * 10) / 10 })
      }
    }
    w.__kbBubH = (e: KeyboardEvent) => {
      if (['PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) {
        rec.bubble.push({
          key: e.key,
          target: describe(e.target),
          defaultPrevented: e.defaultPrevented,
          atBubble: true,
          t: Math.round(performance.now() * 10) / 10
        })
      }
    }
    window.addEventListener('keydown', w.__kbCapH, true)
    window.addEventListener('keydown', w.__kbBubH, false)
    const container = document.querySelector('#messages')
    if (container) {
      w.__kbContH = () => {
        rec.containerPass += 1
      }
      container.addEventListener('keydown', w.__kbContH, true)
      w.__kbSeH = () => {
        rec.scrollEnds += 1
        rec.scrollEndTimes.push(Math.round(performance.now() * 10) / 10)
      }
      try {
        ;(container.addEventListener as (t: string, l: EventListener, o?: AddEventListenerOptions) => void)(
          'scrollend',
          w.__kbSeH,
          { passive: true }
        )
      } catch {
        // scrollend type unknown — counter stays 0, reported as such
      }
      w.__kbScrollH = () => {
        // Passive only: causal movement marker, never prevents default.
        if (rec.scrollTimes.length < 500) rec.scrollTimes.push(Math.round(performance.now() * 10) / 10)
      }
      try {
        container.addEventListener('scroll', w.__kbScrollH, { passive: true })
      } catch {
        // scroll listener optional — times stay empty, reported as such
      }
    }
  })
}

async function readProbe(page: Page): Promise<ProbeReport> {
  return page.evaluate(() => {
    const rec = (window as unknown as Record<string, any>).__kbProbe
    if (!rec) return { capture: [], bubble: [], containerPass: -1, scrollEnds: -1, scrollEndTimes: [], scrollTimes: [] }
    return {
      capture: [...rec.capture],
      bubble: [...rec.bubble],
      containerPass: rec.containerPass,
      scrollEnds: rec.scrollEnds,
      scrollEndTimes: Array.isArray(rec.scrollEndTimes) ? [...rec.scrollEndTimes] : [],
      scrollTimes: Array.isArray(rec.scrollTimes) ? [...rec.scrollTimes] : []
    }
  })
}

async function removeKeyProbe(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>
      try {
        if (w.__kbCapH) window.removeEventListener('keydown', w.__kbCapH, true)
        if (w.__kbBubH) window.removeEventListener('keydown', w.__kbBubH, false)
        const container = document.querySelector('#messages')
        if (container && w.__kbContH) container.removeEventListener('keydown', w.__kbContH, true)
        if (container && w.__kbScrollH) container.removeEventListener('scroll', w.__kbScrollH)
      } catch {
        // best-effort
      } finally {
        delete w.__kbProbe
        delete w.__kbCapH
        delete w.__kbBubH
        delete w.__kbContH
        delete w.__kbSeH
        delete w.__kbScrollH
      }
    })
    .catch(() => {})
}

/**
 * App programmatic-write counter for #messages (observe-only test seam).
 * Chromium native scrolling never calls the JS scrollTop setter, so any
 * setter/scrollTo hit targeting #messages during a native paging window is
 * an app write (keeper pullback) that aborts the native smooth animation.
 * Wraps Element.prototype.scrollTop setter + scrollTo/scrollBy with
 * passthrough counters; counts are diffed per leg, never asserted globally.
 */
interface WriteDetail {
  t: number
  kind: string
  value: string
  anchor: string
  stack: string
}

async function installWriteCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__kbWriteCounter) return
    const rec = { writes: [] as Array<{ t: number; kind: string; value: string; anchor: string; stack: string }> }
    w.__kbWriteCounter = rec
    const isMessages = (el: unknown): boolean => {
      try {
        const m = document.querySelector('#messages')
        if (!m || !el) return false
        return m === el || m.contains(el as Node)
      } catch {
        return false
      }
    }
    const anchorNow = (): string => {
      try {
        const container = document.querySelector('#messages') as HTMLElement | null
        if (!container) return '(no-container)'
        const c = container.getBoundingClientRect()
        const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
        for (const row of rows) {
          const r = row.getBoundingClientRect()
          const id = row.getAttribute('data-message-id')
          if (id && r.top <= c.top && r.bottom > c.top) return `${id.slice(0, 8)}…@${Math.round(r.top - c.top)}`
        }
        return '(no-crossing)'
      } catch {
        return '(err)'
      }
    }
    const stackOf = (): string => {
      try {
        // Root-cause instrument (diagnostic-only, no contract change):
        // retain a complete app stack (2-4k) so the animation-abort source
        // keeps caller frames beyond the wrapped setter frame.
        return (new Error('kb-write').stack || '').split('\n').slice(1, 30).join(' | ').slice(0, 4000)
      } catch {
        return '(no-stack)'
      }
    }
    const pushWrite = (kind: string, value: string): void => {
      try {
        rec.writes.push({
          t: Math.round(performance.now() * 10) / 10,
          kind,
          value: value.slice(0, 200),
          anchor: anchorNow(),
          stack: stackOf()
        })
      } catch {}
    }
    try {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
      if (desc && desc.set && !(desc.set as unknown as Record<string, unknown>).__kbCounted) {
        const orig = desc.set
        const wrapped = function (this: Element, v: number): void {
          try {
            if (isMessages(this)) {
              pushWrite('setter', `scrollTop=${String(v)}`)
            }
          } catch {}
          orig.call(this, v)
        }
        ;(wrapped as unknown as Record<string, unknown>).__kbCounted = true
        Object.defineProperty(Element.prototype, 'scrollTop', {
          get: desc.get,
          set: wrapped,
          configurable: true,
          enumerable: desc.enumerable
        })
      }
    } catch {}
    for (const name of ['scrollTo', 'scrollBy'] as const) {
      try {
        const orig = (Element.prototype as unknown as Record<string, unknown>)[name]
        if (typeof orig === 'function' && !(orig as unknown as Record<string, unknown>).__kbCounted) {
          const counted = function (this: Element, ...args: unknown[]): unknown {
            try {
              if (this && (this as Element).id === 'messages') {
                pushWrite(name, `${name}(${args.map((a) => String(a)).join(',')})`)
              }
            } catch {}
            return (orig as (...a: unknown[]) => unknown).apply(this, args)
          }
          ;(counted as unknown as Record<string, unknown>).__kbCounted = true
          ;(Element.prototype as unknown as Record<string, unknown>)[name] = counted
        }
      } catch {}
    }
  })
}

async function readWriteCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rec = (window as unknown as Record<string, any>).__kbWriteCounter
    return rec ? (rec.writes.length as number) : -1
  })
}

async function readWriteDetails(page: Page): Promise<WriteDetail[]> {
  return page.evaluate(() => {
    const rec = (window as unknown as Record<string, any>).__kbWriteCounter
    if (!rec || !Array.isArray(rec.writes)) return []
    return (rec.writes as WriteDetail[]).map((wr) => ({
      t: wr.t,
      kind: wr.kind,
      value: String(wr.value ?? ''),
      anchor: String(wr.anchor ?? ''),
      stack: String(wr.stack ?? '')
    }))
  })
}

/**
 * Abort-source instrument (diagnostic-only, read-only, reversible):
 * BTB pre/post computed exposure + document-subtree mutation log filtered to
 * BTB / #messages / tooltip overlay. MutationObserver only — no rAF, no
 * timeouts, no page gesture, no contract change. Proves whether a
 * visible→hidden→shown style/attribute transition or a tooltip overlay
 * insert/position lands before the first scrollend (native animation abort)
 * in the near-bottom leg.
 */
interface BtbSnapshot {
  exists: boolean
  ariaHidden: string | null
  disabled: boolean | null
  tabIndex: number | null
  visibility: string
  opacity: string
  pointerEvents: string
  connected: boolean
}

interface AbortMutation {
  t: number
  target: string
  type: string
  attr: string
  added: number
  removed: number
}

async function readBtbSnapshot(page: Page): Promise<BtbSnapshot> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="conversation-back-to-bottom"]') as HTMLElement | null
    if (!el)
      return {
        exists: false,
        ariaHidden: null,
        disabled: null,
        tabIndex: null,
        visibility: 'n/a',
        opacity: 'n/a',
        pointerEvents: 'n/a',
        connected: false
      }
    let cs: CSSStyleDeclaration | null = null
    try {
      cs = window.getComputedStyle(el)
    } catch {
      cs = null
    }
    return {
      exists: true,
      ariaHidden: el.getAttribute('aria-hidden'),
      disabled: (el as HTMLButtonElement).disabled ?? null,
      tabIndex: (el as HTMLButtonElement).tabIndex ?? null,
      visibility: cs ? cs.visibility : 'n/a',
      opacity: cs ? cs.opacity : 'n/a',
      pointerEvents: cs ? cs.pointerEvents : 'n/a',
      connected: el.isConnected
    }
  })
}

async function installAbortProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    try {
      w.__kbAbortMO?.disconnect?.()
    } catch {}
    w.__kbAbortLog = [] as AbortMutation[]
    const describeTarget = (n: Node | null): string => {
      const el = n as HTMLElement | null
      if (!el || !el.tagName) return String((n as Node | null)?.nodeName ?? 'unknown')
      const tag = el.tagName.toLowerCase()
      const testid = el.getAttribute?.('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''
      const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : ''
      return `${tag}${id}${testid}`
    }
    const isRelevant = (n: Node | null): boolean => {
      try {
        const el = n as HTMLElement | null
        if (!el || !el.tagName) return false
        if (el.getAttribute?.('data-testid') === 'conversation-back-to-bottom') return true
        if ((el as HTMLElement).id === 'messages') return true
        try {
          if ((el as Element).closest?.('[data-testid="conversation-back-to-bottom"], #messages')) return true
        } catch {}
        // Tooltip overlay churn (passive hover activation mid-gesture):
        // the overlay mounts under body (outside #messages), so tag it by
        // class even without an ancestor match.
        try {
          const cls = String((el as HTMLElement).className ?? '')
          if (cls.includes('ant-tooltip')) return true
        } catch {}
        return false
      } catch {
        return false
      }
    }
    const mo = new MutationObserver((muts) => {
      try {
        const log = w.__kbAbortLog as AbortMutation[]
        for (const m of muts) {
          const t = m.target as Node | null
          if (!isRelevant(t)) continue
          if (log.length < 200)
            log.push({
              t: Math.round(performance.now() * 10) / 10,
              target: describeTarget(t).slice(0, 80),
              type: m.type,
              attr: m.attributeName ?? '',
              added: m.addedNodes?.length ?? 0,
              removed: m.removedNodes?.length ?? 0
            })
        }
      } catch {}
    })
    w.__kbAbortMO = mo
    try {
      mo.observe(document.body, {
        attributes: true,
        attributeFilter: ['style', 'class', 'aria-hidden', 'disabled', 'tabindex'],
        childList: true,
        subtree: true
      })
    } catch {}
  })
}

async function readAbortProbe(page: Page): Promise<AbortMutation[]> {
  return page.evaluate(() => {
    const log = (window as unknown as Record<string, any>).__kbAbortLog
    if (!Array.isArray(log)) return []
    return (log as AbortMutation[]).slice(0, 200)
  })
}

async function removeAbortProbe(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>
      try {
        w.__kbAbortMO?.disconnect?.()
      } catch {
      } finally {
        delete w.__kbAbortMO
        delete w.__kbAbortLog
      }
    })
    .catch(() => {})
}

async function describeActiveElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a) return '(null)'
    const tag = (a.tagName ?? '').toLowerCase()
    const id = a.id ? `#${a.id}` : ''
    let inside = false
    try {
      inside = !!document.querySelector('#messages')?.contains(a)
    } catch {
      inside = false
    }
    return `${tag}${id}${inside ? ':in-messages' : ':outside-messages'}`
  })
}

/**
 * Real keyboard press + 4s rAF scrollTop timeline on BOTH #messages and the
 * document element. Distinguishes: no movement anywhere (suppressed),
 * document scrolled instead (normal native focus behavior — focus never
 * reached the scroller), #messages moved then reverted (keeper compensation
 * without intent), movement persisted (healthy).
 */
async function pressKeyAndSample(page: Page, key: 'PageDown' | 'PageUp'): Promise<KeyLeg> {
  const start = await page.evaluate(() => {
    const c = document.querySelector('#messages') as HTMLElement | null
    return {
      msg: c ? c.scrollTop : NaN,
      doc: document.documentElement ? document.documentElement.scrollTop : NaN,
      ch: c ? c.clientHeight : NaN
    }
  })
  await page.keyboard.press(key)
  const samples = await page.evaluate(
    () =>
      new Promise<Array<{ t: number; msg: number; doc: number }>>((resolve) => {
        const out: Array<{ t: number; msg: number; doc: number }> = []
        const t0 = performance.now()
        const tick = () => {
          const c = document.querySelector('#messages') as HTMLElement | null
          out.push({
            t: Math.round((performance.now() - t0) * 10) / 10,
            msg: c ? c.scrollTop : NaN,
            doc: document.documentElement ? document.documentElement.scrollTop : NaN
          })
          if (performance.now() - t0 < 4000) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      })
  )
  const msgs = samples.map((s) => s.msg).filter((v) => Number.isFinite(v))
  const minTop = Math.min(...msgs)
  const maxTop = Math.max(...msgs)
  const endTop = msgs[msgs.length - 1]
  const docEnd = samples[samples.length - 1].doc
  const delta = endTop - start.msg
  const peak = Math.abs(maxTop - start.msg) > Math.abs(minTop - start.msg) ? maxTop : minTop
  return {
    key,
    startTop: start.msg,
    minTop,
    maxTop,
    endTop,
    docStart: start.doc,
    docEnd,
    clientHeight: start.ch,
    delta,
    docDelta: docEnd - start.doc,
    maxExcursion: peak - start.msg,
    finalFromPeak: endTop - peak
  }
}

/**
 * Diagnostic-only per-leg record for ONE native paging leg. Answers WHERE the
 * press landed and what the app did with it: focus target sampled before the
 * press and again after it, the key sighting from the existing key probe
 * (target + defaultPrevented), the #messages scroll timeline edges, the
 * per-leg app-write delta, and the boundary the leg ended at. Never asserts
 * and never changes input, so the record is emitted before any assertion and
 * survives a failing one. Bounded one-line [E2E] output, no message content.
 */
async function describePagingLeg(
  page: Page,
  label: string,
  leg: KeyLeg,
  focusBefore: string,
  beforeProbe: ProbeReport | null,
  beforeWrites: number
): Promise<void> {
  const focusAfter = await describeActiveElement(page).catch(() => '(err)')
  const afterProbe = await readProbe(page).catch(() => null)
  const afterWrites = await readWriteCount(page).catch(() => -1)
  const state = await readScrollState(page).catch(() => null)
  const bubbleNew = afterProbe && beforeProbe ? afterProbe.bubble.slice(beforeProbe.bubble.length) : []
  const captureNew = afterProbe && beforeProbe ? afterProbe.capture.slice(beforeProbe.capture.length) : []
  const endsNew = afterProbe && beforeProbe ? afterProbe.scrollEndTimes.slice(beforeProbe.scrollEndTimes.length) : []
  const firstBubble = bubbleNew[0] ?? null
  const firstCapture = captureNew[0] ?? null
  const writeDelta = beforeWrites >= 0 && afterWrites >= 0 ? afterWrites - beforeWrites : NaN
  const range = state ? state.scrollHeight - state.clientHeight : NaN
  const excursion = Math.abs(leg.maxExcursion)
  const motion =
    excursion <= 1
      ? 'never-moved'
      : Math.abs(leg.finalFromPeak) >= excursion * 0.5
        ? 'moved-then-reverted'
        : 'moved-persisted'
  const boundary =
    Number.isFinite(range) && range > 0
      ? Math.abs(leg.endTop) <= OFFSET_TOL
        ? 'newest-edge(clamped)'
        : range - Math.abs(leg.endTop) <= OFFSET_TOL
          ? 'oldest-edge(clamped)'
          : 'interior'
      : 'unknown-range'
  // eslint-disable-next-line no-console
  console.log(
    `[E2E] kb-leg ${label} key=${leg.key} focusBefore=${focusBefore} focusAfter=${focusAfter} ` +
      `keyTarget=${firstBubble ? `${firstBubble.key}@${firstBubble.target} prevented=${firstBubble.defaultPrevented}` : 'none'} ` +
      `captureTarget=${firstCapture ? firstCapture.target : 'none'} ` +
      `st=${Math.round(leg.startTop)}->${Math.round(leg.endTop)} min=${Math.round(leg.minTop)} max=${Math.round(leg.maxTop)} ` +
      `delta=${Math.round(leg.delta)} excursion=${Math.round(leg.maxExcursion)} fromPeak=${Math.round(leg.finalFromPeak)} ` +
      `ch=${Math.round(leg.clientHeight)} sh=${state ? Math.round(state.scrollHeight) : 'NaN'} range=${Math.round(range)} ` +
      `distOldest=${Math.round(range - Math.abs(leg.endTop))} distNewest=${Math.round(Math.abs(leg.endTop))} ` +
      `docDelta=${Math.round(leg.docDelta)} motion=${motion} boundary=${boundary} ` +
      `keyEvents=${captureNew.length}/${bubbleNew.length} scrollEnds=${endsNew.length} writesDelta=${Number.isFinite(writeDelta) ? writeDelta : '?'}`
  )
}

async function waitScrollQuiescence(page: Page): Promise<number> {
  let last = (await readScrollState(page)).scrollTop
  const start = Date.now()
  while (Date.now() - start < 8000) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.waitForTimeout(350)
    const cur = (await readScrollState(page)).scrollTop
    if (Math.abs(cur - last) <= 8) return cur
    last = cur
  }
  throw new Error(`scroll never reached quiescence (last=${last})`)
}

/**
 * Idle-start precondition for a native key gesture (driver-owned, not a
 * product delay): the preceding wheel drive must have fully completed
 * (scrollTop stable AND no new scrollend AND no new app write across one
 * observation window) before the key presses. Without this, a late wheel
 * scrollend/write tail lands inside the key window and is misattributed to
 * the keyboard path. Returns a one-line diagnostic proving the wheel owned
 * quiescence (counts before/after the gate). Uses only the existing
 * quiescence poll + read-only counters — no new hard sleep, no retry.
 */
async function waitForIdleStart(page: Page, label: string): Promise<string> {
  const beforeProbe = await readProbe(page).catch(() => null)
  const beforeWrites = await readWriteCount(page).catch(() => -1)
  const beforeTop = (await readScrollState(page)).scrollTop
  const settledTop = await waitScrollQuiescence(page)
  const afterProbe = await readProbe(page).catch(() => null)
  const afterWrites = await readWriteCount(page).catch(() => -1)
  const seDelta = afterProbe && beforeProbe ? afterProbe.scrollEnds - beforeProbe.scrollEnds : NaN
  const wDelta = afterWrites - beforeWrites
  return (
    `${label} idle-start top ${Math.round(beforeTop)}→${Math.round(settledTop)} ` +
    `scrollEnds=${beforeProbe?.scrollEnds ?? '?'}→${afterProbe?.scrollEnds ?? '?'} (Δ${Number.isFinite(seDelta) ? seDelta : '?'}) ` +
    `writes=${beforeWrites}→${afterWrites} (Δ${wDelta})`
  )
}

/** Causal slice between two probe/write snapshots for one key leg. */
function describeLegCausality(
  label: string,
  beforeProbe: ProbeReport,
  afterProbe: ProbeReport,
  beforeWrites: WriteDetail[],
  afterWrites: WriteDetail[]
): string {
  const capNew = afterProbe.capture.slice(beforeProbe.capture.length)
  const bubNew = afterProbe.bubble.slice(beforeProbe.bubble.length)
  const seNew = afterProbe.scrollEndTimes.slice(beforeProbe.scrollEndTimes.length)
  const wrNew = afterWrites.slice(beforeWrites.length)
  const keyT = bubNew.length > 0 ? bubNew[0].t : capNew.length > 0 ? capNew[0].t : NaN
  const wrLines = wrNew
    .slice(0, 3)
    .map((wr) => {
      const rel = Number.isFinite(keyT) ? `${Math.round((wr.t - keyT) * 10) / 10}ms-after-key` : `t=${wr.t}`
      // Diagnostic-only: retain the full app stack (2-4k) instead of the
      // 220-char wrapped-frame stub that drops caller frames.
      return `${wr.kind}:${wr.value}@${rel} anchor=${wr.anchor} stack=${wr.stack.slice(0, 4000)}`
    })
    .join(' // ')
  return (
    `${label} keys=[${bubNew.map((k) => `${k.key}@${k.target} prevented=${k.defaultPrevented} t=${k.t}`).join('; ') || 'none'}] ` +
    `scrollEnds=[${seNew.join(',') || 'none'}] writes=${wrNew.length}${wrNew.length ? ` (${wrLines})` : ''}`
  )
}

/**
 * Bounded restore-convergence gate for topic away/back.
 *
 * activateTopic only waits loaded ids / loading false / DOM count — NOT
 * selected currentTopicId nor async restore settle (own-offset plan +
 * post-fold rAF applies + final commit). Measuring immediately after
 * activateTopic observes pre-settle geometry. This gate waits genuine
 * convergence: currentTopicId == target, loading settled, exclusive
 * displayed topic message ids, requested target identity DOM connected and
 * visible inside a visible #messages container. Geometry settling itself is
 * left to the caller's bounded expect.poll + scroll quiescence.
 */
async function waitForTopicRestoreReady(
  page: Page,
  topicId: string,
  expectedIds: string[],
  targetId: string
): Promise<void> {
  await page.waitForFunction(
    ({ tid }: { tid: string }) => (window as any).store?.getState()?.messages?.currentTopicId === tid,
    { tid: topicId },
    { timeout: 15000 }
  )
  await page.waitForFunction(
    ({ tid, target, expected }: { tid: string; target: string; expected: string[] }) => {
      const s = (window as any).store?.getState()
      if (s?.messages?.currentTopicId !== tid) return false
      if (s?.messages?.loadingByTopic?.[tid]) return false
      const container = document.querySelector('#messages') as HTMLElement | null
      if (!container || !container.isConnected) return false
      if (window.getComputedStyle(container).display === 'none') return false
      const cr = container.getBoundingClientRect()
      if (!(cr.width > 0 && cr.height > 0)) return false
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
      if (rows.length === 0) return false
      const allowed = new Set(expected)
      for (const row of rows) {
        const id = row.getAttribute('data-message-id')
        if (!id || !allowed.has(id)) return false
      }
      let found: HTMLElement | null = null
      for (const row of rows) {
        if (row.getAttribute('data-message-id') === target) {
          found = row
          break
        }
      }
      if (!found || !found.isConnected) return false
      if (window.getComputedStyle(found).display === 'none') return false
      const r = found.getBoundingClientRect()
      if (!(r.height > 0)) return false
      const visibleHeight = Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top)
      if (!(visibleHeight > 0)) return false
      return true
    },
    { tid: topicId, target: targetId, expected: expectedIds },
    { timeout: 15000 }
  )
}

/**
 * Ordinary wheel drives to true physical bottom (scrollTop ~0). Seams
 * surface only (wheel/click/keyboard); never writes scrollTop.
 */
async function wheelToBottomEdge(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const st = await readScrollState(page)
    if (Math.abs(st.scrollTop) <= 2) return
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, st.scrollTop < 0 ? 420 : -420)
    await page.waitForTimeout(200)
  }
  throw new Error('wheel-to-bottom failed')
}

/**
 * Park the cursor on a hover-dead spot OUTSIDE #messages (driver hygiene, not
 * product behavior). It isolates ORDINARY paging legs from incidental
 * hover/tooltip DOM churn while content slides under the cursor mid-gesture;
 * it does NOT cover the stationary-cursor hover-tooltip hotspot (cursor left
 * on a message action button breeding passive tooltip activation
 * mid-gesture), which stays a known product residual — unverified and
 * unfixed here, never claimed resolved by this park. Wheel drives necessarily
 * hover #messages to deliver wheel events, so park AFTER each drive and AFTER
 * each focus click. Mouse moves never steal focus, so the :in-messages
 * keyboard precondition is unaffected. Returns the spot for timeline
 * diagnostics.
 */
async function parkCursorOnDeadSpot(page: Page): Promise<{ x: number; y: number; hit: string } | null> {
  const spot = await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cands: Array<[number, number]> = []
    for (let x = 8; x < 220; x += 12) cands.push([x, Math.round(vh * 0.5)])
    cands.push([Math.round(vw / 2), 4], [4, 4], [vw - 4, 4])
    for (const [x, y] of cands) {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      if (!el) continue
      const tag = (el.tagName ?? '').toLowerCase()
      if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea') continue
      if (el.closest && el.closest('button,a,[role="button"],.ant-tooltip')) continue
      const m = document.querySelector('#messages')
      if (m && (m === el || m.contains(el))) continue
      return { x, y, hit: `${tag}.${String(el.className ?? '').slice(0, 40)}` }
    }
    return null
  })
  if (spot) await page.mouse.move(spot.x, spot.y)
  return spot
}

/** Ordinary wheel drives to within one page above physical bottom. */
async function wheelToNearBottom(page: Page): Promise<number> {
  for (let i = 0; i < 12; i++) {
    const st = await readScrollState(page)
    if (st.scrollTop <= -30 && st.scrollTop >= -200) return st.scrollTop
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    if (st.scrollTop > -30) await page.mouse.wheel(0, -120)
    else await page.mouse.wheel(0, 120)
    await page.waitForTimeout(300)
  }
  throw new Error('wheel-to-near-bottom failed')
}

test.describe('Keyboard viewport scroll — real PageUp/PageDown after ordinary click', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('PageDown then PageUp page the viewport, survive settling, and commit the stable anchor', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'KEYBOARD VIEWPORT SCROLL: real PageDown/PageUp after an ordinary message-row click must move #messages by page-sized amounts in opposite directions, survive settling, and commit a snapshot matching the live stable anchor. Probe records key target/defaultPrevented, container passthrough, scrollend count, #messages-vs-document scroll timelines, phase, and snapshot metadata.'
    })
    const page: Page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `kb-scroll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `KbScroll ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => uuidLike(i),
      contentPrefix: 'kb-scroll-',
      contentForIndex
    })
    await activateTopic(page, topicId, TOTAL)
    const loaded = await page.evaluate(
      (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])] as string[],
      topicId
    )
    expect(loaded.length, 'fully loaded topic avoids conflating pagination (displayCount=TOTAL)').toBe(TOTAL)

    const middle = await wheelToMiddle(page, ids)
    await waitSnapMatchesLive(page, topicId, ids)
    const initialSnap = await readSnapFull(page, topicId)
    expect(initialSnap, 'wheel-established snapshot must exist before keyboard legs').not.toBeNull()
    expect(initialSnap!.id, 'wheel-established snapshot must confirm the middle anchor').toBe(middle.id)
    const rangeStart = await readScrollState(page)
    const middleTop = rangeStart.scrollTop
    const scrollRange = Math.abs(rangeStart.scrollHeight - rangeStart.clientHeight)
    expect(scrollRange, 'scroll range must fit two page-sized moves from the middle').toBeGreaterThan(
      2 * rangeStart.clientHeight
    )

    // Ordinary click on the settled anchor row — real pointer input, no
    // tabIndex/scrollTop/intent injection. This is the reported scenario.
    const rowBox = await page.locator(`#messages [data-message-id="${middle.id}"]`).first().boundingBox()
    expect(rowBox, 'settled anchor row must have a box for an ordinary click').not.toBeNull()
    await page.mouse.click(rowBox!.x + rowBox!.width / 2, rowBox!.y + rowBox!.height / 2)
    await page.waitForTimeout(400)
    const afterClickFocus = await describeActiveElement(page)
    // Cursor hygiene: the click leaves the cursor over the row; park it away
    // so hover/tooltip churn cannot abort the keyboard gestures below.
    await parkCursorOnDeadSpot(page)
    const containerTabIndex = await page.evaluate(
      () => document.querySelector('#messages')?.getAttribute('tabindex') ?? '(none)'
    )
    const phaseAfterClick = (await readScrollState(page)).phase

    await installKeyProbe(page)
    await installWriteCounter(page)
    expect(await readWriteCount(page), 'programmatic-write counter must be installed').toBeGreaterThanOrEqual(0)
    // F1: each keyboard leg must commit BEFORE the next key presses. A final
    // snapId==anchor check alone is a false positive: PageDown then PageUp can
    // net back to the old wheel viewport with zero keyboard commits and still
    // pass. The per-leg live+snapshot match below closes that hole.
    const down = await pressKeyAndSample(page, 'PageDown')
    await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
    const downLive = await settledOrThrow(page)
    const downSnap = await readSnapFull(page, topicId)
    const downState = await readScrollState(page)
    const up = await pressKeyAndSample(page, 'PageUp')
    await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
    const upLive = await settledOrThrow(page)
    const upSnap = await readSnapFull(page, topicId)
    const upState = await readScrollState(page)
    // Final extra PageDown leg: the keyboard-established restore position must
    // be genuinely keyboard-established AND distinguishable from the initial
    // wheel position (PageDown+PageUp alone nets back to the wheel viewport).
    const third = await pressKeyAndSample(page, 'PageDown')
    const settledTop = await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
    const probe = await readProbe(page)
    const finalAnchor = await settledOrThrow(page).catch(() => null)
    const snapMeta = await readSnapMeta(page, topicId)
    const snapId = await readSnapId(page, topicId)
    const finalSnap = await readSnapFull(page, topicId)
    const phaseFinal = (await readScrollState(page)).phase

    const pageSize = Math.max(200, 0.35 * down.clientHeight)

    // Textarea comparison with a focus precondition: keyboard paging semantics
    // for editable inputs are asserted NEGATIVELY below (PageDown in the
    // textarea must not page #messages) — no invented redirect contract.
    await page.locator('.inputbar textarea, textarea[placeholder]').first().click()
    await page.waitForTimeout(300)
    const textareaFocus = await describeActiveElement(page)
    const textLeg = await pressKeyAndSample(page, 'PageDown')
    const textProbe = await readProbe(page)

    const timeline =
      `clickFocus=${afterClickFocus} containerTabIndex=${containerTabIndex} phaseAfterClick=${phaseAfterClick} ` +
      `range=${Math.round(scrollRange)} ch=${Math.round(down.clientHeight)} pageSizeGate=${Math.round(pageSize)} | ` +
      `DOWN start=${Math.round(down.startTop)} min=${Math.round(down.minTop)} max=${Math.round(down.maxTop)} end=${Math.round(down.endTop)} delta=${Math.round(down.delta)} peak=${Math.round(down.maxExcursion)} revert=${Math.round(down.finalFromPeak)} docDelta=${Math.round(down.docDelta)} live=${downLive.id.slice(0, 8)}…@${Math.round(downLive.offset)} snap=${downSnap ? `${downSnap.id.slice(0, 8)}… st=${downSnap.scrollTop === null ? '?' : Math.round(downSnap.scrollTop)} off=${downSnap.intraRowOffset === null ? '?' : Math.round(downSnap.intraRowOffset)}` : 'null'} | ` +
      `UP start=${Math.round(up.startTop)} min=${Math.round(up.minTop)} max=${Math.round(up.maxTop)} end=${Math.round(up.endTop)} delta=${Math.round(up.delta)} peak=${Math.round(up.maxExcursion)} revert=${Math.round(up.finalFromPeak)} docDelta=${Math.round(up.docDelta)} live=${upLive.id.slice(0, 8)}…@${Math.round(upLive.offset)} snap=${upSnap ? `${upSnap.id.slice(0, 8)}… st=${upSnap.scrollTop === null ? '?' : Math.round(upSnap.scrollTop)} off=${upSnap.intraRowOffset === null ? '?' : Math.round(upSnap.intraRowOffset)}` : 'null'} | ` +
      `THIRD start=${Math.round(third.startTop)} end=${Math.round(third.endTop)} delta=${Math.round(third.delta)} docDelta=${Math.round(third.docDelta)} | ` +
      `settledTop=${Math.round(settledTop)} phaseFinal=${phaseFinal} snap=[${snapMeta}] liveAnchor=${finalAnchor ? `${finalAnchor.id.slice(0, 8)}…@${Math.round(finalAnchor.offset)}` : 'null'} | ` +
      `keys capture=[${probe.capture.map((k) => `${k.key}@${k.target}`).join('; ')}] ` +
      `bubble=[${probe.bubble.map((k) => `${k.key}@${k.target} prevented=${k.defaultPrevented}`).join('; ')}] ` +
      `containerPass=${probe.containerPass} scrollEnds=${probe.scrollEnds} | ` +
      `TEXTAREA focus=${textareaFocus} delta=${Math.round(textLeg.delta)} docDelta=${Math.round(textLeg.docDelta)} ` +
      `bubbleTail=[${textProbe.bubble
        .slice(-2)
        .map((k) => `${k.key}@${k.target} prevented=${k.defaultPrevented}`)
        .join('; ')}]`
    test.info().annotations.push({ type: 'kb-scroll-timeline', description: timeline.slice(0, 1900) })
    try {
      // eslint-disable-next-line no-console
      console.log(`[E2E] kb-scroll ${timeline}`)
    } catch {}
    await removeKeyProbe(page)

    // F3: promote already-logged probe facts to assertions. (scrollend count
    // proves one native gesture end per paging leg; internal session close is
    // proven by the unit controller tests, not by this counter.)
    expect(afterClickFocus, 'ordinary click must focus inside #messages for native paging').toMatch(/:in-messages/)
    expect(containerTabIndex, 'keyboard-focusable scroll host must expose tabIndex=0').toBe('0')
    const pagingBubbles = probe.bubble.filter((k) => k.key === 'PageDown' || k.key === 'PageUp')
    expect(pagingBubbles.length, 'probe must observe all three keyboard paging legs').toBeGreaterThanOrEqual(3)
    for (const sight of pagingBubbles) {
      expect(sight.defaultPrevented, `native ${sight.key} key event must not be prevented (${sight.target})`).toBe(
        false
      )
    }
    expect(probe.scrollEnds, 'one native scrollend must fire per successful keyboard paging leg (3 legs)').toBe(3)
    for (const [label, leg] of [
      ['PageDown', down],
      ['PageUp', up],
      ['final PageDown', third]
    ] as const) {
      expect(
        Math.abs(leg.docDelta),
        `${label} must page #messages, not the document (docDelta ${Math.round(leg.docDelta)}px)`
      ).toBeLessThanOrEqual(16)
    }

    // Strict regression assertions (expected RED while suppressed).
    // Full-page gate: the pre-fix truncation lands at ~230px with zero
    // writes and zero revert, so a lax 0.35x gate lets the bug pass. Every
    // middle leg must reach the full native page (~0.9 x clientHeight).
    const fullPageGate = Math.round(0.8 * down.clientHeight)
    expect(
      Math.abs(down.delta),
      `PageDown must page #messages by >= page size (${Math.round(pageSize)}px)`
    ).toBeGreaterThanOrEqual(pageSize)
    expect(
      Math.abs(up.delta),
      `PageUp must page #messages by >= page size (${Math.round(pageSize)}px)`
    ).toBeGreaterThanOrEqual(pageSize)
    expect(
      Math.abs(third.delta),
      `final PageDown must page #messages by >= page size (${Math.round(pageSize)}px)`
    ).toBeGreaterThanOrEqual(pageSize)
    for (const [label, leg] of [
      ['PageDown', down],
      ['PageUp', up],
      ['final PageDown', third]
    ] as const) {
      expect(
        Math.abs(leg.delta),
        `${label} must reach the full native page (~0.9x ch, gate ${fullPageGate}px, got ${Math.round(leg.delta)}px)`
      ).toBeGreaterThanOrEqual(fullPageGate)
    }
    expect(
      Math.abs(Math.abs(down.delta) - Math.abs(up.delta)) / Math.max(1, Math.abs(up.delta)),
      `PageDown (${Math.round(down.delta)}) and PageUp (${Math.round(up.delta)}) must be symmetric within 15%`
    ).toBeLessThanOrEqual(0.15)
    expect(
      down.delta * up.delta < 0,
      `PageDown (${Math.round(down.delta)}) and PageUp (${Math.round(up.delta)}) must move in opposite directions`
    ).toBe(true)
    expect(
      Math.abs(down.finalFromPeak),
      `PageDown movement must survive settling (peak revert ${Math.round(down.finalFromPeak)}px, not a keeper reversal)`
    ).toBeLessThanOrEqual(pageSize / 2)
    expect(
      Math.abs(up.finalFromPeak),
      `PageUp movement must survive settling (peak revert ${Math.round(up.finalFromPeak)}px, not a keeper reversal)`
    ).toBeLessThanOrEqual(pageSize / 2)
    expect(
      Math.abs(third.finalFromPeak),
      `final PageDown movement must survive settling (peak revert ${Math.round(third.finalFromPeak)}px, not a keeper reversal)`
    ).toBeLessThanOrEqual(pageSize / 2)
    // F1: intermediate keyboard commits — each leg's settled live anchor must
    // already match the route snapshot BEFORE the next key presses. The down
    // leg must also differ materially from the initial wheel position (its
    // movement assertions above already prove travel; this associates the down
    // commit with that travel before the reversal).
    expect(downSnap, 'PageDown leg must commit a route snapshot before PageUp presses').not.toBeNull()
    expect(downSnap!.id, 'PageDown snapshot identity must match the settled live identity').toBe(downLive.id)
    if (downSnap!.intraRowOffset !== null) {
      expect(
        Math.abs(downSnap!.intraRowOffset - downLive.offset),
        'PageDown snapshot offset must match the settled live offset'
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }
    expect(downSnap!.scrollTop, 'PageDown snapshot scrollTop must be finite').not.toBeNull()
    expect(
      Math.abs((downSnap!.scrollTop as number) - downState.scrollTop),
      'PageDown snapshot scrollTop must match the settled container scrollTop'
    ).toBeLessThanOrEqual(OFFSET_TOL)
    {
      const movedId = downLive.id !== middle.id
      const movedOffset = Math.abs(downLive.offset - middle.offset) > OFFSET_TOL
      const movedTop = Math.abs(downState.scrollTop - middleTop) >= pageSize / 2
      expect(
        movedId || movedOffset || movedTop,
        `PageDown commit must differ materially from the initial wheel position (live=${downLive.id.slice(0, 8)}…@${Math.round(downLive.offset)} vs wheel=${middle.id.slice(0, 8)}…@${Math.round(middle.offset)} topDelta=${Math.round(downState.scrollTop - middleTop)}px)`
      ).toBe(true)
    }
    expect(upSnap, 'PageUp leg must commit a route snapshot before the final PageDown presses').not.toBeNull()
    expect(upSnap!.id, 'PageUp snapshot identity must match the settled live identity').toBe(upLive.id)
    if (upSnap!.intraRowOffset !== null) {
      expect(
        Math.abs(upSnap!.intraRowOffset - upLive.offset),
        'PageUp snapshot offset must match the settled live offset'
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }
    expect(upSnap!.scrollTop, 'PageUp snapshot scrollTop must be finite').not.toBeNull()
    expect(
      Math.abs((upSnap!.scrollTop as number) - upState.scrollTop),
      'PageUp snapshot scrollTop must match the settled container scrollTop'
    ).toBeLessThanOrEqual(OFFSET_TOL)
    expect(finalAnchor, 'viewport must settle on a live anchor after keyboard paging').not.toBeNull()
    expect(snapId, 'keyboard paging must commit a snapshot matching the live stable anchor').toBe(finalAnchor!.id)
    expect(finalSnap, 'final keyboard leg must commit a route snapshot').not.toBeNull()
    expect(finalSnap!.id, 'final snapshot identity must match the settled live identity').toBe(finalAnchor!.id)
    if (finalSnap!.intraRowOffset !== null) {
      expect(
        Math.abs(finalSnap!.intraRowOffset - finalAnchor!.offset),
        'final snapshot offset must match the settled live offset'
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }
    {
      const movedId = finalAnchor!.id !== middle.id
      const movedOffset = Math.abs(finalAnchor!.offset - middle.offset) > OFFSET_TOL
      const movedTop = Math.abs(settledTop - middleTop) >= pageSize / 2
      expect(
        movedId || movedOffset || movedTop,
        `final keyboard position must be distinguishable from the initial wheel position (live=${finalAnchor!.id.slice(0, 8)}…@${Math.round(finalAnchor!.offset)} vs wheel=${middle.id.slice(0, 8)}…@${Math.round(middle.offset)} topDelta=${Math.round(settledTop - middleTop)}px)`
      ).toBe(true)
    }

    // Editable field is never hijacked: PageDown with textarea focus must not
    // page #messages. Precondition first (focus truly in the textarea) so the
    // negative assertion cannot pass vacuously when focus never moved.
    expect(textareaFocus, 'no-hijack probe must actually hold textarea focus').toMatch(/textarea/)
    expect(textProbe.bubble.length, 'no-hijack probe must observe the textarea key').toBeGreaterThan(
      probe.bubble.length
    )
    expect(
      Math.abs(textLeg.delta),
      `PageDown in textarea must not page #messages (delta ${Math.round(textLeg.delta)}px, far below page gate ${Math.round(pageSize)}px)`
    ).toBeLessThanOrEqual(16)

    // Keyboard-established snapshot survival: the SAME keyboard-committed
    // anchor (not a wheel position) survives a Settings roundtrip and a topic
    // away/back — stable snapshot + page/route restoration for keyboard input.
    const kbAnchor = finalAnchor!
    const sidebarKb = new SidebarPage(page)
    await sidebarKb.goToSettings()
    await waitForSettingsLoad(page)
    await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
    await sidebarKb.goToHome()
    await waitForChatReady(page)
    await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
    const afterSettings = await settledOrThrow(page)
    expect(afterSettings.id, 'keyboard-established anchor must survive a Settings roundtrip').toBe(kbAnchor.id)
    expect(
      Math.abs(afterSettings.offset - kbAnchor.offset),
      'keyboard-established anchor offset must survive a Settings roundtrip'
    ).toBeLessThanOrEqual(OFFSET_TOL)

    const otherTopicId = `kb-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSmallTopic(page, assistantId, otherTopicId, `KbOther ${otherTopicId}`)
    // F2: capture the REQUESTED keyboard snapshot before leaving — the topic
    // return must restore THIS saved identity at its saved intra-row offset,
    // and the target snapshot itself must not be polluted by the outgoing
    // route. Same-topic id + non-bottom + visible-in-one-viewport alone is
    // insufficient (ADR own snapshot identity + offset).
    const requestedSnap = await readSnapFull(page, topicId)
    expect(requestedSnap, 'requested keyboard snapshot must exist before topic away').not.toBeNull()
    expect(requestedSnap!.id, 'requested snapshot must be the keyboard-established identity').toBe(kbAnchor.id)
    await activateTopic(page, otherTopicId, 4)
    await activateTopic(page, topicId, TOTAL)
    // Bounded restore convergence: activateTopic only waits loaded ids /
    // loading false / DOM count — NOT selected currentTopicId nor async
    // restore settle (own-offset plan + post-fold rAF applies + final
    // commit). A first-frame measurement here observes pre-settle geometry,
    // so convergence below precedes any oracle read. Exact original
    // requestedSnap identity + offset remains the sole geometry oracle;
    // the after-snapshot is never used as the target source (it could mask
    // rewritten geometry).
    await waitForTopicRestoreReady(page, topicId, ids, requestedSnap!.id)
    await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
    await settledOrThrow(page).catch(() => null)
    const snapAfterTopic = await readSnapFull(page, topicId)
    expect(snapAfterTopic, 'topic away/back must preserve a snapshot for the keyboard topic').not.toBeNull()
    expect(snapAfterTopic!.id, 'topic away/back must preserve a snapshot for the keyboard topic').toBeTruthy()
    expect(ids, 'restored snapshot must belong to the keyboard topic (no cross-topic contamination)').toContain(
      snapAfterTopic!.id
    )
    expect(snapAfterTopic!.isAtBottom, 'keyboard middle snapshot must stay non-bottom across away/back').toBe(false)
    // Target snapshot itself not polluted by the outgoing route: the exact
    // requested keyboard identity survives (not any-of-30 rows).
    expect(
      snapAfterTopic!.id,
      `target snapshot must still be the requested keyboard identity (requested=${requestedSnap!.id.slice(0, 8)}… actual=${snapAfterTopic!.id.slice(0, 8)}…, no outgoing pollution)`
    ).toBe(requestedSnap!.id)
    // Narrow ADR measurement: the DOM row for the SAVED snapshot identity
    // itself must land at its saved intra-row offset (<=12px). Measured
    // directly — never via the crossing-first live helper, never any-of-30
    // rows, never a broad viewport-height tolerance as the primary oracle.
    // Re-layout across a topic switch may legitimately resolve the
    // container-top pixel (crossing-first pick) to a neighbor row, so
    // crossing-first equality is NOT asserted here; the explicit stable target
    // rect below proves the equivalent viewport instead. Terminal stable
    // behavior only: bounded poll lets the async restore converge; no
    // first-frame atomicity is asserted (existing page suite covers that).
    const requestedId: string = requestedSnap!.id
    const savedOffset: number = requestedSnap!.intraRowOffset ?? kbAnchor.offset
    // Manual bounded convergence sample (logs every reading — the poll
    // oracle alone hides which row/height the restore converged to).
    let restoreGap = NaN
    let restoreLast = 'none'
    {
      const start = Date.now()
      while (Date.now() - start < 15000) {
        const m = await measureTargetRow(page, requestedId)
        if (m && m.found && Number.isFinite(m.offset)) {
          restoreGap = Math.abs(m.offset - savedOffset)
          restoreLast = `h=${Math.round(m.height)} off=${Math.round(m.offset)} vis=${Math.round(m.visibleHeight)}`
          if (restoreGap <= OFFSET_TOL) break
        } else {
          restoreGap = NaN
          restoreLast = 'unmeasurable'
        }
        await page.waitForTimeout(250)
      }
      const diag = await page.evaluate((tid: string) => {
        const c = document.querySelector('#messages') as HTMLElement | null
        let snap = ''
        try {
          const raw = (window as any).keyv?.get?.(`scroll:topic-${tid}::main`) as Record<string, unknown> | undefined
          if (raw && typeof raw === 'object') {
            const mid =
              typeof raw.messageId === 'string'
                ? (raw.messageId as string).slice(0, 8)
                : typeof raw.anchorId === 'string'
                  ? (raw.anchorId as string).slice(0, 8)
                  : '?'
            snap = `snap=${mid} st=${typeof raw.scrollTop === 'number' ? Math.round(raw.scrollTop as number) : '?'} off=${typeof raw.intraRowOffset === 'number' ? Math.round(raw.intraRowOffset as number) : '?'} bottom=${String(raw.isAtBottom)}`
          } else snap = 'snap=(empty)'
        } catch {
          snap = 'snap=(err)'
        }
        const rows = document.querySelectorAll('#messages [data-message-id]').length
        return `phase=${c?.getAttribute('data-viewport-phase') ?? '?'} top=${c ? Math.round(c.scrollTop) : NaN} sh=${c ? Math.round(c.scrollHeight) : NaN} ch=${c ? Math.round(c.clientHeight) : NaN} rows=${rows} ${snap}`
      }, topicId)
      restoreLast += ` | ${diag}`
    }
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[E2E] kb-restore-poll requested=${requestedId.slice(0, 8)} savedOff=${Math.round(savedOffset)} gap=${Number.isFinite(restoreGap) ? Math.round(restoreGap) : '?'} last=${restoreLast}`
      )
    } catch {}
    expect(restoreGap, 'saved stable message identity must converge to its saved intra-row offset').toBeLessThanOrEqual(
      OFFSET_TOL
    )
    const targetRect = await measureTargetRow(page, requestedId)
    const rectDiag =
      `requested=${requestedSnap!.id.slice(0, 8)}… savedOff=${Math.round(savedOffset)} ` +
      `after=${snapAfterTopic!.id.slice(0, 8)}… afterOff=${snapAfterTopic!.intraRowOffset === null ? '?' : Math.round(snapAfterTopic!.intraRowOffset)} ` +
      `rect=${targetRect ? `found=${targetRect.found} h=${Math.round(targetRect.height)} off=${Number.isFinite(targetRect.offset) ? Math.round(targetRect.offset) : '?'} vis=${Math.round(targetRect.visibleHeight)} ch=${Math.round(targetRect.containerHeight)} rectTop=${Number.isFinite(targetRect.rectTop) ? Math.round(targetRect.rectTop) : '?'} contTop=${Math.round(targetRect.contTop)} outerOff=${Number.isFinite(targetRect.outerOffset) ? Math.round(targetRect.outerOffset) : '?'} layerGap=${Number.isFinite(targetRect.layerGap) ? Math.round(targetRect.layerGap) : '?'}` : 'null'}`
    test.info().annotations.push({ type: 'kb-topic-restore', description: rectDiag.slice(0, 1200) })
    try {
      // eslint-disable-next-line no-console
      console.log(`[E2E] kb-restore ${rectDiag}`)
    } catch {}
    expect(targetRect, `requested target row must be measurable (${rectDiag})`).not.toBeNull()
    expect(targetRect!.found, `requested snapshot identity must be present in the DOM (${rectDiag})`).toBe(true)
    expect(targetRect!.height, `requested target row must have real height (${rectDiag})`).toBeGreaterThan(0)
    expect(targetRect!.visibleHeight, `requested target row must be visible (${rectDiag})`).toBeGreaterThan(0)
    expect(
      Math.abs(targetRect!.offset - savedOffset),
      `saved stable message identity must land at its saved intra-row offset (<=${OFFSET_TOL}px) (${rectDiag})`
    ).toBeLessThanOrEqual(OFFSET_TOL)
    // Secondary containment only (never the primary oracle): within one viewport.
    expect(
      Math.abs(targetRect!.offset) < targetRect!.containerHeight,
      `requested target row must lie within one viewport of the container top (${rectDiag})`
    ).toBe(true)
    // Snapshot itself must retain the exact requested identity/offset after
    // completion (not rewritten by the outgoing route or the restore).
    const snapFinal = await readSnapFull(page, topicId)
    expect(snapFinal, `snapshot must still exist after settled restore (${rectDiag})`).not.toBeNull()
    expect(snapFinal!.id, `snapshot identity must still be the requested identity after completion (${rectDiag})`).toBe(
      requestedId
    )
    if (snapFinal!.intraRowOffset !== null && requestedSnap!.intraRowOffset !== null) {
      expect(
        Math.abs(snapFinal!.intraRowOffset - requestedSnap!.intraRowOffset),
        `snapshot offset must still be the requested offset after completion (${rectDiag})`
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }
  })

  test('keyboard bottom and near-bottom edges page natively (write timeline diagnostic, no pullback)', async ({
    mainWindow
  }) => {
    // Isolation split (not green-washing): the edge legs below never feed the
    // restore oracle above — they legitimately move the route snapshot to the
    // bottom — so they run here as an independent test with identical
    // assertions. A restore failure in the main test no longer masks this
    // independent edge evidence, and no coverage is removed. The long-Markdown
    // large-window phase lives in the next independent test so a short-edge
    // failure cannot mask the BackToBottom root-fix evidence.
    // Title semantics: the write counter is diagnostic no-pullback evidence
    // (movement-survival assertions prove no keeper pullback), not a hard
    // zero-write gate — identical contract, corrected wording.
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'KEYBOARD EDGES (30-short): from true physical bottom one PageUp must page the full native amount with no pullback; a last-page PageDown from within one page of the bottom must reach physical bottom in ONE press (no stuck midpoint). Causal instrument records pre/post write stacks, key/scroll/scrollend times, and snapshot/anchor per leg. Ordinary wheel/click/keyboard only (seams surface); never writes scrollTop.'
    })
    const page: Page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `kb-edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `KbEdge ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => uuidLike(i),
      contentPrefix: 'kb-edge-',
      contentForIndex
    })
    await activateTopic(page, topicId, TOTAL)
    const loaded = await page.evaluate(
      (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])] as string[],
      topicId
    )
    expect(loaded.length, 'fully loaded topic avoids conflating pagination (displayCount=TOTAL)').toBe(TOTAL)
    await installKeyProbe(page)
    await installWriteCounter(page)
    expect(await readWriteCount(page), 'programmatic-write counter must be installed').toBeGreaterThanOrEqual(0)
    // Fact: first key must page the full native amount; the FULL native page
    // gate plus no-revert proves no truncation/pullback — a lax gate would let
    // the bug pass. Writes stay diagnostic (readable counter + stacks below).
    // Settle discipline: idle past wheel-induced async tails before each
    // press so each measured leg is a clean idle-start native gesture. The
    // idle-start gate below (scrollTop + scrollend + write quiescence) proves
    // the wheel owned completion; it is a driver gesture-completion
    // precondition, not a product delay mask.
    await wheelToBottomEdge(page)
    await page.waitForTimeout(2500)
    const bottomPt = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#messages [data-message-id]')) as HTMLElement[]
      let best: HTMLElement | null = null
      let bestBottom = -Infinity
      for (const row of rows) {
        const r = row.getBoundingClientRect()
        if (r.bottom > bestBottom) {
          bestBottom = r.bottom
          best = row
        }
      }
      if (!best) return null
      const r = (best as HTMLElement).getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    expect(bottomPt, 'bottommost row must be clickable for an ordinary focus click').not.toBeNull()
    await page.mouse.click(bottomPt!.x, bottomPt!.y)
    await page.waitForTimeout(400)
    const bottomClickFocus = await describeActiveElement(page)
    // Cursor hygiene: park off the scroller so hover/tooltip churn cannot
    // abort the bottom PageUp gesture (focus stays :in-messages).
    await parkCursorOnDeadSpot(page)
    const bottomIdleDiag = await waitForIdleStart(page, 'bottom-PgUp')
    const bottomPreLive = await readAnchor(page)
    const bottomPreSnap = await readSnapFull(page, topicId)
    const bottomPreState = await readScrollState(page)
    const bottomProbeBefore = await readProbe(page)
    const bottomWritesBeforeList = await readWriteDetails(page)
    const bottomWritesBefore = bottomWritesBeforeList.length
    const bottomPgUp = await pressKeyAndSample(page, 'PageUp')
    await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
    const bottomProbeAfter = await readProbe(page)
    const bottomWritesAfterList = await readWriteDetails(page)
    const bottomWrites = bottomWritesAfterList.length - bottomWritesBefore
    const bottomCausal = describeLegCausality(
      'BOTTOM-PGUP',
      bottomProbeBefore,
      bottomProbeAfter,
      bottomWritesBeforeList,
      bottomWritesAfterList
    )
    const bottomLive = await settledOrThrow(page)
    const bottomSnap = await readSnapFull(page, topicId)
    const bottomState = await readScrollState(page)
    const edgePageSize = Math.max(200, 0.35 * bottomPgUp.clientHeight)
    const nearPre = await wheelToNearBottom(page)
    // Cursor hygiene: the drive hovers #messages to deliver wheel events;
    // park away before the settle wait so no hover dwell survives into the
    // near PageDown gesture.
    await parkCursorOnDeadSpot(page)
    await page.waitForTimeout(2000)
    const nearIdleDiag = await waitForIdleStart(page, 'near-PgDn')
    const nearPreLive = await readAnchor(page)
    const nearPreSnap = await readSnapFull(page, topicId)
    const nearPreState = await readScrollState(page)
    const nearProbeBefore = await readProbe(page)
    const nearWritesBeforeList = await readWriteDetails(page)
    const nearWritesBefore = nearWritesBeforeList.length
    const nearBtbPre = await readBtbSnapshot(page)
    await installAbortProbe(page)
    const nearPgDn = await pressKeyAndSample(page, 'PageDown')
    await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
    const nearBtbPost = await readBtbSnapshot(page)
    const nearAbortMuts = await readAbortProbe(page)
    await removeAbortProbe(page).catch(() => {})
    const nearProbeAfter = await readProbe(page)
    const nearWritesAfterList = await readWriteDetails(page)
    const nearWrites = nearWritesAfterList.length - nearWritesBefore
    const nearCausal = describeLegCausality(
      'NEAR-PGDN',
      nearProbeBefore,
      nearProbeAfter,
      nearWritesBeforeList,
      nearWritesAfterList
    )
    const nearLive = await settledOrThrow(page)
    const nearSnap = await readSnapFull(page, topicId)
    const nearState = await readScrollState(page)
    const bottomTimeline =
      `BOTTOM-PGUP start=${Math.round(bottomPgUp.startTop)} end=${Math.round(bottomPgUp.endTop)} delta=${Math.round(bottomPgUp.delta)} peak=${Math.round(bottomPgUp.maxExcursion)} revert=${Math.round(bottomPgUp.finalFromPeak)} docDelta=${Math.round(bottomPgUp.docDelta)} writes=${bottomWrites} live=${bottomLive.id.slice(0, 8)}…@${Math.round(bottomLive.offset)} snap=${bottomSnap ? `${bottomSnap.id.slice(0, 8)}… st=${bottomSnap.scrollTop === null ? '?' : Math.round(bottomSnap.scrollTop)}` : 'null'} | ` +
      `NEAR-PGDN pre=${Math.round(nearPre)} end=${Math.round(nearPgDn.endTop)} delta=${Math.round(nearPgDn.delta)} revert=${Math.round(nearPgDn.finalFromPeak)} docDelta=${Math.round(nearPgDn.docDelta)} writes=${nearWrites} live=${nearLive.id.slice(0, 8)}…@${Math.round(nearLive.offset)} snapBottom=${nearSnap ? String(nearSnap.isAtBottom) : 'null'}`
    const causalTimeline =
      `${bottomIdleDiag} preLive=${bottomPreLive ? `${bottomPreLive.id.slice(0, 8)}…@${Math.round(bottomPreLive.offset)}` : 'null'} preSnap=${bottomPreSnap ? `${bottomPreSnap.id.slice(0, 8)}… st=${bottomPreSnap.scrollTop === null ? '?' : Math.round(bottomPreSnap.scrollTop)}` : 'null'} preTop=${Math.round(bottomPreState.scrollTop)} phase=${bottomPreState.phase} || ${bottomCausal} || ` +
      `${nearIdleDiag} preLive=${nearPreLive ? `${nearPreLive.id.slice(0, 8)}…@${Math.round(nearPreLive.offset)}` : 'null'} preSnap=${nearPreSnap ? `${nearPreSnap.id.slice(0, 8)}… st=${nearPreSnap.scrollTop === null ? '?' : Math.round(nearPreSnap.scrollTop)}` : 'null'} preTop=${Math.round(nearPreState.scrollTop)} phase=${nearPreState.phase} || ${nearCausal}`
    test.info().annotations.push({ type: 'kb-bottom-timeline', description: bottomTimeline.slice(0, 1500) })
    test.info().annotations.push({ type: 'kb-edge-causality', description: causalTimeline.slice(0, 1900) })
    const nearKeyT =
      nearProbeAfter.bubble.length > 0
        ? (nearProbeAfter.bubble[nearProbeBefore.bubble.length]?.t ?? NaN)
        : ((nearProbeAfter.capture[nearProbeBefore.capture.length]?.t as number | undefined) ?? NaN)
    const nearSeNew = nearProbeAfter.scrollEndTimes.slice(nearProbeBefore.scrollEndTimes.length)
    // Tooltip-hotspot observation (diagnostic-only residual, no contract):
    // a stationary cursor on the message action button may breed tooltip
    // churn mid-gesture. Count tooltip overlay mutations inside the key leg
    // window for diagnosis only — the parked ordinary legs above stay the
    // contract, and this count NEVER gates the leg (neither zero-churn
    // guaranteed nor asserted here).
    const nearTooltipMuts = nearAbortMuts.filter((m) => m.target.includes('ant-tooltip'))
    const abortDiag =
      `NEAR-ABORT keyT=${Number.isFinite(nearKeyT) ? nearKeyT : 'na'} scrollEnds=[${nearSeNew.join(',') || 'none'}] ` +
      `btbPre=${nearBtbPre.exists ? `aria=${nearBtbPre.ariaHidden} dis=${String(nearBtbPre.disabled)} tab=${String(nearBtbPre.tabIndex)} vis=${nearBtbPre.visibility} op=${nearBtbPre.opacity} pe=${nearBtbPre.pointerEvents}` : 'absent'} ` +
      `btbPost=${nearBtbPost.exists ? `aria=${nearBtbPost.ariaHidden} dis=${String(nearBtbPost.disabled)} tab=${String(nearBtbPost.tabIndex)} vis=${nearBtbPost.visibility} op=${nearBtbPost.opacity} pe=${nearBtbPost.pointerEvents}` : 'absent'} ` +
      `tooltip=${nearTooltipMuts.length} ` +
      `muts=${nearAbortMuts.length}${
        nearAbortMuts.length
          ? ` (${nearAbortMuts
              .slice(0, 12)
              .map(
                (m) =>
                  `@${m.t} ${m.target} ${m.type}${m.attr ? `:${m.attr}` : ''}${m.type === 'childList' ? ` +${m.added}/-${m.removed}` : ''}`
              )
              .join(' // ')})`
          : ''
      }`
    test.info().annotations.push({ type: 'kb-near-abort', description: abortDiag.slice(0, 1900) })
    try {
      // eslint-disable-next-line no-console
      console.log(`[E2E] kb-near-abort ${abortDiag.slice(0, 1900)}`)
    } catch {}
    try {
      // eslint-disable-next-line no-console
      console.log(`[E2E] kb-bottom ${bottomTimeline}`)
    } catch {}
    try {
      // eslint-disable-next-line no-console
      console.log(`[E2E] kb-edge-causal ${causalTimeline.slice(0, 1900)}`)
    } catch {}
    await removeKeyProbe(page).catch(() => {})
    expect(bottomClickFocus, 'ordinary bottom click must focus inside #messages for native paging').toMatch(
      /:in-messages/
    )
    expect(
      Math.abs(bottomPgUp.docDelta),
      `bottom PageUp must page #messages, not the document (docDelta ${Math.round(bottomPgUp.docDelta)}px)`
    ).toBeLessThanOrEqual(16)
    // Write counter is no-pullback evidence, not a hard zero gate: the
    // movement-survival assertions below prove no keeper pullback even if a
    // benign programmatic write lands inside the window. Writes stay in the
    // timeline for diagnosis.
    expect(bottomWrites, 'write counter must be readable for the bottom leg').toBeGreaterThanOrEqual(0)
    expect(
      Math.abs(bottomPgUp.delta),
      `bottom PageUp must reach the full native page (~0.9x ch, gate ${Math.round(0.8 * bottomPgUp.clientHeight)}px, got ${Math.round(bottomPgUp.delta)}px; pre-fix truncation lands at ~230px with zero writes)`
    ).toBeGreaterThanOrEqual(Math.round(0.8 * bottomPgUp.clientHeight))
    expect(
      Math.abs(bottomPgUp.finalFromPeak),
      `bottom PageUp movement must survive settling (peak revert ${Math.round(bottomPgUp.finalFromPeak)}px, not a keeper pullback)`
    ).toBeLessThanOrEqual(edgePageSize / 2)
    expect(bottomSnap, 'bottom PageUp leg must commit a route snapshot').not.toBeNull()
    expect(bottomSnap!.id, 'bottom PageUp snapshot identity must match the settled live identity').toBe(bottomLive.id)
    if (bottomSnap!.intraRowOffset !== null) {
      expect(
        Math.abs(bottomSnap!.intraRowOffset - bottomLive.offset),
        'bottom PageUp snapshot offset must match the settled live offset'
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }
    expect(bottomSnap!.scrollTop, 'bottom PageUp snapshot scrollTop must be finite').not.toBeNull()
    expect(
      Math.abs((bottomSnap!.scrollTop as number) - bottomState.scrollTop),
      'bottom PageUp snapshot scrollTop must match the settled container scrollTop'
    ).toBeLessThanOrEqual(OFFSET_TOL)
    expect(
      Math.abs(nearPgDn.docDelta),
      `near-bottom PageDown must page #messages, not the document (docDelta ${Math.round(nearPgDn.docDelta)}px)`
    ).toBeLessThanOrEqual(16)
    expect(nearWrites, 'write counter must be readable for the near-bottom leg').toBeGreaterThanOrEqual(0)
    expect(
      Math.abs(nearState.scrollTop),
      `last-page PageDown from ${Math.round(nearPre)} must reach physical bottom in one press (no stuck midpoint)`
    ).toBeLessThanOrEqual(2)
    expect(
      Math.abs(nearPgDn.finalFromPeak),
      `near-bottom PageDown movement must survive settling (peak revert ${Math.round(nearPgDn.finalFromPeak)}px, not a keeper pullback)`
    ).toBeLessThanOrEqual(edgePageSize / 2)
    expect(nearSnap, 'near-bottom PageDown leg must commit a route snapshot').not.toBeNull()
    expect(nearSnap!.isAtBottom, 'reaching physical bottom must resume bottom follow').toBe(true)
    // Tooltip-hotspot observation (known product residual, unfixed): the count
    // stays in the timeline for diagnosis only — existing fullpage/near/
    // restore legs unchanged, no relaxed assert, and NO zero-churn guarantee.
    // A nonzero count names a suspected abort source without passing or
    // failing anything; the movement assertions above stay the contract.
  })

  test('keyboard long-markdown large-window pages with stable BTB mount', async ({ mainWindow, electronApp }) => {
    // Structural isolation (not green-washing): the long-Markdown
    // large-window phase below proves the BackToBottom stable-mount root fix
    // independently of the 30-short edge legs above. All long assertions are
    // preserved verbatim — first/next-full PageUp plus near 30px/200px/0.7page
    // PageDown matrix plus natural wheel + explicit BTB return are actually
    // executed here, never list-compiled. A short-edge failure no longer
    // masks this root-fix evidence, and no coverage is removed.
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'KEYBOARD LONG (BackToBottom stable-mount root fix): user + 1 long Markdown multi-screen SUCCESS at 1706x967. First PageUp from the physical bottom must reach the full native page with zero truncation; second/third must agree within 5%; near 30px/200px/0.7page PageDown each reach physical bottom in ONE press; natural wheel + explicit BTB return. Ordinary input only; never writes scrollTop.'
    })
    const page: Page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    try {
      await (electronApp as any).evaluate(async ({ BrowserWindow }: any) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (w) {
          w.setSize(1706, 967)
          w.center()
        }
      })
    } catch {
      await page.setViewportSize({ width: 1706, height: 967 }).catch(() => {})
    }
    await page.waitForTimeout(1200)
    const longTopicId = `kb-long-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await seedLongMarkdownTopic(page, assistantId, longTopicId)
    await activateTopic(page, longTopicId, 2)
    const longLoaded = await page.evaluate(
      (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])] as string[],
      longTopicId
    )
    expect(longLoaded.length, 'long topic holds user + 1 long assistant message').toBe(2)
    // Multi-screen precondition at the large window (sh >> ch, several pages).
    const longRange = await readScrollState(page)
    expect(
      longRange.scrollHeight - longRange.clientHeight,
      'long Markdown must span multiple screens at 1706x967'
    ).toBeGreaterThan(2 * longRange.clientHeight)
    test.info().annotations.push({
      type: 'kb-long-range',
      description: `ch=${Math.round(longRange.clientHeight)} sh=${Math.round(longRange.scrollHeight)} range=${Math.round(longRange.scrollHeight - longRange.clientHeight)}`
    })

    await wheelToBottomEdge(page)
    await page.waitForTimeout(2500)
    // Test-setup focus (not product compensation): click the REAL visible
    // center of #messages (never the max-bottom row geometric center, which
    // resolves off-screen at y~-1759 for the long Markdown and leaves focus
    // outside so keys never page). Nudge off links/buttons when needed, then
    // focus the container with preventScroll as explicit setup. Readback
    // below proves focus truly landed inside #messages before paging.
    const longBottomPt = await page.evaluate(() => {
      const c = document.querySelector('#messages') as HTMLElement | null
      if (!c) return null
      const r = c.getBoundingClientRect()
      let x = r.x + r.width / 2
      let y = r.y + r.height / 2
      try {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null
        if (hit && hit.closest && hit.closest('a,button')) {
          y = r.y + r.height * 0.35
        }
      } catch {}
      return { x, y }
    })
    expect(longBottomPt, 'long-topic #messages visible center must be clickable').not.toBeNull()
    await page.mouse.click(longBottomPt!.x, longBottomPt!.y)
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const c = document.querySelector('#messages') as HTMLElement | null
      try {
        c?.focus({ preventScroll: true } as FocusOptions)
      } catch {
        c?.focus()
      }
    })
    await page.waitForTimeout(300)
    await installKeyProbe(page)
    const longClickFocus = await describeActiveElement(page)
    expect(longClickFocus, 'long-topic setup click must focus inside #messages for native paging').toMatch(
      /:in-messages/
    )
    // Cursor hygiene: park off the scroller so hover/tooltip churn cannot
    // abort the long PageUp gestures (focus stays :in-messages).
    await parkCursorOnDeadSpot(page)
    // Stable-mount identity: pin the live BTB node BEFORE the first paging
    // gesture. The button is always mounted (hidden via visual/interactive/
    // assistive gates, never DOM absence) — DOM-absent must never count as
    // hidden, so the locator must stay attached at the bottom.
    const btbLocator = page.locator('[data-testid="conversation-back-to-bottom"]')
    await expect(btbLocator, 'BTB node must stay attached at the physical bottom').toBeAttached()
    await page.evaluate(() => {
      ;(window as any).__btbPinned = document.querySelector('[data-testid="conversation-back-to-bottom"]')
    })
    const btbHiddenAtBottom = await btbLocator.getAttribute('aria-hidden')
    expect(btbHiddenAtBottom, 'BTB must be assistive-hidden at the physical bottom').toBe('true')
    expect(await btbLocator.isDisabled(), 'BTB must be non-interactive at the physical bottom').toBe(true)

    const longLegs: KeyLeg[] = []
    const longReverts: number[] = []
    for (let i = 0; i < 3; i++) {
      const leg = await pressKeyAndSample(page, 'PageUp')
      await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
      longLegs.push(leg)
      longReverts.push(leg.finalFromPeak)
    }
    const longCh = longLegs[0].clientHeight
    const longTimeline =
      `LONG-PGUP ch=${Math.round(longCh)} ` +
      longLegs
        .map(
          (l, i) =>
            `#${i + 1} delta=${Math.round(l.delta)} revert=${Math.round(l.finalFromPeak)} doc=${Math.round(l.docDelta)}`
        )
        .join(' | ')
    test.info().annotations.push({ type: 'kb-long-timeline', description: longTimeline.slice(0, 1500) })
    try {
      // eslint-disable-next-line no-console
      console.log(`[E2E] kb-long ${longTimeline}`)
    } catch {}
    // First PageUp from the physical bottom must reach the full native page
    // (~0.9x ch). Pre-fix truncation lands at ~79px on ch769.
    expect(
      Math.abs(longLegs[0].delta),
      `long first PageUp must page >=0.8x ch (got ${Math.round(longLegs[0].delta)}px on ch ${Math.round(longCh)}px)`
    ).toBeGreaterThanOrEqual(Math.round(0.8 * longCh))
    // Second/third legs must agree with the first within 5% (uniform paging,
    // no first-gesture anomaly).
    for (const [label, leg] of [
      ['second', longLegs[1]],
      ['third', longLegs[2]]
    ] as const) {
      expect(
        Math.abs(Math.abs(leg.delta) - Math.abs(longLegs[0].delta)) / Math.max(1, Math.abs(longLegs[0].delta)),
        `long ${label} PageUp (${Math.round(leg.delta)}) must match the first (${Math.round(longLegs[0].delta)}) within 5%`
      ).toBeLessThanOrEqual(0.05)
      expect(
        Math.abs(leg.finalFromPeak),
        `long ${label} movement must survive settling (revert ${Math.round(leg.finalFromPeak)}px)`
      ).toBeLessThanOrEqual(longCh / 2)
    }
    expect(
      Math.abs(longLegs[0].finalFromPeak),
      `long first movement must survive settling (revert ${Math.round(longLegs[0].finalFromPeak)}px)`
    ).toBeLessThanOrEqual(longCh / 2)
    // First departure kept the SAME BTB node (no insert/remove mid-gesture).
    const btbSameNode = await page.evaluate(() => {
      const cur = document.querySelector('[data-testid="conversation-back-to-bottom"]')
      return !!(window as any).__btbPinned && cur === (window as any).__btbPinned
    })
    expect(btbSameNode, 'first departure from bottom must keep the same BTB DOM node').toBe(true)
    expect(await btbLocator.getAttribute('aria-hidden'), 'BTB must be exposed after leaving the bottom').toBe('false')
    expect(await btbLocator.isDisabled(), 'BTB must be interactive after leaving the bottom').toBe(false)

    // Near-bottom PageDown matrix on the long topic: 30px, 200px, and ~0.7
    // page above the bottom each reach physical bottom in ONE press.
    const nearMatrix: Array<{ label: string; drive: () => Promise<number> }> = [
      {
        label: '30px',
        drive: async () => {
          // Drive budget covers full-page departures: three genuine ~729px
          // PageUps park ~2187px from the bottom (previously ~237px under
          // truncation), so the loop allows 40 rounds with a coarse step far
          // away and the original fine step near the window. Window and
          // assertions below are unchanged.
          for (let i = 0; i < 40; i++) {
            const st = await readScrollState(page)
            if (st.scrollTop <= -25 && st.scrollTop >= -45) return st.scrollTop
            const box = await page.locator('#messages').first().boundingBox()
            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            const far = Math.abs(st.scrollTop + 35) > 400
            if (st.scrollTop > -25) await page.mouse.wheel(0, far ? -320 : -60)
            else await page.mouse.wheel(0, far ? 320 : 60)
            await page.waitForTimeout(300)
          }
          throw new Error('drive to 30px failed')
        }
      },
      {
        label: '200px',
        drive: async () => wheelToNearBottom(page)
      },
      {
        label: '0.7page',
        drive: async () => {
          const chNow = (await readScrollState(page)).clientHeight
          const target = -Math.round(0.7 * chNow)
          // Coarse far step + fine near step: a fixed 160px step straddles
          // the ±40px window (e.g. -480/-640 around -538) and oscillates
          // forever. Window and assertions below are unchanged.
          for (let i = 0; i < 40; i++) {
            const st = await readScrollState(page)
            if (Math.abs(st.scrollTop - target) <= 40) return st.scrollTop
            const box = await page.locator('#messages').first().boundingBox()
            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            const step = Math.abs(st.scrollTop - target) > 400 ? 320 : 40
            await page.mouse.wheel(0, st.scrollTop > target ? -step : step)
            await page.waitForTimeout(300)
          }
          throw new Error('drive to 0.7page failed')
        }
      }
    ]
    for (const entry of nearMatrix) {
      const pre = await entry.drive()
      // Cursor hygiene: each drive hovers #messages; park away before the
      // settle wait so no hover dwell survives into the PageDown gesture.
      await parkCursorOnDeadSpot(page)
      await page.waitForTimeout(2000)
      const leg = await pressKeyAndSample(page, 'PageDown')
      await waitScrollQuiescence(page).catch(async () => (await readScrollState(page)).scrollTop)
      const end = (await readScrollState(page)).scrollTop
      test.info().annotations.push({
        type: 'kb-long-near',
        description: `${entry.label} pre=${Math.round(pre)} delta=${Math.round(leg.delta)} end=${Math.round(end)} revert=${Math.round(leg.finalFromPeak)}`
      })
      expect(
        Math.abs(end),
        `long ${entry.label} PageDown from ${Math.round(pre)} must reach physical bottom in one press`
      ).toBeLessThanOrEqual(2)
      expect(
        Math.abs(leg.finalFromPeak),
        `long ${entry.label} movement must survive settling (revert ${Math.round(leg.finalFromPeak)}px)`
      ).toBeLessThanOrEqual(longCh / 2)
    }

    // Natural wheel reaches the bottom and the explicit button returns there:
    // at least one of each on the long topic (ordinary input only).
    await wheelToBottomEdge(page)
    await page.waitForTimeout(1500)
    expect(
      Math.abs((await readScrollState(page)).scrollTop),
      'natural wheel must reach the physical bottom on the long topic'
    ).toBeLessThanOrEqual(2)
    // The cursor is parked off-scroller after the matrix; re-hover #messages
    // so this wheel reaches the intended scroller (wheel dispatches at the
    // cursor position).
    {
      const box = await page.locator('#messages').first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    }
    // Column-reverse host: scrollTop 0 IS the bottom, so leaving it upward
    // needs a negative delta (+500 would clamp at the edge and go nowhere).
    await page.mouse.wheel(0, -500)
    await page.waitForTimeout(1500)
    await expect(btbLocator, 'BTB must be exposed after wheeling away on the long topic').toBeAttached()
    await btbLocator.click()
    await page.waitForTimeout(1500)
    expect(
      Math.abs((await readScrollState(page)).scrollTop),
      'explicit BTB activation must return to the physical bottom on the long topic'
    ).toBeLessThanOrEqual(16)
    try {
      const longProbe = await readProbe(page)
      // eslint-disable-next-line no-console
      console.log(
        `[E2E] kb-long-probe focus=${longClickFocus} keys=${longProbe.bubble.length} ends=${longProbe.scrollEnds}`
      )
    } catch {}
    await removeKeyProbe(page).catch(() => {})
  })

  test('control: wheel-established middle position survives a Settings roundtrip', async ({ mainWindow }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'CONTROL: ordinary wheel-established middle position survives Chat->Settings->Chat with anchor identity + offset intact, proving snapshot/restore machinery works independently of the keyboard path.'
    })
    const page: Page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const sidebarPage = new SidebarPage(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `kb-ctrl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `KbCtrl ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => uuidLike(i),
      contentPrefix: 'kb-ctrl-',
      contentForIndex: (i: number) => `kb-ctrl-${pad(i, 5)} ${'filler words '.repeat(25)}`
    })
    await activateTopic(page, topicId, TOTAL)
    const middle = await wheelToMiddle(page, ids)
    await waitSnapMatchesLive(page, topicId, ids)
    const snapBefore = await readSnapId(page, topicId)
    expect(snapBefore, 'wheel-established snapshot must confirm the middle anchor').toBe(middle.id)

    await sidebarPage.goToSettings()
    await waitForSettingsLoad(page)
    await expect(page.locator('#home-page')).toBeHidden({ timeout: 10000 })
    await sidebarPage.goToHome()
    await waitForChatReady(page)
    await expect(page.locator('#home-page')).toBeVisible({ timeout: 15000 })
    const restored = await settledOrThrow(page)
    expect(restored.id, 'control roundtrip must restore the wheel-established anchor identity').toBe(middle.id)
    expect(
      Math.abs(restored.offset - middle.offset),
      'control roundtrip must restore the anchor offset'
    ).toBeLessThanOrEqual(OFFSET_TOL)
  })
})

test.describe('Keyboard native paging — continuous presses and clamped-edge paging', () => {
  test('consecutive PageUp/PageDown presses each page natively (no stall) and clamped-edge presses stay native', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED UI: from a verified middle position (proven by the scroll range, >500px from both physical extremes), consecutive native PageDown presses must each move #messages by a full page (~0.9 x clientHeight, monotonic, never a truncated stub or a stall at the same position), the same must hold for consecutive PageUp presses back up, a press at the clamped newest edge must stay honestly clamped (no fabricated motion) while the opposite direction still pages natively, and the reading row must stay inside the offset tolerance across the whole sequence (app holds the reading position, it never cancels or reverts native keyboard motion).'
    })
    const page: Page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const assistantId = await prepareAssistant(page, TOTAL)
    const topicId = `kb-continuous-${uuidLike(Date.now() % 100000)}`
    const ids = await seedLongMarkdownTopic(page, assistantId, topicId)
    await activateTopic(page, topicId, Math.min(TOTAL, ids.length))

    // Multi-screen precondition: three full native pages in EACH direction must
    // have real room (range > 8 client heights), so no press inside the sequence
    // can be clamped at an edge and read as a stall.
    const rangeSt = await readScrollState(page)
    expect(
      rangeSt.scrollHeight - rangeSt.clientHeight,
      'long Markdown must span more than eight screens so both three-press sequences have room'
    ).toBeGreaterThan(8 * rangeSt.clientHeight)

    // Setup focus first (native paging needs the scroll host focused), then the
    // verified middle, then cursor hygiene — all real input, no scrollTop write.
    const setupFocus = await focusMessagesForNativePaging(page)
    await wheelToMiddleByRange(page)
    await parkCursorOnDeadSpot(page)
    const anchor = await settledOrThrow(page)

    // Diagnostic-only instruments (existing test seams; no input or
    // precondition change): key probe for key target/defaultPrevented, write
    // counter for per-leg app writes. Every record is emitted BEFORE its
    // assertion so a failing leg still reports where the press landed.
    await installKeyProbe(page)
    await installWriteCounter(page)
    const snapBefore = await readSnapId(page, topicId)
    const startSt = await readScrollState(page)
    // eslint-disable-next-line no-console
    console.log(
      `[E2E] kb-leg-start focus=${setupFocus} snap=${snapBefore.slice(0, 8)} anchorRow=${anchor.id.slice(0, 8)}@${Math.round(anchor.offset)} ` +
        `st=${Math.round(startSt.scrollTop)} ch=${Math.round(startSt.clientHeight)} sh=${Math.round(startSt.scrollHeight)} ` +
        `range=${Math.round(startSt.scrollHeight - startSt.clientHeight)}`
    )

    // --- Consecutive PageDown: every press must page a full native amount -----
    const downDeltas: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const focusBefore = await describeActiveElement(page)
      const beforeProbe = await readProbe(page).catch(() => null)
      const beforeWrites = await readWriteCount(page).catch(() => -1)
      const leg = await pressKeyAndSample(page, 'PageDown')
      await describePagingLeg(page, `down${i + 1}`, leg, focusBefore, beforeProbe, beforeWrites)
      await waitScrollQuiescence(page)
      downDeltas.push(leg.delta)
      expect(leg.docDelta, 'the document must not scroll instead of #messages').toBeLessThanOrEqual(4)
      expect(
        Math.abs(leg.delta),
        `PageDown leg ${i + 1} must move #messages by a full native page, not a stub (delta=${leg.delta})`
      ).toBeGreaterThan(leg.clientHeight * 0.5)
    }
    // Every press moved the SAME direction: no stall, no reversal.
    expect(downDeltas.every((d) => d * downDeltas[0] >= 0)).toBe(true)
    expect(Math.abs(downDeltas[0])).toBeGreaterThan(0)

    // --- Consecutive PageUp back up: symmetric, no stall ---------------------
    const upDeltas: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const focusBefore = await describeActiveElement(page)
      const beforeProbe = await readProbe(page).catch(() => null)
      const beforeWrites = await readWriteCount(page).catch(() => -1)
      const leg = await pressKeyAndSample(page, 'PageUp')
      await describePagingLeg(page, `up${i + 1}`, leg, focusBefore, beforeProbe, beforeWrites)
      await waitScrollQuiescence(page)
      upDeltas.push(leg.delta)
      expect(leg.docDelta, 'the document must not scroll instead of #messages').toBeLessThanOrEqual(4)
      expect(
        Math.abs(leg.delta),
        `PageUp leg ${i + 1} must move #messages by a full native page, not a stub (delta=${leg.delta})`
      ).toBeGreaterThan(leg.clientHeight * 0.5)
    }
    expect(upDeltas.every((d) => d * upDeltas[0] >= 0)).toBe(true)
    expect(Math.sign(upDeltas[0]), 'PageUp must move opposite to PageDown').toBe(-Math.sign(downDeltas[0]))
    // eslint-disable-next-line no-console
    console.log(
      `[E2E] kb-leg-seq downDeltas=${downDeltas.map((d) => Math.round(d)).join(',')} upDeltas=${upDeltas.map((d) => Math.round(d)).join(',')} ` +
        `snapAfterUp=${(await readSnapId(page, topicId)).slice(0, 8)}`
    )

    // --- The reading row survives the whole sequence (no revert, no cancel) ---
    const afterSeq = await measureTargetRow(page, anchor.id)
    expect(afterSeq?.found, 'the live reading row must stay mounted across native paging').toBe(true)
    const afterSeqOffset = afterSeq?.offset ?? anchor.offset
    expect(
      Math.abs(afterSeqOffset - anchor.offset),
      'app holds must not fight native keyboard paging (reading row offset bounded)'
    ).toBeLessThanOrEqual(OFFSET_TOL * 12)

    // --- Clamped newest edge: honest clamp, opposite direction still pages ----
    // Real wheel to the physical newest edge (never a scrollTop write).
    await wheelToBottomEdge(page)
    const clampedDownBefore = await describeActiveElement(page)
    const clampedDownProbe = await readProbe(page).catch(() => null)
    const clampedDownWrites = await readWriteCount(page).catch(() => -1)
    const clampedDown = await pressKeyAndSample(page, 'PageDown')
    await describePagingLeg(page, 'clampedDown', clampedDown, clampedDownBefore, clampedDownProbe, clampedDownWrites)
    expect(
      Math.abs(clampedDown.delta),
      `a PageDown at the clamped newest edge must stay honestly clamped (no fabricated motion, delta=${clampedDown.delta})`
    ).toBeLessThanOrEqual(OFFSET_TOL)
    expect(clampedDown.docDelta, 'the document must not scroll instead of #messages').toBeLessThanOrEqual(4)
    const beforeClampedUp = await readScrollState(page)
    const clampedUpBefore = await describeActiveElement(page)
    const clampedUpProbe = await readProbe(page).catch(() => null)
    const clampedUpWrites = await readWriteCount(page).catch(() => -1)
    const clampedUp = await pressKeyAndSample(page, 'PageUp')
    await describePagingLeg(page, 'clampedUp', clampedUp, clampedUpBefore, clampedUpProbe, clampedUpWrites)
    expect(
      Math.abs(clampedUp.delta),
      `PageUp at the clamped edge must page natively (delta=${clampedUp.delta}, ch=${clampedUp.clientHeight})`
    ).toBeGreaterThan(clampedUp.clientHeight * 0.5)
    expect(clampedUp.endTop).not.toBe(beforeClampedUp.scrollTop)
    await removeKeyProbe(page).catch(() => {})
  })
})
