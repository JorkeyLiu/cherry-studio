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
 * #messages by a meaningful native page-sized amount in opposite directions,
 * survive settling, and commit a snapshot whose stable anchor matches the live
 * crossing-first anchor. The SAME keyboard-established anchor must then
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
}

interface ProbeReport {
  capture: Array<{ key: string; target: string }>
  bubble: Array<{ key: string; target: string; defaultPrevented: boolean }>
  containerPass: number
  scrollEnds: number
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
} | null> {
  return page.evaluate((mid: string) => {
    const container = document.querySelector('#messages') as HTMLElement | null
    if (!container) return null
    const c = container.getBoundingClientRect()
    const row =
      (document.querySelector(`#messages [data-message-id="${mid}"]`) as HTMLElement | null) ??
      (document.getElementById(`message-${mid}`) as HTMLElement | null)
    if (!row || !row.isConnected)
      return {
        found: false,
        height: 0,
        offset: NaN,
        containerHeight: c.height,
        visibleHeight: 0,
        rectTop: NaN,
        contTop: c.top
      }
    if (window.getComputedStyle(row).display === 'none')
      return {
        found: false,
        height: 0,
        offset: NaN,
        containerHeight: c.height,
        visibleHeight: 0,
        rectTop: NaN,
        contTop: c.top
      }
    const r = row.getBoundingClientRect()
    const visibleHeight = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)
    return {
      found: true,
      height: r.height,
      offset: r.top - c.top,
      containerHeight: c.height,
      visibleHeight,
      rectTop: r.top,
      contTop: c.top
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

async function installKeyProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__kbProbe) return
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
      capture: [] as Array<{ key: string; target: string }>,
      bubble: [] as KeySight[],
      containerPass: 0,
      scrollEnds: 0
    }
    w.__kbProbe = rec
    w.__kbCapH = (e: KeyboardEvent) => {
      if (['PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) {
        rec.capture.push({ key: e.key, target: describe(e.target) })
      }
    }
    w.__kbBubH = (e: KeyboardEvent) => {
      if (['PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) {
        rec.bubble.push({
          key: e.key,
          target: describe(e.target),
          defaultPrevented: e.defaultPrevented,
          atBubble: true
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
    }
  })
}

async function readProbe(page: Page): Promise<ProbeReport> {
  return page.evaluate(() => {
    const rec = (window as unknown as Record<string, any>).__kbProbe
    if (!rec) return { capture: [], bubble: [], containerPass: -1, scrollEnds: -1 }
    return {
      capture: [...rec.capture],
      bubble: [...rec.bubble],
      containerPass: rec.containerPass,
      scrollEnds: rec.scrollEnds
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
      } catch {
        // best-effort
      } finally {
        delete w.__kbProbe
        delete w.__kbCapH
        delete w.__kbBubH
        delete w.__kbContH
        delete w.__kbSeH
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

test.describe('Keyboard viewport scroll — real PageUp/PageDown after ordinary click', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('PageDown then PageUp page the viewport, survive settling, and commit the stable anchor', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
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
    const containerTabIndex = await page.evaluate(
      () => document.querySelector('#messages')?.getAttribute('tabindex') ?? '(none)'
    )
    const phaseAfterClick = (await readScrollState(page)).phase

    await installKeyProbe(page)
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

    // Textarea comparison with a focus precondition: keyboard paging semantics
    // for editable inputs are asserted NEGATIVELY below (PageDown in the
    // textarea must not page #messages) — no invented redirect contract.
    await page.locator('.inputbar textarea, textarea[placeholder]').first().click()
    await page.waitForTimeout(300)
    const textareaFocus = await describeActiveElement(page)
    const textLeg = await pressKeyAndSample(page, 'PageDown')
    const textProbe = await readProbe(page)

    const pageSize = Math.max(200, 0.35 * down.clientHeight)
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
    await expect
      .poll(
        async () => {
          const m = await measureTargetRow(page, requestedId)
          if (!m || !m.found || !Number.isFinite(m.offset)) return NaN
          return Math.abs(m.offset - savedOffset)
        },
        { timeout: 15000, intervals: [250] }
      )
      .toBeLessThanOrEqual(OFFSET_TOL)
    const targetRect = await measureTargetRow(page, requestedId)
    const rectDiag =
      `requested=${requestedSnap!.id.slice(0, 8)}… savedOff=${Math.round(savedOffset)} ` +
      `after=${snapAfterTopic!.id.slice(0, 8)}… afterOff=${snapAfterTopic!.intraRowOffset === null ? '?' : Math.round(snapAfterTopic!.intraRowOffset)} ` +
      `rect=${targetRect ? `found=${targetRect.found} h=${Math.round(targetRect.height)} off=${Number.isFinite(targetRect.offset) ? Math.round(targetRect.offset) : '?'} vis=${Math.round(targetRect.visibleHeight)} ch=${Math.round(targetRect.containerHeight)} rectTop=${Number.isFinite(targetRect.rectTop) ? Math.round(targetRect.rectTop) : '?'} contTop=${Math.round(targetRect.contTop)}` : 'null'}`
    test.info().annotations.push({ type: 'kb-topic-restore', description: rectDiag.slice(0, 1200) })
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
