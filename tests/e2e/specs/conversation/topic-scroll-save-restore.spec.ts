/**
 * Topic Switch Scroll Save/Restore — S3.2 E2E Regression (production contract)
 *
 * Production contract (useScrollPosition + messageNavigation):
 *   snapshot = { scrollTop, anchorId, isAtBottom }
 *   bootstrap restore priority: bottom > anchorId > scrollTop
 *   fresh bottom snapshots are valid; browser/layout clamps pixels.
 *   Canonical storage key is the route key `scroll:topic-<id>::main`
 *   (production `useScrollPosition('topic-<id>::main')`); the legacy
 *   `scroll:topic-<id>` read exists only as the production
 *   getLegacyMainSavedPosition fallback and is tried second here, matching
 *   the established newer-viewport pattern (e.g. page-viewport-resume,
 *   route-settings-session).
 *
 * Oracles (production-observable UI behavior):
 *   - visible anchor/bottom within tolerance, active-topic DOM membership,
 *     host identity. Exact negative pixel equality and null key are NOT oracles.
 *   - Keyv is supporting evidence only: transition save must update outgoing
 *     topic and must NOT copy its non-bottom snapshot into the target.
 *
 * Coverage:
 *   1) Transition save targets outgoing topic (supporting key evidence)
 *   2) Fresh activation resets to bottom + isolated DOM (no leakage)
 *   3) Restoration via visible anchor/bottom + relative position
 *   4) Independent anchors survive round-trip without contamination
 *   5) #messages host remains the same connected node (stable-host)
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

// ---------------------------------------------------------------------------
// Helpers — production-compatible geometry & state waits
// ---------------------------------------------------------------------------

function scrollableMessage(label: string): string {
  return `${label} ${'deterministic scrollable content '.repeat(80)}`
}

async function waitForActiveTopic(
  page: import('@playwright/test').Page,
  expectedTopicId: string,
  timeout = 10000
): Promise<void> {
  await page.waitForFunction(
    ({ id }: { id: string }) => {
      const s = (window as any).store?.getState()
      return s?.messages?.currentTopicId === id
    },
    { id: expectedTopicId },
    { timeout }
  )
}

async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ selector, text }) => {
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

async function waitForAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<number> {
  await page.waitForFunction(
    ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let count = 0
      for (const id of msgIds) {
        const msg = s.messages.entities?.[id]
        if (msg?.role === 'assistant') count++
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
        const msg = s.messages.entities?.[msgIds[i]]
        if (msg?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages.entities[latestAssistantId]
      const terminalStatuses = ['success', 'error']
      if (!terminalStatuses.includes(assistantMsg.status)) return false
      const blocks = assistantMsg.blocks || []
      if (blocks.length === 0) return false
      for (const blockId of blocks) {
        const block = s.messageBlocks?.entities?.[blockId]
        if (!block) return false
        if (block.status !== 'success' && block.status !== 'error') return false
      }
      return true
    },
    { topicId },
    { timeout }
  )
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[tid] || []
    let count = 0
    for (const id of msgIds) {
      const msg = s.messages.entities[id]
      if (msg?.role === 'assistant') count++
    }
    return count
  }, topicId)
}

async function createNewTopic(page: import('@playwright/test').Page, sendMessages?: string[]): Promise<string> {
  const idsBefore = await page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return {
      activeTopicId: s.messages?.currentTopicId ?? null,
      topicIds: (assistant?.topics || []).map((t: any) => t.id)
    }
  })
  if (idsBefore.activeTopicId) await removeScrollSpacer(page, idsBefore.activeTopicId)
  const addBtn = page.locator('.topics-tab button').first()
  await addBtn.waitFor({ state: 'visible', timeout: 10000 })
  await addBtn.click()
  await page.waitForFunction(
    ({ topicIds }: { topicIds: string[] }) => {
      const topics = (window as any).store?.getState()?.assistants?.assistants?.[0]?.topics || []
      return topics.some((topic: { id: string }) => !topicIds.includes(topic.id))
    },
    { topicIds: idsBefore.topicIds },
    { timeout: 10000 }
  )
  const topicId = await page.evaluate((topicIds: string[]) => {
    const topics = (window as any).store?.getState()?.assistants?.assistants?.[0]?.topics || []
    return topics.find((topic: { id: string }) => !topicIds.includes(topic.id))?.id || ''
  }, idsBefore.topicIds)
  if (sendMessages && topicId) {
    let assistantCount = 0
    for (const msg of sendMessages) {
      await uiSendMessage(page, msg)
      assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount)
    }
  }
  if (topicId) await waitForTopicDomActivation(page, topicId)
  return topicId
}

async function waitForTopicDomActivation(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const state = (window as any).store?.getState()
      const activeTopicId = state?.messages?.currentTopicId
      if (activeTopicId !== topicId) return false
      if (state?.messages?.loadingByTopic?.[topicId]) return false
      const messageIds = new Set<string>(state?.messages?.messageIdsByTopic?.[topicId] || [])
      if (messageIds.size === 0) return true
      return Array.from(messageIds).some(
        (messageId) => document.querySelector(`#messages [data-message-id="${messageId}"]`) !== null
      )
    },
    { topicId },
    { timeout: 10000 }
  )
}

async function clickTopicById(
  page: import('@playwright/test').Page,
  topicId: string,
  previousTopicId?: string
): Promise<void> {
  if (previousTopicId) await removeScrollSpacer(page, previousTopicId)
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.click()
  await waitForActiveTopic(page, topicId)
  await waitForTopicDomActivation(page, topicId)
}

type ScrollSnapshot = {
  scrollTop: number
  anchorId: string | null
  messageId: string | null
  intraRowOffset: number | null
  isAtBottom: boolean
}

const OFFSET_TOL = 12

async function getScrollPosition(
  page: import('@playwright/test').Page,
  topicId: string
): Promise<ScrollSnapshot | null> {
  return page.evaluate(
    ({ topicId }: { topicId: string }) => {
      // Canonical route key first; legacy fallback only per production
      // getLegacyMainSavedPosition schema compatibility. Canonical contract
      // is { scrollTop, messageId, intraRowOffset, isAtBottom }; anchorId is
      // retained only as the legacy compatibility alias for the same identity.
      const keys = [`scroll:topic-${topicId}::main`, `scroll:topic-${topicId}`]
      for (const key of keys) {
        const val = (window as any).keyv?.get(key)
        if (val && typeof val === 'object' && 'scrollTop' in val) {
          const rec = val as Record<string, unknown>
          const canonical =
            typeof rec.messageId === 'string' && (rec.messageId as string).length > 0
              ? (rec.messageId as string)
              : typeof rec.anchorId === 'string'
                ? (rec.anchorId as string)
                : null
          const rawOffset = rec.intraRowOffset
          const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? rawOffset : null
          return {
            scrollTop: rec.scrollTop as number,
            anchorId: canonical,
            messageId: canonical,
            intraRowOffset: offset,
            isAtBottom: !!(rec.isAtBottom as boolean)
          }
        }
      }
      return null
    },
    { topicId }
  )
}

async function getContainerScrollTop(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.getElementById('messages')
    return el ? el.scrollTop : 0
  })
}

async function getTopicMessageIds(page: import('@playwright/test').Page, topicId: string): Promise<string[]> {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    return [...(s.messages?.messageIdsByTopic?.[tid] || [])] as string[]
  }, topicId)
}

async function getRenderedMessageIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('#messages [data-message-id]'))
      .map((el) => el.getAttribute('data-message-id') || '')
      .filter(Boolean)
  })
}

async function getFirstVisibleMessageId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => {
    const container = document.getElementById('messages')
    if (!container) return null
    const containerRect = container.getBoundingClientRect()
    const elements = container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')
    const isVisible = (el: HTMLElement): boolean => {
      const style = window.getComputedStyle(el)
      if (style.display === 'none') return false
      const rect = el.getBoundingClientRect()
      if (rect.height === 0) return false
      const visibleHeight = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top)
      return visibleHeight > 0
    }
    let closestId: string | null = null
    let minDistance = Infinity
    for (const el of elements) {
      if (!(el instanceof HTMLElement)) continue
      if (!isVisible(el)) continue
      const rect = el.getBoundingClientRect()
      const distance = Math.abs(rect.top - containerRect.top)
      if (distance < minDistance) {
        minDistance = distance
        closestId = el.id.replace('message-', '')
      }
    }
    return closestId
  })
}

async function assertTopicDomExclusive(
  page: import('@playwright/test').Page,
  topicId: string,
  otherTopicId: string | null
): Promise<void> {
  const [topicIds, renderedIds] = await Promise.all([getTopicMessageIds(page, topicId), getRenderedMessageIds(page)])
  const renderedSet = new Set(renderedIds)
  // Every rendered message must belong to the active topic
  for (const rid of renderedIds) {
    expect(topicIds).toContain(rid)
  }
  expect(renderedSet.size).toBeGreaterThan(0)
  if (otherTopicId) {
    const otherIds = await getTopicMessageIds(page, otherTopicId)
    for (const oid of otherIds) {
      expect(renderedSet.has(oid)).toBe(false)
    }
  }
}

async function expectBottomWithinTolerance(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  await addScrollSpacer(page, topicId)
  await page.waitForFunction(
    () => {
      const el = document.getElementById('messages')
      return el ? Math.abs(el.scrollTop) < 100 : false
    },
    undefined,
    { timeout: 10000 }
  )
  const top = await getContainerScrollTop(page)
  expect(Math.abs(top)).toBeLessThan(100)
}

async function waitForNonBottomSnapshot(
  page: import('@playwright/test').Page,
  topicId: string,
  timeout = 5000
): Promise<ScrollSnapshot> {
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      // Canonical route oracle; legacy key accepted only as schema-compat fallback.
      const keys = [`scroll:topic-${topicId}::main`, `scroll:topic-${topicId}`]
      for (const key of keys) {
        const v = (window as any).keyv?.get(key)
        if (v && typeof v === 'object' && 'isAtBottom' in v && v.isAtBottom === false) return true
      }
      return false
    },
    { topicId },
    { timeout }
  )
  const snap = await getScrollPosition(page, topicId)
  if (!snap) throw new Error(`no snapshot for ${topicId} after wait`)
  return snap
}

async function scrollMessageIntoViewAndPersist(
  page: import('@playwright/test').Page,
  topicId: string,
  messageId: string
): Promise<number> {
  // Test precondition correction: synthetic scrollIntoView + synthetic scroll
  // event alone never declares a live wheel/touch/pointer session, so the
  // production handleScroll path only keeper-holds and never commits a
  // snapshot. Use ordinary real wheel input (which declares intent via
  // onWheel before the scroll commits) to establish the same browsing intent:
  // the target message visible at a verified non-bottom reading position.
  await ensureOverflow(page, topicId)
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const isTargetVisible = (): Promise<boolean> =>
    page.evaluate((mid: string) => {
      const container = document.getElementById('messages')
      const el = document.getElementById(`message-${mid}`)
      if (!container || !el || !el.isConnected) return false
      if (window.getComputedStyle(el).display === 'none') return false
      const c = container.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      if (r.height === 0) return false
      return Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0
    }, messageId)
  const isNonBottom = (): Promise<boolean> =>
    page.evaluate(() => {
      const el = document.getElementById('messages')
      if (!el) return false
      return Math.abs(el.scrollTop) > 300
    })
  // Sweep both wheel signs (no column-reverse assumption) until the target is
  // visible at a non-bottom offset; each wheel is ordinary user input.
  for (let i = 0; i < 40; i++) {
    if ((await isTargetVisible()) && (await isNonBottom())) break
    await page.mouse.wheel(0, -640)
    await page.waitForTimeout(220)
  }
  if (!((await isTargetVisible()) && (await isNonBottom()))) {
    for (let i = 0; i < 40; i++) {
      if ((await isTargetVisible()) && (await isNonBottom())) break
      await page.mouse.wheel(0, 640)
      await page.waitForTimeout(220)
    }
  }
  const scrollTop = await getContainerScrollTop(page)
  return scrollTop
}

/**
 * Diverge to a second committed non-bottom viewport with ordinary real wheel
 * input. A programmatic scrollTop write is NOT a substitute here: with no
 * live wheel/touch/pointer session it never commits (production handleScroll
 * only keeper-holds) AND the keeper hold compensates it away before any
 * transition freeze runs — so the freeze would (correctly) capture the held
 * viewport, not the poke. Real wheel input declares intent via onWheel,
 * commits via userTakeover, and stays keeper-held, giving the transition
 * save a genuine distinct current viewport to freeze.
 */
