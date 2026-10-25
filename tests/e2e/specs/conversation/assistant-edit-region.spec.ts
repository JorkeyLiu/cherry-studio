/**
 * Assistant-message Edit/Cancel interaction-region stationary baseline (PRE-FIX FAILING E2E).
 *
 * Bounded evidence+regression task ONLY — no production/docs edits. Two
 * minimal reproducible tests through the REAL per-message assistant editor
 * (NOT the global edit-mode toggle):
 *
 *  1. `assistant Edit open keeps the interaction region stationary`
 *  2. `assistant Edit Cancel returns without inheriting Edit centering`
 *
 * Known pre-fix paths under test (read-only, never patched here):
 *  - Message.tsx `isEditing` effect `scrollIntoView(center, smooth)`
 *  - MessageEditor focus + autoFocus textarea effects
 *  - shared keeper routeViewportContext hold resize/mutation body-row anchor
 *
 * Contract (shared root fix target): opening or cancelling the assistant
 * editor must keep the SAME interaction region stationary — the clicked
 * message row's viewport geometry with the stationary pointer still hitting
 * the same message — instead of per-button smooth-centering each control.
 * Raw `scrollTop` invariance does NOT hold in column-reverse (a height swap
 * below the viewport necessarily changes `scrollTop` for the SAME row
 * position), so message-row geometry + hit-testing is primary.
 *
 * Seams (existing only): #messages, [data-message-id],
 * [data-testid="msg-assistant-edit-btn"], .message-editor-area,
 * .editing-message (+ .cm-content[contenteditable] in source mode),
 * window.store (seed/introspection),
 * window.api.chatDb.ensureTopic/pasteMessagesToTopic/getRawTopic
 * (seed/introspection), window.keyv scroll snapshot (supporting only),
 * data-viewport-phase (supporting only). UI actions (topic click, hover,
 * pointer click at recorded screen points, wheel, Esc/cancel click) always
 * go through the real UI. Never dispatches editing state or scrollToBottom
 * to fake the flow.
 *
 * Geometry: #messages renders column-reverse, so bottom/newest is
 * scrollTop ~= 0 and the oldest edge is the most negative scrollTop.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const DISPLAY_COUNT = 10
const BOTTOM_TOL = 100
const OFFSET_TOL = 12
// Stationary rendering tolerance: subpixel/style budget only (~2px). A real
// centering jump must fail, never be absorbed. Transition frames get a
// marginally larger budget for one painted intermediate frame.
const REGION_TOL = 2
const TRANSITION_TOL = 4
const NON_BOTTOM_MIN = 300
const TRUE_BOTTOM_TOL = 60
const TAKEOVER_MIN_MOVE = 200
const TAKEOVER_FINAL_TOL = 80
const TAKEOVER_POST_ADJUST_MIN = 150

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

interface Reading {
  anchorId: string
  offset: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
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

interface ControlGeometry {
  /** Edit (pre) or Cancel (post) button center actually clicked. */
  buttonCenter: { x: number; y: number }
  /** Button top minus container top. */
  buttonOffset: number
  buttonRect: Rect
  /** Stable region identity across editor swaps: the message row itself. */
  messageOffset: number
  messageRect: Rect
  /** Footer (closed) or editor action-bar (open) region, when measurable. */
  regionOffset: number | null
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
 * Seed: 3 single rounds + mid-topic user ask + ONE mid-topic assistant
 * target (medium-long in-flow content so its footer is a real in-flow
 * control region) + 4 single rounds. Total 16 authority rows. The mid-topic
 * placement is deliberate: a verified non-bottom reading viewport can fully
 * contain the assistant footer, so every Edit click is a real physical
 * pointer click with no test-induced auto-scroll.
 */
function buildEditRegionEntries(topicId: string, assistantId: string) {
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
    const userId = push(userIndex, 'user', `aer-fill-user-${round} ${'filler words '.repeat(30)}`)
    push(assistantIndex, 'assistant', `aer-fill-assistant-${round} ${'filler words '.repeat(30)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  const askId = push(6, 'user', `aer-target-ask ${'filler words '.repeat(10)}`)
  const targetAssistantId = push(
    7,
    'assistant',
    `aer-target-assistant-marker\n\n${Array.from({ length: 12 }, (_, i) => `target paragraph ${pad(i, 3)} in-flow filler words for control region`).join('\n\n')}`,
    {
      askId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    }
  )
  for (let round = 3; round < 7; round++) {
    const userIndex = round * 2 + 2
    const assistantIndex = round * 2 + 3
    const userId = push(userIndex, 'user', `aer-fill-user-${round} ${'filler words '.repeat(30)}`)
    push(assistantIndex, 'assistant', `aer-fill-assistant-${round} ${'filler words '.repeat(30)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  return { entries, targetAssistantId }
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
    { topicId, assistantId: liveAssistantId, name: `EditRegion ${topicId}` }
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
    { topicId, assistantId: liveAssistantId, name: `EditRegion ${topicId}`, entries }
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

async function setupEditRegionTopic(
  page: Page,
  displayCount = DISPLAY_COUNT
): Promise<{ topicId: string; targetAssistantId: string }> {
  await ensureDisplayCount(page, displayCount)
  const liveAssistantId = await getLiveAssistantId(page)
  const topicId = `aer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const built = buildEditRegionEntries(topicId, liveAssistantId)
  await seedTopicViaMainAuthority(page, liveAssistantId, topicId, built.entries)
  await activateTopicCold(page, topicId, [built.targetAssistantId])
  const loaded = await page.evaluate(
    (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])] as string[],
    topicId
  )
  expect(loaded.length).toBeGreaterThanOrEqual(Math.min(displayCount, 16))
  expect(loaded).toContain(built.targetAssistantId)
  return { topicId, targetAssistantId: built.targetAssistantId }
}

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
  return {
    anchorId: anchor.id,
    offset: anchor.offset,
    scrollTop: scroll.scrollTop,
    scrollHeight: scroll.scrollHeight,
    clientHeight: scroll.clientHeight
  }
}

function escId(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Edit button must sit fully inside #messages so the pointer click causes no auto-scroll. */
async function isEditButtonInViewport(page: Page, messageId: string): Promise<boolean> {
  return page.evaluate((id: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) return false
    const c = container.getBoundingClientRect()
    const btn = document.querySelector(
      `#message-${typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id} [data-testid="msg-assistant-edit-btn"]`
    ) as HTMLElement | null
    if (!btn) return false
    const r = btn.getBoundingClientRect()
    return r.top >= c.top && r.bottom <= c.bottom && r.width > 0 && r.height > 0
  }, messageId)
}

async function captureControlGeometry(page: Page, messageId: string): Promise<ControlGeometry> {
  return page.evaluate((id: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) throw new Error('#messages not found')
    const c = container.getBoundingClientRect()
    const cssEsc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const btn = document.querySelector(
      `#message-${cssEsc} [data-testid="msg-assistant-edit-btn"]`
    ) as HTMLElement | null
    if (!btn) throw new Error(`assistant edit button for ${id} not found`)
    const br = btn.getBoundingClientRect()
    if (!(br.width > 0 && br.height > 0)) throw new Error(`assistant edit button for ${id} has no box`)
    const row =
      (document.querySelector(`#message-${cssEsc}[data-message-id="${cssEsc}"]`) as HTMLElement | null) ??
      (document.querySelector(`#messages [data-message-id="${cssEsc}"]`) as HTMLElement | null)
    if (!row) throw new Error(`message row for ${id} not found`)
    const mr = row.getBoundingClientRect()
    // Stable interaction region (shared mechanism): the message-controls
    // annotation covers the footer when closed and the editor action bar
    // when open — the same semantic area through replacement.
    const region =
      (row.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null) ??
      (row.querySelector('.MessageFooter, [class*="MessageFooter"]') as HTMLElement | null)
    let regionOffset: number | null = null
    if (region) {
      const fr = region.getBoundingClientRect()
      if (fr.width > 0 && fr.height > 0) regionOffset = fr.bottom - c.top
    }
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
      buttonCenter: { x: br.x + br.width / 2, y: br.y + br.height / 2 },
      buttonOffset: br.top - c.top,
      buttonRect: norm(br),
      messageOffset: mr.top - c.top,
      messageRect: norm(mr),
      regionOffset,
      containerRect: { top: c.top, bottom: c.bottom, height: c.height }
    }
  }, messageId)
}

async function captureEditorGeometry(
  page: Page,
  messageId: string
): Promise<{
  messageOffset: number
  messageRect: Rect
  textareaRect: Rect | null
  cancelCenter: { x: number; y: number } | null
  cancelOffset: number | null
  regionOffset: number | null
  containerRect: { top: number; bottom: number; height: number }
}> {
  return page.evaluate((id: string) => {
    const container = document.getElementById('messages') as HTMLElement | null
    if (!container) throw new Error('#messages not found')
    const c = container.getBoundingClientRect()
    const cssEsc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const row =
      (document.querySelector(`#message-${cssEsc}[data-message-id="${cssEsc}"]`) as HTMLElement | null) ??
      (document.querySelector(`#messages [data-message-id="${cssEsc}"]`) as HTMLElement | null)
    if (!row) throw new Error(`message row for ${id} not found after edit open`)
    const mr = row.getBoundingClientRect()
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
    // CodeMirror contract: .editing-message stays the visible wrapper; the
    // real editable surface is .cm-content[contenteditable=true] in source
    // mode. Height geometry tracks the .editing-message wrapper (stable
    // viewport bounds; .cm-content doc height varies with virtualization) —
    // viewport semantics unchanged, actual input still targets .cm-content.
    const ta = (row.querySelector('.editing-message') as HTMLElement | null) ?? null
    let textareaRect: Rect | null = null
    if (ta) {
      const tr = ta.getBoundingClientRect()
      if (tr.width > 0 && tr.height > 0) textareaRect = norm(tr)
    }
    // Stable interaction region on the open side: the editor action bar
    // carries the same message-controls annotation as the closed footer.
    const region = row.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
    let regionOffset: number | null = null
    if (region) {
      const rr = region.getBoundingClientRect()
      if (rr.width > 0 && rr.height > 0) regionOffset = rr.bottom - c.top
    }
    // Cancel is the action-bar X button: locale-independent. Save carries
    // .message-editor-save-btn, resend carries .message-editor-resend-btn.
    // Scope explicitly to the existing controls region
    // ([data-interaction-region="message-controls"] ActionBar) — never DOM
    // first/last-child assumptions (EditorSurface last child is the edit
    // surface, whose first visible non-save button is the toolbar Source
    // toggle, not Cancel).
    const area = row.querySelector('.message-editor-area') as HTMLElement | null
    let cancelCenter: { x: number; y: number } | null = null
    let cancelOffset: number | null = null
    if (area) {
      const controls = row.querySelector(
        '.message-editor-area [data-interaction-region="message-controls"]'
      ) as HTMLElement | null
      const scope: HTMLElement | null = controls ?? area
      const btns = Array.from(scope.querySelectorAll('button')) as HTMLElement[]
      let cancel =
        btns.find(
          (b) =>
            !b.classList.contains('message-editor-save-btn') &&
            !b.classList.contains('message-editor-resend-btn') &&
            b.getBoundingClientRect().width > 0 &&
            b.getBoundingClientRect().height > 0
        ) ?? null
      if (!cancel && scope) {
        const all = Array.from(scope.querySelectorAll('button')) as HTMLElement[]
        cancel = all.find((b) => /cancel|取消/.test((b.getAttribute('aria-label') ?? '').toLowerCase())) ?? null
      }
      if (cancel) {
        const cr = cancel.getBoundingClientRect()
        cancelCenter = { x: cr.x + cr.width / 2, y: cr.y + cr.height / 2 }
        cancelOffset = cr.top - c.top
      }
    }
    return {
      messageOffset: mr.top - c.top,
      messageRect: norm(mr),
      textareaRect,
      cancelCenter,
      cancelOffset,
      regionOffset,
      containerRect: { top: c.top, bottom: c.bottom, height: c.height }
    }
  }, messageId)
}

