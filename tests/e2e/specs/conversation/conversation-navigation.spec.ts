/**
 * Conversation navigation redesign — INTEGRATED E2E (real UI, real IPC, real SQLite).
 *
 * Approved behavior (shared fixture, disposable profile, mock provider,
 * deterministic assertions):
 * - T1 whole-route user list: 50/20 seed, enable the single
 *   `messageNavigation` toggle, assert the LEFT chat-viewport navigation list
 *   holds ALL 25 user messages of the effective route (incl. window-outside
 *   head) in chronological order against the fetchWholeTopicSnapshot oracle,
 *   with loaded Redux/DOM still bounded; clicking the head item navigates by
 *   stable ID (around-target positioning proves the head message renders).
 * - T2 previews + branch switch: quote/long-text user messages render
 *   body-only previews (no quoted content, no raw HTML, bounded length) with
 *   localized fallbacks for quote-only items; one authority-seeded
 *   attachment-only user row keeps a navigable stable-ID row with its file
 *   label and stable-ID click positions it; the list is internally
 *   scrollable with bounded height; forking L1 through the real toolbar
 *   button switches the list to the new effective route (route isolation).
 * - T3 independent back-to-bottom button: hidden at the genuine physical
 *   bottom with the navigation toggle OFF (always available, no settings
 *   gate); a real wheel away during an active slow stream reveals it; a real
 *   click returns to the bottom and resumes follow.
 *
 * Seams (existing only): #messages, [data-testid="topic-item"],
 * [data-testid="conversation-navigation"],
 * [data-testid^="conversation-nav-item-"],
 * [data-testid="conversation-back-to-bottom"], window.store
 * (introspection), window.api.chatDb.ensureTopic/pasteMessagesToTopic
 * (seed), window.keyv (supporting only). Sends go through the real
 * textarea/Enter; all pointer input goes through the real mouse. Never
 * dispatches scrollToBottom or SEND_MESSAGE to fake a gesture.
 *
 * Geometry: #messages renders column-reverse, so bottom/newest is
 * scrollTop ~= 0 and reading positions are negative scrollTop.
 */
import type { Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { SLOW_STREAM_MARKER } from '../../fixtures/mock-openai-server'
import { activateTopic, clickToolbarBranch } from '../../utils/branch-route-setup'

// Runner-cwd anchored repo root (same CJS-safe pattern as
// startup/native-runtime.spec.ts): the Playwright runner executes at the repo
// root, and this spec stays on the CJS loader (no import.meta).
function runnerRepoRoot(): string {
  const candidate = process.cwd()
  const pkg = path.join(candidate, 'package.json')
  if (fs.existsSync(pkg)) return fs.realpathSync(candidate)
  throw new Error('conversation-navigation: cannot resolve repository root from runner cwd')
}

// File-anchored repo root: derived from this spec file location
// (tests/e2e/specs/conversation/ -> repo root is 4 levels up), independent of
// the launch cwd so a wrong-worktree app cannot false-pass.
function fileRepoRoot(specFile: string): string {
  const root = path.resolve(path.dirname(specFile), '../../../..')
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error(`conversation-navigation: file-anchored root missing package.json: ${root}`)
  }
  return fs.realpathSync(root)
}

const DISPLAY_LIMIT = 20
const SYNTHETIC_TOTAL = 50
const BOTTOM_TOL = 100
const PRODUCT_BOTTOM_TOL = 1

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

async function prepareDisplayCountAndAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, DISPLAY_LIMIT)

  const displayOk = await page.evaluate(
    (limit: number) => (window as any).store.getState().messages.displayCount,
    DISPLAY_LIMIT
  )
  expect(displayOk).toBe(DISPLAY_LIMIT)

  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist for addTopic').toBeTruthy()
  return liveAssistantId as string
}

async function seedNavTopic(
  page: any,
  liveAssistantId: string,
  topicId: string,
  total: number,
  contentForIndex: (i: number) => string
): Promise<void> {
  const name = `Nav Test ${topicId}`
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
    { topicId, assistantId: liveAssistantId, name }
  )
  expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)

  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < total; i++) {
    const msgId = `${topicId}-msg-${pad(i, 5)}`
    const blockId = `${topicId}-block-${pad(i, 5)}`
    entries.push({
      message: {
        id: msgId,
        topicId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        assistantId: liveAssistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [blockId],
        sortOrder: i
      },
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: contentForIndex(i),
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  }

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
      entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
    }) => {
      try {
        const api = (window as any).api as any
        const chatDb = api?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function') {
          return { ok: false, err: 'chatDb missing' }
        }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name, entries }
  )
  expect(persist.ok, `persist failed: ${(persist as any).err}`).toBe(true)
}

async function activateTopicAndWaitForBootstrap(page: any, topicId: string, expected = DISPLAY_LIMIT): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()

  await page.waitForFunction(
    ({ topicId, expected }: { topicId: string; expected: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length === expected && loading !== true
    },
    { topicId, expected },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages [data-message-id]').length === expected,
    expected,
    { timeout: 30000 }
  )
}

async function enableConversationNavigation(page: any): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).store.dispatch({ type: 'settings/setMessageNavigation', payload: true })
  })
  const navEnabled = await page.evaluate(() => (window as any).store.getState().settings?.messageNavigation)
  expect(navEnabled).toBe(true)
}

/** Real UI send pattern copied from ordinary-chat.spec.ts (spec-local only). */
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

async function navItemIds(page: any): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="conversation-nav-item-"]')).map(
      (el) => (el as HTMLElement).getAttribute('data-testid') || ''
    )
  )
}

interface Anchor {
  id: string
  offset: number
}

/** Physical container-relative geometry of a message row inside #messages. */
interface TargetGeometry {
  cTop: number
  cBottom: number
  rTop: number
  rBottom: number
  scrollTop: number
}

async function targetGeometry(page: any, messageId: string): Promise<TargetGeometry | null> {
  return page.evaluate((id: string) => {
    const container = document.getElementById('messages')
    const target = document.getElementById(`message-${id}`)
    if (!container || !target) return null
    const c = container.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    return { cTop: c.top, cBottom: c.bottom, rTop: r.top, rBottom: r.bottom, scrollTop: container.scrollTop }
  }, messageId)
}

function isOutsideViewport(g: TargetGeometry): boolean {
  return g.rBottom <= g.cTop || g.rTop >= g.cBottom
}