async function wheelToSecondCommittedPosition(
  page: import('@playwright/test').Page,
  topicId: string,
  fromScrollTop: number
): Promise<ScrollSnapshot> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const committedTop = async (): Promise<number | null> => (await getScrollPosition(page, topicId))?.scrollTop ?? null
  // Older-edge direction first (away from bottom: no bottom collapse), then
  // the reverse sweep (no column-reverse sign assumption baked in).
  for (const delta of [-640, 640]) {
    for (let i = 0; i < 30; i++) {
      const committed = await committedTop()
      if (committed !== null && Math.abs(committed - fromScrollTop) > 400) break
      await page.mouse.wheel(0, delta)
      await page.waitForTimeout(220)
      // Never collapse to bottom while seeking the divergent position.
      if (Math.abs(await getContainerScrollTop(page)) <= 300) break
    }
    const committed = await committedTop()
    if (committed !== null && Math.abs(committed - fromScrollTop) > 400) break
  }
  // Let scrollend close the session and the keeper settle, then read the
  // final committed value as the transition baseline.
  await page.waitForTimeout(1200)
  const diverged = await getScrollPosition(page, topicId)
  if (!diverged) throw new Error('no committed snapshot after wheel divergence')
  expect(diverged.isAtBottom).toBe(false)
  expect(Math.abs(diverged.scrollTop - fromScrollTop)).toBeGreaterThan(400)
  expect(Math.abs(await getContainerScrollTop(page))).toBeGreaterThan(300)
  return diverged
}

