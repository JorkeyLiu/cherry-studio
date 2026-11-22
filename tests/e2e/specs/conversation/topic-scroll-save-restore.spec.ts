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

async function uiSendMessage(
  page: import('@playwright/test').Page,
  text: string,
  diag?: { topicId: string; sendIndex: number; sendTotal: number; prevCount: number }
): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  // Fill acceptance: the synthetic native-setter fill can be undone by a
  // renderer re-render (observed: value stayed "" past the 5s poll). Bounded
  // retry re-applies the identical fill sequence; the final attempt rethrows
  // the unchanged toHaveValue assertion — never swallowed or weakened.
  let fillError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
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
    try {
      await expect(textarea).toHaveValue(text, { timeout: 5000 })
      fillError = null
      break
    } catch (error) {
      fillError = error
    }
  }
  if (fillError) throw fillError
  await textarea.press('Enter')
  // Send acceptance gate (still Enter-based dispatch, never IPC): production
  // consumes the input on an accepted send. Failing fast here — with the
  // send index attached — instead of a 60s downstream assistant timeout.
  try {
    await expect(textarea).toHaveValue('', { timeout: 10000 })
  } catch (error) {
    try {
      if (diag) {
        const diagnostic = await collectAssistantResponseDiagnostic(
          page,
          diag.topicId,
          diag.prevCount,
          'send-acceptance',
          diag.sendIndex,
          diag.sendTotal
        )
        await test.info().attach(`send-acceptance-send-${diag.sendIndex}.json`, {
          body: JSON.stringify(diagnostic, null, 2),
          contentType: 'application/json'
        })
      }
    } catch {
      // Best-effort diagnostic only; never masks the original failure.
    }
    throw error
  }
}

async function collectAssistantResponseDiagnostic(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  phase: string,
  sendIndex?: number,
  sendTotal?: number
): Promise<Record<string, unknown>> {
  return page.evaluate(
    ({
      tid,
      prevCount,
      phaseName,
      idx,
      total
    }: {
      tid: string
      prevCount: number
      phaseName: string
      idx?: number
      total?: number
    }) => {
      const s = (window as any).store?.getState()
      const msgIds: string[] = s?.messages?.messageIdsByTopic?.[tid] || []
      const perMessage = msgIds.map((id: string) => {
        const m = s?.messages?.entities?.[id]
        // Roles/statuses only — never message text content.
        return { role: m?.role ?? null, status: m?.status ?? null }
      })
      let assistantSeen = 0
      for (const m of perMessage) if (m.role === 'assistant') assistantSeen++
      let latestAssistant: Record<string, unknown> | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        const m = s?.messages?.entities?.[msgIds[i]]
        if (m?.role === 'assistant') {
          const blockStatuses = ((m.blocks || []) as string[]).map((bid: string) => {
            const b = s?.messageBlocks?.entities?.[bid]
            // Block statuses only — never block content.
            return b?.status ?? null
          })
          latestAssistant = { status: m?.status ?? null, blockCount: (m.blocks || []).length, blockStatuses }
          break
        }
      }
      const ta = document.querySelector('.inputbar textarea, textarea[placeholder]') as HTMLTextAreaElement | null
      return {
        phase: phaseName,
        topicId: tid,
        previousAssistantCount: prevCount,
        assistantSeen,
        sendIndex: idx ?? null,
        sendTotal: total ?? null,
        messageCount: msgIds.length,
        perMessage,
        loadingByTopic: s?.messages?.loadingByTopic?.[tid] ?? null,
        currentTopicId: s?.messages?.currentTopicId ?? null,
        latestAssistant,
        textarea: ta
          ? {
              // Value length only — never the input text.
              valueLength: ta.value?.length ?? 0,
              disabled: ta.disabled,
              focused: document.activeElement === ta
            }
          : null
      }
    },
    { tid: topicId, prevCount: previousAssistantCount, phaseName: phase, idx: sendIndex, total: sendTotal }
  )
}