function intersectsViewport(g: TargetGeometry): boolean {
  return g.rBottom > g.cTop && g.rTop < g.cBottom
}

/** Settle helper: target top-edge aligned near the container top (start alignment). */
async function waitForTopAlignment(page: any, messageId: string, tol = 32): Promise<TargetGeometry> {
  await page.waitForFunction(
    ({ id, tol }: { id: string; tol: number }) => {
      const container = document.getElementById('messages')
      const target = document.getElementById(`message-${id}`)
      if (!container || !target) return false
      const c = container.getBoundingClientRect()
      const r = target.getBoundingClientRect()
      return r.bottom > c.top && r.top < c.bottom && Math.abs(r.top - c.top) <= tol
    },
    { id: messageId, tol },
    { timeout: 30000 }
  )
  const geo = await targetGeometry(page, messageId)
  expect(geo).not.toBeNull()
  return geo!
}

async function readScrollTop(page: any): Promise<number> {
  return page.locator('#messages').evaluate((el: HTMLElement) => el.scrollTop)
}

/**
 * Clamped-geometry wait for near-bottom targets (e.g. T2 attachment-only row
 * near the newest edge): top-alignment is geometrically impossible without
 * positive overscroll (finite clamped scroll delta only), so the contract is
 * genuine viewport intersection + stability, never a mandatory top offset 0.
 */
async function waitForViewportIntersection(page: any, messageId: string): Promise<TargetGeometry> {
  await page.waitForFunction(
    (id: string) => {
      const container = document.getElementById('messages')
      const target = document.getElementById(`message-${id}`)
      if (!container || !target) return false
      const c = container.getBoundingClientRect()
      const r = target.getBoundingClientRect()
      return r.bottom > c.top && r.top < c.bottom
    },
    messageId,
    { timeout: 30000 }
  )
  const geo = await targetGeometry(page, messageId)
  expect(geo).not.toBeNull()
  return geo!
}

/** Restored original MessageOutline body (collapsed narrow strip, hover expands). */
function outlineBodySelector(): string {
  return '[data-testid="conversation-navigation"] > div'
}

/** Hover the original collapsed strip via a real row (body is pointer-events auto, container is none). */
async function hoverOriginalOutline(page: any): Promise<void> {
  const row = page.locator('[data-testid^="conversation-nav-item-"]').first()
  await row.hover({ timeout: 10000 })
  // Hover reveals the single-line text (original CSS: display block + opacity 1 on body:hover).
  await page.waitForFunction(
    () => {
      const landmark = document.querySelector('[data-testid="conversation-navigation"]')
      const body = landmark?.firstElementChild as HTMLElement | null
      if (!landmark || !body) return false
      const text = body.querySelector('[data-testid^="conversation-nav-item-"] > div:last-child') as HTMLElement | null
      if (!text) return false
      const style = getComputedStyle(text)
      return style.display !== 'none' && Number.parseFloat(style.opacity) > 0.5
    },
    undefined,
    { timeout: 10000 }
  )
}

/** Stable viewport: scrollTop unchanged across samples (no drift, no keeper pull-back). */
async function expectStableScrollTop(page: any, samples = 3, gapMs = 250, tol = 2): Promise<number> {
  const tops: number[] = []
  for (let i = 0; i < samples; i++) {
    tops.push(await readScrollTop(page))
    await page.waitForTimeout(gapMs)
  }
  for (const t of tops) {
    expect(Math.abs(t - tops[0])).toBeLessThanOrEqual(tol)
  }
  return tops[0]
}

/** Focused T3 hold thresholds (same numerics as streaming-click-pause.spec.ts). */
const ANCHOR_TOL = 12
const HOLD_GROWTH = 500
const PAUSED_MIN = 200

/** Length/status of one streaming main-text block (spec-local, same pattern as pause legs). */
async function streamBlockState(page: any, blockId: string): Promise<{ status: string; length: number } | null> {
  return page.evaluate((id: string) => {
    const s = (window as any).store?.getState()
    const block = s?.messageBlocks?.entities?.[id]
    if (!block || block.type !== 'main_text') return null
    return { status: block.status as string, length: (block.content as string)?.length ?? 0 }
  }, blockId)
}