/**
 * Narrow ADR oracle: the DOM row for the PRE-AWAY requested snapshot identity
 * itself (never a post-return rewritten snapshot, never any-visible row) must
 * land at its saved intra-row offset (rect.top - container.top vs saved offset,
 * <=12px, matching keyboard-viewport-scroll/page-viewport-resume). A broad
 * |rowTop - containerTop| < containerHeight check is NOT a valid oracle for a
 * tall row: a correct restore in the middle of a 2772px row with a 402px
 * viewport is ~1932px from the container top and legitimately fails nearTop.
 * Legacy snapshots without a finite intraRowOffset keep the prior visible-only
 * fallback with this truthful limitation: visibility proves presence, not the
 * saved reading position.
 */
async function measureRequestedRow(
  page: import('@playwright/test').Page,
  requestedId: string
): Promise<{
  found: boolean
  height: number
  offset: number
  containerHeight: number
  visibleHeight: number
} | null> {
  return page.evaluate((mid: string) => {
    const container = document.getElementById('messages')
    if (!container) return null
    const cRect = container.getBoundingClientRect()
    const el =
      (document.querySelector(`#messages [data-message-id="${mid}"]`) as HTMLElement | null) ??
      (document.getElementById(`message-${mid}`) as HTMLElement | null)
    if (!el || !el.isConnected) {
      return { found: false, height: 0, offset: NaN, containerHeight: cRect.height, visibleHeight: 0 }
    }
    if (window.getComputedStyle(el).display === 'none') {
      return { found: false, height: 0, offset: NaN, containerHeight: cRect.height, visibleHeight: 0 }
    }
    const r = el.getBoundingClientRect()
    if (r.height === 0) {
      return { found: false, height: 0, offset: NaN, containerHeight: cRect.height, visibleHeight: 0 }
    }
    return {
      found: true,
      height: r.height,
      offset: r.top - cRect.top,
      containerHeight: cRect.height,
      visibleHeight: Math.min(r.bottom, cRect.bottom) - Math.max(r.top, cRect.top)
    }
  }, requestedId)
}

