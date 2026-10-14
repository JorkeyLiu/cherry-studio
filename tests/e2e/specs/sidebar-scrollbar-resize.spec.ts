/**
 * Sidebar scrollbar vs resize handle — bounded hit-target regression.
 *
 * Covers the user report: the chat scrollbar cannot be grabbed because the
 * sidebar resize handle steals clicks. The handle's active pointer hit
 * region must stay inside its own allocated 6px box; no overflowing
 * pseudo-element may extend over the neighboring 6px chat scrollbar.
 *
 * Deferred runtime: run only after all writers complete a fresh build.
 *   pnpm build && pnpm test:e2e tests/e2e/specs/sidebar-scrollbar-resize.spec.ts
 *
 * Evidence (when run):
 *   - Test 1 proves a physical mouse drag on the chat scrollbar/track leaves
 *     `--topic-list-width` exactly unchanged AND really scrolls vertically
 *     (`#messages` scrollTop delta; width unchanged alone is insufficient).
 *     Hit-test also proves the point resolves inside #messages, never to
 *     the handle.
 *   - Test 2 proves a physical mouse drag on the handle itself still resizes
 *     the topic list (`--topic-list-width` delta + Redux persistence).
 *
 * Seams (existing only): shared electron fixture, mock provider seed,
 * window.store (seed/introspection), window.api.chatDb.ensureTopic/
 * pasteMessagesToTopic (Main-authority seed), #messages rows, topic-item
 * click for cold activation. UI drags always go through the real pointer.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron.fixture'
import { waitForAppReady, waitForChatReady } from '../utils/wait-helpers'

const WIDTH_TOL = 3
const HANDLE_DRAG_PX = 80
const SCROLL_DELTA_MIN = 5

/** Runtime error capture: fails on Download ReferenceError or undefined icon render. */
function installRuntimeErrorCapture(page: Page, sink: string[]): void {
  page.on('pageerror', (error) => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    sink.push(`pageerror: ${text}`)
  })
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    sink.push(`console.error: ${msg.text()}`)
  })
}

function assertNoRuntimeErrors(sink: string[]): void {
  const forbidden = sink.filter((line) => /Download|ReferenceError|undefined|is not defined/i.test(line))
  expect(
    forbidden,
    `runtime errors must not include Download/ReferenceError/undefined icon: ${JSON.stringify(sink)}`
  ).toEqual([])
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

type SeedEntry = { message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }

function buildOverflowEntries(topicId: string, assistantId: string): SeedEntry[] {
  const entries: SeedEntry[] = []
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
  // 25 rounds of filler + one tall tail guarantees #messages overflow.
  for (let round = 0; round < 25; round++) {
    const userId = push(round * 2, 'user', `scrollbar-resize-user-${round} ${'filler words '.repeat(40)}`)
    push(round * 2 + 1, 'assistant', `scrollbar-resize-assistant-${round} ${'filler words '.repeat(40)}`, {
      askId: userId,
      model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
      modelId: 'mock-model'
    })
  }
  const tailParagraphs = Array.from(
    { length: 60 },
    (_, i) => `scrollbar-resize tail paragraph ${pad(i, 3)} filler words`
  )
  const tailAsk = push(50, 'user', 'scrollbar-resize tail ask?')
  push(51, 'assistant', `scrollbar-resize tail reply\n\n${tailParagraphs.join('\n\n')}`, {
    askId: tailAsk,
    model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
    modelId: 'mock-model'
  })
  return entries
}

async function seedOverflowTopic(page: Page, topicId: string): Promise<void> {
  const assistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(assistantId, 'live assistant id must exist').toBeTruthy()
  const entries = buildOverflowEntries(topicId, assistantId as string)
  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
        ;(window as any).store.dispatch({
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
    { topicId, assistantId: assistantId as string, name: `ScrollbarResize ${topicId}` }
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
        const chatDb = (window as any).api?.chatDb
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
    { topicId, assistantId: assistantId as string, name: `ScrollbarResize ${topicId}`, entries }
  )
  expect(persist.ok, `Main authority seed failed: ${(persist as any).err}`).toBe(true)

  // Cold activation through the real topic item click.
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= 10 && s.messages?.loadingByTopic?.[topicId] !== true
    },
    { topicId },
    { timeout: 30000 }
  )
  await page.waitForFunction(() => document.querySelectorAll('#messages [data-message-id]').length >= 10, null, {
    timeout: 30000
  })
  // Realistic overflow required: scrollHeight must exceed clientHeight.
  const overflow = await page.evaluate(() => {
    const el = document.getElementById('messages') as HTMLElement | null
    if (!el) throw new Error('#messages not found')
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
  expect(overflow.scrollHeight, 'seeded chat must overflow for scrollbar regression').toBeGreaterThan(
    overflow.clientHeight
  )
}

async function readTopicListWidth(page: Page): Promise<number> {
  const raw = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--topic-list-width').trim()
  )
  return parseInt(raw) || 275
}

/** Bounding box of the topic-list (right-side) resize handle. */
async function getTopicListHandleBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const messages = document.getElementById('messages')
    if (!messages) throw new Error('#messages not found')
    const mRect = messages.getBoundingClientRect()
    const cands = Array.from(document.querySelectorAll('div')).filter((el) => {
      const cs = getComputedStyle(el)
      if (cs.cursor !== 'col-resize') return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.width <= 8 && r.height > 100
    })
    if (cands.length === 0) throw new Error('no col-resize handle found')
    // The topic-list handle sits between chat and the right topic list:
    // nearest handle to the chat right edge.
    let best: Element | null = null
    let bestDist = Infinity
    for (const el of cands) {
      const r = el.getBoundingClientRect()
      const dist = Math.min(Math.abs(r.left - mRect.right), Math.abs(r.right - mRect.right))
      if (dist < bestDist) {
        bestDist = dist
        best = el
      }
    }
    const r = (best as HTMLElement).getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
}