/** Id of the longest streaming main-text block (the active slow stream). */
async function findStreamingBlockId(page: any): Promise<string | null> {
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

async function waitForBlockGrowth(page: any, blockId: string, minLength: number): Promise<void> {
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

/** Crossing-first visible anchor + container-relative offset (repo convention, same as pause legs). */
async function readAnchor(page: any): Promise<Anchor | null> {
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
 * T3 hold-entry settle (diagnostic-probe anchored: 2026-10-13 ui:observe
 * t3-quiet-vs-drift-probe reproduced the reported hold flip on current
 * bundles — immediate baseline 162ms post-wheel at len 1162 / offset +6.4
 * shifted 40px within 40ms with scrollTop fixed at -1568, then flipped
 * rows through +594 chars with scrollTop never moving). The 8x150ms
 * real-wheel burst outpaces settled render, so a baseline taken immediately
 * measures input settling, not the keeper. The baseline therefore waits for
 * genuine user-input completion: real-wheel quiet (no new wheel for at
 * least T3_WHEEL_QUIET_MS, derived from the 150ms input cadence) plus a
 * stable visible anchor (same row, offsets within T3_SETTLE_TOL across
 * three consecutive 150ms frames — anchor-offset stability, never raw
 * scrollTop, which streaming compensation legitimately moves) plus
 * required row overlap (visible height >= T3_MIN_OVERLAP_PX so an
 * edge-touching row cannot be picked). Finite deadline: expiry throws with
 * the last samples attached (drift evidence preserved, never skipped).
 * Hold numerics below (500 / same-ID / 12px / 200px / click-return + 500)
 * are unchanged.
 */
const T3_WHEEL_QUIET_MS = 500
const T3_SETTLE_TOL = 8
const T3_MIN_OVERLAP_PX = 60
const T3_SETTLE_DEADLINE_MS = 8000

interface QuietAnchor extends Anchor {
  visibleHeight: number
  quietMs: number
}

async function anchorVisibleHeight(page: any, id: string): Promise<number> {
  return page.evaluate((messageId: string) => {
    const container = document.getElementById('messages')
    const target = document.getElementById(`message-${messageId}`)
    if (!container || !target) return 0
    const c = container.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    return Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top))
  }, id)
}

async function waitForQuietReadingAnchor(page: any, lastWheelTime: number): Promise<QuietAnchor> {
  const deadline = Date.now() + T3_SETTLE_DEADLINE_MS
  const samples: Anchor[] = []
  for (;;) {
    const current = await readAnchor(page)
    if (current) {
      samples.push(current)
      if (samples.length > 3) samples.shift()
    }
    const quietMs = Date.now() - lastWheelTime
    if (current && samples.length === 3 && quietMs >= T3_WHEEL_QUIET_MS) {
      const sameRow = samples.every((s) => s.id === current.id)
      const spread = Math.max(...samples.map((s) => s.offset)) - Math.min(...samples.map((s) => s.offset))
      if (sameRow && spread <= T3_SETTLE_TOL) {
        const visibleHeight = await anchorVisibleHeight(page, current.id)
        if (visibleHeight >= T3_MIN_OVERLAP_PX) {
          return { id: current.id, offset: current.offset, visibleHeight, quietMs }
        }
      }
    }
    if (Date.now() >= deadline) {
      const tail = samples.map((s) => `${s.id.slice(0, 8)}@${s.offset.toFixed(1)}`).join(',')
      throw new Error(
        `T3 hold entry never settled within ${T3_SETTLE_DEADLINE_MS}ms ` +
          `(wheel-quiet ${T3_WHEEL_QUIET_MS}ms + same-row 3-frame spread<=${T3_SETTLE_TOL}px + overlap>=${T3_MIN_OVERLAP_PX}px; last=[${tail}])`
      )
    }
    await page.waitForTimeout(150)
  }
}

/**
 * Spec-local authority seed for one attachment-only user message plus its
 * assistant reply (real IPC/SQLite, no live files: only block metadata is
 * persisted and read back through the snapshot — never file I/O).
 */
async function seedAttachmentOnlyPair(
  page: any,
  liveAssistantId: string,
  topicId: string,
  name: string,
  startIndex: number,
  fileName: string
): Promise<string> {
  const userIdx = startIndex
  const asstIdx = startIndex + 1
  const userId = `${topicId}-msg-${pad(userIdx, 5)}`
  const asstId = `${topicId}-msg-${pad(asstIdx, 5)}`
  const userBlockId = `${topicId}-block-${pad(userIdx, 5)}`
  const asstBlockId = `${topicId}-block-${pad(asstIdx, 5)}`
  const stamp = '2026-01-01T00:00:00.000Z'
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = [
    {
      message: {
        id: userId,
        topicId,
        role: 'user',
        assistantId: liveAssistantId,
        createdAt: stamp,
        updatedAt: stamp,
        status: 'success',
        blocks: [userBlockId],
        sortOrder: userIdx
      },
      blocks: [
        {
          id: userBlockId,
          messageId: userId,
          type: 'file',
          file: {
            id: `${topicId}-file-attach`,
            name: fileName,
            origin_name: fileName,
            path: `/tmp/${fileName}`,
            size: 1024,
            ext: '.pdf',
            type: 'document'
          },
          status: 'success',
          createdAt: stamp,
          updatedAt: stamp
        }
      ]
    },
    {
      message: {
        id: asstId,
        topicId,
        role: 'assistant',
        assistantId: liveAssistantId,
        createdAt: stamp,
        updatedAt: stamp,
        status: 'success',
        blocks: [asstBlockId],
        sortOrder: asstIdx
      },
      blocks: [
        {
          id: asstBlockId,
          messageId: asstId,
          type: 'main_text',
          content: 'assistant reply after attachment',
          status: 'success',
          createdAt: stamp,
          updatedAt: stamp
        }
      ]
    }
  ]
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
      entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
    }) => {
      try {
        const api = (window as any).api as any
        const chatDb = api?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function') {
          return { ok: false, err: 'chatDb missing' }
        }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name, entries }
  )
  expect(persist.ok, `attachment persist failed: ${(persist as any).err}`).toBe(true)
  return userId
}