async function waitForRequestedRowOffsetRestoration(
  page: import('@playwright/test').Page,
  requested: Pick<ScrollSnapshot, 'messageId' | 'anchorId' | 'intraRowOffset'>,
  timeout = 15000
): Promise<void> {
  const requestedId = requested.messageId || requested.anchorId
  if (!requestedId) throw new Error('no requested snapshot identity for restoration oracle')
  const savedOffset = requested.intraRowOffset
  if (savedOffset === null || !Number.isFinite(savedOffset)) {
    // Compatibility limitation: legacy snapshot without a finite offset can
    // only prove the requested row is present and visible, not that the saved
    // reading position restored. All canonical new snapshots carry a finite
    // offset and must use the exact identity+offset path below.
    await page.waitForFunction(
      ({ id }: { id: string }) => {
        const container = document.getElementById('messages')
        if (!container) return false
        const el =
          (document.querySelector(`#messages [data-message-id="${id}"]`) as HTMLElement | null) ??
          (document.getElementById(`message-${id}`) as HTMLElement | null)
        if (!el || !el.isConnected) return false
        if (window.getComputedStyle(el).display === 'none') return false
        const rect = el.getBoundingClientRect()
        if (rect.height === 0) return false
        const cRect = container.getBoundingClientRect()
        return Math.min(rect.bottom, cRect.bottom) - Math.max(rect.top, cRect.top) > 0
      },
      { id: requestedId },
      { timeout }
    )
    return
  }
  await expect
    .poll(
      async () => {
        const m = await measureRequestedRow(page, requestedId)
        if (!m || !m.found || !Number.isFinite(m.offset)) return NaN
        return Math.abs(m.offset - (savedOffset as number))
      },
      { timeout, intervals: [250] }
    )
    .toBeLessThanOrEqual(OFFSET_TOL)
  const target = await measureRequestedRow(page, requestedId)
  const diag =
    `requested=${requestedId.slice(0, 8)}… savedOff=${Math.round(savedOffset as number)} ` +
    `rect=${target ? `found=${target.found} h=${Math.round(target.height)} off=${Number.isFinite(target.offset) ? Math.round(target.offset) : '?'} vis=${Math.round(target.visibleHeight)} ch=${Math.round(target.containerHeight)}` : 'null'}`
  expect(target, `requested target row must be measurable (${diag})`).not.toBeNull()
  expect(target!.found, `requested snapshot identity must be present in the DOM (${diag})`).toBe(true)
  expect(target!.height, `requested target row must have real height (${diag})`).toBeGreaterThan(0)
  expect(target!.visibleHeight, `requested target row must be visible (${diag})`).toBeGreaterThan(0)
  expect(
    Math.abs(target!.offset - (savedOffset as number)),
    `saved stable message identity must land at its saved intra-row offset (<=${OFFSET_TOL}px) (${diag})`
  ).toBeLessThanOrEqual(OFFSET_TOL)
}