async function waitForAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000,
  diag?: { sendIndex?: number; sendTotal?: number }
): Promise<number> {
  try {
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
  } catch (error) {
    // Timeout diagnostics captured while the page is still open (before
    // fixture teardown closes it). Best-effort: never masks the original
    // failure. No message text, block content, API data, or credentials.
    try {
      const phase = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
      const diagnostic = await collectAssistantResponseDiagnostic(
        page,
        topicId,
        previousAssistantCount,
        phase,
        diag?.sendIndex,
        diag?.sendTotal
      )
      const tag = diag?.sendIndex !== undefined ? `send-${diag.sendIndex}` : 'unknown-send'
      await test.info().attach(`assistant-response-timeout-${tag}.json`, {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: 'application/json'
      })
    } catch {
      // Best-effort diagnostic only; never masks the original failure.
    }
    throw error
  }
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
    for (let sendIndex = 0; sendIndex < sendMessages.length; sendIndex++) {
      await uiSendMessage(page, sendMessages[sendIndex], {
        topicId,
        sendIndex,
        sendTotal: sendMessages.length,
        prevCount: assistantCount
      })
      assistantCount = await waitForAssistantResponseComplete(page, topicId, assistantCount, 60000, {
        sendIndex,
        sendTotal: sendMessages.length
      })
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

async function getDistBottom(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.getElementById('messages')
    return el ? el.scrollHeight - el.clientHeight - el.scrollTop : 0
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
      return el ? el.scrollHeight - el.clientHeight - el.scrollTop < 100 : false
    },
    undefined,
    { timeout: 10000 }
  )
  expect(await getDistBottom(page)).toBeLessThan(100)
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
      return el.scrollHeight - el.clientHeight - el.scrollTop > 300
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
      if ((await getDistBottom(page)) <= 300) break
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
  expect(await getDistBottom(page)).toBeGreaterThan(300)
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
// Branch-route history-anchor restore (bounded regression for the
// bootstrap-latest vs TOP-around race on topic return). Spec-local only:
// no shared-helper, config, fixture, or production-source changes.
//
// Topology: topic A carries a non-main branch route with 14 effective rows
// (4-row ancestor prefix + 10-row owned suffix); default displayCount is 10
// (asserted read-only, never dispatched), so bootstrap latest(10) holds only
// the suffix and never the route-oldest anchor. The anchor is made truly
// visible first through real wheel pagination (production save path — the
// snapshot is only read by this spec, never written), the topic round-trips
// A->B->A via visible topic-item coordinate clicks (the topic list lives
// outside #messages, so no click auto-scroll can pollute the messages
// viewport), and the return must restore the anchor automatically: no wheel,
// no load-older, same branch, saved identity + saved offset (existing
// OFFSET_TOL, never weakened). Frame sampling starts BEFORE the B->A click
// (page-viewport-resume pattern): the first and every subsequent *eligible*
// visible frame must already show the anchor. Eligible excludes only
// genuinely transitional frames (messages hidden, container hidden,
// positioning phase, in-flight route load); a settled wrong-window paint
// stays eligible and fails.
// ---------------------------------------------------------------------------

const BRANCH_RESTORE_MAIN_TOTAL = 10
const BRANCH_RESTORE_SUFFIX_TOTAL = 10
const BRANCH_RESTORE_FORK_IDX = 3

function padBranchIdx(n: number): string {
  return String(n).padStart(5, '0')
}

function branchRestoreContent(tag: string, i: number): string {
  return `branch anchor seed ${tag}-${padBranchIdx(i)} ${'deterministic scrollable content '.repeat(60)}`
}

interface BranchRestoreTopology {
  topicId: string
  branchId: string
  anchorId: string
  mainIds: string[]
  suffixIds: string[]
  effectiveIds: string[]
}

async function seedBranchRestoreTopic(
  page: import('@playwright/test').Page,
  assistantId: string,
  topicId: string,
  name: string
): Promise<BranchRestoreTopology> {
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
    { topicId, assistantId, name }
  )
  expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)

  const mainIds: string[] = []
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < BRANCH_RESTORE_MAIN_TOTAL; i++) {
    const msgId = `${topicId}-msg-${padBranchIdx(i)}`
    const blockId = `${topicId}-block-${padBranchIdx(i)}`
    mainIds.push(msgId)
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const message: Record<string, unknown> = {
      id: msgId,
      topicId,
      role,
      assistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      sortOrder: i
    }
    if (role === 'assistant') message.askId = mainIds[i - 1]
    entries.push({
      message,
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: branchRestoreContent('main', i),
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
        const ensured = await api.chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        const pasted = await api.chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persist.ok, `persist failed: ${(persist as any).err}`).toBe(true)

  const forkAnchor = mainIds[BRANCH_RESTORE_FORK_IDX]
  const created: any = await page.evaluate(
    async ({ tid, anchor }: { tid: string; anchor: string }) =>
      await (window as any).api.chatDb.createBranch({
        topicId: tid,
        parentBranchId: null,
        anchorMessageId: anchor,
        name: `E2E branch ${tid}`
      }),
    { tid: topicId, anchor: forkAnchor }
  )
  expect(created?.ok, `createBranch failed: ${JSON.stringify(created)}`).toBe(true)
  const branchId = created.value.branch.id as string
  expect(branchId, 'branch id must be issued by Main').toBeTruthy()

  let afterId = forkAnchor
  const suffixIds: string[] = []
  for (let k = 0; k < BRANCH_RESTORE_SUFFIX_TOTAL; k++) {
    const mid = `${topicId}-suffix-${padBranchIdx(k)}`
    const blockId = `${topicId}-suffix-block-${padBranchIdx(k)}`
    const role = (BRANCH_RESTORE_MAIN_TOTAL + k) % 2 === 0 ? 'user' : 'assistant'
    const message: Record<string, unknown> = {
      id: mid,
      topicId,
      role,
      assistantId,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    if (role === 'assistant') message.askId = afterId
    const entry = {
      message,
      blocks: [
        {
          id: blockId,
          messageId: mid,
          type: 'main_text',
          content: branchRestoreContent('suffix', k),
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    }
    const inserted: any = await page.evaluate(
      async ({ tid, bid, after, entry }: { tid: string; bid: string; after: string; entry: unknown }) =>
        await (window as any).api.chatDb.insertMessagesAfterAnchor({
          topicId: tid,
          branchId: bid,
          afterMessageId: after,
          entries: [entry]
        }),
      { tid: topicId, bid: branchId, after: afterId, entry }
    )
    expect(inserted?.ok, `suffix insert ${k} failed: ${JSON.stringify(inserted)}`).toBe(true)
    suffixIds.push(mid)
    afterId = mid
  }

  const route: any = await page.evaluate(
    async ({ tid, bid }: { tid: string; bid: string }) =>
      await (window as any).api.chatDb.fetchMessages({ topicId: tid, branchId: bid }),
    { tid: topicId, bid: branchId }
  )
  expect(route?.ok, `effective route fetch failed: ${JSON.stringify(route)}`).toBe(true)
  const effectiveIds = (route.value.messages as Array<{ id: string }>).map((m) => m.id)
  expect(effectiveIds, 'effective branch route must be anchor-inclusive prefix + owned suffix').toEqual([
    ...mainIds.slice(0, BRANCH_RESTORE_FORK_IDX + 1),
    ...suffixIds
  ])
  expect(effectiveIds.length, 'effective branch route must hold 14 rows').toBe(
    BRANCH_RESTORE_FORK_IDX + 1 + BRANCH_RESTORE_SUFFIX_TOTAL
  )
  return { topicId, branchId, anchorId: mainIds[0], mainIds, suffixIds, effectiveIds }
}

async function seedSmallMainTopic(
  page: import('@playwright/test').Page,
  assistantId: string,
  topicId: string,
  name: string,
  total: number
): Promise<string[]> {
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
    { topicId, assistantId, name }
  )
  expect(addOk.ok, `addTopic failed: ${(addOk as any).err}`).toBe(true)
  const ids: string[] = []
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < total; i++) {
    const msgId = `${topicId}-msg-${padBranchIdx(i)}`
    const blockId = `${topicId}-block-${padBranchIdx(i)}`
    ids.push(msgId)
    entries.push({
      message: {
        id: msgId,
        topicId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        assistantId,
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
          content: `small topic seed ${padBranchIdx(i)}`,
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
        const ensured = await api.chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic failed ${JSON.stringify(ensured)}` }
        const pasted = await api.chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste failed ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persist.ok, `persist failed: ${(persist as any).err}`).toBe(true)
  return ids
}

async function getBranchScrollPosition(
  page: import('@playwright/test').Page,
  topicId: string,
  branchId: string
): Promise<ScrollSnapshot | null> {
  return page.evaluate(
    ({ topicId, branchId }: { topicId: string; branchId: string }) => {
      const keys = [`scroll:topic-${topicId}::${branchId}`, `scroll:topic-${topicId}::main`, `scroll:topic-${topicId}`]
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
    { topicId, branchId }
  )
}

async function waitForBranchAnchorSnapshot(
  page: import('@playwright/test').Page,
  topicId: string,
  branchId: string,
  anchorId: string,
  timeout = 15000
): Promise<ScrollSnapshot> {
  await page.waitForFunction(
    ({ tid, bid, aid }: { tid: string; bid: string; aid: string }) => {
      const keys = [`scroll:topic-${tid}::${bid}`, `scroll:topic-${tid}::main`, `scroll:topic-${tid}`]
      for (const key of keys) {
        const v = (window as any).keyv?.get(key)
        if (v && typeof v === 'object' && 'scrollTop' in v && v.isAtBottom === false) {
          const id =
            typeof v.messageId === 'string' && v.messageId.length > 0
              ? v.messageId
              : typeof v.anchorId === 'string'
                ? v.anchorId
                : null
          if (id === aid && typeof v.intraRowOffset === 'number' && Number.isFinite(v.intraRowOffset)) return true
        }
      }
      return false
    },
    { tid: topicId, bid: branchId, aid: anchorId },
    { timeout }
  )
  const snap = await getBranchScrollPosition(page, topicId, branchId)
  if (!snap) throw new Error(`no branch snapshot for ${topicId} after wait`)
  return snap
}

/**
 * Visible topic-item coordinate click. The topic list lives outside
 * #messages, and mouse.click at coordinates performs no Playwright
 * auto-scroll, so the messages viewport cannot be polluted by this
 * navigation (unlike locator.click auto-scroll semantics).
 */
async function clickTopicItemByCoords(
  page: import('@playwright/test').Page,
  topicId: string,
  previousTopicId?: string
): Promise<void> {
  if (previousTopicId) await removeScrollSpacer(page, previousTopicId)
  const item = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await item.waitFor({ state: 'attached', timeout: 15000 })
  await item.scrollIntoViewIfNeeded()
  await item.waitFor({ state: 'visible', timeout: 15000 })
  const box = await item.boundingBox()
  if (!box) throw new Error(`topic item ${topicId} has no bounding box for coordinate click`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await waitForActiveTopic(page, topicId)
}

async function switchToBranchRouteViaCascader(
  page: import('@playwright/test').Page,
  topicId: string,
  branchId: string,
  expectedLen: number
): Promise<void> {
  await page.locator('[data-testid="branch-selector-entry"]').first().click()
  await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
  await page.locator(`[data-testid="branch-cascader-item-${branchId}"]`).first().click()
  await page.waitForFunction(
    ({ tid, bid, len }: { tid: string; bid: string; len: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[tid]
      return (
        s.topicBranch?.activeBranchIdByTopic?.[tid] === bid &&
        Array.isArray(ids) &&
        ids.length === len &&
        s.messages?.loadingByTopic?.[tid] !== true
      )
    },
    { tid: topicId, bid: branchId, len: expectedLen },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected: number) => document.querySelectorAll('#messages [data-message-id]').length === expected,
    expectedLen,
    { timeout: 30000 }
  )
}

async function isMessageVisibleInContainer(page: import('@playwright/test').Page, messageId: string): Promise<boolean> {
  return page.evaluate((mid: string) => {
    const container = document.getElementById('messages')
    const el = document.getElementById(`message-${mid}`)
    if (!container || !el || !el.isConnected) return false
    if (window.getComputedStyle(el).display === 'none') return false
    const c = container.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.height === 0) return false
    return Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0
  }, messageId)
}

/**
 * Genuine-user pagination toward history: real wheel input pages the branch
 * bootstrap (latest 10) up until the route-oldest anchor is truly visible,
 * then fine-tunes it into a nonzero mid-viewport band so the production
 * commit carries a real row offset (not an edge clamp). Settles scrollend +
 * keeper before reading the committed pre-away snapshot.
 */
async function wheelHistoryAnchorIntoView(
  page: import('@playwright/test').Page,
  topicId: string,
  branchId: string,
  anchorId: string
): Promise<ScrollSnapshot> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 40; i++) {
    if (await isMessageVisibleInContainer(page, anchorId)) break
    await page.mouse.wheel(0, -640)
    await page.waitForTimeout(220)
  }
  expect(
    await isMessageVisibleInContainer(page, anchorId),
    'history anchor must become visible via real wheel pagination'
  ).toBe(true)
  for (let i = 0; i < 16; i++) {
    const m = await measureRequestedRow(page, anchorId)
    if (m && m.found && m.offset >= 40 && m.offset <= 220) break
    await page.mouse.wheel(0, (m?.offset ?? 999) < 40 ? -160 : 160)
    await page.waitForTimeout(220)
  }
  expect(
    await isMessageVisibleInContainer(page, anchorId),
    'history anchor must stay visible after offset tuning'
  ).toBe(true)
  await page.waitForTimeout(1200)
  const snap = await waitForBranchAnchorSnapshot(page, topicId, branchId, anchorId, 15000)
  expect(snap.isAtBottom, 'pre-away branch snapshot must be a non-bottom reading position').toBe(false)
  return snap
}

interface BranchReturnFrame {
  t: number
  anchorId: string
  anchorOffset: number
  scrollTop: number
  phase: string
  messagesVisible: boolean
  containerVis: string
  loading: boolean
}

async function startBranchReturnProbe(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  await page.evaluate(
    ({ tid, k }: { tid: string; k: string }) => {
      const frames: BranchReturnFrame[] = []
      let running = true
      let raf = 0
      const t0 = performance.now()
      const readFrame = (): BranchReturnFrame => {
        const container = document.querySelector('#messages') as HTMLElement | null
        let messagesVisible = false
        let containerVis = ''
        let anchorId = ''
        let anchorOffset = 0
        let scrollTop = NaN
        let phase = ''
        try {
          if (container) {
            const cs = getComputedStyle(container)
            containerVis = cs.visibility
            const r = container.getBoundingClientRect()
            messagesVisible = cs.display !== 'none' && r.width > 0 && r.height > 0
            scrollTop = container.scrollTop
            phase = container.getAttribute('data-viewport-phase') ?? ''
            const c = container.getBoundingClientRect()
            const rows = Array.from(container.querySelectorAll('[data-message-id]')) as HTMLElement[]
            const cands: { id: string; top: number; bottom: number }[] = []
            for (const row of rows) {
              const br = row.getBoundingClientRect()
              const id = row.getAttribute('data-message-id')
              if (id) cands.push({ id, top: br.top, bottom: br.bottom })
            }
            if (cands.length > 0) {
              const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
              const picked =
                crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
              anchorId = picked.id
              anchorOffset = picked.top - c.top
            }
          }
        } catch {
          // keep defaults; the frame still records the failure shape
        }
        let loading = false
        try {
          loading = (window as any).store?.getState()?.messages?.loadingByTopic?.[tid] === true
        } catch {
          // keep default
        }
        return {
          t: Math.round((performance.now() - t0) * 10) / 10,
          anchorId,
          anchorOffset: Math.round(anchorOffset * 10) / 10,
          scrollTop: Math.round(scrollTop * 10) / 10,
          phase,
          messagesVisible,
          containerVis,
          loading
        }
      }
      const tick = () => {
        if (!running) return
        frames.push(readFrame())
        raf = requestAnimationFrame(tick)
      }
      tick()
      ;(window as any)[k] = {
        frames,
        stop: () => {
          running = false
          try {
            cancelAnimationFrame(raf)
          } catch {
            // ignore
          }
        }
      }
    },
    { tid: topicId, k: '__branch_return_probe' }
  )
}

async function stopBranchReturnProbe(page: import('@playwright/test').Page): Promise<BranchReturnFrame[]> {
  return page
    .evaluate((k: string) => {
      const p = (window as any)[k] as { frames: BranchReturnFrame[]; stop: () => void } | undefined
      try {
        p?.stop?.()
      } catch {
        // ignore
      }
      const frames = p ? [...p.frames] : []
      delete (window as any)[k]
      return { frames }
    }, '__branch_return_probe')
    .then((r: { frames: BranchReturnFrame[] }) => r.frames)
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
  test('branch-route history anchor auto-restores on topic return without paging (bootstrap-latest race)', async ({
    mainWindow
  }) => {
    const page = mainWindow
    const displayCount = await page.evaluate(() => (window as any).store.getState().messages?.displayCount)
    expect(displayCount, 'default displayCount must be 10 (no global config change)').toBe(10)
    const liveAssistantId = await page.evaluate(
      () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
    )
    expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topo = await seedBranchRestoreTopic(
      page,
      liveAssistantId as string,
      `branch-anchor-a-${stamp}`,
      `Branch A ${stamp}`
    )
    const { topicId: topicA, branchId, anchorId } = topo

    // Main-authoritative bound: bootstrap latest(10) on the branch route must
    // not contain the route-oldest anchor.
    const latestRes: any = await page.evaluate(
      async ({ tid, bid }: { tid: string; bid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({
          kind: 'latest',
          topicId: tid,
          branchId: bid,
          limit: 10
        }),
      { tid: topicA, bid: branchId }
    )
    expect(latestRes.ok, `branch latest oracle failed: ${JSON.stringify(latestRes)}`).toBe(true)
    expect(latestRes.value.window.returnedCount).toBe(10)
    expect((latestRes.value.messages as Array<{ id: string }>).map((m) => m.id)).not.toContain(anchorId)

    const topicB = `branch-anchor-b-${stamp}`
    await seedSmallMainTopic(page, liveAssistantId as string, topicB, `Branch B ${stamp}`, 4)

    // Activate A on its main route (bootstrap latest 10 of 10 main rows).
    await clickTopicItemByCoords(page, topicA)
    await waitForTopicDomActivation(page, topicA)
    const mainResident = await getTopicMessageIds(page, topicA)
    expect(mainResident.length).toBe(BRANCH_RESTORE_MAIN_TOTAL)

    // Switch to the branch route through the production cascader UI:
    // bootstrap latest(10) holds only the owned suffix, anchor absent.
    await switchToBranchRouteViaCascader(page, topicA, branchId, 10)
    const bootResident = await getTopicMessageIds(page, topicA)
    expect(bootResident).toEqual(topo.suffixIds)
    expect(bootResident).not.toContain(anchorId)
    const bootDom = await getRenderedMessageIds(page)
    expect(bootDom).not.toContain(anchorId)

    // Genuine-user pagination makes the history anchor truly visible; the
    // production path commits the pre-away snapshot (read-only oracle here).
    await captureMessagesHost(page)
    const preAway = await wheelHistoryAnchorIntoView(page, topicA, branchId, anchorId)
    const requestedId = preAway.messageId || preAway.anchorId
    expect(requestedId, 'pre-away snapshot must carry the history anchor identity').toBe(anchorId)
    expect(preAway.intraRowOffset, 'pre-away snapshot must carry a finite intra-row offset').not.toBeNull()
    expect(Number.isFinite(preAway.intraRowOffset as number)).toBe(true)
    const savedOffset = preAway.intraRowOffset as number

    // A->B through a visible topic-item coordinate click.
    await clickTopicItemByCoords(page, topicB, topicA)
    await waitForTopicDomActivation(page, topicB)
    await assertTopicDomExclusive(page, topicB, topicA)

    // B->A with the return probe sampling from BEFORE the click. No wheel,
    // no load-older, no snapshot write anywhere after this point.
    await startBranchReturnProbe(page, topicA)
    await clickTopicItemByCoords(page, topicA, topicB)
    await waitForTopicDomActivation(page, topicA)
    await page.waitForFunction(
      ({ tid, bid }: { tid: string; bid: string }) =>
        (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] === bid,
      { tid: topicA, bid: branchId },
      { timeout: 30000 }
    )
    await waitForRequestedRowOffsetRestoration(page, preAway, 30000)
    const frames = await stopBranchReturnProbe(page)

    // The anchor window published (not the superseding latest-10): the
    // resident carries the saved anchor and never shrinks below bootstrap.
    const returnedIds = await getTopicMessageIds(page, topicA)
    expect(returnedIds, 'returned resident must carry the saved history anchor').toContain(anchorId)
    expect(returnedIds.length, 'returned resident must not shrink below bootstrap').toBeGreaterThanOrEqual(10)

    // Main-row true stable identity in the DOM (never the nav list).
    const domAnchor = await page.evaluate((mid: string) => {
      const byAttr = document.querySelector(`#messages [data-message-id="${mid}"]`)
      const byId = document.getElementById(`message-${mid}`)
      return { attr: !!byAttr, connected: !!byId && byId.isConnected }
    }, anchorId)
    expect(domAnchor.attr, 'history anchor must be rendered in #messages').toBe(true)
    expect(domAnchor.connected, 'history anchor true row element must stay connected').toBe(true)
    const returnedDom = await getRenderedMessageIds(page)
    expect(returnedDom, 'rendered rows must match the returned resident set').toEqual(
      expect.arrayContaining(returnedIds)
    )
    expect(returnedDom.length).toBe(returnedIds.length)

    // Same branch route restored (not reset to main).
    const restoredBranch = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      topicA
    )
    expect(restoredBranch, 'topic return must restore the same branch route').toBe(branchId)

    // The persisted snapshot still carries the requested identity + offset.
    const snapAfter = await getBranchScrollPosition(page, topicA, branchId)
    expect(snapAfter).toBeTruthy()
    expect(snapAfter!.isAtBottom).toBe(false)
    expect(snapAfter!.messageId || snapAfter!.anchorId, 'snapshot must preserve the requested identity').toBe(
      requestedId
    )
    if (snapAfter!.intraRowOffset !== null && preAway.intraRowOffset !== null) {
      expect(
        Math.abs(snapAfter!.intraRowOffset - (preAway.intraRowOffset as number)),
        'snapshot must preserve the requested intra-row offset'
      ).toBeLessThanOrEqual(OFFSET_TOL)
    }

    // First and every subsequent eligible visible frame already holds the
    // saved anchor at its saved offset (viewport ADR). Only genuinely
    // transitional frames (hidden/positioning/in-flight load) are excluded,
    // plus pre-click frames from the other topic: the probe starts BEFORE the
    // B->A click, so early eligible frames still show topic B. The
    // target-route gate (anchorId must belong to the returned resident)
    // drops those without hiding signal: a settled wrong-window paint of
    // topic A itself stays eligible and fails.
    const visibleAny = frames.filter((f) => f.messagesVisible && f.containerVis !== 'hidden')
    const eligible = frames.filter(
      (f) =>
        f.messagesVisible &&
        f.containerVis !== 'hidden' &&
        f.phase !== 'positioning' &&
        !f.loading &&
        f.anchorId &&
        returnedIds.includes(f.anchorId)
    )
    const firstEligible = eligible.length > 0 ? eligible[0] : null
    test.info().annotations.push({
      type: 'branch-anchor-return-frames',
      description:
        `frames=${frames.length} visibleAny=${visibleAny.length} eligible=${eligible.length} ` +
        `expected=${anchorId.slice(0, 24)}@${Math.round(savedOffset)} ` +
        `firstEligible=${firstEligible ? `${firstEligible.anchorId.slice(0, 24)}@${Math.round(firstEligible.anchorOffset)} st=${Math.round(firstEligible.scrollTop)} phase=${firstEligible.phase}` : 'none'}`
    })
    expect(frames.length, 'probe must sample return frames').toBeGreaterThan(0)
    expect(frames.length - visibleAny.length, 'must not hide every sample').toBeLessThan(frames.length)
    expect(eligible.length, 'return must paint eligible visible frames (no hide-to-pass)').toBeGreaterThan(0)
    expect(firstEligible!.anchorId, 'first eligible visible frame must already show the saved anchor').toBe(anchorId)
    expect(
      Math.abs(firstEligible!.anchorOffset - savedOffset),
      'first eligible visible frame must already hold the saved offset'
    ).toBeLessThanOrEqual(OFFSET_TOL)
    const badIdx = eligible.findIndex(
      (f) => f.anchorId !== anchorId || Math.abs(f.anchorOffset - savedOffset) > OFFSET_TOL
    )
    expect(badIdx, 'first and every subsequent eligible visible frame must hold the saved anchor@offset').toBe(-1)

    await assertTopicDomExclusive(page, topicA, topicB)
    await assertHostStable(page)
    await removeScrollSpacer(page, topicA)
  })
})
