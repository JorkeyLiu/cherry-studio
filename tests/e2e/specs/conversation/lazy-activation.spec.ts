import type { Page } from '@playwright/test'

import { expect, test } from '../../fixtures/electron.fixture'

/**
 * S3.5 Lazy Activation — ContentSearch mount lifecycle + stable host.
 *
 * Verifies:
 *  - ContentSearch has zero mounted instance before invocation
 *  - Mounted/visible/focused after Cmd/Ctrl+F (search_message_in_chat)
 *  - Removed after Escape
 *  - Inputbar + #messages remain visible before/during/after
 *
 * Plus (same file, own seeded topic, independently runnable via `-g`):
 *  - Search-driven viewport coherence: a Cmd/Ctrl+F hit inside a chat row is
 *    positioned by the chat navigation authority (the row is adopted as the
 *    route's reading anchor), so the matched text stays where it was placed
 *    through settle — from bottom and from a scrolled reading position — for
 *    both hits of ONE long message, and closing the search neither restores the
 *    previous position nor breaks ordinary user scrolling.
 *
 * Uses shared electron.fixture (disposable profile, mock provider).
 */

test.describe('S3.5 Lazy Activation — ContentSearch + stable host', () => {
  test.setTimeout(120000)

  test('ContentSearch lazy mount lifecycle and Inputbar/viewport remain immediate', async ({ mainWindow }) => {
    const page = mainWindow

    const contentSearch = page.locator('[data-testid="content-search"]')
    const contentSearchHost = page.locator('[data-testid="content-search-host"]')
    const inputbar = page.locator('.inputbar textarea, textarea[placeholder]').first()
    const messages = page.locator('#messages')

    // — Before invocation: zero mounted instance, stable host immediate —
    await test.step('before invocation: zero ContentSearch, Inputbar+viewport visible', async () => {
      await expect(contentSearch).toHaveCount(0)
      await expect(contentSearchHost).toHaveCount(0)
      await expect(inputbar).toBeVisible({ timeout: 30000 })
      await expect(messages).toBeVisible({ timeout: 15000 })
    })

    // — Invoke via shortcut: Cmd/Ctrl+F —
    await test.step('invoke ContentSearch via Cmd/Ctrl+F', async () => {
      // Try both Control+F and Meta+F to cover platform differences; one will succeed.
      // Playwright maps ControlOrMeta via explicit keys.
      const platform = await page.evaluate(() => navigator.platform)
      const isMac = platform.toLowerCase().includes('mac')
      if (isMac) {
        await page.keyboard.press('Meta+F')
      } else {
        await page.keyboard.press('Control+F')
      }
      await expect(contentSearch).toBeVisible({ timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(1)
      // Input should be focused inside the search bar
      const searchInput = contentSearch.locator('input').first()
      await expect(searchInput).toBeVisible({ timeout: 5000 })
      await expect(searchInput).toBeFocused({ timeout: 5000 })
      // Stable host still immediate during search
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
    })

    // — Close via Escape: should unmount (zero instance) —
    await test.step('Escape closes ContentSearch and unmounts (zero instance)', async () => {
      await page.keyboard.press('Escape')
      await expect(contentSearch).toHaveCount(0, { timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(0, { timeout: 10000 })
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
    })

    // — Re-invoke with selected text path (selection + shortcut) —
    // Selecting text is optional for coverage; we verify second mount still works.
    await test.step('re-invoke and verify initial text + navigation still functional', async () => {
      // Seed some visible text to select: create a temporary selection via evaluate
      await page.evaluate(() => {
        const range = document.createRange()
        const sel = window.getSelection()
        const msg = document.querySelector('#messages .message-content-container') as HTMLElement | null
        if (msg && msg.firstChild) {
          range.selectNodeContents(msg)
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      })
      const platform2 = await page.evaluate(() => navigator.platform)
      const isMac2 = platform2.toLowerCase().includes('mac')
      if (isMac2) {
        await page.keyboard.press('Meta+F')
      } else {
        await page.keyboard.press('Control+F')
      }
      await expect(contentSearch).toBeVisible({ timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(1)
      const searchInput2 = contentSearch.locator('input').first()
      await expect(searchInput2).toBeVisible()
      // Input value may contain selected text if selection existed; focus is required in any case
      await expect(searchInput2).toBeFocused({ timeout: 5000 })
      // Clean up via Escape again
      await page.keyboard.press('Escape')
      await expect(contentSearch).toHaveCount(0, { timeout: 10000 })
      await expect(contentSearchHost).toHaveCount(0, { timeout: 10000 })
      // Stable host still visible after second cycle
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
    })

    // — Verify Inputbar/viewport not deferred at any stage —
    await test.step('Inputbar and viewport remained immediate throughout lifecycle', async () => {
      await expect(inputbar).toBeVisible()
      await expect(messages).toBeVisible()
      await expect(contentSearch).toHaveCount(0)
      await expect(contentSearchHost).toHaveCount(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Search -> viewport integration
// ---------------------------------------------------------------------------

const SEARCH_QUERY = 'searchjumpmarker'
const FIRST_HIT_NEEDLE = `${SEARCH_QUERY} first`
const SECOND_HIT_NEEDLE = `${SEARCH_QUERY} second`
const LONG_ROW_ROWS = 60
// Paragraph indexes inside the single long assistant row that carry the hits.
const FIRST_HIT_PARAGRAPH = 3
const SECOND_HIT_PARAGRAPH = 45
const SETTLE_TOL_PX = 4
const VISIBLE_TOL_PX = 3

const pad = (n: number, w: number): string => String(n).padStart(w, '0')

/**
 * Seed: 2 short rounds, one long assistant row carrying the SAME keyword at two
 * paragraphs (taller than the viewport, so each hit must be positioned on its
 * own text), then 6 more short rounds so the long row is mid-topic rather than
 * at the route bottom.
 */
function buildSearchViewportEntries(topicId: string, assistantId: string) {
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
  const model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' }
  let index = 0
  const fillerRound = (tag: string) => {
    const userId = push(index++, 'user', `${tag}-user ${'filler words '.repeat(20)}`)
    push(index++, 'assistant', `${tag}-assistant ${'filler words '.repeat(20)}`, {
      askId: userId,
      model,
      modelId: 'mock-model'
    })
  }
  fillerRound('sv-pre-0')
  const longAskId = push(index++, 'user', `sv-long-ask ${'filler words '.repeat(10)}`)
  const paragraphs = Array.from({ length: LONG_ROW_ROWS }, (_, i) => {
    const marker =
      i === FIRST_HIT_PARAGRAPH
        ? FIRST_HIT_NEEDLE
        : i === SECOND_HIT_PARAGRAPH
          ? SECOND_HIT_NEEDLE
          : `paragraph ${pad(i, 3)}`
    return `${marker} filler words filler words filler words filler words filler words`
  })
  const longRowId = push(index++, 'assistant', `sv-long-answer-marker\n\n${paragraphs.join('\n\n')}`, {
    askId: longAskId,
    model,
    modelId: 'mock-model'
  })
  for (let round = 0; round < 6; round++) fillerRound(`sv-post-${round}`)
  return { entries, longRowId, totalRows: index }
}

const pressSearchShortcut = async (page: Page) => {
  const platform = await page.evaluate(() => navigator.platform)
  const isMac = platform.toLowerCase().includes('mac')
  await page.keyboard.press(isMac ? 'Meta+F' : 'Control+F')
}

interface MatchReading {
  text: string
  rowId: string | null
  rowTop: number | null
  /** Hit rect in viewport coordinates. */
  top: number
  bottom: number
  /** Unobscured reading band the open search panel leaves visible. */
  bandTop: number
  bandBottom: number
  /** Where the hit's centre sits in that band (0 = band top, 1 = band bottom). */
  bandPosition: number
  /** Readable with the search panel open (inside the band, not under it). */
  visible: boolean
  /** Behind the floating search panel, i.e. on screen but not readable. */
  covered: boolean
  scrollTop: number
}

/**
 * Reads one hit's REAL text geometry plus the current unobscured band.
 *
 * Neither the highlight nor the row is the only oracle: the row is taller than
 * the viewport, so only the matched TEXT rectangle says whether the hit is
 * readable and where in the band it landed; whether the match is actually
 * painted is read from the highlight registry (see `expectHighlightPersistence`)
 * because text geometry alone cannot see a highlight that was dropped. The band
 * is read from the live container and search-panel rectangles, never from a
 * hard-coded header height.
 */
const readHit = (page: Page, needle: string): Promise<MatchReading | null> =>
  page.evaluate(
    ({ needle, tol }: { needle: string; tol: number }) => {
      const container = document.getElementById('messages')
      if (!container) return null
      const box = container.getBoundingClientRect()
      const panel = document.querySelector('[data-testid="content-search"]')
      const panelRect = panel ? panel.getBoundingClientRect() : null
      // The panel covers the container's top strip only while it actually
      // overlaps it; anything else leaves the whole container readable.
      const bandTop = panelRect && panelRect.bottom > box.top ? Math.min(box.bottom, panelRect.bottom) : box.top
      const bandBottom = box.bottom
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        const value = node.nodeValue ?? ''
        const at = value.indexOf(needle)
        if (at === -1) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
        if (!rect) continue
        const element = node.parentElement
        const row = element?.closest('[data-message-id]') as HTMLElement | null
        const centre = rect.top + rect.height / 2
        return {
          text: needle,
          rowId: row?.getAttribute('data-message-id') ?? null,
          rowTop: row ? row.getBoundingClientRect().top - box.top : null,
          top: rect.top,
          bottom: rect.bottom,
          bandTop,
          bandBottom,
          bandPosition: (centre - bandTop) / Math.max(1, bandBottom - bandTop),
          visible: rect.top >= bandTop - tol && rect.bottom <= bandBottom + tol,
          covered: panelRect ? rect.bottom > panelRect.top && rect.top < panelRect.bottom : false,
          scrollTop: container.scrollTop
        }
      }
      return null
    },
    { needle, tol: VISIBLE_TOL_PX }
  )

/** Samples one hit until its geometry and the scroll position stop moving. */
const settledHit = async (page: Page, needle: string, quietSamples = 3): Promise<MatchReading> => {
  let previous: MatchReading | null = null
  let quiet = 0
  const start = Date.now()
  let current: MatchReading | null = null
  while (Date.now() - start < 15000) {
    current = await readHit(page, needle)
    if (!current) throw new Error(`hit text "${needle}" disappeared from the rendered rows`)
    if (
      previous &&
      previous.rowId === current.rowId &&
      Math.abs(previous.top - current.top) <= SETTLE_TOL_PX &&
      Math.abs(previous.scrollTop - current.scrollTop) <= SETTLE_TOL_PX
    ) {
      quiet += 1
      if (quiet >= quietSamples) return current
    } else {
      quiet = 0
    }
    previous = current
    await page.waitForTimeout(160)
  }
  throw new Error(`search viewport failed to settle: ${JSON.stringify(current)}`)
}

const readScrollTop = (page: Page): Promise<number> =>
  page.evaluate(() => (document.getElementById('messages') as HTMLElement).scrollTop)

const prefersReducedMotion = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)

interface MotionSample {
  /** Milliseconds since the capture started. */
  t: number
  /** Container scrollTop at that frame. */
  top: number
}

/**
 * Starts a per-frame scroll-position recorder in the page.
 *
 * The oracle for "the jump is animated" is the intermediate PAINTED positions,
 * not the settled coordinate: a settled-only assertion cannot tell a smooth
 * journey from an instant teleport (which is exactly the regression this covers).
 */
const startScrollMotionCapture = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const store = window as unknown as { __searchMotionSamples?: Array<{ t: number; top: number }> }
    const container = document.getElementById('messages') as HTMLElement | null
    store.__searchMotionSamples = []
    if (!container) return
    const started = performance.now()
    const step = () => {
      store.__searchMotionSamples?.push({ t: performance.now() - started, top: container.scrollTop })
      if (performance.now() - started < 8000) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })

const readScrollMotionCapture = (page: Page): Promise<MotionSample[]> =>
  page.evaluate(
    () =>
      (window as unknown as { __searchMotionSamples?: Array<{ t: number; top: number }> }).__searchMotionSamples ?? []
  )

/**
 * Intermediate-frame evidence for one journey between `fromTop` and `toTop`:
 * positions that are neither the start nor the destination. `minFrames` guards
 * against a teleport that happens to be caught by a single sample.
 */
const intermediateFrames = (samples: MotionSample[], fromTop: number, toTop: number, tol = 8): MotionSample[] =>
  samples.filter((sample) => Math.abs(sample.top - fromTop) > tol && Math.abs(sample.top - toTop) > tol)

// ---------------------------------------------------------------------------
// Highlight persistence oracle
// ---------------------------------------------------------------------------

/**
 * The user-visible fact under test is "the located match stays highlighted while
 * the user moves through hits". `CSS.highlights` is the paint mechanism Cmd/Ctrl+F
 * search actually uses, so the registry — not the text DOM — is the oracle: a
 * registered, connected range is a painted match, while a registry that empties
 * (or a wholesale `clear()`) mid-navigation is exactly the flash-then-disappear
 * the user reports. Text geometry alone cannot see that.
 */
interface HighlightSample {
  t: number
  searchMatches: number
  currentMatch: number
  /** Every registered current-match range still has connected endpoints. */
  currentConnected: boolean
}

interface HighlightOp {
  t: number
  op: string
  name: string | null
  /** Caller frames for a wholesale clear (diagnostic only). */
  stack?: string[]
}

interface HighlightMutation {
  t: number
  type: string
  attributeName: string | null
  target: string
}

interface HighlightState {
  searchMatches: number
  currentMatch: number
  /** Text actually covered by the registered current-match range. */
  currentText: string | null
  connected: boolean
}

/**
 * Installs a per-frame sampler of the live highlight registry plus a log of every
 * registry operation, so a navigation can be judged on what was registered over
 * time rather than on one final snapshot.
 */
const startHighlightCapture = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const store = window as unknown as {
      __searchHighlights?: Array<{ t: number; searchMatches: number; currentMatch: number; currentConnected: boolean }>
      __searchHighlightOps?: Array<{ t: number; op: string; name: string | null; stack?: string[] }>
      __searchMutations?: Array<{ t: number; type: string; attributeName: string | null; target: string }>
      __searchHighlightPatched?: boolean
      __searchCaptureLoop?: boolean
      __searchMutationStop?: () => void
    }
    store.__searchHighlights = []
    store.__searchHighlightOps = []
    store.__searchMutations = []
    const started = performance.now()
    const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
    if (registry && !store.__searchHighlightPatched) {
      const log = (op: string, name: string | null) => {
        const stack = op === 'clear' ? new Error('registry-clear').stack?.split('\n').slice(1, 4) : undefined
        store.__searchHighlightOps?.push({ t: performance.now() - started, op, name, stack })
      }
      const patch = (key: 'set' | 'delete' | 'clear') => {
        const original = registry[key] as (...args: unknown[]) => unknown
        registry[key] = function (this: Map<string, Set<Range>>, ...args: unknown[]) {
          log(key, typeof args[0] === 'string' ? args[0] : null)
          return original.apply(this, args)
        } as never
      }
      try {
        patch('set')
        patch('delete')
        patch('clear')
        store.__searchHighlightPatched = true
      } catch {
        // Sampling alone still proves persistence/disappearance.
      }
    }
    // Diagnostic only: which DOM mutations the search observer sees during a jump.
    // Exactly one observer: a re-started capture replaces the previous one.
    store.__searchMutationStop?.()
    const chatMain = document.getElementById('chat-main')
    if (chatMain) {
      const mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target
          const element = target instanceof Element ? target : target.parentElement
          const region = element?.closest('[data-message-id]')
            ? 'row'
            : element?.closest('#messages')
              ? 'viewport'
              : 'chrome'
          const label = element
            ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${
                element.className && typeof element.className === 'string'
                  ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
                  : ''
              }@${region}`
            : target.nodeName
          store.__searchMutations?.push({
            t: Math.round(performance.now() - started),
            type: record.type,
            attributeName: record.attributeName,
            target: label
          })
        }
      })
      mutationObserver.observe(chatMain, { childList: true, subtree: true, characterData: true, attributes: true })
      store.__searchMutationStop = () => mutationObserver.disconnect()
    }
    const sample = () => {
      const current = registry?.get('current-match')
      const all = registry?.get('search-matches')
      let connected = true
      if (current) {
        for (const range of current) {
          if (!range.startContainer.isConnected || !range.endContainer.isConnected) connected = false
        }
      }
      store.__searchHighlights?.push({
        t: performance.now() - started,
        searchMatches: all ? all.size : 0,
        currentMatch: current ? current.size : 0,
        currentConnected: connected
      })
    }
    sample()
    // One sampling loop: re-starting a capture resets the arrays, not the loop.
    if (!store.__searchCaptureLoop) {
      store.__searchCaptureLoop = true
      const step = () => {
        sample()
        if (performance.now() - started < 8000) {
          requestAnimationFrame(step)
        } else {
          store.__searchCaptureLoop = false
        }
      }
      requestAnimationFrame(step)
    }
  })

const readHighlightCapture = (
  page: Page
): Promise<{ samples: HighlightSample[]; ops: HighlightOp[]; mutations: HighlightMutation[] }> =>
  page.evaluate(() => {
    const store = window as unknown as {
      __searchHighlights?: Array<{ t: number; searchMatches: number; currentMatch: number; currentConnected: boolean }>
      __searchHighlightOps?: Array<{ t: number; op: string; name: string | null; stack?: string[] }>
      __searchMutations?: Array<{ t: number; type: string; attributeName: string | null; target: string }>
    }
    return {
      samples: store.__searchHighlights ?? [],
      ops: store.__searchHighlightOps ?? [],
      mutations: store.__searchMutations ?? []
    }
  })

const readHighlightState = (page: Page): Promise<HighlightState> =>
  page.evaluate(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
    const current = registry?.get('current-match')
    const all = registry?.get('search-matches')
    let connected = true
    let currentText: string | null = null
    if (current) {
      const parts: string[] = []
      for (const range of current) {
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) connected = false
        parts.push(range.toString())
      }
      currentText = parts.join('|')
    }
    return {
      searchMatches: all ? all.size : 0,
      currentMatch: current ? current.size : 0,
      currentText,
      connected
    }
  })

/**
 * Asserts the located hit is registered, connected, and never empty across one
 * navigation window, and that the registry was only updated by name.
 */
const expectHighlightPersistence = async (page: Page, label: string, expectedMatches: number): Promise<void> => {
  const { samples, ops, mutations } = await readHighlightCapture(page)
  const state = await readHighlightState(page)
  // Registry history is part of every failure message: a vanished highlight is
  // only actionable together with what was registered when and what was written.
  const history = `state=${JSON.stringify(state)} ops=${JSON.stringify(ops)} mutations=${JSON.stringify(mutations)} samples=${
    samples.length
  } empty=${JSON.stringify(samples.filter((sample) => sample.searchMatches === 0 || sample.currentMatch === 0).map((sample) => Math.round(sample.t)))}`
  expect(state.searchMatches, `${label}: the whole match set must stay highlighted (${history})`).toBe(expectedMatches)
  expect(state.currentMatch, `${label}: the current hit must stay highlighted (${history})`).toBe(1)
  expect(state.connected, `${label}: the highlighted range must stay live in the document (${history})`).toBe(true)
  expect(state.currentText, `${label}: the highlight must cover the query text (${history})`).toContain(SEARCH_QUERY)

  const registered = samples.findIndex((sample) => sample.searchMatches > 0 && sample.currentMatch > 0)
  expect(registered, `${label}: a highlight must be registered while navigating (${history})`).toBeGreaterThanOrEqual(0)
  const tracked = samples.slice(registered)
  expect(tracked.length, `${label}: the registry must be sampled per frame (${history})`).toBeGreaterThan(3)
  expect(
    tracked
      .filter((sample) => sample.searchMatches === 0 || sample.currentMatch === 0)
      .map((sample) => Math.round(sample.t)),
    `${label}: the highlight must never disappear between hits (${history})`
  ).toHaveLength(0)
  expect(
    tracked.filter((sample) => !sample.currentConnected).map((sample) => Math.round(sample.t)),
    `${label}: the highlighted range must never become detached (${history})`
  ).toHaveLength(0)
  // From the moment the hit is registered, the registry must only ever be
  // updated by name: a wholesale clear is what removed the paint with no repaint
  // following it. Session-level clears before that point (committing the query
  // itself) are not part of the navigation window.
  const registeredAt = samples[registered].t
  expect(
    ops.filter((op) => op.op === 'clear' && op.t >= registeredAt),
    `${label}: the registry must be updated by name, never cleared wholesale (${history})`
  ).toHaveLength(0)
}

/**
 * Painted evidence for the landed hit. `::highlight()` has no `getComputedStyle`
 * surface, so paint is proven by pixels: a clip of the hit changes when the named
 * entry is removed, while two consecutive clips with the entry present are
 * byte-identical — so the difference is the highlight, not incidental repaint.
 */
const expectHighlightPainted = async (page: Page, needle: string): Promise<void> => {
  const clip = await page.evaluate((text: string) => {
    const container = document.getElementById('messages')
    if (!container) return null
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const value = node.nodeValue ?? ''
      const at = value.indexOf(text)
      if (at === -1) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      const rect = range.getBoundingClientRect()
      if (!rect || rect.width === 0 || rect.height === 0) continue
      return {
        x: Math.max(0, Math.floor(rect.left - 4)),
        y: Math.max(0, Math.floor(rect.top - 4)),
        width: Math.ceil(rect.width + 8),
        height: Math.ceil(rect.height + 8)
      }
    }
    return null
  }, needle)
  expect(clip, `painted check: hit text "${needle}" must be rendered`).not.toBeNull()
  const withHighlight = await page.screenshot({ clip: clip as { x: number; y: number; width: number; height: number } })
  await page.evaluate(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
    ;(window as unknown as { __searchSavedCurrent?: unknown }).__searchSavedCurrent = registry?.get('current-match')
    registry?.delete('current-match')
  })
  const without1 = await page.screenshot({ clip: clip as { x: number; y: number; width: number; height: number } })
  const without2 = await page.screenshot({ clip: clip as { x: number; y: number; width: number; height: number } })
  await page.evaluate(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
    const saved = (window as unknown as { __searchSavedCurrent?: Set<Range> }).__searchSavedCurrent
    if (saved) registry?.set('current-match', saved)
  })
  expect(without1.equals(without2), 'painted check: the control captures must be identical').toBe(true)
  expect(
    withHighlight.equals(without1),
    `painted check: the registered current-match must change the painted pixels of "${needle}"`
  ).toBe(false)
}

async function seedSearchTopic(page: Page, topicId: string): Promise<void> {
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  const { entries, totalRows } = buildSearchViewportEntries(topicId, liveAssistantId as string)

  const seeded = await page.evaluate(
    async ({
      topicId,
      assistantId,
      entries,
      displayCount
    }: {
      topicId: string
      assistantId: string
      entries: unknown
      displayCount: number
    }) => {
      try {
        const store = (window as any).store
        store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: {
              id: topicId,
              assistantId,
              name: `SearchViewport ${topicId}`,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        store.dispatch({ type: 'newMessages/setDisplayCount', payload: displayCount })
        const chatDb = ((window as any).api as any)?.chatDb
        if (!chatDb || typeof chatDb.ensureTopic !== 'function' || typeof chatDb.pasteMessagesToTopic !== 'function')
          return { ok: false, err: 'chatDb missing' }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name: `SearchViewport ${topicId}` })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (error) {
        return { ok: false, err: error instanceof Error ? error.message : String(error) }
      }
    },
    { topicId, assistantId: liveAssistantId as string, entries, displayCount: totalRows + 10 }
  )
  expect(seeded.ok, `Main authority seed failed: ${(seeded as any).err}`).toBe(true)
}

test.describe('Cmd/Ctrl+F search -> chat viewport coherence', () => {
  test.setTimeout(240000)

  test('match jump lands readable text under the search panel, animates a long move, and survives settle, next hit, supersession, interruption and close', async ({
    mainWindow
  }) => {
    const page = mainWindow
    const contentSearch = page.locator('[data-testid="content-search"]')
    const messages = page.locator('#messages')
    const topicId = `e2e-search-viewport-${Date.now()}`
    let totalRows = 0

    // The animated landing is the normal case; a reduced-motion host is entitled
    // to an instant landing, so the animation assertion is skipped only there.
    const reducedMotion = await prefersReducedMotion(page)

    await test.step('seed a topic whose long row carries the keyword twice', async () => {
      const built = buildSearchViewportEntries(topicId, 'placeholder')
      totalRows = built.totalRows
      await seedSearchTopic(page, topicId)
      const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
      await topicItem.waitFor({ state: 'attached', timeout: 15000 })
      await topicItem.scrollIntoViewIfNeeded()
      await topicItem.click()
      await page.waitForFunction(
        ({ rows }: { rows: number }) => document.querySelectorAll('#messages [data-message-id]').length >= rows,
        { rows: totalRows },
        { timeout: 30000 }
      )
      await expect(messages).toBeVisible({ timeout: 15000 })
    })

    let firstMotionSamples: MotionSample[] = []
    let firstLanding = 0

    await test.step('from bottom: the first hit lands readable under the search panel', async () => {
      // The route opens at the column-reverse bottom (scrollTop ~= 0).
      await page.waitForFunction(
        () => Math.abs((document.getElementById('messages') as HTMLElement).scrollTop) <= 1,
        undefined,
        { timeout: 15000 }
      )
      await startScrollMotionCapture(page)
      // Sampled from before the query is even typed: the located hit must become
      // registered and stay registered through the jump.
      await startHighlightCapture(page)
      await pressSearchShortcut(page)
      await expect(contentSearch).toBeVisible({ timeout: 10000 })
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await contentSearch.locator('input').first().fill(SEARCH_QUERY)
      await expect(contentSearch).toContainText('1/2', { timeout: 15000 })

      const first = await settledHit(page, FIRST_HIT_NEEDLE)
      const firstFacts = JSON.stringify({
        top: Math.round(first.top),
        bottom: Math.round(first.bottom),
        bandTop: Math.round(first.bandTop),
        bandBottom: Math.round(first.bandBottom),
        bandPosition: Number(first.bandPosition.toFixed(3)),
        scrollTop: Math.round(first.scrollTop)
      })
      // Readable, and NOT hidden behind the floating search bar: the landing
      // band excludes the strip the panel actually covers.
      expect(first.covered, `the landed hit must not sit behind the search panel (${firstFacts})`).toBe(false)
      expect(first.visible, `first hit must be inside the unobscured reading area (${firstFacts})`).toBe(true)
      expect(first.top, firstFacts).toBeGreaterThanOrEqual(first.bandTop)
      expect(first.rowId, `the hit must belong to a message row (${firstFacts})`).toBeTruthy()
      // The hit sits near the middle of what the panel leaves visible.
      expect(first.bandPosition, firstFacts).toBeGreaterThan(0.25)
      expect(first.bandPosition, firstFacts).toBeLessThan(0.75)

      firstMotionSamples = await readScrollMotionCapture(page)
      firstLanding = first.scrollTop
      await expectHighlightPersistence(page, 'first hit', 2)
    })

    await test.step('the long jump animates through intermediate painted positions', async () => {
      if (reducedMotion) {
        // Reduced motion is honoured with an instant landing; nothing to assert.
        return
      }
      expect(firstMotionSamples.length, 'scroll motion must be sampled per frame').toBeGreaterThan(5)
      const travel = intermediateFrames(firstMotionSamples, 0, firstLanding)
      expect(
        travel.length,
        `the jump must animate through intermediate positions (samples: ${JSON.stringify(
          firstMotionSamples.map((sample) => Math.round(sample.top))
        )})`
      ).toBeGreaterThanOrEqual(2)
      // No frame may pass the landing position and come back.
      const overshoot = firstMotionSamples.filter((sample) => Math.abs(sample.top) > Math.abs(firstLanding) + 8)
      expect(
        overshoot.map((sample) => Math.round(sample.top)),
        'no frame may overshoot the landing'
      ).toHaveLength(0)
      // Nothing rewinds after the movement ends.
      const tail = firstMotionSamples.slice(-3)
      for (const sample of tail) {
        expect(Math.abs(sample.top - firstLanding)).toBeLessThanOrEqual(8)
      }
    })

    let longRowId: string | null = null
    let firstHitScrollTop = 0
    await test.step('stability: the viewport is not pulled back after layout settles', async () => {
      const settled = await settledHit(page, FIRST_HIT_NEEDLE, 4)
      longRowId = settled.rowId
      firstHitScrollTop = settled.scrollTop
      // Several further painted frames must not move it back toward the bottom.
      for (let sample = 0; sample < 6; sample++) {
        await page.waitForTimeout(120)
        const current = await readHit(page, FIRST_HIT_NEEDLE)
        expect(current, 'the first hit must still be rendered').not.toBeNull()
        expect(current!.visible, `hit must stay visible (sample ${sample})`).toBe(true)
        expect(Math.abs(current!.scrollTop - firstHitScrollTop)).toBeLessThanOrEqual(SETTLE_TOL_PX)
      }
    })

    await test.step('same long row: the next hit positions on its own text', async () => {
      await startHighlightCapture(page)
      await contentSearch.locator('input').first().press('Enter')
      await expect(contentSearch).toContainText('2/2', { timeout: 15000 })
      const second = await settledHit(page, SECOND_HIT_NEEDLE)
      expect(second.covered, 'second hit must not sit behind the search panel').toBe(false)
      expect(second.visible, 'second hit must be readable').toBe(true)
      expect(second.top).toBeGreaterThanOrEqual(second.bandTop)
      expect(second.bandPosition).toBeGreaterThan(0.2)
      expect(second.bandPosition).toBeLessThan(0.8)
      // Same owning row, deeper position: repeated hits do not collapse onto the
      // row's top.
      expect(second.rowId).toBe(longRowId)
      // Toward the newest end of the same row: a deeper hit means a LARGER
      // (less negative) column-reverse scrollTop.
      expect(second.scrollTop).toBeGreaterThan(firstHitScrollTop + 100)
      // Both hits stay highlighted and the located one stays the current match:
      // moving between hits must not blink the highlight out of the registry.
      await expectHighlightPersistence(page, 'next hit', 2)
      await expectHighlightPainted(page, SECOND_HIT_NEEDLE)
    })

    await test.step('previous match (Shift+Enter) returns to the first hit and stays', async () => {
      await startHighlightCapture(page)
      await contentSearch.locator('input').first().press('Shift+Enter')
      await expect(contentSearch).toContainText('1/2', { timeout: 15000 })
      const back = await settledHit(page, FIRST_HIT_NEEDLE)
      expect(back.visible, 'first hit must be back inside the reading area').toBe(true)
      expect(back.covered).toBe(false)
      expect(back.rowId).toBe(longRowId)
      // Back on the first hit's own text, not on the row top and not still at
      // the second hit's position.
      expect(Math.abs(back.scrollTop - firstHitScrollTop)).toBeLessThanOrEqual(SETTLE_TOL_PX)
      await expectHighlightPersistence(page, 'previous hit', 2)
      await expectHighlightPainted(page, FIRST_HIT_NEEDLE)
      // And it stays there through further painted frames.
      for (let sample = 0; sample < 6; sample++) {
        await page.waitForTimeout(120)
        const current = await readHit(page, FIRST_HIT_NEEDLE)
        expect(current, 'the first hit must still be rendered').not.toBeNull()
        expect(current!.visible, `previous hit must stay visible (sample ${sample})`).toBe(true)
        expect(Math.abs(current!.scrollTop - back.scrollTop)).toBeLessThanOrEqual(SETTLE_TOL_PX)
      }
    })

    await test.step('an already readable hit is not repositioned', async () => {
      const before = await settledHit(page, FIRST_HIT_NEEDLE)
      await startScrollMotionCapture(page)
      // Same query re-committed: the located hit is the one already sitting
      // clearly inside the reading area, so the viewport must not take a new
      // journey for it.
      const input = contentSearch.locator('input').first()
      await input.fill('')
      await input.fill(SEARCH_QUERY)
      await expect(contentSearch).toContainText('1/2', { timeout: 15000 })
      await page.waitForTimeout(900)
      const after = await settledHit(page, FIRST_HIT_NEEDLE, 2)
      expect(after.visible).toBe(true)
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(SETTLE_TOL_PX)
      const samples = await readScrollMotionCapture(page)
      const maxTravel = samples.reduce((worst, sample) => Math.max(worst, Math.abs(sample.top - before.scrollTop)), 0)
      expect(maxTravel, 'a clearly visible hit must not be moved').toBeLessThanOrEqual(12)
    })

    await test.step('rapid next then previous settles on the latest request', async () => {
      const input = contentSearch.locator('input').first()
      await input.press('Enter')
      // Supersede the in-flight animation with the opposite request.
      await page.waitForTimeout(60)
      await input.press('Shift+Enter')
      await expect(contentSearch).toContainText('1/2', { timeout: 15000 })
      const settled = await settledHit(page, FIRST_HIT_NEEDLE)
      expect(settled.visible, 'the latest request must leave its hit readable').toBe(true)
      expect(settled.covered).toBe(false)
      // The superseded movement never resumes: the position holds and ends on
      // the latest requested hit.
      expect(Math.abs(settled.scrollTop - firstHitScrollTop)).toBeLessThanOrEqual(SETTLE_TOL_PX)
      for (let sample = 0; sample < 5; sample++) {
        await page.waitForTimeout(120)
        const current = await readHit(page, FIRST_HIT_NEEDLE)
        expect(current, 'the first hit must still be rendered').not.toBeNull()
        expect(Math.abs(current!.scrollTop - settled.scrollTop)).toBeLessThanOrEqual(SETTLE_TOL_PX)
      }
    })

    await test.step('from a scrolled reading position: the hit lands on its text', async () => {
      await page.keyboard.press('Escape')
      await expect(contentSearch).toHaveCount(0, { timeout: 10000 })
      const box = await messages.first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      const before = await readScrollTop(page)
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, -560)
        if (Math.abs((await readScrollTop(page)) - before) > 200) break
      }
      const readingPosition = await readScrollTop(page)
      expect(Math.abs(readingPosition - before)).toBeGreaterThan(200)

      await pressSearchShortcut(page)
      await expect(contentSearch).toBeVisible({ timeout: 10000 })
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await contentSearch.locator('input').first().fill(SEARCH_QUERY)
      await expect(contentSearch).toContainText('1/2', { timeout: 15000 })
      const hit = await settledHit(page, FIRST_HIT_NEEDLE)
      expect(hit.covered).toBe(false)
      expect(hit.visible).toBe(true)
      expect(hit.top).toBeGreaterThanOrEqual(hit.bandTop)
      expect(hit.rowId).toBe(longRowId)
      expect(Math.abs(hit.scrollTop - readingPosition)).toBeGreaterThan(100)
    })

    await test.step('a wheel during the jump interrupts it without a later rewind', async () => {
      // Back to the route bottom so the next jump is a long journey again.
      await page.keyboard.press('Escape')
      await expect(contentSearch).toHaveCount(0, { timeout: 10000 })
      const box = await messages.first().boundingBox()
      expect(box, 'the scroll container must have a box').not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      for (let i = 0; i < 30; i++) {
        await page.mouse.wheel(0, 800)
        if (Math.abs(await readScrollTop(page)) <= 2) break
      }
      await page.waitForFunction(
        () => Math.abs((document.getElementById('messages') as HTMLElement).scrollTop) <= 2,
        undefined,
        { timeout: 15000 }
      )

      await startScrollMotionCapture(page)
      await pressSearchShortcut(page)
      await expect(contentSearch).toBeVisible({ timeout: 10000 })
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await contentSearch.locator('input').first().fill(SEARCH_QUERY)
      await expect(contentSearch).toContainText('1/2', { timeout: 15000 })

      // Take the viewport over only once the movement is really under way.
      await page.waitForFunction(
        () => Math.abs((document.getElementById('messages') as HTMLElement).scrollTop) > 40,
        undefined,
        { timeout: 15000 }
      )
      const beforeWheel = await readScrollTop(page)
      await page.mouse.wheel(0, 240)
      // The wheel's own scroll lands asynchronously: let it apply (and the
      // interrupted journey come to rest) before sampling the stop position.
      await page.waitForFunction(
        ({ baseline }: { baseline: number }) => {
          const top = (document.getElementById('messages') as HTMLElement).scrollTop
          return top !== baseline
        },
        { baseline: beforeWheel },
        { timeout: 5000 }
      )
      await page.waitForTimeout(250)
      const interrupted = await readScrollTop(page)
      // The interrupted journey must not resume or rewind afterwards.
      await page.waitForTimeout(1200)
      const afterQuiet = await readScrollTop(page)
      expect(
        Math.abs(afterQuiet - interrupted),
        `the interrupted jump must not resume or rewind (interrupted=${Math.round(interrupted)}, after=${Math.round(afterQuiet)})`
      ).toBeLessThanOrEqual(24)
      // No frame may rewind after the interruption: sample the live position over
      // the next painted frames (independent of when the capture started).
      const frames = await page.evaluate(async () => {
        const container = document.getElementById('messages') as HTMLElement
        const out: number[] = []
        for (let i = 0; i < 10; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          out.push(Math.round(container.scrollTop))
        }
        return out
      })
      expect(
        frames.filter((top) => Math.abs(top - afterQuiet) > 24),
        `no frame may rewind after the interruption (after=${Math.round(afterQuiet)} frames=${JSON.stringify(frames)})`
      ).toHaveLength(0)
      // The journey did not complete: the hit is not parked in the band centre.
      const hit = await readHit(page, FIRST_HIT_NEEDLE)
      expect(hit, 'the hit text must still be rendered').not.toBeNull()
      expect(Math.abs(hit!.bandPosition - 0.5)).toBeGreaterThan(0.1)
    })

    await test.step('closing the search keeps the match position and leaves user scroll intact', async () => {
      const beforeClose = await settledHit(page, FIRST_HIT_NEEDLE)
      await page.keyboard.press('Escape')
      await expect(contentSearch).toHaveCount(0, { timeout: 10000 })
      // No restore of the previous (pre-search) position.
      const afterClose = await readScrollTop(page)
      expect(Math.abs(afterClose - beforeClose.scrollTop)).toBeLessThanOrEqual(SETTLE_TOL_PX)
      const rowTopAfterClose = await page.evaluate((rowId: string | null) => {
        if (!rowId) return null
        const row = document.querySelector(`#messages [data-message-id="${rowId}"]`) as HTMLElement | null
        const container = document.getElementById('messages')
        if (!row || !container) return null
        return row.getBoundingClientRect().top - container.getBoundingClientRect().top
      }, beforeClose.rowId)
      expect(rowTopAfterClose).not.toBeNull()
      expect(Math.abs((rowTopAfterClose as number) - (beforeClose.rowTop as number))).toBeLessThanOrEqual(SETTLE_TOL_PX)

      // Ordinary user scrolling still owns the viewport afterwards.
      const box = await messages.first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      const start = await readScrollTop(page)
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, 400)
        if (Math.abs((await readScrollTop(page)) - start) > 100) break
      }
      const moved = await readScrollTop(page)
      expect(Math.abs(moved - start)).toBeGreaterThan(100)
    })
  })
})