test.describe('conversation navigation redesign', () => {
  test.setTimeout(180000)

  test('T1 whole-route user list + stable-ID around navigation', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'T1 INTEGRATED UI: settings/setMessageNavigation enable → cold activate 50-msg topic (20 loaded) → LEFT conversation list holds all 25 effective-route user messages incl. window-outside head in chronological order against fetchWholeTopicSnapshot oracle with loaded Redux/DOM bounded → click head item navigates by stable ID (around-target head renders). Deterministic mocked provider.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `convnav-t1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const seedContent = `convnav-content-${'x'.repeat(20)}`
    await seedNavTopic(page, liveAssistantId, topicId, SYNTHETIC_TOTAL, (i) => `${seedContent}-${pad(i, 5)}`)
    await activateTopicAndWaitForBootstrap(page, topicId)
    await enableConversationNavigation(page)

    const headId = `${topicId}-msg-${pad(0, 5)}`
    const headContent = `${seedContent}-${pad(0, 5)}`

    // Loaded projection stays bounded before navigation.
    const pre = await page.evaluate((topicId: string) => {
      const s = (window as any).store.getState()
      return { ids: [...(s.messages?.messageIdsByTopic?.[topicId] ?? [])] }
    }, topicId)
    expect(pre.ids.length).toBe(DISPLAY_LIMIT)
    expect(pre.ids).not.toContain(headId)

    // Whole-topic oracle: user IDs in effective-route order.
    const snap: any = await page.evaluate(
      async (topicId: string) => await (window as any).api.chatDb.fetchWholeTopicSnapshot({ topicId }),
      topicId
    )
    expect(snap.ok).toBe(true)
    const expectedUserIds = (snap.value.messages as any[]).filter((m) => m.role === 'user').map((m) => m.id)
    expect(expectedUserIds.length).toBe(SYNTHETIC_TOTAL / 2)

    // The LEFT list holds every user message incl. the window-outside head.
    const nav = page.getByTestId('conversation-navigation')
    await expect(nav).toBeVisible({ timeout: 20000 })
    await expect.poll(async () => (await navItemIds(page)).length, { timeout: 20000 }).toBe(expectedUserIds.length)
    expect(await navItemIds(page)).toEqual(expectedUserIds.map((id) => `conversation-nav-item-${id}`))
    await expect(nav).toContainText(headContent, { timeout: 10000 })

    // No assistant message is listed.
    const assistantListed = await page.evaluate(
      () => document.querySelectorAll('[data-testid^="conversation-nav-item-"]').length
    )
    expect(assistantListed).toBe(expectedUserIds.length)

    // Restored original outline: hovering the collapsed strip expands the
    // body (narrow indicators -> text). The 25-row body is bounded
    // (max-height min(100%, 70vh)) and internally scrollable on hover —
    // never grows with content, never shifts the chat layout.
    await hoverOriginalOutline(page)
    const listMetrics = await page.evaluate(() => {
      const landmark = document.querySelector('[data-testid="conversation-navigation"]')
      const list = landmark?.firstElementChild as HTMLElement | null
      if (!list || !landmark) return null
      const style = getComputedStyle(list as HTMLElement)
      const landmarkStyle = getComputedStyle(landmark as HTMLElement)
      const rect = (list as HTMLElement).getBoundingClientRect()
      return {
        overflowY: style.overflowY,
        landmarkPosition: landmarkStyle.position,
        height: rect.height,
        scrollHeight: (list as HTMLElement).scrollHeight,
        clientHeight: (list as HTMLElement).clientHeight,
        viewportHeight: window.innerHeight
      }
    })
    expect(listMetrics).not.toBeNull()
    expect(['auto', 'scroll']).toContain(listMetrics!.overflowY)
    expect(listMetrics!.landmarkPosition).toBe('absolute')
    expect(listMetrics!.scrollHeight).toBeGreaterThan(listMetrics!.clientHeight)
    expect(listMetrics!.height).toBeLessThanOrEqual(listMetrics!.viewportHeight * 0.6 + 1)

    // Click the window-outside head item: stable-ID navigation positions it.
    // Real mouse click on the original item (role=button div with dot+text),
    // never forced/JS. Geometry (not CSS display) is the jump oracle.
    await hoverOriginalOutline(page)
    await page.getByTestId(`conversation-nav-item-${headId}`).click({ timeout: 10000 })
    // Physical proof: the head row genuinely intersects the #messages
    // viewport, top-edge aligned (historical target, geometrically possible),
    // after a real viewport move — then holds stable through observers.
    const headGeo = await waitForTopAlignment(page, headId)
    expect(intersectsViewport(headGeo)).toBe(true)
    await expectStableScrollTop(page)

    // Historical-window newer target: after around-navigation the projection
    // is historical (newer messages beyond), so the independent back-to-bottom
    // button must be visible through the existing window flow — asserted via
    // the button oracle, never via direct scroll geometry alone.
    const historicalBackButton = page.getByTestId('conversation-back-to-bottom')
    await expect(historicalBackButton).toBeVisible({ timeout: 10000 })
    // Canonical return: real click reaches the genuine newest bottom.
    await historicalBackButton.click({ timeout: 10000 })
    await page.waitForFunction(
      (tol: number) => {
        const el = document.getElementById('messages') as HTMLElement | null
        return !!el && Math.abs(el.scrollTop) <= tol
      },
      PRODUCT_BOTTOM_TOL,
      { timeout: 15000 }
    )
    console.log(`[E2E] T1 list=${expectedUserIds.length} head positioned via stable ID`)
  })

  test('T2 quote/long previews, bounded internal scroll, branch-switch isolation', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'T2 INTEGRATED UI: seed markdown/HTML-quote + long + quote-only + attachment-only user messages → list shows body-only previews (quoted content absent, no raw HTML, bounded length) with localized fallback for the quote-only item and the file label for the attachment-only row (stable-ID click positions it); list is internally scrollable with bounded height → real toolbar fork switches the list to the L1 effective route. Deterministic mocked provider.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `convnav-t2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const longBody = `long body segment ${'y'.repeat(600)}`
    const contents = [
      'How do I configure retries for the client?',
      // Blank line before the trailing body: without it CommonMark parses the
      // last line as a lazy continuation of the blockquote, so the seed keeps
      // the paragraph boundary the preview needs.
      `My question about timeouts.\n> quoted reply from the docs that must not preview\n\nMore of my own words.`,
      `Please explain this snippet:\n<blockquote><p>quoted html that must not preview</p></blockquote>\nKeep this explanation request.`,
      longBody,
      `> only a quote, nothing else`,
      'Final follow-up question here.'
    ]
    await seedNavTopic(page, liveAssistantId, topicId, contents.length * 2, (i) =>
      i % 2 === 0 ? contents[i / 2] : `assistant reply ${i}`
    )
    const attachFileName = 'nav-attachment-report.pdf'
    const attachUserId = await seedAttachmentOnlyPair(
      page,
      liveAssistantId,
      topicId,
      `Nav Test ${topicId}`,
      contents.length * 2,
      attachFileName
    )
    await activateTopicAndWaitForBootstrap(page, topicId, contents.length * 2 + 2)
    await enableConversationNavigation(page)

    const nav = page.getByTestId('conversation-navigation')
    await expect(nav).toBeVisible({ timeout: 20000 })
    await expect.poll(async () => (await navItemIds(page)).length, { timeout: 20000 }).toBe(contents.length + 1)

    // Body-only previews: quoted content absent, body present, no raw HTML.
    await expect(nav).toContainText('How do I configure retries', { timeout: 10000 })
    await expect(nav).toContainText('My question about timeouts.', { timeout: 10000 })
    await expect(nav).toContainText('More of my own words.', { timeout: 10000 })
    await expect(nav).not.toContainText('quoted reply from the docs')
    await expect(nav).toContainText('Keep this explanation request.', { timeout: 10000 })
    await expect(nav).not.toContainText('quoted html that must not preview')
    const longItemText = await page.getByTestId(`conversation-nav-item-${topicId}-msg-${pad(6, 5)}`).textContent()
    expect(longItemText ?? '').toContain('long body segment')
    expect((longItemText ?? '').length).toBeLessThanOrEqual(280)
    // Quote-only item stays navigable with a localized fallback.
    const quoteOnlyItem = page.getByTestId(`conversation-nav-item-${topicId}-msg-${pad(8, 5)}`)
    await expect(quoteOnlyItem).toContainText(/Quoted message|引用消息|引用訊息/)
    // Attachment-only item stays navigable with its meaningful file label
    // (metadata only — no path, query, or internal ID leaks into the row).
    const attachItem = page.getByTestId(`conversation-nav-item-${attachUserId}`)
    await expect(attachItem).toContainText(attachFileName)
    const attachText = (await attachItem.textContent()) ?? ''
    expect(attachText).not.toContain('/tmp/')
    // Stable-ID click positions the attachment-only message in the viewport.
    // Restored original gesture: hover the collapsed strip (narrow dot rail)
    // to expand the body, then a real mouse click on the original item
    // (role=button div with dot+text, title=full text), never forced/JS.
    await hoverOriginalOutline(page)
    await attachItem.click({ timeout: 10000 })
    // Physical proof: the near-newest attachment row genuinely intersects the
    // #messages viewport after the real click, then holds. Top-alignment is
    // NOT required here — the row sits ~566px from the top at the bottom with
    // only ~132px below, so a finite clamped position (intersection + stable)
    // is the optimum without positive overscroll. No blank filler is added.
    const attachScrollBefore = await readScrollTop(page)
    const attachGeo = await waitForViewportIntersection(page, attachUserId)
    expect(intersectsViewport(attachGeo)).toBe(true)
    expect(Number.isFinite(attachGeo.scrollTop)).toBe(true)
    expect(Math.abs(attachGeo.scrollTop)).toBeLessThanOrEqual(Math.abs(attachScrollBefore) + 1)
    await expectStableScrollTop(page)
    // Restored original CSS identity (verbatim, no styling alterations):
    // single-line ellipsis rows (white-space nowrap + ellipsis, 24px row),
    // native title tooltip carries the full text — never a two-line clamp.
    const originalStyle = await quoteOnlyItem.evaluate((el) => {
      const text = el.querySelector('div:last-child') as HTMLElement | null
      const rowStyle = getComputedStyle(el as HTMLElement)
      const textStyle = text ? getComputedStyle(text) : null
      return {
        rowHeight: rowStyle.height,
        whiteSpace: textStyle?.whiteSpace ?? null,
        textOverflow: textStyle?.textOverflow ?? null,
        title: (el as HTMLElement).getAttribute('title') ?? null,
        role: (el as HTMLElement).getAttribute('role') ?? null
      }
    })
    expect(originalStyle.role).toBe('button')
    expect(originalStyle.rowHeight).toBe('24px')
    expect(originalStyle.whiteSpace).toBe('nowrap')
    expect(originalStyle.textOverflow).toBe('ellipsis')
    expect(typeof originalStyle.title === 'string' && originalStyle.title.length > 0).toBe(true)

    // Internally scrollable with bounded height (never grows with content).
    // Original body: hover reveals overflow-y auto within max-height.
    await hoverOriginalOutline(page)
    const listMetrics = await page.evaluate(() => {
      const landmark = document.querySelector('[data-testid="conversation-navigation"]')
      const list = landmark?.firstElementChild as HTMLElement | null
      if (!list) return null
      const style = getComputedStyle(list as HTMLElement)
      const rect = (list as HTMLElement).getBoundingClientRect()
      return {
        overflowY: style.overflowY,
        height: rect.height,
        viewportHeight: window.innerHeight
      }
    })
    expect(listMetrics).not.toBeNull()
    expect(['auto', 'scroll']).toContain(listMetrics!.overflowY)
    expect(listMetrics!.height).toBeLessThanOrEqual(listMetrics!.viewportHeight * 0.6 + 1)

    // Branch switch: fork L1 at a mid anchor through the real toolbar button;
    // the list follows the new effective route (route isolation).
    const anchorAssistantId = `${topicId}-msg-${pad(5, 5)}`
    await clickToolbarBranch(page, anchorAssistantId)
    // Fork activation commits asynchronously (toolbar click dispatches an
    // async IPC round-trip); poll the Redux activation instead of racing a
    // single synchronous read. Same assertion, robust timing.
    let activeRoute: string | null = null
    await expect
      .poll(
        async () => {
          activeRoute = await page.evaluate(
            (topicId: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[topicId] ?? null,
            topicId
          )
          return activeRoute
        },
        { timeout: 20000 }
      )
      .not.toBeNull()
    expect(activeRoute, 'toolbar fork must activate the L1 route').not.toBeNull()
    const branchId = activeRoute as unknown as string
    const branchSnap: any = await page.evaluate(
      async ({ topicId, branchId }: { topicId: string; branchId: string }) =>
        await (window as any).api.chatDb.fetchWholeTopicSnapshot({ topicId, branchId }),
      { topicId, branchId }
    )
    expect(branchSnap.ok).toBe(true)
    const branchUserIds = (branchSnap.value.messages as any[]).filter((m) => m.role === 'user').map((m) => m.id)
    await expect
      .poll(async () => await navItemIds(page), { timeout: 20000 })
      .toEqual(branchUserIds.map((id) => `conversation-nav-item-${id}`))
    console.log(`[E2E] T2 previews ok, branch route users=${branchUserIds.length}`)
  })

  test('T3 independent back-to-bottom button during streaming', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'T3 INTEGRATED UI: navigation toggle OFF → button absent at genuine bottom → real slow-stream send + real wheel away reveals the always-available button → away hold proves streaming MAIN_TEXT grows by a reachable amount while the first visible reading anchor holds (row-stable per viewport ADR) → real click returns to bottom and stays pinned through further growth → hidden after completion. Deterministic mocked provider, single-route only.'
    })
    const page = mainWindow as Page
    clearRequestLog()

    // Independence: the toggle stays OFF for this whole test.
    const navToggle = await page.evaluate(() => (window as any).store.getState().settings?.messageNavigation)
    expect(navToggle).toBe(false)

    // Hidden at the genuine physical bottom.
    await expect(page.getByTestId('conversation-back-to-bottom')).toHaveCount(0)

    const needle = `convnav button stream ${SLOW_STREAM_MARKER}`
    const seq = getRequestSequence()
    await uiSendMessage(page, needle)
    // Bounded T3 synchronization: the mock request arrives asynchronously
    // after the renderer IPC round-trip, so an immediate
    // findProductRequestAfter raced the arrival. Wait for early streaming
    // content first (proves the send dispatched, same order as the passing
    // streaming-click-pause legs), then poll the sequence-scoped log.
    await page.waitForFunction(
      () => {
        const s = (window as any).store?.getState()
        if (!s?.messageBlocks?.entities) return false
        for (const block of Object.values(s.messageBlocks.entities) as any[]) {
          if (block?.type === 'main_text' && typeof block?.content === 'string' && block.content.length > 200) {
            return true
          }
        }
        return false
      },
      undefined,
      { timeout: 30000 }
    )
    await expect.poll(async () => findProductRequestAfter(seq), { timeout: 15000 }).not.toBeNull()
    const streamReq = findProductRequestAfter(seq)
    expect(streamReq, 'mock must receive the streaming request').not.toBeNull()
    expect(streamReq!.method).toBe('POST')
    expect(streamReq!.url).toBe('/v1/chat/completions')
    expect((streamReq!.parsed as any)?.model).toBe('mock-model')
    expect((streamReq!.parsed as any)?.stream).toBe(true)
    const sentMessages = (streamReq!.parsed as any)?.messages as Array<{ role: string; content: string }>
    expect(Array.isArray(sentMessages)).toBe(true)
    expect(
      sentMessages.some((m) => m?.role === 'user' && typeof m?.content === 'string' && m.content.includes(needle))
    ).toBe(true)

    // Wait for stream growth, then wheel genuinely away from the bottom.
    await page.waitForFunction(
      () => {
        const s = (window as any).store?.getState()
        const ids = Object.keys(s?.messageBlocks?.entities ?? {})
        return ids.some((id) => {
          const b = s.messageBlocks.entities[id]
          return b && typeof b.content === 'string' && b.content.length > 500
        })
      },
      undefined,
      { timeout: 60000 }
    )
    const box = await page.locator('#messages').boundingBox()
    expect(box, '#messages must have a box for the real wheel').not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(150)
    }
    const lastWheelTime = Date.now()
    const awayTop = await page.locator('#messages').evaluate((el) => el.scrollTop)
    expect(Math.abs(awayTop), 'real wheel must leave the genuine bottom').toBeGreaterThan(50)

    // Hold-entry settle BEFORE the baseline (see waitForQuietReadingAnchor):
    // genuine wheel-quiet + stable visible anchor + required row overlap, so
    // the baseline is the user's settled reading row, not mid-settling input.
    const quiet = await waitForQuietReadingAnchor(page, lastWheelTime)
    console.log(
      `[E2E] T3 hold entry settled: anchor=${quiet.id} offset=${quiet.offset.toFixed(1)} visibleH=${Math.round(quiet.visibleHeight)} quietMs=${Math.round(quiet.quietMs)}`
    )

    // ── Focused hold contract (single-route, slow marker with plenty remaining). ──
    // The away pause happens early (~500 chars of the finite ~4145-char mock),
    // so lenAtPause + HOLD_GROWTH stays arithmetically reachable. While the
    // user reads away, streaming MAIN_TEXT must grow by that reachable amount
    // and the first visible reading anchor (row-stable per viewport ADR, not
    // raw scrollTop under column-reverse growth) must not drift; generation
    // continues after the hold.
    const holdBlockId = await findStreamingBlockId(page)
    expect(holdBlockId, 'active streaming block must exist while reading away').not.toBeNull()
    const holdPre = await streamBlockState(page, holdBlockId!)
    expect(holdPre?.status, 'stream still active at hold entry (remaining budget for proof)').toBe('streaming')
    const lenAtPause = holdPre?.length ?? -1
    const preAnchor = await readAnchor(page)
    expect(preAnchor, 'anchor must resolve while reading away').not.toBeNull()
    console.log(`[E2E] T3 hold entry: lenAtPause=${lenAtPause} anchor=${preAnchor!.id} status=${holdPre?.status}`)
    await waitForBlockGrowth(page, holdBlockId!, lenAtPause + HOLD_GROWTH)
    const pausedTop = await page.locator('#messages').evaluate((el) => el.scrollTop)
    expect(Math.abs(pausedTop), 'continued growth while away never pulls to bottom').toBeGreaterThan(PAUSED_MIN)
    const pausedAnchor = await readAnchor(page)
    expect(pausedAnchor, 'anchor must still resolve through hold growth').not.toBeNull()
    expect(pausedAnchor!.id, 'hold keeps the reading row').toBe(preAnchor!.id)
    expect(Math.abs(pausedAnchor!.offset - preAnchor!.offset), 'held reading row stays put').toBeLessThanOrEqual(
      ANCHOR_TOL
    )
    const pausedState = await streamBlockState(page, holdBlockId!)
    expect(pausedState?.status, 'generation continues while reading away').toBe('streaming')
    console.log(
      `[E2E] T3 hold done: grew to ${pausedState?.length} anchor=${pausedAnchor!.id} ` +
        `dOffset=${Math.abs(pausedAnchor!.offset - preAnchor!.offset).toFixed(1)} top=${Math.round(pausedTop)}`
    )

    // The always-available button reveals with no settings gate and no hover.
    const backButton = page.getByTestId('conversation-back-to-bottom')
    await expect(backButton).toBeVisible({ timeout: 10000 })

    // Real click returns to the genuine bottom and resumes follow.
    await backButton.click({ timeout: 10000 })
    await page.waitForFunction(
      (tol: number) => {
        const el = document.getElementById('messages') as HTMLElement | null
        return !!el && Math.abs(el.scrollTop) <= tol
      },
      PRODUCT_BOTTOM_TOL,
      { timeout: 15000 }
    )
    const settledTop = await page.locator('#messages').evaluate((el) => el.scrollTop)
    expect(Math.abs(settledTop), 'explicit bottom navigation must reach the genuine bottom').toBeLessThanOrEqual(
      BOTTOM_TOL
    )

    // Follow resumes continuously, not one-shot: further stream growth while
    // resumed stays pinned to the bottom (single-route hold budget still has
    // thousands of chars remaining, so +HOLD_GROWTH stays reachable).
    const resumePre = await streamBlockState(page, holdBlockId!)
    if (resumePre?.status === 'streaming') {
      const resumeLen = resumePre.length
      await waitForBlockGrowth(page, holdBlockId!, resumeLen + HOLD_GROWTH)
      expect(
        await page.locator('#messages').evaluate((el) => el.scrollTop),
        'resumed follow stays pinned through growth'
      ).toBeLessThanOrEqual(BOTTOM_TOL)
      console.log(`[E2E] T3 resume pinned through +${HOLD_GROWTH} from ${resumeLen}`)
    }

    // Stable hidden after completion at the newest bottom.
    await page.waitForFunction(
      (id: string) => {
        const s = (window as any).store?.getState()
        const block = s?.messageBlocks?.entities?.[id]
        return !!block && block.status === 'success'
      },
      holdBlockId!,
      { timeout: 60000 }
    )
    await expect(page.getByTestId('conversation-back-to-bottom')).toHaveCount(0, { timeout: 10000 })
    console.log(
      `[E2E] T3 button revealed away=${Math.round(awayTop)} settled=${Math.round(settledTop)} holdDone complete hidden`
    )
  })

  test('T4 ordinary resident navigation: compact centered outline + real clicks jump', async ({
    electronApp,
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'T4 INTEGRATED UI: three normal real Enter sends with mocked replies (6 all-resident messages, no paging) → compact outline is content-fitting and vertically centered in the chat viewport → real mouse clicks on first/middle/last user items each prove before-outside/after-top-aligned with a genuine viewport move and post-settle stability; same-item re-click holds; keyboard focus reaches rows. Deterministic mocked provider.'
    })
    const page = mainWindow as Page
    // Production runtime provenance: the actual Electron app build root must
    // resolve to the same repo root as this spec file and the runner cwd —
    // file-anchored (independent) vs cwd-anchored so a wrong-worktree launch
    // cannot false-pass via duplicated paths. Disposable profile ownership
    // stays fixture-owned and unchanged.
    const runnerRoot = runnerRepoRoot()
    const specRoot = fileRepoRoot(test.info().file)
    expect(specRoot).toBe(runnerRoot)
    const actualAppPath = await electronApp.evaluate(({ app }: any) => app.getAppPath())
    expect(typeof actualAppPath).toBe('string')
    const realAppPath = fs.realpathSync(actualAppPath as string)
    expect(realAppPath).toBe(runnerRoot)
    expect(fs.existsSync(path.join(realAppPath, 'package.json'))).toBe(true)
    expect(
      fs.existsSync(path.join(realAppPath, 'src/renderer/src/pages/home/Messages/ConversationNavigation.tsx'))
    ).toBe(true)
    expect(fs.existsSync(path.join(realAppPath, 'src/renderer/src/pages/home/Messages/MessageOutline.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(realAppPath, 'out', 'main'))).toBe(true)
    console.log(`[E2E] T4 provenance actualElectronAppPath=${realAppPath} repoRoot=${runnerRoot}`)
    const liveAssistantId = await prepareDisplayCountAndAssistant(page)
    const topicId = `convnav-t4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Empty ordinary topic (real IPC/SQLite ownership, no seeded windows).
    const created = await page.evaluate(
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
          return (window as any).api.chatDb.ensureTopic({ topicId, assistantId, name })
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      { topicId, assistantId: liveAssistantId, name: `Nav Test ${topicId}` }
    )
    expect(created?.ok).toBe(true)
    const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
    await topicItem.waitFor({ state: 'attached', timeout: 15000 })
    await topicItem.scrollIntoViewIfNeeded()
    await topicItem.click()
    await page.waitForFunction(
      (id: string) => (window as any).store.getState().messages?.loadingByTopic?.[id] !== true,
      topicId,
      { timeout: 30000 }
    )
    await page.locator('#messages').waitFor({ state: 'attached', timeout: 15000 })
    await enableConversationNavigation(page)

    // Three normal real sends; long user bodies guarantee a scrollable
    // viewport so every navigation is a genuine move (no paging: 6 « 20).
    const sentUserIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const expected = (i + 1) * 2
      await uiSendMessage(page, `T4 resident journey ${i} ${'x'.repeat(1500)}`)
      await page.waitForFunction(
        ({ id, expected }: { id: string; expected: number }) => {
          const s = (window as any).store?.getState()
          const ids = s?.messages?.messageIdsByTopic?.[id] ?? []
          if (!Array.isArray(ids) || ids.length !== expected) return false
          for (const block of Object.values(s?.messageBlocks?.entities ?? {}) as any[]) {
            if (block && ids.includes(block.messageId) && block.status === 'streaming') return false
          }
          return true
        },
        { id: topicId, expected },
        { timeout: 90000 }
      )
      const userId = await page.evaluate((id: string) => {
        const s = (window as any).store?.getState()
        const ids = (s?.messages?.messageIdsByTopic?.[id] ?? []) as string[]
        const entities = s?.messages?.entities ?? {}
        for (let k = ids.length - 1; k >= 0; k--) {
          if (entities[ids[k]]?.role === 'user') return ids[k] as string
        }
        return null
      }, topicId)
      expect(userId).toBeTruthy()
      sentUserIds.push(userId as string)
    }

    // All six messages resident in projection and DOM; current latest bottom.
    const resident = await page.evaluate((id: string) => {
      const s = (window as any).store?.getState()
      return {
        ids: [...((s?.messages?.messageIdsByTopic?.[id] ?? []) as string[])],
        dom: document.querySelectorAll('#messages [data-message-id]').length
      }
    }, topicId)
    expect(resident.ids.length).toBe(6)
    expect(resident.dom).toBe(6)
    expect(Math.abs(await readScrollTop(page))).toBeLessThanOrEqual(1)

    // Outline holds exactly the three user rows in chronological order.
    const nav = page.getByTestId('conversation-navigation')
    await expect(nav).toBeVisible({ timeout: 20000 })
    await expect.poll(async () => (await navItemIds(page)).length, { timeout: 20000 }).toBe(3)
    expect(await navItemIds(page)).toEqual(sentUserIds.map((id) => `conversation-nav-item-${id}`))

    // Restored original compact geometry (no hover): three 24px rows with the
    // original gap/padding (3*24 + gaps + padding, no blank filler, no large
    // lower void), collapsed to the narrow dot strip, vertically centered via
    // the original midpoint count formula (top max(calc(50% - count*24/2+10),20px)).
    const collapsed = await page.evaluate(() => {
      const landmark = document.querySelector('[data-testid="conversation-navigation"]')
      const list = landmark?.firstElementChild as HTMLElement | null
      const container = document.getElementById('messages')
      if (!list || !landmark || !container) return null
      const r = (list as HTMLElement).getBoundingClientRect()
      const c = container.getBoundingClientRect()
      const rows = Array.from(list.querySelectorAll('[data-testid^="conversation-nav-item-"]')) as HTMLElement[]
      return {
        w: r.width,
        h: r.height,
        rowCount: rows.length,
        rowHeights: rows.map((el) => getComputedStyle(el).height),
        railCenterY: r.top + r.height / 2,
        msgCenterY: c.top + c.height / 2,
        viewportHeight: window.innerHeight
      }
    })
    expect(collapsed).not.toBeNull()
    expect(collapsed!.rowCount).toBe(3)
    expect(collapsed!.rowHeights.every((h) => h === '24px')).toBe(true)
    expect(collapsed!.w, 'collapsed original strip stays discreet').toBeLessThan(80)
    expect(collapsed!.h, 'three short original rows fit with no large void').toBeLessThan(200)
    expect(collapsed!.h).toBeLessThanOrEqual(collapsed!.viewportHeight * 0.6 + 1)
    expect(
      Math.abs(collapsed!.railCenterY - collapsed!.msgCenterY),
      'original rail vertically centered within the chat viewport'
    ).toBeLessThanOrEqual(60)

    // Original hover: the collapsed strip intrinsically expands to the text
    // (text display block + opacity 1, width grows vs collapsed, never a fixed
    // panel width). Keyboard focus reaches the original rows (role=button,
    // tabIndex 0) with no CSS focus alteration.
    const collapsedW = collapsed!.w
    await hoverOriginalOutline(page)
    const expandedW = await page.evaluate(() => {
      const landmark = document.querySelector('[data-testid="conversation-navigation"]')
      const body = landmark?.firstElementChild as HTMLElement | null
      return body ? body.getBoundingClientRect().width : null
    })
    expect(expandedW).not.toBeNull()
    expect(expandedW!, 'original hover intrinsically expands past the collapsed strip').toBeGreaterThan(collapsedW)
    const firstItem = page.getByTestId(`conversation-nav-item-${sentUserIds[0]}`)
    await firstItem.focus()
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.getAttribute?.('data-testid')), {
        timeout: 10000
      })
      .toBe(`conversation-nav-item-${sentUserIds[0]}`)

    // Explicit graph absence after hover + normal 3-user chat: the deleted
    // graph feature stays absent (ReactFlow canvas/controls/minimap/node
    // counts zero, old history button gone, no graph namespace), scoped to the
    // removed feature's own selectors — never a global antd-drawer sweep.
    // The visible 3-row list retains its physical rect before/after.
    const listRectBefore = await page.evaluate(() => {
      const landmark = document.querySelector('[data-testid="conversation-navigation"]')
      const body = landmark?.firstElementChild as HTMLElement | null
      if (!body) return null
      const r = body.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    expect(listRectBefore).not.toBeNull()
    await hoverOriginalOutline(page)
    const graphAbsence = await page.evaluate(() => {
      const q = (sel: string) => document.querySelectorAll(sel).length
      return {
        reactFlow: q('.react-flow'),
        reactFlowCanvas: q('.react-flow__canvas, canvas.react-flow__canvas'),
        reactFlowControls: q('.react-flow__controls'),
        reactFlowMinimap: q('.react-flow__minimap'),
        reactFlowNodes: q('.react-flow__node'),
        reactFlowContainer: q('.react-flow-container'),
        xyflow: q('.xyflow, [class*="xyflow"]'),
        historyButton: q('[aria-label="Chat History"]'),
        reactFlowNamespace: typeof (window as any).ReactFlow === 'undefined' ? 0 : 1,
        listRows: q('[data-testid^="conversation-nav-item-"]')
      }
    })
    expect(graphAbsence.reactFlow).toBe(0)
    expect(graphAbsence.reactFlowCanvas).toBe(0)
    expect(graphAbsence.reactFlowControls).toBe(0)
    expect(graphAbsence.reactFlowMinimap).toBe(0)
    expect(graphAbsence.reactFlowNodes).toBe(0)
    expect(graphAbsence.reactFlowContainer).toBe(0)
    expect(graphAbsence.xyflow).toBe(0)
    expect(graphAbsence.historyButton).toBe(0)
    expect(graphAbsence.reactFlowNamespace).toBe(0)
    expect(graphAbsence.listRows).toBe(3)
    const listRectAfter = await page.evaluate(() => {
      const landmark = document.querySelector('[data-testid="conversation-navigation"]')
      const body = landmark?.firstElementChild as HTMLElement | null
      if (!body) return null
      const r = body.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    expect(listRectAfter).not.toBeNull()
    expect(Math.abs(listRectAfter!.width - listRectBefore!.width)).toBeLessThanOrEqual(120)
    expect(Math.abs(listRectAfter!.height - listRectBefore!.height)).toBeLessThanOrEqual(8)
    console.log(
      `[E2E] T4 graph absence zero (flow/controls/minimap/nodes/container/xyflow/historyBtn/ns) listRows=${graphAbsence.listRows}`
    )

    // Real mouse clicks: first -> last -> middle. Each starts from a proven
    // viewport position and ends intersecting #messages with a genuine move
    // (scroll delta > 100 where geometrically possible) then holds stable
    // across observer triggers (2s/5s samples via expectStableScrollTop).
    // Historical/mid targets top-align when geometrically possible; the
    // near-bottom last target uses finite clamped geometry (intersection +
    // stable, no mandatory top 0, no blank filler). Geometry — never
    // toBeVisible — is the jump oracle.
    const clickOrder = [sentUserIds[0], sentUserIds[2], sentUserIds[1]]
    for (const targetId of clickOrder) {
      const before = await targetGeometry(page, targetId)
      expect(before, 'target resolves before click').not.toBeNull()
      const topBefore = before!.scrollTop
      const wasOutside = isOutsideViewport(before!)
      await hoverOriginalOutline(page)
      await page.getByTestId(`conversation-nav-item-${targetId}`).click({ timeout: 10000 })
      const isLast = targetId === sentUserIds[2]
      const after = isLast
        ? await waitForViewportIntersection(page, targetId)
        : await waitForTopAlignment(page, targetId)
      expect(intersectsViewport(after), `target ${targetId} ends inside the viewport`).toBe(true)
      if (wasOutside) {
        expect(
          Math.abs(after.scrollTop - topBefore),
          `clicking ${targetId} genuinely moves the viewport`
        ).toBeGreaterThan(100)
      }
      await expectStableScrollTop(page)
    }

    // Same-item re-click holds the viewport (no drift, no pull-back).
    const reTop = await readScrollTop(page)
    await hoverOriginalOutline(page)
    await page.getByTestId(`conversation-nav-item-${sentUserIds[1]}`).click({ timeout: 10000 })
    const reGeo = await waitForViewportIntersection(page, sentUserIds[1])
    expect(intersectsViewport(reGeo)).toBe(true)
    expect(Math.abs(reGeo.scrollTop - reTop)).toBeLessThanOrEqual(2)
    await expectStableScrollTop(page)
    console.log(`[E2E] T4 resident 3-turn nav clicks jumped first/last/middle + stable re-click`)
  })
})