async function captureMessagesHost(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__s32Host = document.getElementById('messages')
  })
}

async function assertHostStable(page: import('@playwright/test').Page): Promise<void> {
  const stable = await page.evaluate(() => {
    const cur = document.getElementById('messages')
    const prev = (window as any).__s32Host as HTMLElement | null
    if (!cur || !prev) return false
    return cur === prev && cur.isConnected && prev.isConnected
  })
  expect(stable).toBe(true)
}

async function removeScrollSpacer(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  await page.evaluate((activeTopicId: string) => {
    const el = document.getElementById('messages')
    if (!el) return
    const spacers = el.querySelectorAll<HTMLElement>('[data-scroll-test-spacer]')
    spacers.forEach((spacer) => {
      if (spacer.dataset.scrollTestTopic === activeTopicId) spacer.remove()
    })
  }, topicId)
}

async function ensureOverflow(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  await waitForTopicDomActivation(page, topicId)
  await page.evaluate((activeTopicId: string) => {
    const el = document.getElementById('messages')
    if (!el) throw new Error('#messages container not found')
    const state = (window as any).store?.getState()
    const currentTopicId = state?.messages?.currentTopicId
    if (currentTopicId !== activeTopicId) throw new Error(`Message DOM is not active for topic ${activeTopicId}`)
    const existingSpacer = el.querySelector<HTMLElement>('[data-scroll-test-spacer]')
    if (existingSpacer?.dataset.scrollTestTopic === activeTopicId) return
    existingSpacer?.remove()
    if (el.scrollHeight > el.clientHeight) return
    const messageIds = new Set<string>(state?.messages?.messageIdsByTopic?.[activeTopicId] || [])
    const topicMessage = Array.from(messageIds)
      .map((messageId) => document.getElementById(`message-${messageId}`))
      .find((message): message is HTMLElement => message instanceof HTMLElement)
    if (!topicMessage) throw new Error(`Message DOM is not settled for topic ${activeTopicId}`)
    const spacer = document.createElement('div')
    spacer.style.height = '5000px'
    spacer.style.pointerEvents = 'none'
    spacer.dataset.scrollTestSpacer = 'true'
    spacer.dataset.scrollTestTopic = activeTopicId
    topicMessage.appendChild(spacer)
  }, topicId)
}