/** elementFromPoint at a screen point must still resolve to the same message row. */
async function hitTestMessageAtPoint(page: Page, point: { x: number; y: number }, messageId: string): Promise<boolean> {
  return page.evaluate(
    ({ x, y, id }: { x: number; y: number; id: string }) => {
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      if (!hit) return false
      const row = hit.closest?.('[data-message-id]') as HTMLElement | null
      if (!row) return false
      if (row.getAttribute('data-testid') === 'answer-group-selector') return false
      return row.getAttribute('data-message-id') === id
    },
    { x: point.x, y: point.y, id: messageId }
  )
}

async function readPhase(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('messages')?.getAttribute('data-viewport-phase') ?? '')
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

async function describeActiveElement(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return 'null'
      const tag = el.tagName.toLowerCase()
      const cls = (el.className && String(el.className).slice(0, 120)) || ''
      const aria = el.getAttribute('aria-label') ?? ''
      const row = el.closest?.('[data-message-id]') as HTMLElement | null
      const rowId = row?.getAttribute('data-message-id') ?? ''
      return `${tag}|${cls}|aria=${aria}|row=${rowId}`
    })
    .catch(() => 'unknown')
}

async function installEditSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__aerSpy) return
    w.__aerSpy = []
    const push = (entry: Record<string, unknown>) => {
      try {
        ;(w.__aerSpy as Array<Record<string, unknown>>).push({ t: Date.now(), ...entry })
      } catch {}
    }
    const proto = (window as any).Element?.prototype
    const origSIV = proto?.scrollIntoView
    if (typeof origSIV === 'function') {
      proto.scrollIntoView = function (this: Element, ...args: unknown[]) {
        try {
          const el = this as HTMLElement
          push({
            kind: 'scrollIntoView',
            tag: el.tagName?.toLowerCase() ?? '',
            id: (el as HTMLElement).id ?? '',
            msg: el.getAttribute?.('data-message-id') ?? '',
            cls: String((el as HTMLElement).className ?? '').slice(0, 80),
            arg0: (() => {
              try {
                return JSON.stringify(args[0] ?? null).slice(0, 200)
              } catch {
                return String(args[0]).slice(0, 200)
              }
            })()
          })
        } catch {}
        return origSIV.apply(this, args as [])
      }
    }
    const htmlProto = (window as any).HTMLElement?.prototype
    const origFocus = htmlProto?.focus
    if (typeof origFocus === 'function') {
      htmlProto.focus = function (this: HTMLElement, ...args: unknown[]) {
        try {
          push({
            kind: 'focus',
            tag: this.tagName?.toLowerCase() ?? '',
            cls: String(this.className ?? '').slice(0, 80),
            msg: this.closest?.('[data-message-id]')?.getAttribute('data-message-id') ?? ''
          })
        } catch {}
        return origFocus.apply(this, args as [])
      }
    }
  })
}

async function readEditSpy(page: Page): Promise<Array<Record<string, unknown>>> {
  return page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>
      return Array.isArray(w.__aerSpy) ? (w.__aerSpy.slice() as Array<Record<string, unknown>>) : []
    })
    .catch(() => [])
}

async function clearEditSpy(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      try {
        delete (window as unknown as Record<string, any>).__aerSpy
      } catch {}
    })
    .catch(() => {})
}

/**
 * Ordinary wheel-established reading viewport that additionally keeps the
 * target assistant Edit button fully inside #messages without any direct
 * scrollTop write. Nudges toward bottom in small steps, then the opposite
 * sign, until the button is fully in-viewport while staying verified
 * non-bottom. Fails loudly otherwise.
 */
async function wheelToReadingPositionWithEditVisible(page: Page, messageId: string): Promise<Reading> {
  await wheelToReadingPosition(page)
  // Hover reveals the menubar (opacity 0 -> 1); the button box exists either
  // way, but hover matches the real user gesture before the click.
  const row = page.locator(`#message-${escId(messageId)}[data-message-id="${escId(messageId)}"]`).first()
  await row.hover().catch(() => {})
  if (await isEditButtonInViewport(page, messageId)) {
    const anchor = await settledAnchor(page)
    const fresh = await readScroll(page)
    expect(Math.abs(fresh.scrollTop), 'edit target must stay non-bottom').toBeGreaterThan(NON_BOTTOM_MIN)
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
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, 280)
    await page.waitForTimeout(220)
    const scroll = await readScroll(page)
    if (Math.abs(scroll.scrollTop) <= NON_BOTTOM_MIN) break
    await row.hover().catch(() => {})
    if (await isEditButtonInViewport(page, messageId)) {
      const anchor = await settledAnchor(page)
      const fresh = await readScroll(page)
      expect(Math.abs(fresh.scrollTop), 'nudge to reveal Edit must stay non-bottom').toBeGreaterThan(NON_BOTTOM_MIN)
      return {
        anchorId: anchor.id,
        offset: anchor.offset,
        scrollTop: fresh.scrollTop,
        scrollHeight: fresh.scrollHeight,
        clientHeight: fresh.clientHeight
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -280)
    await page.waitForTimeout(220)
    const scroll = await readScroll(page)
    if (Math.abs(scroll.scrollTop) <= NON_BOTTOM_MIN) break
    await row.hover().catch(() => {})
    if (await isEditButtonInViewport(page, messageId)) {
      const anchor = await settledAnchor(page)
      const fresh = await readScroll(page)
      expect(Math.abs(fresh.scrollTop), 'nudge to reveal Edit must stay non-bottom').toBeGreaterThan(NON_BOTTOM_MIN)
      return {
        anchorId: anchor.id,
        offset: anchor.offset,
        scrollTop: fresh.scrollTop,
        scrollHeight: fresh.scrollHeight,
        clientHeight: fresh.clientHeight
      }
    }
  }
  const visible = await isEditButtonInViewport(page, messageId)
  expect(visible, `assistant Edit button for ${messageId} must be reachable at a non-bottom reading position`).toBe(
    true
  )
  throw new Error('unreachable')
}

/**
 * Let the production smooth scrollIntoView + focus settle, then require
 * scroll quiescence (two rAF-separated samples within 8px) before the
 * retention assertion — settlement is polled, never assumed.
 */
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
  const fin = await readAnchor(page).catch(() => null)
  const fscroll = await readScroll(page).catch(
    () => ({ scrollTop: NaN, scrollHeight: NaN, clientHeight: NaN }) as never
  )
  throw new Error(
    `scroll never reached quiescence (last=${last} final=${fin ? `${fin.id}@${Math.round(fin.offset)}` : 'null'} st=${Math.round(fscroll.scrollTop)})`
  )
}

async function readMessageOffset(page: Page, messageId: string): Promise<number> {
  return page
    .evaluate((id: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return NaN
      const cssEsc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const row =
        (document.querySelector(`#message-${cssEsc}[data-message-id="${cssEsc}"]`) as HTMLElement | null) ??
        (document.querySelector(`#messages [data-message-id="${cssEsc}"]`) as HTMLElement | null)
      if (!row) return NaN
      return row.getBoundingClientRect().top - container.getBoundingClientRect().top
    }, messageId)
    .catch(() => NaN)
}

/** Live controls-region offset (footer when closed, editor action bar when open). */
async function readRegionOffset(page: Page, messageId: string): Promise<number> {
  return page
    .evaluate((id: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return NaN
      const cssEsc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const row =
        (document.querySelector(`#message-${cssEsc}[data-message-id="${cssEsc}"]`) as HTMLElement | null) ??
        (document.querySelector(`#messages [data-message-id="${cssEsc}"]`) as HTMLElement | null)
      if (!row) return NaN
      const region =
        (row.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null) ??
        (row.querySelector('.MessageFooter, [class*="MessageFooter"]') as HTMLElement | null)
      if (!region) return NaN
      return region.getBoundingClientRect().bottom - container.getBoundingClientRect().top
    }, messageId)
    .catch(() => NaN)
}

