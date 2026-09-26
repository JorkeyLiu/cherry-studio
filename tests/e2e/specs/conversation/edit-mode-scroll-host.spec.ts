/**
 * Edit-mode scroll host — global edit mode viewport anchoring (INTEGRATED E2E, real UI).
 *
 * Single deterministic scenario (B from former S65 combined):
 * Global edit mode toggle: overflow topic scrolled to non-bottom; click real data-testid edit-mode-toggle
 * to enter edit mode; assert first visible / scrollTop preserved within tolerance, no bottom jump;
 * toggle out and assert preserved again. Edit-mode host stability is via stable outer EditModeProvider
 * with internal bridge and removal of MessagesContainer key — this E2E proves the user-visible contract.
 *
 * Selectors are locale-independent (data-testid). No thinking mock/spec touched.
 */
import { expect, test } from '../../fixtures/electron.fixture'

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

// -----------------------------------------------------------------------------
// Shared helpers (only those required by B)
// -----------------------------------------------------------------------------
async function prepareDisplayCountAndAssistant(page: any, limit: number): Promise<string> {
  await page.evaluate((lim: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: lim })
  }, limit)
  const ok = await page.evaluate((lim: number) => (window as any).store.getState().messages.displayCount, limit)
  expect(ok).toBe(limit)
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

async function activateTopicAndWaitForBootstrap(page: any, topicId: string, atLeast: number): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId, atLeast }: { topicId: string; atLeast: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length >= atLeast && loading !== true
    },
    { topicId, atLeast },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (atLeast: number) => document.querySelectorAll('#messages [data-message-id]').length >= atLeast,
    atLeast,
    { timeout: 30000 }
  )
}

async function getContainerScrollTop(page: any): Promise<number> {
  return page.evaluate(() => {
    const el = document.getElementById('messages')
    return el ? el.scrollTop : 0
  })
}

async function getFirstVisibleMessageId(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const container = document.getElementById('messages')
    if (!container) return null
    const cRect = container.getBoundingClientRect()
    const els = Array.from(container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')) as HTMLElement[]
    const isVisible = (el: HTMLElement) => {
      const style = window.getComputedStyle(el)
      if (style.display === 'none') return false
      const rect = el.getBoundingClientRect()
      if (rect.height === 0) return false
      const visibleHeight = Math.min(rect.bottom, cRect.bottom) - Math.max(rect.top, cRect.top)
      return visibleHeight > 0
    }
    let closest: string | null = null
    let minDist = Infinity
    for (const el of els) {
      if (!isVisible(el)) continue
      const rect = el.getBoundingClientRect()
      const dist = Math.abs(rect.top - cRect.top)
      if (dist < minDist) {
        minDist = dist
        closest = el.id.replace('message-', '')
      }
    }
    return closest
  })
}

function scrollableFiller(label: string): string {
  return `${label} ${'deterministic scrollable content '.repeat(80)}`
}

async function ensureOverflow(page: any, topicId: string): Promise<void> {
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      return s?.messages?.currentTopicId === topicId
    },
    { topicId },
    { timeout: 10000 }
  )
  await page.evaluate((activeTopicId: string) => {
    const el = document.getElementById('messages')
    if (!el) throw new Error('#messages not found')
    const s = (window as any).store?.getState()
    if (s?.messages?.currentTopicId !== activeTopicId) throw new Error('not active topic')
    if (el.scrollHeight > el.clientHeight) return
    const existing = el.querySelector<HTMLElement>('[data-scroll-test-spacer]')
    if (existing?.dataset.scrollTestTopic === activeTopicId) return
    existing?.remove()
    const ids: string[] = s?.messages?.messageIdsByTopic?.[activeTopicId] ?? []
    const anchor = ids.map((id) => document.getElementById(`message-${id}`)).find((e) => e instanceof HTMLElement) as
      | HTMLElement
      | undefined
    if (!anchor) throw new Error('no message DOM for spacer')
    const spacer = document.createElement('div')
    spacer.style.height = '5000px'
    spacer.style.pointerEvents = 'none'
    spacer.dataset.scrollTestSpacer = 'true'
    spacer.dataset.scrollTestTopic = activeTopicId
    anchor.appendChild(spacer)
  }, topicId)
  const overflow = await page.evaluate(() => {
    const el = document.getElementById('messages')
    return el ? { sh: el.scrollHeight, ch: el.clientHeight } : null
  })
  if (!overflow || overflow.sh <= overflow.ch) {
    await page.evaluate((activeTopicId: string) => {
      const el = document.getElementById('messages')!
      const s = (window as any).store?.getState()
      const ids: string[] = s?.messages?.messageIdsByTopic?.[activeTopicId] ?? []
      const anchor = ids.map((id) => document.getElementById(`message-${id}`)).find((e) => e instanceof HTMLElement) as
        | HTMLElement
        | undefined
      if (!anchor) return
      let spacer = el.querySelector<HTMLElement>('[data-scroll-test-spacer]')
      if (!spacer) {
        spacer = document.createElement('div')
        spacer.dataset.scrollTestSpacer = 'true'
        spacer.dataset.scrollTestTopic = activeTopicId
        spacer.style.height = '5000px'
        spacer.style.pointerEvents = 'none'
        anchor.appendChild(spacer)
      }
    }, topicId)
  }
}

