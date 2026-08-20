/**
 * Topic Switch Scroll Save/Restore — S3.2 E2E Regression (production contract)
 *
 * Production contract (useScrollPosition + messageNavigation):
 *   snapshot = { scrollTop, anchorId, isAtBottom }
 *   bootstrap restore priority: bottom > anchorId > scrollTop
 *   fresh bottom snapshots are valid; browser/layout clamps pixels.
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

async function getScrollPosition(
  page: import('@playwright/test').Page,
  topicId: string
): Promise<{ scrollTop: number; anchorId: string | null; isAtBottom: boolean } | null> {
  return page.evaluate((key: string) => {
    const val = (window as any).keyv?.get(key)
    if (val && typeof val === 'object' && 'scrollTop' in val) {
      return val as { scrollTop: number; anchorId: string | null; isAtBottom: boolean }
    }
    return null
  }, `scroll:topic-${topicId}`)
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
): Promise<{ scrollTop: number; anchorId: string | null; isAtBottom: boolean }> {
  await page.waitForFunction(
    ({ key }: { key: string }) => {
      const v = (window as any).keyv?.get(key)
      return v && typeof v === 'object' && 'isAtBottom' in v && v.isAtBottom === false
    },
    { key: `scroll:topic-${topicId}` },
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
  await ensureOverflow(page, topicId)
  const scrollTop = await page.evaluate(
    ({ mid }) => {
      const container = document.getElementById('messages')
      const target = document.getElementById(`message-${mid}`)
      if (!container) throw new Error('#messages not found')
      if (!target) throw new Error(`message-${mid} not found`)
      target.scrollIntoView({ block: 'start', behavior: 'auto' })
      container.dispatchEvent(new Event('scroll', { bubbles: true }))
      return container.scrollTop
    },
    { mid: messageId }
  )
  return scrollTop
}

async function setContainerScrollTopWithoutEvent(
  page: import('@playwright/test').Page,
  topicId: string,
  targetScrollTop: number
): Promise<number> {
  await ensureOverflow(page, topicId)
  return page.evaluate((target: number) => {
    const el = document.getElementById('messages')
    if (!el) throw new Error('#messages container not found')
    el.scrollTop = target
    return el.scrollTop
  }, targetScrollTop)
}

async function waitForAnchorOrVisibleRestoration(
  page: import('@playwright/test').Page,
  expectedAnchorId: string | null,
  fallbackVisibleId: string | null,
  timeout = 10000
): Promise<void> {
  const oracleId = expectedAnchorId || fallbackVisibleId
  if (!oracleId) throw new Error('no anchor or fallback visible id for restoration oracle')
  await page.waitForFunction(
    ({ id }: { id: string }) => {
      const container = document.getElementById('messages')
      if (!container) return false
      const el = document.getElementById(`message-${id}`)
      if (!el) return false
      if (window.getComputedStyle(el).display === 'none') return false
      const rect = el.getBoundingClientRect()
      if (rect.height === 0) return false
      const cRect = container.getBoundingClientRect()
      const visibleHeight = Math.min(rect.bottom, cRect.bottom) - Math.max(rect.top, cRect.top)
      return visibleHeight > 0
    },
    { id: oracleId },
    { timeout }
  )
  // Also ensure it is near the container top (within viewport) — relative position
  const nearTop = await page.evaluate(
    ({ id }) => {
      const container = document.getElementById('messages')
      const el = document.getElementById(`message-${id}`)
      if (!container || !el) return false
      const cRect = container.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return Math.abs(r.top - cRect.top) < cRect.height
    },
    { id: oracleId }
  )
  expect(nearTop).toBe(true)
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

    // Change live DOM to a distinct unsaved non-bottom state WITHOUT scroll event
    const transitionTarget = initialSnapshot.scrollTop + 200
    const actualTransitionDomTop = await setContainerScrollTopWithoutEvent(mainWindow, topicA, transitionTarget)
    // Ensure DOM actually moved to a different non-bottom offset
    expect(actualTransitionDomTop).not.toBe(initialSnapshot.scrollTop)

    // A→B: transition coordinator saves old-topic snapshot to old key
    await clickTopicById(mainWindow, topicB, topicA)

    // Supporting key evidence only: outgoing A snapshot changed, B did not inherit A's non-bottom snapshot
    const afterSnapshotA = await getScrollPosition(mainWindow, topicA)
    expect(afterSnapshotA).toBeTruthy()
    expect(afterSnapshotA!.isAtBottom).toBe(false)
    expect(afterSnapshotA!.scrollTop).not.toBe(initialSnapshot.scrollTop)

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
    const visibleA = await getFirstVisibleMessageId(mainWindow)
    expect(visibleA).toBeTruthy()
    const savedAnchorA = snapA.anchorId || visibleA

    // A→B: establish B at bottom (fresh) then later restore A
    await clickTopicById(mainWindow, topicB, topicA)
    await waitForTopicDomActivation(mainWindow, topicB)
    await expectBottomWithinTolerance(mainWindow, topicB)
    await assertTopicDomExclusive(mainWindow, topicB, topicA)

    // B→A: restore must show A's anchor/visible message near top, or bottom if snapshot says bottom
    await clickTopicById(mainWindow, topicA, topicB)
    await waitForTopicDomActivation(mainWindow, topicA)
    const snapARestored = await getScrollPosition(mainWindow, topicA)
    expect(snapARestored).toBeTruthy()
    if (snapARestored!.isAtBottom) {
      await expectBottomWithinTolerance(mainWindow, topicA)
    } else {
      await waitForAnchorOrVisibleRestoration(mainWindow, snapARestored!.anchorId, visibleA)
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
    const visibleA1 = await getFirstVisibleMessageId(mainWindow)
    const oracleA = snapA1.anchorId || visibleA1
    expect(oracleA).toBeTruthy()

    await clickTopicById(mainWindow, topicB, topicA)
    // Anchor B at a different position (second message) to prove independence
    const anchorB = idsB[1] || idsB[0]
    await scrollMessageIntoViewAndPersist(mainWindow, topicB, anchorB)
    const snapB1 = await waitForNonBottomSnapshot(mainWindow, topicB)
    const visibleB1 = await getFirstVisibleMessageId(mainWindow)
    const oracleB = snapB1.anchorId || visibleB1
    expect(oracleB).toBeTruthy()
    expect(oracleB).not.toBe(oracleA)

    // A→B already done; now B→A must restore A's oracle
    await clickTopicById(mainWindow, topicA, topicB)
    await waitForTopicDomActivation(mainWindow, topicA)
    const snapAAfter = await getScrollPosition(mainWindow, topicA)
    if (snapAAfter?.isAtBottom) {
      await expectBottomWithinTolerance(mainWindow, topicA)
    } else {
      await waitForAnchorOrVisibleRestoration(mainWindow, snapAAfter?.anchorId || null, visibleA1)
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
      await waitForAnchorOrVisibleRestoration(mainWindow, snapBAfter?.anchorId || null, visibleB1)
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