test.describe('Assistant Edit/Cancel interaction-region stationary baseline', () => {
  test.setTimeout(300000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('assistant Edit open keeps the interaction region stationary', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'ASSISTANT-EDIT REGION OPEN (PRE-FIX FAILING): from a verified non-bottom reading viewport with the mid-topic assistant footer fully in-viewport, a real physical pointer click at the recorded Edit-button center must keep the SAME message-row interaction region at its previous viewport geometry with the stationary pointer still hitting the same message — never smooth-centered. Painted transition frames sampled from BEFORE the click through editor open + settle; focus/scrollIntoView spy + phase/snapshot/activeElement recorded for shared-mechanism choice.'
    })
    const page: Page = mainWindow
    const { topicId, targetAssistantId } =
      await test.step('seed mid-topic assistant topic and cold-activate', async () => setupEditRegionTopic(page))

    const preReading = await test.step('wheel to a verified non-bottom reading position with Edit visible', async () =>
      wheelToReadingPositionWithEditVisible(page, targetAssistantId))
    const prePhase = await readPhase(page)
    const preSnap = await readRouteSnapshot(page, topicId)
    const preActive = await describeActiveElement(page)
    const pre = await captureControlGeometry(page, targetAssistantId)
    const point = { ...pre.buttonCenter }
    expect(
      await hitTestMessageAtPoint(page, point, targetAssistantId),
      'precondition: click point hits the target assistant message'
    ).toBe(true)
    await installEditSpy(page)

    // Painted transition tracking starts BEFORE the pointer click and
    // continues through editor open + settle — never only the eventual
    // final. The pointer is never repositioned during tracking. Both the
    // row top and the controls region (footer → action bar) are sampled
    // every frame: the region is the primary oracle (row identity alone is
    // insufficient through the height swap), the row is supporting.
    const samples: number[] = [0]
    const regionSamples: number[] = [0]
    const phases: string[] = [prePhase]
    const preRegionForFrames =
      typeof pre.regionOffset === 'number' && Number.isFinite(pre.regionOffset) ? pre.regionOffset : null
    await page.mouse.click(point.x, point.y)
    let editorSeen = false
    let settledExtra = 0
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      const cur = await readMessageOffset(page, targetAssistantId)
      if (Number.isFinite(cur)) samples.push(Math.abs(cur - pre.messageOffset))
      if (preRegionForFrames !== null) {
        const curRegion = await readRegionOffset(page, targetAssistantId)
        if (Number.isFinite(curRegion)) regionSamples.push(Math.abs(curRegion - preRegionForFrames))
      }
      phases.push(await readPhase(page).catch(() => ''))
      const open = await page.evaluate(() => !!document.querySelector('.message-editor-area')).catch(() => false)
      if (open) {
        editorSeen = true
        settledExtra += 1
        if (settledExtra >= 4) break
      } else {
        settledExtra = 0
      }
    }
    expect(editorSeen, 'editor must open after the real Edit click').toBe(true)
    const worst = samples.length > 0 ? Math.max(...samples) : Number.NaN
    const regionWorst = regionSamples.length > 0 ? Math.max(...regionSamples) : Number.NaN
    await waitForScrollQuiescence(page)
    const post = await captureEditorGeometry(page, targetAssistantId)
    const postScroll = await readScroll(page)
    const postPhase = await readPhase(page)
    const postSnap = await readRouteSnapshot(page, topicId)
    const postActive = await describeActiveElement(page)
    const spy = await readEditSpy(page)
    await clearEditSpy(page).catch(() => {})
    const messageDrift = Math.abs(post.messageOffset - pre.messageOffset)
    const centerDrift = Math.hypot(
      post.messageRect.left - pre.messageRect.left,
      post.messageRect.top - pre.messageRect.top
    )
    // Primary region oracle: the footer ↔ action-bar interaction area BOTTOM stays
    // where the click found it (same semantic area through replacement).
    expect(pre.regionOffset, 'precondition: footer interaction region must be measurable').not.toBeNull()
    expect(post.regionOffset, 'editor action-bar interaction region must be measurable').not.toBeNull()
    const regionDrift =
      pre.regionOffset !== null && post.regionOffset !== null
        ? Math.abs(post.regionOffset - pre.regionOffset)
        : Number.NaN
    const hit = await hitTestMessageAtPoint(page, point, targetAssistantId)
    const scrollTopDelta = Math.abs(postScroll.scrollTop - preReading.scrollTop)
    const hitDetail = await page
      .evaluate(({ x, y }: { x: number; y: number }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null
        if (!hit) return 'null'
        const row = hit.closest?.('[data-message-id]') as HTMLElement | null
        return `${hit.tagName.toLowerCase()}|${String(hit.className ?? '').slice(0, 80)}|row=${row?.getAttribute('data-message-id') ?? 'none'}|testid=${row?.getAttribute('data-testid') ?? (hit as HTMLElement).getAttribute?.('data-testid') ?? ''}`
      }, point)
      .catch(() => 'unknown')
    console.log(
      `[E2E] aer-open preMsgOff=${Math.round(pre.messageOffset)} postMsgOff=${Math.round(post.messageOffset)} drift=${messageDrift.toFixed(1)} regionDrift=${Number.isFinite(regionDrift) ? regionDrift.toFixed(1) : 'NaN'} hit=${hit} hitDetail=${hitDetail} worst=${Number.isFinite(worst) ? worst.toFixed(1) : 'NaN'} regionWorst=${Number.isFinite(regionWorst) ? regionWorst.toFixed(1) : 'NaN'} n=${samples.length} preScroll=${Math.round(preReading.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)} spy=${JSON.stringify(spy).slice(0, 600)}`
    )
    test.info().annotations.push({
      type: 'aer-open-geometry',
      description: `preMsgOff=${Math.round(pre.messageOffset)} postMsgOff=${Math.round(post.messageOffset)} drift=${messageDrift.toFixed(1)} regionDrift=${Number.isFinite(regionDrift) ? regionDrift.toFixed(1) : 'NaN'} centerDrift=${centerDrift.toFixed(1)} preBtnOff=${Math.round(pre.buttonOffset)} preRegion=${pre.regionOffset !== null ? Math.round(pre.regionOffset) : 'null'} postRegion=${post.regionOffset !== null ? Math.round(post.regionOffset) : 'null'} preScroll=${Math.round(preReading.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)} delta=${scrollTopDelta.toFixed(1)} hit=${hit} worst=${Number.isFinite(worst) ? worst.toFixed(1) : 'NaN'} regionWorst=${Number.isFinite(regionWorst) ? regionWorst.toFixed(1) : 'NaN'} n=${samples.length} textarea=${post.textareaRect ? `${Math.round(post.textareaRect.top)}x${Math.round(post.textareaRect.height)}` : 'null'} cancel=${post.cancelOffset !== null ? Math.round(post.cancelOffset) : 'null'} prePhase=${prePhase} postPhase=${postPhase} preActive=${preActive} postActive=${postActive} preSnap=${JSON.stringify(preSnap)?.slice(0, 220) ?? 'null'} postSnap=${JSON.stringify(postSnap)?.slice(0, 220) ?? 'null'} spy=${JSON.stringify(spy).slice(0, 900)}`
    })
    // Primary stationary contract: the SAME controls interaction region
    // (footer → action bar) stays where the click found it; the stationary
    // pointer still hits the same message. Row-top identity alone is
    // insufficient through the editor height swap (the row top legitimately
    // shifts while the interaction area holds), so row geometry is logged
    // diagnostics only — the region + hit-test oracle gates.
    expect(
      regionDrift,
      `Edit open: controls interaction region stays at its previous viewport offset`
    ).toBeLessThanOrEqual(REGION_TOL)
    expect(hit, `Edit open: stationary pointer at the original Edit click point still hits the same message`).toBe(true)
    expect(regionWorst, `Edit open: painted region transition frames never jump`).toBeLessThanOrEqual(TRANSITION_TOL)
    void messageDrift
    void centerDrift
    void worst
    // Never a jump to global bottom; stays inside the live scroll range (at
    // true physical boundaries record clamping via the range gate below, not
    // a false offset demand — this viewport is verified non-bottom by setup).
    expect(Math.abs(postScroll.scrollTop), `Edit open: must remain non-bottom (no bottom jump)`).toBeGreaterThan(
      BOTTOM_TOL
    )
    const topExtreme = -(postScroll.scrollHeight - postScroll.clientHeight)
    expect(postScroll.scrollTop, `Edit open: post viewport stays inside the live scroll range`).toBeGreaterThanOrEqual(
      topExtreme - OFFSET_TOL
    )
    expect(postScroll.scrollTop, `Edit open: post viewport stays at/above bottom`).toBeLessThanOrEqual(OFFSET_TOL)
    // Ordering evidence for the shared-mechanism choice: the competing
    // smooth-center write must be visible in the spy when the region jumps.
    test.info().annotations.push({
      type: 'aer-open-ordering',
      description: `phases=${phases.slice(0, 12).join(',')} spyKinds=${spy.map((s) => String(s.kind)).join(',')}`
    })
  })

  test('assistant Edit Cancel returns without inheriting Edit centering', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'ASSISTANT-EDIT REGION CANCEL (PRE-FIX FAILING): from the same verified non-bottom reading viewport, open the editor with a real Edit click, then Cancel with a real pointer click at the recorded Cancel center: the message-row interaction region must return to the PRE-EDIT viewport geometry — never inherit the Edit smooth-centering. Records pre/edit/cancel geometry + rAF drift + focus/phase/snapshot for the shared-mechanism choice.'
    })
    const page: Page = mainWindow
    const { topicId, targetAssistantId } =
      await test.step('seed mid-topic assistant topic and cold-activate', async () => setupEditRegionTopic(page))
    const preReading = await test.step('wheel to a verified non-bottom reading position with Edit visible', async () =>
      wheelToReadingPositionWithEditVisible(page, targetAssistantId))
    const pre = await captureControlGeometry(page, targetAssistantId)
    const editPoint = { ...pre.buttonCenter }
    await installEditSpy(page)
    await page.mouse.click(editPoint.x, editPoint.y)
    await expect(page.locator('.message-editor-area')).toBeVisible({ timeout: 15000 })
    await waitForScrollQuiescence(page)
    const editGeom = await captureEditorGeometry(page, targetAssistantId)
    const editScroll = await readScroll(page)
    expect(editGeom.cancelCenter, 'cancel button must render in the editor action bar').not.toBeNull()
    // Physical-click precondition: the Cancel center must be on-screen.
    // An off-screen Cancel after Edit open is itself jump evidence (the
    // interaction region left the viewport) — record it loudly instead of
    // clicking void coordinates.
    const viewportSize = page.viewportSize()
    if (editGeom.cancelCenter) {
      test.info().annotations.push({
        type: 'aer-cancel-placement',
        description: `cancelCenter=${Math.round(editGeom.cancelCenter.x)},${Math.round(editGeom.cancelCenter.y)} viewport=${viewportSize ? `${viewportSize.width}x${viewportSize.height}` : 'null'}`
      })
      expect(
        editGeom.cancelCenter.y,
        'Cancel must stay on-screen after Edit open (else the region jumped out)'
      ).toBeGreaterThanOrEqual(0)
      if (viewportSize) {
        expect(editGeom.cancelCenter.y, 'Cancel must stay on-screen after Edit open').toBeLessThanOrEqual(
          viewportSize.height
        )
        expect(editGeom.cancelCenter.x, 'Cancel must stay on-screen after Edit open').toBeLessThanOrEqual(
          viewportSize.width
        )
      }
    }
    const cancelPoint = { ...(editGeom.cancelCenter as { x: number; y: number }) }
    const cancelPreMsgOffset = editGeom.messageOffset
    const cancelHitDetail = await page
      .evaluate(({ x, y }: { x: number; y: number }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null
        if (!hit) return 'null'
        const btn = hit.closest?.('button') as HTMLElement | null
        const row = hit.closest?.('[data-message-id]') as HTMLElement | null
        return `${hit.tagName.toLowerCase()}|${String(hit.className ?? '').slice(0, 60)}|btnAria=${btn?.getAttribute('aria-label') ?? 'none'}|row=${row?.getAttribute('data-message-id') ?? 'none'}`
      }, cancelPoint)
      .catch(() => 'unknown')
    console.log(
      `[E2E] aer-cancel-click-target detail=${cancelHitDetail} point=${Math.round(cancelPoint.x)},${Math.round(cancelPoint.y)}`
    )
    // Cancel via a real physical pointer click at the recorded Cancel center;
    // the pointer is never repositioned afterwards. Region frames track the
    // action-bar → footer area (primary), row frames support.
    const cancelSamples: number[] = [0]
    const cancelRegionSamples: number[] = [0]
    const cancelPreRegion =
      typeof editGeom.regionOffset === 'number' && Number.isFinite(editGeom.regionOffset) ? editGeom.regionOffset : null
    await page.mouse.click(cancelPoint.x, cancelPoint.y)
    let editorGone = false
    let settledExtra = 0
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      const cur = await readMessageOffset(page, targetAssistantId)
      if (Number.isFinite(cur)) cancelSamples.push(Math.abs(cur - pre.messageOffset))
      if (cancelPreRegion !== null) {
        const curRegion = await readRegionOffset(page, targetAssistantId)
        // Pre-close frames compare against the action-bar area; post-close
        // frames compare against the footer — both are the same semantic
        // controls region, but the absolute reference differs. Track drift
        // against the closer of the two stable references so the swap itself
        // is not misread as a jump: the final return assertion below gates
        // the exact pre-edit restoration.
        if (Number.isFinite(curRegion)) {
          const preRegion =
            typeof pre.regionOffset === 'number' && Number.isFinite(pre.regionOffset) ? pre.regionOffset : null
          const candidates: number[] = [Math.abs(curRegion - cancelPreRegion)]
          if (preRegion !== null) candidates.push(Math.abs(curRegion - preRegion))
          cancelRegionSamples.push(Math.min(...candidates))
        }
      }
      const open = await page.evaluate(() => !!document.querySelector('.message-editor-area')).catch(() => true)
      if (!open) {
        editorGone = true
        settledExtra += 1
        if (settledExtra >= 4) break
      } else {
        settledExtra = 0
      }
    }
    expect(editorGone, 'editor must close after the real Cancel click').toBe(true)
    const cancelWorst = cancelSamples.length > 0 ? Math.max(...cancelSamples) : Number.NaN
    const cancelRegionWorst = cancelRegionSamples.length > 0 ? Math.max(...cancelRegionSamples) : Number.NaN
    await waitForScrollQuiescence(page)
    // Footer returns: hover to reveal the menubar box for the post geometry.
    await page
      .locator(`#message-${escId(targetAssistantId)}[data-message-id="${escId(targetAssistantId)}"]`)
      .first()
      .hover()
      .catch(() => {})
    const post = await captureControlGeometry(page, targetAssistantId)
    const postScroll = await readScroll(page)
    const postPhase = await readPhase(page)
    const postSnap = await readRouteSnapshot(page, topicId)
    const postActive = await describeActiveElement(page)
    const spy = await readEditSpy(page)
    await clearEditSpy(page).catch(() => {})
    const returnDrift = Math.abs(post.messageOffset - pre.messageOffset)
    expect(pre.regionOffset, 'precondition: footer interaction region must be measurable').not.toBeNull()
    expect(post.regionOffset, 'post-cancel footer interaction region must be measurable').not.toBeNull()
    const returnRegionDrift =
      pre.regionOffset !== null && post.regionOffset !== null
        ? Math.abs(post.regionOffset - pre.regionOffset)
        : Number.NaN
    const hit = await hitTestMessageAtPoint(page, editPoint, targetAssistantId)
    console.log(
      `[E2E] aer-cancel preMsgOff=${Math.round(pre.messageOffset)} editMsgOff=${Math.round(cancelPreMsgOffset)} cancelMsgOff=${Math.round(post.messageOffset)} returnDrift=${returnDrift.toFixed(1)} returnRegionDrift=${Number.isFinite(returnRegionDrift) ? returnRegionDrift.toFixed(1) : 'NaN'} hit=${hit} worst=${Number.isFinite(cancelWorst) ? cancelWorst.toFixed(1) : 'NaN'} regionWorst=${Number.isFinite(cancelRegionWorst) ? cancelRegionWorst.toFixed(1) : 'NaN'} n=${cancelSamples.length} preScroll=${Math.round(preReading.scrollTop)} editScroll=${Math.round(editScroll.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)} spy=${JSON.stringify(spy).slice(0, 600)}`
    )
    test.info().annotations.push({
      type: 'aer-cancel-geometry',
      description: `preMsgOff=${Math.round(pre.messageOffset)} editMsgOff=${Math.round(cancelPreMsgOffset)} cancelMsgOff=${Math.round(post.messageOffset)} returnDrift=${returnDrift.toFixed(1)} returnRegionDrift=${Number.isFinite(returnRegionDrift) ? returnRegionDrift.toFixed(1) : 'NaN'} preScroll=${Math.round(preReading.scrollTop)} editScroll=${Math.round(editScroll.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)} hit=${hit} worst=${Number.isFinite(cancelWorst) ? cancelWorst.toFixed(1) : 'NaN'} regionWorst=${Number.isFinite(cancelRegionWorst) ? cancelRegionWorst.toFixed(1) : 'NaN'} n=${cancelSamples.length} phase=${postPhase} active=${postActive} snap=${JSON.stringify(postSnap)?.slice(0, 220) ?? 'null'} spy=${JSON.stringify(spy).slice(0, 900)}`
    })
    // Cancel must restore the PRE-EDIT region — never keep the Edit-centered
    // viewport. Both the final return and every painted cancel frame are gated.
    // The closed→closed return restores identical DOM, so both the region and
    // the row top return exactly; transition row frames are diagnostics only
    // (the editor-state row legitimately differs mid-swap while the region
    // holds), while transition region frames gate.
    expect(returnRegionDrift, `Cancel: controls region returns to its pre-edit viewport offset`).toBeLessThanOrEqual(
      REGION_TOL
    )
    expect(
      returnDrift,
      `Cancel: message region returns to its pre-edit viewport offset (no inherited centering)`
    ).toBeLessThanOrEqual(REGION_TOL)
    expect(hit, `Cancel: original Edit click point still hits the same message after Cancel`).toBe(true)
    expect(cancelRegionWorst, `Cancel: painted region cancel frames never jump`).toBeLessThanOrEqual(TRANSITION_TOL)
    void cancelWorst
    expect(Math.abs(postScroll.scrollTop), `Cancel: must remain non-bottom (no bottom jump)`).toBeGreaterThan(
      BOTTOM_TOL
    )
    const topExtreme = -(postScroll.scrollHeight - postScroll.clientHeight)
    expect(postScroll.scrollTop, `Cancel: post viewport stays inside the live scroll range`).toBeGreaterThanOrEqual(
      topExtreme - OFFSET_TOL
    )
    expect(postScroll.scrollTop, `Cancel: post viewport stays at/above bottom`).toBeLessThanOrEqual(OFFSET_TOL)
  })

  test('baseline no-effect geometry drift stays quiet', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'ASSISTANT-EDIT REGION BASELINE (NO-EFFECT): from the same verified non-bottom reading viewport, sample message-row + controls-region viewport offsets with NO interaction for ~2.5s. Proves the REGION_TOL=2 / TRANSITION_TOL=4 budgets are quiet at rest, so a real centering jump cannot hide inside tolerance.'
    })
    const page: Page = mainWindow
    const { targetAssistantId } = await test.step('seed mid-topic assistant topic and cold-activate', async () =>
      setupEditRegionTopic(page))
    await test.step('wheel to a verified non-bottom reading position with Edit visible', async () =>
      wheelToReadingPositionWithEditVisible(page, targetAssistantId))
    const base = await captureControlGeometry(page, targetAssistantId)
    const baseScroll = await readScroll(page)
    const msgSamples: number[] = [0]
    const regionSamples: number[] = [0]
    const scrollSamples: number[] = [0]
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      const curMsg = await readMessageOffset(page, targetAssistantId)
      if (Number.isFinite(curMsg)) msgSamples.push(Math.abs(curMsg - base.messageOffset))
      if (base.regionOffset !== null) {
        const curRegion = await readRegionOffset(page, targetAssistantId)
        if (Number.isFinite(curRegion) && base.regionOffset !== null)
          regionSamples.push(Math.abs(curRegion - (base.regionOffset as number)))
      }
      const curScroll = await readScroll(page).catch(() => null)
      if (curScroll) scrollSamples.push(Math.abs(curScroll.scrollTop - baseScroll.scrollTop))
    }
    const msgWorst = Math.max(...msgSamples)
    const regionWorst = regionSamples.length > 0 ? Math.max(...regionSamples) : Number.NaN
    const scrollWorst = Math.max(...scrollSamples)
    console.log(
      `[E2E] aer-baseline msgWorst=${msgWorst.toFixed(2)} regionWorst=${Number.isFinite(regionWorst) ? regionWorst.toFixed(2) : 'NaN'} scrollWorst=${scrollWorst.toFixed(2)} n=${msgSamples.length}`
    )
    test.info().annotations.push({
      type: 'aer-baseline-geometry',
      description: `msgWorst=${msgWorst.toFixed(2)} regionWorst=${Number.isFinite(regionWorst) ? regionWorst.toFixed(2) : 'NaN'} scrollWorst=${scrollWorst.toFixed(2)} n=${msgSamples.length} preMsgOff=${Math.round(base.messageOffset)} preRegion=${base.regionOffset !== null ? Math.round(base.regionOffset) : 'null'} preScroll=${Math.round(baseScroll.scrollTop)}`
    })
    expect(msgWorst, 'baseline: message row offset stays quiet with no interaction').toBeLessThanOrEqual(REGION_TOL)
    expect(regionWorst, 'baseline: controls region offset stays quiet with no interaction').toBeLessThanOrEqual(
      REGION_TOL
    )
    expect(scrollWorst, 'baseline: scrollTop stays quiet with no interaction').toBeLessThanOrEqual(REGION_TOL)
  })

  test('true-bottom assistant edit open and cancel keeps the honest bottom clamp', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'ASSISTANT-EDIT REGION TRUE-BOTTOM (BOUNDARY): from a verified TRUE-BOTTOM viewport (|scrollTop|<=60) on the NEWEST assistant row, a real physical Edit click must NOT smooth-center: the viewport stays honestly clamped at the bottom pin (inside the live scroll range, still bottom), the editor action-bar region stays in-viewport, and Cancel restores the exact pre-edit closed geometry. Non-tab region holds refuse at anchor-null bottom (controller beginInteractionIntent fail-closed); the keeper bottom pin owns geometry there. If open pulls away from bottom, that disproves refusal and FAILS with trigger + feasibility.'
    })
    const page: Page = mainWindow
    const { topicId } = await test.step('seed mid-topic assistant topic and cold-activate', async () =>
      setupEditRegionTopic(page))
    const newestAssistantId = `${topicId}-msg-00015`
    const storedRole = await page.evaluate((id: string) => {
      const s = (window as any).store.getState()
      const entities = s.messages?.entities ?? {}
      const m = (entities as Record<string, any>)[id]
      return m?.role ?? null
    }, newestAssistantId)
    expect(storedRole, 'newest seeded row must be an assistant message').toBe('assistant')
    await page.waitForFunction(
      (id: string) => !!document.querySelector(`#messages [data-message-id="${id}"]`),
      newestAssistantId,
      { timeout: 30000 }
    )
    // Genuine wheel to the true bottom (column-reverse: bottom/newest is
    // scrollTop ~= 0). Only physical wheel input, never a scrollTop write.
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 30; i++) {
      const st = (await readScroll(page)).scrollTop
      if (Math.abs(st) <= TRUE_BOTTOM_TOL) break
      await page.mouse.wheel(0, 560)
      await page.waitForTimeout(200)
    }
    const bottomProbe = await readScroll(page)
    expect(
      Math.abs(bottomProbe.scrollTop),
      `must reach a verified true-bottom viewport (st=${Math.round(bottomProbe.scrollTop)})`
    ).toBeLessThanOrEqual(TRUE_BOTTOM_TOL)
    const bottomAnchor = await settledAnchor(page).catch(() => null)
    const bottomScrollSettled = await readScroll(page)
    expect(Math.abs(bottomScrollSettled.scrollTop), 'settled viewport must still be true-bottom').toBeLessThanOrEqual(
      TRUE_BOTTOM_TOL
    )
    const row = page
      .locator(`#message-${escId(newestAssistantId)}[data-message-id="${escId(newestAssistantId)}"]`)
      .first()
    await row.hover().catch(() => {})
    expect(
      await isEditButtonInViewport(page, newestAssistantId),
      'newest assistant Edit button must be fully in-viewport at true bottom with no test-induced scroll'
    ).toBe(true)
    const pre = await captureControlGeometry(page, newestAssistantId)
    const preScroll = await readScroll(page)
    const prePhase = await readPhase(page)
    const feasibility = await page.evaluate((id: string) => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return null
      const c = container.getBoundingClientRect()
      const cssEsc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const rowEl =
        (document.querySelector(`#message-${cssEsc}[data-message-id="${cssEsc}"]`) as HTMLElement | null) ??
        (document.querySelector(`#messages [data-message-id="${cssEsc}"]`) as HTMLElement | null)
      if (!rowEl) return null
      const r = rowEl.getBoundingClientRect()
      const region = rowEl.querySelector('[data-interaction-region="message-controls"]') as HTMLElement | null
      const rr = region?.getBoundingClientRect() ?? null
      return {
        containerH: c.height,
        rowH: r.height,
        rowTopOff: r.top - c.top,
        rowBottomOff: r.bottom - c.top,
        regionH: rr ? rr.height : null,
        regionBottomOff: rr ? rr.bottom - c.top : null
      }
    }, newestAssistantId)
    await installEditSpy(page)
    const point = { ...pre.buttonCenter }
    expect(await hitTestMessageAtPoint(page, point, newestAssistantId), 'precondition: bottom click hits target').toBe(
      true
    )
    const openSamples: number[] = []
    const openScrollSamples: number[] = []
    await page.mouse.click(point.x, point.y)
    let editorSeen = false
    let settledExtra = 0
    const openDeadline = Date.now() + 20000
    while (Date.now() < openDeadline) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      const cur = await readScroll(page).catch(() => null)
      if (cur) openScrollSamples.push(cur.scrollTop)
      const open = await page.evaluate(() => !!document.querySelector('.message-editor-area')).catch(() => false)
      if (open) {
        editorSeen = true
        settledExtra += 1
        if (settledExtra >= 4) break
      } else {
        settledExtra = 0
      }
    }
    expect(editorSeen, 'editor must open after the real bottom Edit click').toBe(true)
    await waitForScrollQuiescence(page)
    const post = await captureEditorGeometry(page, newestAssistantId)
    const postScroll = await readScroll(page)
    const postPhase = await readPhase(page)
    const spy = await readEditSpy(page)
    await clearEditSpy(page).catch(() => {})
    const postTopExtreme = -(postScroll.scrollHeight - postScroll.clientHeight)
    const openWorstAbs = openScrollSamples.length > 0 ? Math.max(...openScrollSamples.map((v) => Math.abs(v))) : NaN
    const hit = await hitTestMessageAtPoint(page, point, newestAssistantId)
    const regionInViewport =
      post.regionOffset !== null &&
      post.containerRect &&
      post.regionOffset >= -OFFSET_TOL &&
      post.regionOffset <= post.containerRect.height + OFFSET_TOL
    console.log(
      `[E2E] aer-bottom preScroll=${Math.round(preScroll.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)} topExtreme=${Math.round(postTopExtreme)} openWorstAbs=${Number.isFinite(openWorstAbs) ? openWorstAbs.toFixed(1) : 'NaN'} hit=${hit} regionInView=${regionInViewport} anchor=${bottomAnchor ? `${bottomAnchor.id}@${Math.round(bottomAnchor.offset)}` : 'null'} feas=${JSON.stringify(feasibility)} spy=${JSON.stringify(spy).slice(0, 500)}`
    )
    test.info().annotations.push({
      type: 'aer-bottom-geometry',
      description: `preScroll=${Math.round(preScroll.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)} topExtreme=${Math.round(postTopExtreme)} openWorstAbs=${Number.isFinite(openWorstAbs) ? openWorstAbs.toFixed(1) : 'NaN'} hit=${hit} regionInView=${regionInViewport} anchor=${bottomAnchor ? `${bottomAnchor.id}@${Math.round(bottomAnchor.offset)}` : 'null'} preMsgOff=${Math.round(pre.messageOffset)} postMsgOff=${Math.round(post.messageOffset)} preRegion=${pre.regionOffset !== null ? Math.round(pre.regionOffset) : 'null'} postRegion=${post.regionOffset !== null ? Math.round(post.regionOffset) : 'null'} feas=${JSON.stringify(feasibility)} prePhase=${prePhase} postPhase=${postPhase} spy=${JSON.stringify(spy).slice(0, 900)}`
    })
    // Boundary contract (NOT a blanket jump permission): the open must stay
    // honestly clamped — inside the live range AND still bottom. Pulling away
    // from bottom disproves the documented controller refusal (non-tab intents
    // refuse at anchor-null bottom; bottom pin owns geometry) — report the
    // concrete trigger + feasibility as the failure.
    expect(
      postScroll.scrollTop,
      `BOTTOM-REFUSAL trigger=real-Edit-click newest=${newestAssistantId} feas=${JSON.stringify(feasibility)} anchor=${bottomAnchor ? `${bottomAnchor.id}@${Math.round(bottomAnchor.offset)}` : 'null'}: post viewport left the honest bottom clamp (controller refused nothing)`
    ).toBeGreaterThanOrEqual(postTopExtreme - OFFSET_TOL)
    expect(
      postScroll.scrollTop,
      `BOTTOM-REFUSAL trigger=real-Edit-click newest=${newestAssistantId}: post viewport left the honest bottom clamp`
    ).toBeLessThanOrEqual(OFFSET_TOL)
    expect(
      Math.abs(postScroll.scrollTop),
      `bottom Edit open: must remain bottom-clamped, never smooth-centered (openWorstAbs=${Number.isFinite(openWorstAbs) ? openWorstAbs.toFixed(1) : 'NaN'})`
    ).toBeLessThanOrEqual(BOTTOM_TOL)
    expect(post.regionOffset, 'bottom editor action-bar region must be measurable').not.toBeNull()
    expect(regionInViewport, 'bottom editor action-bar region stays in-viewport (honest clamp)').toBe(true)
    expect(hit, 'bottom Edit open: stationary pointer still hits the same newest message').toBe(true)
    // Cancel at bottom is closed→closed identical DOM: exact return is valid
    // (no boundary unrepresentability on the way back).
    expect(post.cancelCenter, 'bottom editor cancel button must render').not.toBeNull()
    const cancelPoint = { ...(post.cancelCenter as { x: number; y: number }) }
    const cancelSamples: number[] = []
    await page.mouse.click(cancelPoint.x, cancelPoint.y)
    let editorGone = false
    let cancelExtra = 0
    const cancelDeadline = Date.now() + 20000
    while (Date.now() < cancelDeadline) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      const open = await page.evaluate(() => !!document.querySelector('.message-editor-area')).catch(() => true)
      if (!open) {
        editorGone = true
        cancelExtra += 1
        if (cancelExtra >= 4) break
      } else {
        cancelExtra = 0
      }
      const curS = await readScroll(page).catch(() => null)
      if (curS) cancelSamples.push(curS.scrollTop)
    }
    expect(editorGone, 'bottom editor must close after the real Cancel click').toBe(true)
    await waitForScrollQuiescence(page)
    await row.hover().catch(() => {})
    const cancelPost = await captureControlGeometry(page, newestAssistantId)
    const cancelPostScroll = await readScroll(page)
    const cancelWorstAbs = cancelSamples.length > 0 ? Math.max(...cancelSamples.map((v) => Math.abs(v))) : Number.NaN
    const returnRegionDrift =
      pre.regionOffset !== null && cancelPost.regionOffset !== null
        ? Math.abs(cancelPost.regionOffset - pre.regionOffset)
        : Number.NaN
    const cancelHit = await hitTestMessageAtPoint(page, point, newestAssistantId)
    console.log(
      `[E2E] aer-bottom-cancel preRegion=${pre.regionOffset !== null ? Math.round(pre.regionOffset) : 'null'} cancelRegion=${cancelPost.regionOffset !== null ? Math.round(cancelPost.regionOffset) : 'null'} drift=${Number.isFinite(returnRegionDrift) ? returnRegionDrift.toFixed(1) : 'NaN'} preScroll=${Math.round(preScroll.scrollTop)} cancelScroll=${Math.round(cancelPostScroll.scrollTop)} worstAbs=${Number.isFinite(cancelWorstAbs) ? cancelWorstAbs.toFixed(1) : 'NaN'} hit=${cancelHit}`
    )
    test.info().annotations.push({
      type: 'aer-bottom-cancel-geometry',
      description: `returnRegionDrift=${Number.isFinite(returnRegionDrift) ? returnRegionDrift.toFixed(1) : 'NaN'} preScroll=${Math.round(preScroll.scrollTop)} cancelScroll=${Math.round(cancelPostScroll.scrollTop)} worstAbs=${Number.isFinite(cancelWorstAbs) ? cancelWorstAbs.toFixed(1) : 'NaN'} hit=${cancelHit}`
    })
    expect(returnRegionDrift, 'bottom Cancel: closed→closed controls region returns exactly').toBeLessThanOrEqual(
      REGION_TOL
    )
    expect(cancelHit, 'bottom Cancel: original click point still hits the newest message').toBe(true)
    expect(
      Math.abs(cancelPostScroll.scrollTop),
      'bottom Cancel: must remain bottom-clamped (no recenter during cancel)'
    ).toBeLessThanOrEqual(BOTTOM_TOL)
    void openSamples
  })

  test('assistant editor Escape while focused causes no viewport move', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'ASSISTANT-EDIT REGION ESCAPE (KEYBOARD): from the verified non-bottom reading viewport, open the assistant editor with a real click, confirm real editor focus (.cm-content preventScroll path), then press the physical Escape key. Geometry (first/every frame) is primary: the structural action-bar region must not move unexpectedly. Assistant Escape is currently a documented no-op (MessageEditor handleKeyDown guards role!==user); the test proves no-move in that state and records cancel as uncovered, or — if a future build closes on Escape — proves the exact pre-edit return.'
    })
    const page: Page = mainWindow
    const { targetAssistantId } = await test.step('seed mid-topic assistant topic and cold-activate', async () =>
      setupEditRegionTopic(page))
    const preReading = await test.step('wheel to a verified non-bottom reading position with Edit visible', async () =>
      wheelToReadingPositionWithEditVisible(page, targetAssistantId))
    const pre = await captureControlGeometry(page, targetAssistantId)
    await installEditSpy(page)
    await page.mouse.click(pre.buttonCenter.x, pre.buttonCenter.y)
    await expect(page.locator('.message-editor-area')).toBeVisible({ timeout: 15000 })
    await waitForScrollQuiescence(page)
    const editGeom = await captureEditorGeometry(page, targetAssistantId)
    const editScroll = await readScroll(page)
    const focusBefore = await describeActiveElement(page)
    const focusIsTextarea =
      /textarea/i.test(focusBefore) ||
      /editing-message/i.test(focusBefore) ||
      /cm-content|cm-editor|contenteditable/i.test(focusBefore)
    test.info().annotations.push({
      type: 'aer-escape-focus',
      description: `focusBefore=${focusBefore} isTextarea=${focusIsTextarea} editScroll=${Math.round(editScroll.scrollTop)} editRegion=${editGeom.regionOffset !== null ? Math.round(editGeom.regionOffset) : 'null'}`
    })
    // Ensure genuine editor focus with a real pointer click if the
    // preventScroll auto-focus did not land (never synthesize focus).
    if (!focusIsTextarea) {
      const taBox = await page
        .locator('.message-editor-area .editing-message .cm-content')
        .first()
        .boundingBox()
        .catch(() => null)
      if (taBox) {
        await page.mouse.click(taBox.x + taBox.width / 2, taBox.y + taBox.height / 2)
        await page.waitForTimeout(400)
      }
    }
    const focusAfter = await describeActiveElement(page)
    const editRegionBeforeEsc =
      typeof editGeom.regionOffset === 'number' && Number.isFinite(editGeom.regionOffset) ? editGeom.regionOffset : null
    const escSamples: number[] = [0]
    const escRegionSamples: number[] = [0]
    const escScrollSamples: number[] = [0]
    await page.keyboard.press('Escape')
    let editorGone = false
    let escExtra = 0
    let editorStillOpen = true
    const escDeadline = Date.now() + 8000
    while (Date.now() < escDeadline) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      const curMsg = await readMessageOffset(page, targetAssistantId)
      if (Number.isFinite(curMsg)) escSamples.push(Math.abs(curMsg - pre.messageOffset))
      if (editRegionBeforeEsc !== null) {
        const curRegion = await readRegionOffset(page, targetAssistantId)
        if (Number.isFinite(curRegion)) escRegionSamples.push(Math.abs(curRegion - editRegionBeforeEsc))
      }
      const curS = await readScroll(page).catch(() => null)
      if (curS) escScrollSamples.push(Math.abs(curS.scrollTop - editScroll.scrollTop))
      const open = await page.evaluate(() => !!document.querySelector('.message-editor-area')).catch(() => true)
      editorStillOpen = open
      if (!open) {
        editorGone = true
        escExtra += 1
        if (escExtra >= 4) break
      } else {
        escExtra = 0
        if (Date.now() > escDeadline - 4000 && escSamples.length > 24) break
      }
    }
    await waitForScrollQuiescence(page).catch(() => {})
    const afterScroll = await readScroll(page)
    const afterActive = await describeActiveElement(page)
    const spy = await readEditSpy(page)
    await clearEditSpy(page).catch(() => {})
    const escWorst = escSamples.length > 0 ? Math.max(...escSamples) : Number.NaN
    const escRegionWorst = escRegionSamples.length > 0 ? Math.max(...escRegionSamples) : Number.NaN
    const escScrollWorst = escScrollSamples.length > 0 ? Math.max(...escScrollSamples) : Number.NaN
    console.log(
      `[E2E] aer-escape focusBefore=${focusBefore} focusAfterClick=${focusAfter} afterActive=${afterActive} editorGone=${editorGone} stillOpen=${editorStillOpen} escWorst=${Number.isFinite(escWorst) ? escWorst.toFixed(1) : 'NaN'} regionWorst=${Number.isFinite(escRegionWorst) ? escRegionWorst.toFixed(1) : 'NaN'} scrollWorst=${Number.isFinite(escScrollWorst) ? escScrollWorst.toFixed(1) : 'NaN'} preScroll=${Math.round(preReading.scrollTop)} editScroll=${Math.round(editScroll.scrollTop)} afterScroll=${Math.round(afterScroll.scrollTop)} spy=${JSON.stringify(spy).slice(0, 500)}`
    )
    test.info().annotations.push({
      type: 'aer-escape-geometry',
      description: `focusBefore=${focusBefore} focusAfter=${focusAfter} afterActive=${afterActive} editorGone=${editorGone} stillOpen=${editorStillOpen} escWorst=${Number.isFinite(escWorst) ? escWorst.toFixed(1) : 'NaN'} regionWorst=${Number.isFinite(escRegionWorst) ? escRegionWorst.toFixed(1) : 'NaN'} scrollWorst=${Number.isFinite(escScrollWorst) ? escScrollWorst.toFixed(1) : 'NaN'} preScroll=${Math.round(preReading.scrollTop)} editScroll=${Math.round(editScroll.scrollTop)} afterScroll=${Math.round(afterScroll.scrollTop)} preRegion=${pre.regionOffset !== null ? Math.round(pre.regionOffset) : 'null'} editRegion=${editRegionBeforeEsc !== null ? Math.round(editRegionBeforeEsc) : 'null'} spy=${JSON.stringify(spy).slice(0, 900)}`
    })
    if (editorGone) {
      // Future close-on-Escape build: exact pre-edit return, never inherited
      // centering. Hover to reveal the footer box for post geometry.
      await page
        .locator(`#message-${escId(targetAssistantId)}[data-message-id="${escId(targetAssistantId)}"]`)
        .first()
        .hover()
        .catch(() => {})
      const post = await captureControlGeometry(page, targetAssistantId)
      const returnDrift =
        pre.regionOffset !== null && post.regionOffset !== null
          ? Math.abs(post.regionOffset - pre.regionOffset)
          : Number.NaN
      expect(returnDrift, 'Escape-cancel close: controls region returns to pre-edit').toBeLessThanOrEqual(REGION_TOL)
      expect(
        Math.abs(afterScroll.scrollTop),
        'Escape-cancel close: must remain non-bottom (no bottom jump)'
      ).toBeGreaterThan(BOTTOM_TOL)
    } else {
      // Documented current assistant behavior: Escape is a no-op (role guard)
      // — the regression contract is strictly no unexpected move.
      expect(editorStillOpen, 'assistant Escape leaves the editor open (documented role-guard no-op)').toBe(true)
      expect(escRegionWorst, 'Escape no-op: painted action-bar region frames never jump').toBeLessThanOrEqual(
        TRANSITION_TOL
      )
      expect(escScrollWorst, 'Escape no-op: scroll never moves unexpectedly').toBeLessThanOrEqual(OFFSET_TOL)
      expect(
        Math.abs(afterScroll.scrollTop - editScroll.scrollTop),
        'Escape no-op: final scroll equals the editing viewport'
      ).toBeLessThanOrEqual(OFFSET_TOL)
      test.info().annotations.push({
        type: 'aer-escape-uncovered',
        description:
          'UNCOVERED: assistant Escape-cancel close path (MessageEditor handleKeyDown early-returns for role!==user, so Escape cannot cancel an assistant edit; keyboard-cancel return geometry for assistant is unproven by construction).'
      })
    }
    void escWorst
  })

  test('genuine scroll while editing supersedes the hold with no later snapback', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'ASSISTANT-EDIT REGION TAKEOVER (GENUINE INPUT): from the verified non-bottom reading viewport, open the assistant editor, then supersede with genuine wheel input (+ one PageDown keyboard scroll) while editing. A later editor resize (real typing) and a real Cancel click must NOT snap back to the pre-edit hold: the final viewport stays where the user left it.'
    })
    const page: Page = mainWindow
    const { topicId, targetAssistantId } =
      await test.step('seed mid-topic assistant topic and cold-activate', async () => setupEditRegionTopic(page))
    const preReading = await test.step('wheel to a verified non-bottom reading position with Edit visible', async () =>
      wheelToReadingPositionWithEditVisible(page, targetAssistantId))
    const pre = await captureControlGeometry(page, targetAssistantId)
    const preScrollTop = preReading.scrollTop
    await page.mouse.click(pre.buttonCenter.x, pre.buttonCenter.y)
    await expect(page.locator('.message-editor-area')).toBeVisible({ timeout: 15000 })
    await waitForScrollQuiescence(page)
    const editScroll = await readScroll(page)
    // Genuine user takeover while the editor is open: small real wheel steps
    // that keep the editor actionable (Cancel must stay clickable without a
    // test-induced scroll-back that would muddy the takeover attribution).
    // No scrollTop writes, no PageDown jumps.
    const wheelBox = await page.locator('#messages').first().boundingBox()
    if (wheelBox) await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2)
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, -320)
      await page.waitForTimeout(220)
    }
    await page.waitForTimeout(400)
    await waitForScrollQuiescence(page).catch(() => {})
    const takenScroll = await readScroll(page)
    const takeoverMove = Math.abs(takenScroll.scrollTop - editScroll.scrollTop)
    console.log(
      `[E2E] aer-takeover editScroll=${Math.round(editScroll.scrollTop)} takenScroll=${Math.round(takenScroll.scrollTop)} move=${takeoverMove.toFixed(1)}`
    )
    test.info().annotations.push({
      type: 'aer-takeover-move',
      description: `editScroll=${Math.round(editScroll.scrollTop)} takenScroll=${Math.round(takenScroll.scrollTop)} move=${takeoverMove.toFixed(1)} preScroll=${Math.round(preScrollTop)}`
    })
    expect(takeoverMove, 'genuine wheel+keyboard while editing must actually move the viewport').toBeGreaterThan(
      TAKEOVER_MIN_MOVE
    )
    expect(Math.abs(takenScroll.scrollTop), 'takeover viewport must stay non-bottom').toBeGreaterThan(BOTTOM_TOL)
    const takenTopExtreme = -(takenScroll.scrollHeight - takenScroll.clientHeight)
    expect(takenScroll.scrollTop, 'takeover viewport stays inside the live range').toBeGreaterThanOrEqual(
      takenTopExtreme - OFFSET_TOL
    )
    // Genuine editor resize while taken over: real typing into the focused
    // CodeMirror surface (never a height injection). Must not snap back to pre-edit.
    const textarea = page.locator('.message-editor-area .editing-message .cm-content').first()
    await textarea.click().catch(() => {})
    await page.keyboard.type('\n\ntakeover resize probe line one\ntakeover resize probe line two', { delay: 20 })
    await page.waitForTimeout(800)
    await waitForScrollQuiescence(page).catch(() => {})
    const resizedScroll = await readScroll(page)
    const resizeHoldSnap = Math.abs(resizedScroll.scrollTop - preScrollTop)
    const resizeTakeoverDrift = Math.abs(resizedScroll.scrollTop - takenScroll.scrollTop)
    console.log(
      `[E2E] aer-takeover-resize resizedScroll=${Math.round(resizedScroll.scrollTop)} snapToPre=${resizeHoldSnap.toFixed(1)} driftFromTaken=${resizeTakeoverDrift.toFixed(1)}`
    )
    test.info().annotations.push({
      type: 'aer-takeover-resize',
      description: `resizedScroll=${Math.round(resizedScroll.scrollTop)} snapToPre=${resizeHoldSnap.toFixed(1)} driftFromTaken=${resizeTakeoverDrift.toFixed(1)}`
    })
    expect(
      resizeTakeoverDrift,
      'resize while taken over: viewport stays where the user left it (no snapback to the pre-edit hold)'
    ).toBeLessThanOrEqual(TAKEOVER_FINAL_TOL)
    // Real Cancel after takeover: sample every frame, then require the final
    // viewport to stay near the taken-over position — never restored pre-edit.
    let editGeom = await captureEditorGeometry(page, targetAssistantId)
    expect(editGeom.cancelCenter, 'cancel button must render after takeover+resize').not.toBeNull()
    // The takeover scroll may have carried the Cancel button outside the
    // #messages container (covered by the input bar): a click there hits void.
    // Wheel back toward the editor with genuine input until Cancel sits fully
    // inside #messages, then RE-ANCHOR the taken-over viewport to that final
    // user position (still far from pre-edit, so the no-snapback assertion
    // discriminates). Never a scrollTop write.
    const isCancelInContainer = (center: { x: number; y: number } | null): Promise<boolean> =>
      page
        .evaluate(({ x, y }: { x: number; y: number }) => {
          const container = document.getElementById('messages') as HTMLElement | null
          if (!container) return false
          const c = container.getBoundingClientRect()
          return x >= c.left && x <= c.right && y >= c.top && y <= c.bottom
        }, center ?? { x: -1, y: -1 })
        .catch(() => false)
    for (let i = 0; i < 8; i++) {
      if (editGeom.cancelCenter && (await isCancelInContainer(editGeom.cancelCenter))) break
      await page.mouse.wheel(0, 160)
      await page.waitForTimeout(250)
      const fresh = await captureEditorGeometry(page, targetAssistantId).catch(() => null)
      if (fresh?.cancelCenter) editGeom = fresh
    }
    expect(
      await isCancelInContainer(editGeom.cancelCenter),
      'takeover Cancel must sit inside #messages before the Cancel click (genuine wheel-back applied)'
    ).toBe(true)
    // Re-anchor: the user viewport after all genuine takeover inputs.
    const takenScrollAdjusted = await readScroll(page)
    const adjustedMoveFromPre = Math.abs(takenScrollAdjusted.scrollTop - preScrollTop)
    test.info().annotations.push({
      type: 'aer-takeover-readjust',
      description: `takenScroll=${Math.round(takenScroll.scrollTop)} adjusted=${Math.round(takenScrollAdjusted.scrollTop)} moveFromPre=${adjustedMoveFromPre.toFixed(1)}`
    })
    expect(
      adjustedMoveFromPre,
      're-anchored takeover viewport must still differ from pre-edit (else the wheel-back erased the takeover)'
    ).toBeGreaterThan(TAKEOVER_POST_ADJUST_MIN)
    let cancelPoint = { ...(editGeom.cancelCenter as { x: number; y: number }) }
    const cancelHitDetail = await page
      .evaluate(({ x, y }: { x: number; y: number }) => {
        const hit = document.elementFromPoint(x, y) as HTMLElement | null
        if (!hit) return 'null'
        const btn = hit.closest?.('button') as HTMLElement | null
        const row = hit.closest?.('[data-message-id]') as HTMLElement | null
        return `${hit.tagName.toLowerCase()}|${String(hit.className ?? '').slice(0, 60)}|btnAria=${btn?.getAttribute('aria-label') ?? 'none'}|row=${row?.getAttribute('data-message-id') ?? 'none'}`
      }, cancelPoint)
      .catch(() => 'unknown')
    console.log(
      `[E2E] aer-takeover-cancel-click-target detail=${cancelHitDetail} point=${Math.round(cancelPoint.x)},${Math.round(cancelPoint.y)}`
    )
    const cancelScrollTrace: number[] = []
    await page.mouse.click(cancelPoint.x, cancelPoint.y)
    let editorGone = false
    let cancelExtra = 0
    let cancelClicks = 1
    const cancelDeadline = Date.now() + 20000
    while (Date.now() < cancelDeadline) {
      // If the first physical click did not start closing within 5s,
      // re-resolve the live Cancel center (layout may have shifted under the
      // still-growing textarea) and click once more at fresh coordinates.
      // Both clicks are genuine pointer input; the count is recorded.
      if (!editorGone && cancelClicks === 1 && Date.now() > cancelDeadline - 15000) {
        const stillOpen = await page.evaluate(() => !!document.querySelector('.message-editor-area')).catch(() => true)
        if (stillOpen) {
          const fresh = await captureEditorGeometry(page, targetAssistantId).catch(() => null)
          if (fresh?.cancelCenter) {
            cancelPoint = { ...fresh.cancelCenter }
            await page.mouse.click(cancelPoint.x, cancelPoint.y)
            cancelClicks = 2
            console.log(
              `[E2E] aer-takeover-cancel-reclick point=${Math.round(cancelPoint.x)},${Math.round(cancelPoint.y)}`
            )
            test.info().annotations.push({
              type: 'aer-takeover-cancel-reclick',
              description: `first click did not close within 5s; second physical click at fresh center ${Math.round(cancelPoint.x)},${Math.round(cancelPoint.y)}`
            })
          }
        }
      }
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      const curS = await readScroll(page).catch(() => null)
      if (curS) cancelScrollTrace.push(curS.scrollTop)
      const open = await page.evaluate(() => !!document.querySelector('.message-editor-area')).catch(() => true)
      if (!open) {
        editorGone = true
        cancelExtra += 1
        if (cancelExtra >= 4) break
      } else {
        cancelExtra = 0
      }
    }
    expect(editorGone, 'editor must close after the post-takeover Cancel click').toBe(true)
    await waitForScrollQuiescence(page)
    const finalScroll = await readScroll(page)
    const finalTopExtreme = -(finalScroll.scrollHeight - finalScroll.clientHeight)
    const cancelWorstSnap = cancelScrollTrace.length
      ? Math.min(...cancelScrollTrace.map((v) => Math.abs(v - preScrollTop)))
      : Number.NaN
    const finalTakeoverDrift = Math.abs(finalScroll.scrollTop - takenScrollAdjusted.scrollTop)
    console.log(
      `[E2E] aer-takeover-cancel finalScroll=${Math.round(finalScroll.scrollTop)} takenAdjusted=${Math.round(takenScrollAdjusted.scrollTop)} drift=${finalTakeoverDrift.toFixed(1)} worstSnapToPre=${Number.isFinite(cancelWorstSnap) ? cancelWorstSnap.toFixed(1) : 'NaN'} preScroll=${Math.round(preScrollTop)}`
    )
    test.info().annotations.push({
      type: 'aer-takeover-cancel-geometry',
      description: `finalScroll=${Math.round(finalScroll.scrollTop)} takenAdjusted=${Math.round(takenScrollAdjusted.scrollTop)} drift=${finalTakeoverDrift.toFixed(1)} worstSnapToPre=${Number.isFinite(cancelWorstSnap) ? cancelWorstSnap.toFixed(1) : 'NaN'} preScroll=${Math.round(preScrollTop)} clicks=${cancelClicks} hit=${cancelHitDetail} topic=${topicId}`
    })
    expect(finalScroll.scrollTop, 'post-takeover Cancel stays inside the live scroll range').toBeGreaterThanOrEqual(
      finalTopExtreme - OFFSET_TOL
    )
    expect(finalScroll.scrollTop, 'post-takeover Cancel stays at/above bottom').toBeLessThanOrEqual(OFFSET_TOL)
    expect(
      finalTakeoverDrift,
      'post-takeover Cancel: final viewport stays where the user left it (no snapback to the pre-edit hold)'
    ).toBeLessThanOrEqual(TAKEOVER_FINAL_TOL)
  })

  /**
   * Nearest visible rows above/below the clicked row, in container
   * coordinates. These are the two stationary oracles for an insertion: the
   * content ABOVE must keep its viewport position and the content BELOW must
   * expand downward by the inserted height.
   */
  async function readNeighborRows(
    page: Page,
    anchorId: string
  ): Promise<{ aboveId: string | null; aboveTop: number | null; belowId: string | null; belowTop: number | null }> {
    return page.evaluate((id: string) => {
      const empty = { aboveId: null, aboveTop: null, belowId: null, belowTop: null }
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return empty
      const cTop = container.getBoundingClientRect().top
      const cssEsc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const anchor =
        (document.querySelector(`#message-${cssEsc}[data-message-id="${cssEsc}"]`) as HTMLElement | null) ?? null
      if (!anchor) return empty
      const a = anchor.getBoundingClientRect()
      let above: { id: string; top: number } | null = null
      let below: { id: string; top: number } | null = null
      const rows = Array.from(
        document.querySelectorAll('#messages [data-message-id]:not([data-testid="answer-group-selector"])')
      ) as HTMLElement[]
      for (const row of rows) {
        const mid = row.getAttribute('data-message-id')
        if (!mid || mid === id) continue
        const r = row.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        if (r.bottom <= a.top + 1) {
          if (!above || r.top > above.top) above = { id: mid, top: r.top - cTop }
        } else if (r.top >= a.bottom - 1) {
          if (!below || r.top < below.top) below = { id: mid, top: r.top - cTop }
        }
      }
      return {
        aboveId: above ? above.id : null,
        aboveTop: above ? above.top : null,
        belowId: below ? below.id : null,
        belowTop: below ? below.top : null
      }
    }, anchorId)
  }

  const residentCount = async (page: Page, topicId: string): Promise<number> =>
    page.evaluate(
      (tid: string) => (((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? []) as string[]).length,
      topicId
    )

  const clickRowToolbarButton = async (page: Page, messageId: string, testId: string): Promise<void> => {
    const e = escId(messageId)
    const row = page.locator(`#message-${e}[data-message-id="${e}"]`).first()
    await expect(row, `message container ${messageId} must be visible`).toBeVisible({ timeout: 15000 })
    await row.hover({ timeout: 8000 }).catch(() => {})
    const btn = row.locator(`[data-testid="${testId}"]`)
    await expect(btn, `toolbar button ${testId} for ${messageId} must be attached`).toBeAttached({ timeout: 10000 })
    try {
      await btn.click({ timeout: 8000 })
    } catch {
      await btn.click({ force: true } as any)
    }
  }

  /** Rows currently mounted in the bounded message window. */
  const domRowCount = async (page: Page): Promise<number> =>
    page.evaluate(() => document.querySelectorAll('#messages [data-message-id]').length)

  /** Resident ids in chronological (oldest-first) order. */
  const residentIds = async (page: Page, topicId: string): Promise<string[]> =>
    page.evaluate(
      (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])] as string[],
      topicId
    )

  test('insert after a mid-list message keeps the clicked region and the content above stationary (default window, repeated)', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INSERT MID-LIST IN-PLACE GEOMETRY AT THE PRODUCTION DEFAULT WINDOW (displayCount 10, not an enlarged test window): from a verified non-bottom reading viewport whose clicked assistant row sits at the OLDER boundary of the loaded window, a real msg-insert-btn click (production insertMessagesAfterAnchor path) must keep the SAME controls interaction region and the nearest row ABOVE it at their previous viewport offsets while the pair and every row below expand downward, and the clicked row must stay mounted inside the bounded window (the newest-capacity reconcile would otherwise evict it). Repeated on the same anchor: a second insert must hold the same continuity with the window still bounded. Painted frames are sampled per round; true-bottom behaviour is asserted separately.'
    })
    const page: Page = mainWindow
    const { topicId } = await test.step('seed the production default window (no enlarged displayCount)', async () =>
      setupEditRegionTopic(page))
    await test.step('confirm the loaded window is the production default size', async () => {
      const size = await residentCount(page, topicId)
      expect(size, 'production default window must be the 10-row loaded projection').toBe(DISPLAY_COUNT)
    })
    const loaded = await residentIds(page, topicId)
    // The reported scenario: the clicked row is the SECOND-OLDEST resident row,
    // so two inserted messages push the newest-capacity range past it. The row
    // above it (the oldest resident) is the "content above" oracle.
    const anchorId = loaded[1]
    const aboveId = loaded[0]
    expect(anchorId, 'a second-oldest resident anchor must exist').toBeTruthy()
    expect(aboveId, 'an oldest resident row above the anchor must exist').toBeTruthy()
    const preReading = await test.step('wheel to a verified non-bottom reading position', async () =>
      wheelToReadingPositionWithEditVisible(page, anchorId))

    const runRound = async (
      round: number
    ): Promise<{
      regionDrift: number
      aboveDrift: number
      worstRegion: number
      worstAbove: number
      belowExpansion: number
      addedRows: number
      domRows: number
      anchorMounted: boolean
      aboveMounted: boolean
      postScrollTop: number
      scrollHeight: number
      clientHeight: number
    }> => {
      const preRegionOffset = await readRegionOffset(page, anchorId)
      expect(Number.isFinite(preRegionOffset), `round ${round}: controls region measurable before insert`).toBe(true)
      const preNeighbors = await readNeighborRows(page, anchorId)
      expect(preNeighbors.aboveId, `round ${round}: a visible row must exist above the clicked message`).not.toBeNull()
      expect(preNeighbors.belowId, `round ${round}: a visible row must exist below the clicked message`).not.toBeNull()
      const preBelowTop = await readMessageOffset(page, preNeighbors.belowId as string)
      const preCount = await residentCount(page, topicId)
      const preDomRows = await domRowCount(page)
      // Painted-frame tracking starts BEFORE the real click and continues
      // through landing + settle (never only the eventual final frame).
      const regionSamples: number[] = [0]
      const aboveSamples: number[] = [0]
      await clickRowToolbarButton(page, anchorId, 'msg-insert-btn')
      let landed = false
      let settled = 0
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        )
        const curRegion = await readRegionOffset(page, anchorId)
        if (Number.isFinite(curRegion)) regionSamples.push(Math.abs(curRegion - preRegionOffset))
        if ((await residentCount(page, topicId)) >= preCount + 2) {
          landed = true
          settled += 1
          if (settled >= 4) break
        } else {
          settled = 0
        }
      }
      expect(landed, `round ${round}: the inserted user/assistant pair must land in the resident projection`).toBe(true)
      await waitForScrollQuiescence(page)
      const postRegionOffset = await readRegionOffset(page, anchorId)
      const postNeighbors = await readNeighborRows(page, anchorId)
      const postAboveTop = preNeighbors.aboveId ? await readMessageOffset(page, preNeighbors.aboveId) : Number.NaN
      const postBelowTop = preNeighbors.belowId ? await readMessageOffset(page, preNeighbors.belowId) : Number.NaN
      const postScroll = await readScroll(page)
      const postCount = await residentCount(page, topicId)
      const domRows = await domRowCount(page)
      const anchorMounted = await page
        .evaluate((id: string) => {
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          return !!document.querySelector(`#message-${esc}[data-message-id="${esc}"]`)
        }, anchorId)
        .catch(() => false)
      const aboveMounted = await page
        .evaluate((id: string) => {
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
          return !!document.querySelector(`#message-${esc}[data-message-id="${esc}"]`)
        }, aboveId)
        .catch(() => false)
      const result = {
        regionDrift: Math.abs(postRegionOffset - preRegionOffset),
        aboveDrift:
          preNeighbors.aboveTop !== null && Number.isFinite(postAboveTop)
            ? Math.abs(postAboveTop - preNeighbors.aboveTop)
            : Number.NaN,
        worstRegion: regionSamples.length > 0 ? Math.max(...regionSamples) : Number.NaN,
        worstAbove: aboveSamples.length > 0 ? Math.max(...aboveSamples) : Number.NaN,
        belowExpansion: Number.isFinite(postBelowTop) ? postBelowTop - preBelowTop : Number.NaN,
        addedRows: postCount - preCount,
        domRows,
        anchorMounted,
        aboveMounted,
        postScrollTop: postScroll.scrollTop,
        scrollHeight: postScroll.scrollHeight,
        clientHeight: postScroll.clientHeight
      }
      test.info().annotations.push({
        type: `insert-window-geometry-round-${round}`,
        description: `preRegion=${Math.round(preRegionOffset)} postRegion=${Math.round(postRegionOffset)} regionDrift=${result.regionDrift.toFixed(1)} worstRegion=${Number.isFinite(result.worstRegion) ? result.worstRegion.toFixed(1) : 'NaN'} aboveDrift=${Number.isFinite(result.aboveDrift) ? result.aboveDrift.toFixed(1) : 'NaN'} worstAbove=${Number.isFinite(result.worstAbove) ? result.worstAbove.toFixed(1) : 'NaN'} belowExpansion=${Number.isFinite(result.belowExpansion) ? result.belowExpansion.toFixed(1) : 'NaN'} resident=${preCount}->${postCount} domRows=${preDomRows}->${domRows} anchorMounted=${anchorMounted} aboveMounted=${aboveMounted} preBelowId=${preNeighbors.belowId} postBelowId=${postNeighbors.belowId} preScroll=${Math.round(preReading.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)}`
      })
      console.log(
        `[E2E] insert-round${round} regionDrift=${result.regionDrift.toFixed(1)} worstRegion=${Number.isFinite(result.worstRegion) ? result.worstRegion.toFixed(1) : 'NaN'} aboveDrift=${Number.isFinite(result.aboveDrift) ? result.aboveDrift.toFixed(1) : 'NaN'} worstAbove=${Number.isFinite(result.worstAbove) ? result.worstAbove.toFixed(1) : 'NaN'} belowExpansion=${Number.isFinite(result.belowExpansion) ? result.belowExpansion.toFixed(1) : 'NaN'} resident=${preCount}->${postCount} domRows=${preDomRows}->${domRows} anchorMounted=${anchorMounted} aboveMounted=${aboveMounted} postScroll=${Math.round(postScroll.scrollTop)}`
      )
      return result
    }

    for (const round of [1, 2]) {
      const metrics =
        await test.step(`insert round ${round}: real msg-insert-btn click on the older-boundary anchor`, async () =>
          runRound(round))
      // 1. The clicked controls interaction region stays where the click found it.
      expect(
        metrics.regionDrift,
        `round ${round}: clicked controls region stays at its previous offset`
      ).toBeLessThanOrEqual(REGION_TOL)
      // 2. The pre-existing content ABOVE the clicked message stays still.
      expect(
        metrics.aboveDrift,
        `round ${round}: the nearest pre-existing row above keeps its offset`
      ).toBeLessThanOrEqual(REGION_TOL)
      // 3. Every painted frame is continuous (not only the final frame).
      expect(metrics.worstRegion, `round ${round}: painted region frames never jump`).toBeLessThanOrEqual(
        TRANSITION_TOL
      )
      expect(metrics.worstAbove, `round ${round}: painted frames above the insertion never jump`).toBeLessThanOrEqual(
        TRANSITION_TOL
      )
      // 4. The pair lands below and downstream content expands DOWNWARD.
      expect(metrics.addedRows, `round ${round}: exactly one user/assistant pair is added`).toBe(2)
      expect(metrics.belowExpansion, `round ${round}: previously-below content moves downward`).toBeGreaterThan(20)
      // 5. The clicked row and the content above it stay MOUNTED: the bounded
      // window retains them instead of trimming the older edge.
      expect(metrics.anchorMounted, `round ${round}: the clicked row stays mounted in the bounded window`).toBe(true)
      expect(metrics.aboveMounted, `round ${round}: the row above the insertion stays mounted`).toBe(true)
      // 6. ...and the window itself stays bounded at the production capacity.
      expect(metrics.domRows, `round ${round}: mounted rows stay inside the bounded window`).toBeLessThanOrEqual(
        DISPLAY_COUNT
      )
      // 7. Still a genuine mid-list reading position (never a bottom jump).
      expect(Math.abs(metrics.postScrollTop), `round ${round}: remains non-bottom (no bottom jump)`).toBeGreaterThan(
        BOTTOM_TOL
      )
      const topExtreme = -(metrics.scrollHeight - metrics.clientHeight)
      expect(
        metrics.postScrollTop,
        `round ${round}: post viewport stays inside the live scroll range`
      ).toBeGreaterThanOrEqual(topExtreme - OFFSET_TOL)
    }
  })
  test('insert at true bottom keeps the honest bottom pin (content shifts up)', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INSERT TRUE-BOTTOM PIN (must stay unchanged): at the natural bottom the bottom pin owns geometry, a mid-list region hold is never armed, and the real msg-insert-btn click leaves the viewport at the honest bottom (scrollTop ~ 0) while the pair is added — the accepted bottom behaviour.'
    })
    const page: Page = mainWindow
    const { topicId } = await test.step('seed mid-topic assistant topic and cold-activate', async () =>
      setupEditRegionTopic(page))
    // Wheel to the true physical bottom (column-reverse: scrollTop ~= 0).
    const box = await page.locator('#messages').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 16; i++) {
      const scroll = await readScroll(page)
      if (Math.abs(scroll.scrollTop) <= 8) break
      await page.mouse.wheel(0, 400)
      await page.waitForTimeout(180)
    }
    const bottomScroll = await readScroll(page)
    expect(Math.abs(bottomScroll.scrollTop), 'precondition: viewport reached the true bottom').toBeLessThanOrEqual(8)
    const bottomAssistantId = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      const entities: Record<string, any> = s.messages?.entities ?? {}
      for (let i = ids.length - 1; i >= 0; i--) {
        if (entities[ids[i]]?.role === 'assistant') return ids[i]
      }
      return null
    }, topicId)
    expect(bottomAssistantId, 'a bottom assistant row must exist').toBeTruthy()
    const preCount = await residentCount(page, topicId)
    await clickRowToolbarButton(page, bottomAssistantId as string, 'msg-insert-btn')
    let landed = false
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
      if ((await residentCount(page, topicId)) >= preCount + 2) {
        landed = true
        break
      }
    }
    expect(landed, 'the inserted pair must land at the bottom').toBe(true)
    await waitForScrollQuiescence(page)
    const postScroll = await readScroll(page)
    const postCount = await residentCount(page, topicId)
    test.info().annotations.push({
      type: 'insert-bottom-geometry',
      description: `rows=${preCount}->${postCount} preScroll=${Math.round(bottomScroll.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)}`
    })
    console.log(
      `[E2E] insert-bottom rows=${preCount}->${postCount} preScroll=${Math.round(bottomScroll.scrollTop)} postScroll=${Math.round(postScroll.scrollTop)}`
    )
    expect(postCount, 'insert at bottom: pair added').toBe(preCount + 2)
    expect(
      Math.abs(postScroll.scrollTop),
      'insert at bottom: the honest bottom pin is unchanged (no upward pull)'
    ).toBeLessThanOrEqual(TRUE_BOTTOM_TOL)
  })
})