/** Point on the chat scrollbar: inside #messages, at its right edge. */
async function getChatScrollbarPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const el = document.getElementById('messages') as HTMLElement | null
    if (!el) throw new Error('#messages not found')
    const r = el.getBoundingClientRect()
    return { x: r.right - 3, y: r.top + r.height / 2 }
  })
}

test.describe('sidebar scrollbar vs resize handle hit target', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
    await waitForChatReady(mainWindow)
  })

  test('physical drag on chat scrollbar/track does not resize topic list', async ({ mainWindow }) => {
    const runtimeErrors: string[] = []
    installRuntimeErrorCapture(mainWindow, runtimeErrors)
    const topicId = `scrollbar-resize-${Date.now()}`
    await seedOverflowTopic(mainWindow, topicId)

    const before = await readTopicListWidth(mainWindow)
    const pt = await getChatScrollbarPoint(mainWindow)

    // Hit-test: the scrollbar point must resolve inside #messages, never to
    // the resize handle (proves no hit steal at the exact grab point).
    const hit = await mainWindow.evaluate(({ x, y }: { x: number; y: number }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      if (!el) return { kind: 'none', insideMessages: false }
      const insideMessages = !!el.closest('#messages')
      let node: HTMLElement | null = el
      let isHandle = false
      while (node) {
        const cs = getComputedStyle(node)
        const r = node.getBoundingClientRect()
        if (cs.cursor === 'col-resize' && r.width > 0 && r.width <= 8) {
          isHandle = true
          break
        }
        node = node.parentElement
      }
      return { kind: el.tagName, insideMessages, isHandle }
    }, pt)
    expect(hit.insideMessages, 'scrollbar grab point must be inside #messages').toBe(true)
    expect(hit.isHandle, 'scrollbar grab point must not hit the resize handle').toBe(false)

    // Normalize to the top so a downward drag has room to scroll; setup only,
    // the scroll itself must come from the real mouse drag below.
    await mainWindow.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      if (el) el.scrollTop = 0
    })
    const scrollBefore = await mainWindow.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      if (!el) throw new Error('#messages not found')
      return el.scrollTop
    })
    expect(scrollBefore, 'chat must start at the top for the scroll proof').toBe(0)

    // Physical scrollbar drag: press on the scrollbar and drag vertically.
    await mainWindow.mouse.move(pt.x, pt.y)
    await mainWindow.mouse.down()
    await mainWindow.mouse.move(pt.x, pt.y + 100, { steps: 10 })
    await mainWindow.mouse.up()

    // Real vertical scroll change: width unchanged alone is insufficient.
    const scrollAfter = await mainWindow.evaluate(() => {
      const el = document.getElementById('messages') as HTMLElement | null
      if (!el) throw new Error('#messages not found')
      return el.scrollTop
    })
    const scrollDelta = Math.abs(scrollAfter - scrollBefore)
    expect(
      scrollDelta,
      `scrollbar drag must really scroll vertically (before=${scrollBefore} after=${scrollAfter} delta=${scrollDelta})`
    ).toBeGreaterThan(SCROLL_DELTA_MIN)

    const after = await readTopicListWidth(mainWindow)
    expect(after, 'scrollbar drag must not resize the topic list').toBe(before)
    assertNoRuntimeErrors(runtimeErrors)
  })

  test('physical drag on the handle still resizes the topic list', async ({ mainWindow }) => {
    const runtimeErrors: string[] = []
    installRuntimeErrorCapture(mainWindow, runtimeErrors)
    const topicId = `handle-resize-${Date.now()}`
    await seedOverflowTopic(mainWindow, topicId)

    const before = await readTopicListWidth(mainWindow)
    const box = await getTopicListHandleBox(mainWindow)
    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2

    // Right-side handle: dragging left widens the topic list.
    await mainWindow.mouse.move(startX, startY)
    await mainWindow.mouse.down()
    await mainWindow.mouse.move(startX - HANDLE_DRAG_PX, startY, { steps: 10 })
    await mainWindow.mouse.up()

    const after = await readTopicListWidth(mainWindow)
    expect(after, `handle drag left by ${HANDLE_DRAG_PX}px must widen the topic list from ${before}px`).toBeGreaterThan(
      before + HANDLE_DRAG_PX - WIDTH_TOL
    )

    // Persistence: onResizeEnd dispatches settings/setTopicListWidth.
    const stored = await mainWindow.evaluate(() => (window as any).store.getState().settings?.topicListWidth)
    expect(stored, 'resized width must persist to settings').toBe(after)
    assertNoRuntimeErrors(runtimeErrors)
  })
})