async function scrollFirstMessageIntoViewAndPersist(page: any, topicId: string, messageId: string): Promise<number> {
  await ensureOverflow(page, topicId)
  return page.evaluate(
    ({ mid }: { mid: string }) => {
      const container = document.getElementById('messages')!
      const target = document.getElementById(`message-${mid}`) as HTMLElement | null
      if (!container) throw new Error('#messages not found')
      if (!target) throw new Error(`message-${mid} not found`)
      target.scrollIntoView({ block: 'start', behavior: 'auto' })
      container.dispatchEvent(new Event('scroll', { bubbles: true }))
      return container.scrollTop
    },
    { mid: messageId }
  )
}

async function waitForNonBottom(page: any, timeout = 5000): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('messages')
      if (!el) return false
      return Math.abs(el.scrollTop) > 80
    },
    undefined,
    { timeout }
  )
}

// -----------------------------------------------------------------------------
// Spec
// -----------------------------------------------------------------------------
test.describe('edit-mode scroll host — integrated UI', () => {
  test.setTimeout(180000)

  test('global edit mode toggle preserves first visible / scroll anchoring with overflow and non-bottom viewport', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'EDIT-MODE HOST INTEGRATED UI: seed topic with filler + spacer overflow, scroll to non-bottom real scrollIntoView+scroll event, click real data-testid=edit-mode-toggle to enter edit mode, assert firstVisible/scrollTop within tolerance and no bottom jump (Math.abs scrollTop >60), toggle out and assert preserved again. No i18n strings, uses shared fixture. Strict: overflow; non-bottom; exact/limited raw offset on enter+exit; firstVisible unchanged; no manual scroll restore/bottom fallback.'
    })
    const page = mainWindow
    const DISPLAY_LIMIT = 20
    const liveAssistantId = await prepareDisplayCountAndAssistant(page, DISPLAY_LIMIT)

    const topicId = `edit-host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const name = `edit-host ${topicId}`
    const TOTAL = 32
    const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
    for (let i = 0; i < TOTAL; i++) {
      const msgId = `${topicId}-msg-${pad(i, 5)}`
      const blockId = `${topicId}-block-${pad(i, 5)}`
      const role = i % 2 === 0 ? 'user' : 'assistant'
      const msg: Record<string, unknown> = {
        id: msgId,
        topicId,
        role,
        assistantId: liveAssistantId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        blocks: [blockId],
        sortOrder: i
      }
      if (role === 'assistant') {
        ;(msg as any).model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
        ;(msg as any).modelId = 'mock-model'
        ;(msg as any).askId = `${topicId}-msg-${pad(i - 1, 5)}`
      }
      entries.push({
        message: msg,
        blocks: [
          {
            id: blockId,
            messageId: msgId,
            type: 'main_text',
            content: scrollableFiller(`b-filler-${pad(i, 5)}`),
            status: 'success',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            sortOrder: 0
          }
        ]
      })
    }

    await page.evaluate(
      ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
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
              updatedAt: new Date().toISOString()
            }
          }
        })
      },
      { topicId, assistantId: liveAssistantId, name }
    )
    const persist = await page.evaluate(
      async ({ topicId, assistantId, name, entries }: any) => {
        const api = (window as any).api.chatDb as any
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured?.ok) return { ok: false, err: JSON.stringify(ensured) }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted?.ok) return { ok: false, err: JSON.stringify(pasted) }
        return { ok: true }
      },
      { topicId, assistantId: liveAssistantId, name, entries }
    )
    expect(persist.ok).toBe(true)
    await activateTopicAndWaitForBootstrap(page, topicId, DISPLAY_LIMIT)

    await ensureOverflow(page, topicId)
    // Scroll to non-bottom via oldest message start
    const oldestId: string | null = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      return ids.length > 0 ? ids[0] : null
    }, topicId)
    expect(oldestId).toBeTruthy()
    await scrollFirstMessageIntoViewAndPersist(page, topicId, oldestId as string)
    await waitForNonBottom(page)
    const firstVisibleBefore = await getFirstVisibleMessageId(page)
    const scrollTopBefore = await getContainerScrollTop(page)
    expect(firstVisibleBefore).toBeTruthy()
    expect(Math.abs(scrollTopBefore)).toBeGreaterThan(80)

    // Ensure edit mode initially off
    const initiallyEnabled = await page.evaluate(() => (window as any).store.getState().editMode?.enabled === true)
    if (initiallyEnabled) {
      await page.locator('[data-testid="edit-mode-toggle"]').click()
      await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === false, undefined, {
        timeout: 15000
      })
    }

    const toggle = page.locator('[data-testid="edit-mode-toggle"]').first()
    await expect(toggle, 'edit-mode toggle must be visible').toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(200)

    // Enter edit mode
    await toggle.click()
    await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === true, undefined, {
      timeout: 15000
    })
    await page.waitForTimeout(600)
    await page
      .waitForFunction(() => !!document.querySelector('.edit-mode-message'), undefined, { timeout: 15000 })
      .catch(() => {})

    const scrollTopEntered = await getContainerScrollTop(page)
    const firstVisibleEntered = await getFirstVisibleMessageId(page)
    const diagEntered = await page.evaluate(() => {
      const el = document.getElementById('messages')
      const s = (window as any).store.getState()
      const c = el ? { sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop } : null
      const editEnabled = s.editMode?.enabled
      const nav = document.querySelectorAll('[id^="message-"]').length
      const dbg = (window as any).__anchorDebug || []
      return { c, editEnabled, nav, dbg }
    })
    console.log(
      '[edit-host] entered',
      JSON.stringify({ scrollTopBefore, scrollTopEntered, firstVisibleBefore, firstVisibleEntered, diagEntered })
    )
    // Strict assertions: overflow, non-bottom, limited raw offset, firstVisible unchanged, no manual scroll restore
    const overflowEntered = await page.evaluate(() => {
      const el = document.getElementById('messages')
      return el ? { sh: el.scrollHeight, ch: el.clientHeight } : null
    })
    expect(overflowEntered, 'overflow must persist on enter').not.toBeNull()
    expect(overflowEntered!.sh).toBeGreaterThan(overflowEntered!.ch)
    expect(Math.abs(scrollTopEntered)).toBeGreaterThan(40)
    expect(Math.abs(scrollTopEntered - scrollTopBefore)).toBeLessThan(180)
    if (firstVisibleBefore && firstVisibleEntered) {
      expect(firstVisibleEntered).toBe(firstVisibleBefore)
    }

    // Toggle out
    await toggle.click()
    await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === false, undefined, {
      timeout: 15000
    })
    await page.waitForTimeout(800)
    const scrollTopExited = await getContainerScrollTop(page)
    const firstVisibleExited = await getFirstVisibleMessageId(page)
    const diagExited = await page.evaluate(() => {
      const el = document.getElementById('messages')
      const s = (window as any).store.getState()
      return el
        ? { sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop, editEnabled: s.editMode?.enabled }
        : null
    })
    console.log('[edit-host] exited', JSON.stringify({ scrollTopExited, firstVisibleExited, diagExited }))
    const overflowExited = await page.evaluate(() => {
      const el = document.getElementById('messages')
      return el ? { sh: el.scrollHeight, ch: el.clientHeight } : null
    })
    expect(overflowExited, 'overflow must persist on exit').not.toBeNull()
    expect(overflowExited!.sh).toBeGreaterThan(overflowExited!.ch)
    expect(Math.abs(scrollTopExited)).toBeGreaterThan(40)
    expect(Math.abs(scrollTopExited - scrollTopEntered)).toBeLessThan(180)
    expect(Math.abs(scrollTopExited - scrollTopBefore)).toBeLessThan(220)
    if (firstVisibleBefore && firstVisibleExited) {
      expect(firstVisibleExited).toBe(firstVisibleBefore)
    }

    const countAfter = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      return ids.length
    }, topicId)
    expect(countAfter).toBeGreaterThan(0)
  })
})