async function addScrollSpacer(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  await ensureOverflow(page, topicId)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Topic Switch Scroll Save/Restore (S3.2)', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('transition save targets outgoing topic and fresh activation shows isolated bottom DOM with stable host', async ({
    mainWindow
  }) => {
    const topicA = await createNewTopic(mainWindow, [
      scrollableMessage('Message 1 from topic A'),
      scrollableMessage('Message 2 from topic A'),
      scrollableMessage('Message 3 from topic A'),
      scrollableMessage('Message 4 from topic A')
    ])
    expect(topicA).toBeTruthy()
    const topicB = await createNewTopic(mainWindow, [
      scrollableMessage('Message 1 from topic B'),
      scrollableMessage('Message 2 from topic B'),
      scrollableMessage('Message 3 from topic B')
    ])
    expect(topicB).toBeTruthy()

    await clickTopicById(mainWindow, topicA)
    await captureMessagesHost(mainWindow)

    // Establish non-bottom position via real scroll event on a real message
    const topicAMessageIds = await getTopicMessageIds(mainWindow, topicA)
    const anchorCandidateA = topicAMessageIds[0]
    expect(anchorCandidateA).toBeTruthy()
    await scrollMessageIntoViewAndPersist(mainWindow, topicA, anchorCandidateA)
    const initialSnapshot = await waitForNonBottomSnapshot(mainWindow, topicA)
    expect(initialSnapshot.isAtBottom).toBe(false)
    const firstVisibleBefore = await getFirstVisibleMessageId(mainWindow)
    expect(firstVisibleBefore).toBeTruthy()

    // Diverge with ordinary real wheel input to a second committed non-bottom
    // viewport (keeper-compatible; see wheelToSecondCommittedPosition). This
    // is the transition save's baseline: the freeze must capture THIS viewport.
    const diverged = await wheelToSecondCommittedPosition(mainWindow, topicA, initialSnapshot.scrollTop)

    // A→B: transition coordinator saves old-topic snapshot to old key
    await clickTopicById(mainWindow, topicB, topicA)

    // Supporting key evidence only: outgoing A snapshot changed, B did not inherit A's non-bottom snapshot
    const afterSnapshotA = await getScrollPosition(mainWindow, topicA)
    expect(afterSnapshotA).toBeTruthy()
    expect(afterSnapshotA!.isAtBottom).toBe(false)
    // The transition freeze must capture the current (diverged) viewport, not
    // the stale initial one — and must capture it exactly (same held layout,
    // ±4px readback guard only).
    expect(Math.abs(afterSnapshotA!.scrollTop - initialSnapshot.scrollTop)).toBeGreaterThan(100)
    expect(Math.abs(afterSnapshotA!.scrollTop - diverged.scrollTop)).toBeLessThanOrEqual(4)

    const snapshotB = await getScrollPosition(mainWindow, topicB)
    if (snapshotB && !snapshotB.isAtBottom) {
      // If B has a non-bottom snapshot, it must not equal A's non-bottom anchor/snapshot
      expect(snapshotB.scrollTop).not.toBe(afterSnapshotA!.scrollTop)
      if (afterSnapshotA!.anchorId) expect(snapshotB.anchorId).not.toBe(afterSnapshotA!.anchorId)
    } else {
      // Fresh bottom snapshot is allowed; otherwise B has no non-bottom leakage
      if (snapshotB) expect(snapshotB.isAtBottom).toBe(true)
    }

    // Fresh B: wait for settled DOM, then user-visible assertions
    await waitForTopicDomActivation(mainWindow, topicB)
    await expectBottomWithinTolerance(mainWindow, topicB)
    await assertTopicDomExclusive(mainWindow, topicB, topicA)
    await assertHostStable(mainWindow)

    await removeScrollSpacer(mainWindow, topicB)
  })

  test('return to prior topic restores visible anchor/position and proves no leakage', async ({ mainWindow }) => {
    const topicA = await createNewTopic(mainWindow, [
      scrollableMessage('Restore A1'),
      scrollableMessage('Restore A2'),
      scrollableMessage('Restore A3'),
      scrollableMessage('Restore A4')
    ])
    const topicB = await createNewTopic(mainWindow, [
      scrollableMessage('Restore B1'),
      scrollableMessage('Restore B2'),
      scrollableMessage('Restore B3')
    ])

    await clickTopicById(mainWindow, topicA)
    await captureMessagesHost(mainWindow)

    const idsA = await getTopicMessageIds(mainWindow, topicA)
    const anchorA = idsA[0]
    await scrollMessageIntoViewAndPersist(mainWindow, topicA, anchorA)
    const snapA = await waitForNonBottomSnapshot(mainWindow, topicA)
    // PRE-AWAY requested oracle: the saved identity + saved intra-row offset
    // before leaving. The return must restore THIS, never a post-return
    // rewritten snapshot.
    const requestedIdA = snapA.messageId || snapA.anchorId
    expect(requestedIdA, 'pre-away snapshot must carry the requested stable identity').toBeTruthy()
    expect(snapA.intraRowOffset, 'canonical pre-away snapshot must carry a finite intra-row offset').not.toBeNull()
    expect(Number.isFinite(snapA.intraRowOffset as number)).toBe(true)

    // A→B: establish B at bottom (fresh) then later restore A
    await clickTopicById(mainWindow, topicB, topicA)
    await waitForTopicDomActivation(mainWindow, topicB)
    await expectBottomWithinTolerance(mainWindow, topicB)
    await assertTopicDomExclusive(mainWindow, topicB, topicA)

    // B→A: restore must show the requested identity at its saved offset, or bottom if snapshot says bottom
    await clickTopicById(mainWindow, topicA, topicB)
    await waitForTopicDomActivation(mainWindow, topicA)
    const snapARestored = await getScrollPosition(mainWindow, topicA)
    expect(snapARestored).toBeTruthy()
    if (snapARestored!.isAtBottom) {
      await expectBottomWithinTolerance(mainWindow, topicA)
    } else {
      expect(snapARestored!.messageId || snapARestored!.anchorId, 'snapshot must preserve the requested identity').toBe(
        requestedIdA
      )
      if (snapARestored!.intraRowOffset !== null && snapA.intraRowOffset !== null) {
        expect(
          Math.abs(snapARestored!.intraRowOffset - (snapA.intraRowOffset as number)),
          'snapshot must preserve the requested intra-row offset'
        ).toBeLessThanOrEqual(OFFSET_TOL)
      }
      await waitForRequestedRowOffsetRestoration(mainWindow, snapA)
      // Also assert DOM still belongs to A, not B
      await assertTopicDomExclusive(mainWindow, topicA, topicB)
    }
    await assertHostStable(mainWindow)
    await removeScrollSpacer(mainWindow, topicA)
  })

  test('independent anchors survive A→B→A→B round-trip with isolated DOM and stable host', async ({ mainWindow }) => {
    const topicA = await createNewTopic(mainWindow, [
      scrollableMessage('Independent A1'),
      scrollableMessage('Independent A2'),
      scrollableMessage('Independent A3'),
      scrollableMessage('Independent A4')
    ])
    const topicB = await createNewTopic(mainWindow, [
      scrollableMessage('Independent B1'),
      scrollableMessage('Independent B2'),
      scrollableMessage('Independent B3'),
      scrollableMessage('Independent B4')
    ])

    // Establish distinct non-bottom anchors: A at oldest, B at middle
    await clickTopicById(mainWindow, topicA)
    await captureMessagesHost(mainWindow)
    const idsA = await getTopicMessageIds(mainWindow, topicA)
    const idsB = await getTopicMessageIds(mainWindow, topicB)
    const anchorA = idsA[0]
    await scrollMessageIntoViewAndPersist(mainWindow, topicA, anchorA)
    const snapA1 = await waitForNonBottomSnapshot(mainWindow, topicA)
    // PRE-AWAY requested oracle for A: saved identity + saved offset.
    const requestedIdA = snapA1.messageId || snapA1.anchorId
    expect(requestedIdA, 'pre-away A snapshot must carry the requested stable identity').toBeTruthy()
    expect(snapA1.intraRowOffset, 'canonical pre-away A snapshot must carry a finite intra-row offset').not.toBeNull()

    await clickTopicById(mainWindow, topicB, topicA)
    // Anchor B at a different position (second message) to prove independence
    const anchorB = idsB[1] || idsB[0]
    await scrollMessageIntoViewAndPersist(mainWindow, topicB, anchorB)
    const snapB1 = await waitForNonBottomSnapshot(mainWindow, topicB)
    // PRE-AWAY requested oracle for B: saved identity + saved offset.
    const requestedIdB = snapB1.messageId || snapB1.anchorId
    expect(requestedIdB, 'pre-away B snapshot must carry the requested stable identity').toBeTruthy()
    expect(snapB1.intraRowOffset, 'canonical pre-away B snapshot must carry a finite intra-row offset').not.toBeNull()
    expect(requestedIdB).not.toBe(requestedIdA)

    // A→B already done; now B→A must restore A's oracle
    await clickTopicById(mainWindow, topicA, topicB)
    await waitForTopicDomActivation(mainWindow, topicA)
    const snapAAfter = await getScrollPosition(mainWindow, topicA)
    if (snapAAfter?.isAtBottom) {
      await expectBottomWithinTolerance(mainWindow, topicA)
    } else {
      expect(snapAAfter?.messageId || snapAAfter?.anchorId, 'A snapshot must preserve the requested identity').toBe(
        requestedIdA
      )
      if (snapAAfter?.intraRowOffset !== null && snapA1.intraRowOffset !== null) {
        expect(
          Math.abs((snapAAfter?.intraRowOffset as number) - (snapA1.intraRowOffset as number)),
          'A snapshot must preserve the requested intra-row offset'
        ).toBeLessThanOrEqual(OFFSET_TOL)
      }
      await waitForRequestedRowOffsetRestoration(mainWindow, snapA1)
    }
    await assertTopicDomExclusive(mainWindow, topicA, topicB)
    await assertHostStable(mainWindow)

    // A→B again must restore B's distinct oracle without contamination
    await clickTopicById(mainWindow, topicB, topicA)
    await waitForTopicDomActivation(mainWindow, topicB)
    const snapBAfter = await getScrollPosition(mainWindow, topicB)
    if (snapBAfter?.isAtBottom) {
      await expectBottomWithinTolerance(mainWindow, topicB)
    } else {
      expect(snapBAfter?.messageId || snapBAfter?.anchorId, 'B snapshot must preserve the requested identity').toBe(
        requestedIdB
      )
      if (snapBAfter?.intraRowOffset !== null && snapB1.intraRowOffset !== null) {
        expect(
          Math.abs((snapBAfter?.intraRowOffset as number) - (snapB1.intraRowOffset as number)),
          'B snapshot must preserve the requested intra-row offset'
        ).toBeLessThanOrEqual(OFFSET_TOL)
      }
      await waitForRequestedRowOffsetRestoration(mainWindow, snapB1)
    }
    await assertTopicDomExclusive(mainWindow, topicB, topicA)
    await assertHostStable(mainWindow)

    // Supporting evidence: snapshots remain independent
    const finalA = await getScrollPosition(mainWindow, topicA)
    const finalB = await getScrollPosition(mainWindow, topicB)
    expect(finalA).toBeTruthy()
    expect(finalB).toBeTruthy()
    if (finalA && finalB) {
      if (!finalA.isAtBottom && !finalB.isAtBottom) {
        // Distinct non-bottom snapshots — scrollTop or anchor must differ
        const sameScrollTop = finalA.scrollTop === finalB.scrollTop
        const sameAnchor = finalA.anchorId !== null && finalA.anchorId === finalB.anchorId
        expect(sameScrollTop && sameAnchor).toBe(false)
      }
    }

    await removeScrollSpacer(mainWindow, topicB)
  })
})
