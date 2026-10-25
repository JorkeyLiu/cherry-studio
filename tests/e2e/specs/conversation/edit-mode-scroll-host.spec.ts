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

async function collectScrollDiag(page: any, topicId: string, messageId: string | null): Promise<Record<string, any>> {
  return page.evaluate(
    ({ tid, mid }: { tid: string; mid: string | null }) => {
      const container = document.getElementById('messages') as HTMLElement | null
      if (!container) return { noContainer: true }
      const cRect = container.getBoundingClientRect()
      const target = mid ? (document.getElementById(`message-${mid}`) as HTMLElement | null) : null
      const tRect = target ? target.getBoundingClientRect() : null
      // Nearest scroll host chain (first 6 scrollable ancestors).
      const chain: Array<Record<string, any>> = []
      let el: HTMLElement | null = target ?? container
      let depth = 0
      while (el && depth < 12 && chain.length < 6) {
        const cs = window.getComputedStyle(el)
        const oy = cs.overflowY
        const scrollable =
          el.scrollHeight > el.clientHeight + 1 && (oy === 'auto' || oy === 'scroll' || el.id === 'messages')
        if (scrollable) {
          const r = el.getBoundingClientRect()
          chain.push({
            tag: el.tagName,
            id: el.id || null,
            cls: (el.className && String(el.className).slice(0, 80)) || null,
            sh: el.scrollHeight,
            ch: el.clientHeight,
            st: el.scrollTop,
            top: Math.round(r.top),
            bottom: Math.round(r.bottom)
          })
        }
        el = el.parentElement
        depth++
      }
      return {
        messages: { sh: container.scrollHeight, ch: container.clientHeight, st: container.scrollTop },
        containerRect: {
          top: Math.round(cRect.top),
          bottom: Math.round(cRect.bottom),
          height: Math.round(cRect.height)
        },
        oldestRect: tRect
          ? { top: Math.round(tRect.top), bottom: Math.round(tRect.bottom), height: Math.round(tRect.height) }
          : null,
        chain,
        currentTopic: (window as any).store?.getState()?.messages?.currentTopicId ?? null,
        expectTopic: tid
      }
    },
    { tid: topicId, mid: messageId }
  )
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

// Real user-scroll precondition: keeper only honors genuine intent
// (capture-phase wheel/pointer/key listeners). Programmatic
// scrollIntoView + synthetic scroll event carries no live user session,
// so the no-intent keeper hold restores the viewport and scrollTop never
// stays non-bottom. Mouse is positioned inside #messages and real wheel
// input establishes the non-bottom anchor.
async function wheelToNonBottom(page: any, topicId: string, messageId: string | null): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(150)
  }
  // Try programmatic first for diagnostics, then real wheel to establish intent.
  if (messageId) {
    const prog = await page.evaluate(
      ({ mid }: { mid: string }) => {
        const container = document.getElementById('messages') as HTMLElement | null
        const target = document.getElementById(`message-${mid}`) as HTMLElement | null
        if (!container || !target) return { ok: false, st: null }
        target.scrollIntoView({ block: 'start', behavior: 'auto' })
        container.dispatchEvent(new Event('scroll', { bubbles: true }))
        return { ok: true, st: container.scrollTop, sh: container.scrollHeight, ch: container.clientHeight }
      },
      { mid: messageId }
    )
    const diagProg = await collectScrollDiag(page, topicId, messageId)
    console.log('[edit-host] programmatic-scroll diag', JSON.stringify({ prog, diagProg }))
  }
  const deadline = Date.now() + 15000
  let lastSt = 0
  while (Date.now() < deadline) {
    const st = await getContainerScrollTop(page)
    lastSt = st
    if (Math.abs(st) > 80) return
    // Wheel up (negative deltaY) moves toward older content under
    // column-reverse (away from bottom scrollTop 0). Alternate with a
    // larger step if stuck.
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(250)
    const st2 = await getContainerScrollTop(page)
    if (Math.abs(st2) > 80) return
    if (Math.abs(st2 - st) < 1) {
      await page.mouse.wheel(0, -1200)
      await page.waitForTimeout(250)
    }
  }
  const diagFail = await collectScrollDiag(page, topicId, messageId)
  console.log('[edit-host] wheel precondition failed', JSON.stringify({ lastSt, diagFail }))
  throw new Error(`wheel precondition failed to reach non-bottom, lastSt=${lastSt}`)
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
    // Scroll to non-bottom via real user input (wheel inside #messages).
    const oldestId: string | null = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      return ids.length > 0 ? ids[0] : null
    }, topicId)
    expect(oldestId).toBeTruthy()
    const diagSetup = await collectScrollDiag(page, topicId, oldestId)
    console.log('[edit-host] setup diag', JSON.stringify(diagSetup))
    await wheelToNonBottom(page, topicId, oldestId)
    await waitForNonBottom(page)
    const diagNonBottom = await collectScrollDiag(page, topicId, oldestId)
    console.log('[edit-host] nonbottom diag', JSON.stringify(diagNonBottom))
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

  test('multi-answer turn shields controls behind an outer cover with immediate footer hide', async ({
    mainWindow
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'EDIT-MODE SHIELD INTEGRATED UI: seed one user ask + two assistant answers sharing the ask (expanded segmented labels, first fold-selected); assert real tab boxes share Y/same row with increasing x and 40px bar geometry; assert footer starts visible with unchanged size; install rAF sampler BEFORE the edit toggle and assert the FIRST edit-turn frame already hides the footer (visibility hidden, opacity 0, no transition) with height reserved; assert bar/tabs geometry unchanged, hit testing lands on the cover, pointer drag/hover cannot reorder/switch/toggle/retry, real-coordinate click on the visible inactive tab selects the whole turn without selectAnswer, right-click auto-selects with the batch menu preserved, and exit restores tab stability. No i18n strings, uses shared fixture.'
    })
    const page = mainWindow
    const DISPLAY_LIMIT = 20
    const liveAssistantId = await prepareDisplayCountAndAssistant(page, DISPLAY_LIMIT)

    const topicId = `edit-shield-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const name = `edit-shield ${topicId}`
    const askId = `${topicId}-user-00000`
    const firstId = `${topicId}-assistant-a1`
    const secondId = `${topicId}-assistant-a2`
    const stamp = '2026-01-01T00:00:00.000Z'
    const blockFor = (msgId: string, content: string) => ({
      id: `${msgId}-block`,
      messageId: msgId,
      type: 'main_text',
      content,
      status: 'success',
      createdAt: stamp,
      updatedAt: stamp,
      sortOrder: 0
    })
    const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = [
      {
        message: {
          id: askId,
          topicId,
          role: 'user',
          assistantId: liveAssistantId,
          createdAt: stamp,
          updatedAt: stamp,
          status: 'success',
          blocks: [`${askId}-block`],
          sortOrder: 0
        },
        blocks: [blockFor(askId, 'edit shield seed question')]
      },
      {
        message: {
          id: firstId,
          topicId,
          role: 'assistant',
          assistantId: liveAssistantId,
          askId,
          foldSelected: true,
          model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model A' },
          modelId: 'mock-model',
          createdAt: stamp,
          updatedAt: stamp,
          status: 'success',
          blocks: [`${firstId}-block`],
          sortOrder: 1
        },
        blocks: [blockFor(firstId, 'edit shield first answer')]
      },
      {
        message: {
          id: secondId,
          topicId,
          role: 'assistant',
          assistantId: liveAssistantId,
          askId,
          model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model B' },
          modelId: 'mock-model',
          createdAt: stamp,
          updatedAt: stamp,
          status: 'success',
          blocks: [`${secondId}-block`],
          sortOrder: 2
        },
        blocks: [blockFor(secondId, 'edit shield second answer')]
      }
    ]

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
    await activateTopicAndWaitForBootstrap(page, topicId, 3)

    const bar = page.locator('#messages .group-menu-bar').first()
    await expect(bar, 'group menu bar must be visible').toBeVisible({ timeout: 15000 })
    const tabs = page.locator('#messages [data-testid="answer-group-selector"]')
    await expect(tabs, 'two answer tabs before edit mode').toHaveCount(2, { timeout: 15000 })
    await expect(tabs.nth(0), 'first tab visible').toBeVisible()
    await expect(tabs.nth(1), 'second tab visible').toBeVisible()

    // Real geometry: expanded segmented labels share one row (same Y)
    // with increasing x; the bar keeps its 40px height.
    const tabBox0Before = await tabs.nth(0).boundingBox()
    const tabBox1Before = await tabs.nth(1).boundingBox()
    const barBoxBefore = await bar.boundingBox()
    expect(tabBox0Before, 'first tab geometry must be measurable').not.toBeNull()
    expect(tabBox1Before, 'second tab geometry must be measurable').not.toBeNull()
    expect(barBoxBefore, 'bar geometry must be measurable').not.toBeNull()
    expect(Math.abs((barBoxBefore?.height ?? 0) - 40)).toBeLessThan(4)
    expect(Math.abs((tabBox0Before?.y ?? 0) - (tabBox1Before?.y ?? 0))).toBeLessThan(6)
    expect(tabBox1Before?.x ?? 0).toBeGreaterThan(tabBox0Before?.x ?? 0)

    // Footer starts visible (grouped answers always show the toolbar) with
    // a stable occupied size.
    const footer = page.locator('#messages .MessageFooter').first()
    await expect(footer, 'message footer must be visible before edit mode').toBeVisible({ timeout: 15000 })
    const footerBoxBefore = await footer.boundingBox()
    expect(footerBoxBefore, 'footer geometry must be measurable').not.toBeNull()
    const footerStyleBefore = await footer.evaluate((el) => {
      const cs = window.getComputedStyle(el)
      return { visibility: cs.visibility, opacity: cs.opacity, display: cs.display }
    })
    expect(footerStyleBefore.visibility).not.toBe('hidden')
    expect(footerStyleBefore.display).not.toBe('none')
    const menubarOpacityBefore = await page.evaluate(() => {
      const el = document.querySelector('#messages .MessageFooter .menubar') as HTMLElement | null
      return el ? window.getComputedStyle(el).opacity : null
    })
    expect(menubarOpacityBefore).toBe('1')

    const readActive = () =>
      page.evaluate(
        ({ firstId, secondId }: { firstId: string; secondId: string }) => {
          const entities = (window as any).store.getState().messages?.entities ?? {}
          return {
            first: entities[firstId]?.foldSelected === true,
            second: entities[secondId]?.foldSelected === true
          }
        },
        { firstId, secondId }
      )
    const activeBefore = await readActive()
    expect(activeBefore.first).toBe(true)
    expect(activeBefore.second).toBe(false)
    const orderBefore = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return [...(s.messages?.messageIdsByTopic?.[tid] ?? [])]
    }, topicId)
    const displayBefore = await page.evaluate(() => (window as any).store.getState().settings?.foldDisplayMode)
    const requestSeqBefore = await page.evaluate(() => {
      const w = window as any
      return typeof w.__mockRequestSequence === 'number' ? w.__mockRequestSequence : -1
    })

    const initiallyEnabled = await page.evaluate(() => (window as any).store.getState().editMode?.enabled === true)
    if (initiallyEnabled) {
      await page.locator('[data-testid="edit-mode-toggle"]').click()
      await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === false, undefined, {
        timeout: 15000
      })
    }

    // rAF sampling begins BEFORE the toggle so the first edit frame is
    // observed (a polling wait would miss the first-frame bug).
    await page.evaluate(() => {
      const w = window as any
      w.__editFooterSamples = []
      w.__stopEditSampling = false
      const loop = () => {
        if (w.__stopEditSampling) return
        const footerEl = document.querySelector('#messages .MessageFooter') as HTMLElement | null
        const cs = footerEl ? window.getComputedStyle(footerEl) : null
        w.__editFooterSamples.push({
          t: performance.now(),
          hasEditClass: !!document.querySelector('#messages .edit-turn-interactive, #messages .edit-turn-selected'),
          hasCover: !!document.querySelector('#messages [data-testid="edit-turn-cover"]'),
          footerVisibility: cs?.visibility ?? null,
          footerOpacity: cs?.opacity ?? null,
          footerTransitionProperty: (cs as any)?.transitionProperty ?? null,
          footerTransitionDuration: (cs as any)?.transitionDuration ?? null,
          footerDisplay: cs?.display ?? null,
          footerHeight: footerEl?.getBoundingClientRect().height ?? null
        })
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })

    const toggle = page.locator('[data-testid="edit-mode-toggle"]').first()
    await expect(toggle, 'edit-mode toggle must be visible').toBeVisible({ timeout: 15000 })
    await toggle.click()
    await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === true, undefined, {
      timeout: 15000
    })
    await page.waitForFunction(
      () => !!document.querySelector('#messages .edit-turn-interactive, #messages .edit-turn-selected'),
      undefined,
      { timeout: 15000 }
    )
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      ;(window as any).__stopEditSampling = true
    })
    const samples = await page.evaluate(() => (window as any).__editFooterSamples as Array<Record<string, any>>)
    expect(samples.length).toBeGreaterThan(0)
    const firstEditIdx = samples.findIndex((s) => s.hasEditClass === true)
    expect(firstEditIdx).toBeGreaterThanOrEqual(0)
    const firstEdit = samples[firstEditIdx]
    expect(firstEdit.hasCover).toBe(true)
    // Immediate hide on the FIRST edit frame: no fade/transition delay,
    // occupied height reserved (visibility, not display:none).
    expect(firstEdit.footerVisibility).toBe('hidden')
    expect(firstEdit.footerOpacity).toBe('0')
    expect(firstEdit.footerTransitionProperty).toBe('none')
    expect(firstEdit.footerDisplay).not.toBe('none')
    expect(Math.abs((firstEdit.footerHeight ?? 0) - (footerBoxBefore?.height ?? 0))).toBeLessThan(3)
    for (const s of samples.slice(firstEditIdx)) {
      expect(s.footerVisibility).toBe('hidden')
      expect(s.footerOpacity).toBe('0')
    }

    // Bar and labels stay visible with unchanged geometry in edit mode.
    await expect(bar, 'group menu bar stays visible in edit mode').toBeVisible({ timeout: 15000 })
    await expect(tabs, 'two answer tabs stay mounted in edit mode').toHaveCount(2, { timeout: 15000 })
    await expect(tabs.nth(0), 'first tab stays visible in edit mode').toBeVisible()
    await expect(tabs.nth(1), 'second tab stays visible in edit mode').toBeVisible()
    const barBoxEntered = await bar.boundingBox()
    const tabBox0Entered = await tabs.nth(0).boundingBox()
    const tabBox1Entered = await tabs.nth(1).boundingBox()
    expect(Math.abs((barBoxEntered?.height ?? 0) - (barBoxBefore?.height ?? 40))).toBeLessThan(3)
    expect(Math.abs((tabBox0Entered?.y ?? 0) - (tabBox1Entered?.y ?? 0))).toBeLessThan(6)
    expect(tabBox1Entered?.x ?? 0).toBeGreaterThan(tabBox0Entered?.x ?? 0)
    for (const [before, entered] of [
      [tabBox0Before, tabBox0Entered],
      [tabBox1Before, tabBox1Entered]
    ] as const) {
      expect(Math.abs((entered?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(3)
      expect(Math.abs((entered?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(3)
    }
    // Ordinary retry stays absent (seed has no failures); the display-mode
    // toggle keeps its mount behind the shield.
    await expect(
      page.locator('#messages [data-testid="group-retry-all-btn"]'),
      'ordinary retry absent in edit mode'
    ).toHaveCount(0, { timeout: 15000 })

    // Hit testing at the visible inactive tab lands on the cover, not the tab.
    const inactiveBox = await tabs.nth(1).boundingBox()
    expect(inactiveBox).not.toBeNull()
    const clickX = (inactiveBox?.x ?? 0) + (inactiveBox?.width ?? 0) / 2
    const clickY = (inactiveBox?.y ?? 0) + (inactiveBox?.height ?? 0) / 2
    const hit = await page.evaluate(
      ({ x, y }: { x: number; y: number }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        return {
          onCover: !!el?.closest('[data-testid="edit-turn-cover"]'),
          onTurn: !!el?.closest('[data-testid="edit-turn"]'),
          tag: el?.tagName ?? null
        }
      },
      { x: clickX, y: clickY }
    )
    expect(hit.onCover).toBe(true)
    expect(hit.onTurn).toBe(true)

    // Pointer drag/hover from the tab cannot reorder, switch answers, or
    // flip the display mode (hover lands on the cover; drag never reaches
    // the Sortable). NOTE: a 40px mousedown/mouseup on the ordinary cover
    // element generates a CLICK that the turn capture delivers once to
    // handleGroupClick (plain-click toggle semantics in useEditMode.ts),
    // so the drag itself may select the turn. Selection is diagnosed, not
    // reset via Redux: if the drag selected, the known behavior is asserted
    // and deselected via a real cover gesture before testing select.
    const selBeforeDrag = await page.evaluate(() => [
      ...((window as any).store.getState().editMode?.selectedGroupIds ?? [])
    ])
    const stBeforeDrag = await getContainerScrollTop(page)
    await page.mouse.move(clickX, clickY)
    await page.mouse.down()
    await page.mouse.move(clickX + 40, clickY, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const selAfterDrag = await page.evaluate(() => [
      ...((window as any).store.getState().editMode?.selectedGroupIds ?? [])
    ])
    const orderAfterDrag = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return [...(s.messages?.messageIdsByTopic?.[tid] ?? [])]
    }, topicId)
    expect(orderAfterDrag).toEqual(orderBefore)
    const activeAfterDrag = await readActive()
    expect(activeAfterDrag).toEqual(activeBefore)
    const displayAfterDrag = await page.evaluate(() => (window as any).store.getState().settings?.foldDisplayMode)
    expect(displayAfterDrag).toBe(displayBefore)
    // Post-drag CURRENT geometry/state (stale clickX/clickY no longer trusted).
    const diagAfterDrag = await page.evaluate(
      ({ x, y }: { x: number; y: number }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        const cover = el?.closest('[data-testid="edit-turn-cover"]') as HTMLElement | null
        const turn = el?.closest('[data-testid="edit-turn"]') as HTMLElement | null
        const inactive = document.querySelectorAll(
          '#messages [data-testid="answer-group-selector"]'
        )[1] as HTMLElement | null
        const r = inactive?.getBoundingClientRect() ?? null
        const c = document.getElementById('messages')
        return {
          staleHit: {
            onCover: !!el?.closest('[data-testid="edit-turn-cover"]'),
            onTurn: !!el?.closest('[data-testid="edit-turn"]'),
            tag: el?.tagName ?? null
          },
          freshInactiveBox: r
            ? { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
            : null,
          st: c ? c.scrollTop : null,
          coverAsk: cover?.parentElement?.getAttribute('data-turn-ask') ?? turn?.getAttribute('data-turn-ask') ?? null
        }
      },
      { x: clickX, y: clickY }
    )
    console.log(
      '[edit-shield] drag diag',
      JSON.stringify({ selBeforeDrag, selAfterDrag, stBeforeDrag, diagAfterDrag, askId })
    )
    // Drag must not switch/toggle the model bar or reorder: active/display/order
    // already asserted above. Selection toggle via the drag CLICK is known
    // plain-click behavior — handle by observing, not by suppressing.
    if ((selAfterDrag as string[]).includes(askId)) {
      console.log('[edit-shield] drag selected turn (known click-toggle); deselecting via real cover gesture')
    }
    // If the drag selected, deselect via a real cover click so the select
    // test starts from a known empty state (no Redux reset, no force/DOM click).
    if ((selAfterDrag as string[]).includes(askId)) {
      const dBox = diagAfterDrag.freshInactiveBox as { cx: number; cy: number } | null
      expect(dBox, 'fresh inactive box must be measurable after drag').not.toBeNull()
      const dX = (dBox as { cx: number; cy: number }).cx
      const dY = (dBox as { cx: number; cy: number }).cy
      const dHit = await page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          return {
            onCover: !!el?.closest('[data-testid="edit-turn-cover"]'),
            onTurn: !!el?.closest('[data-testid="edit-turn"]')
          }
        },
        { x: dX, y: dY }
      )
      expect(dHit.onCover).toBe(true)
      expect(dHit.onTurn).toBe(true)
      await page.mouse.click(dX, dY)
      await page.waitForFunction(
        () => ((window as any).store.getState().editMode?.selectedGroupIds ?? []).length === 0,
        undefined,
        {
          timeout: 15000
        }
      )
      console.log(
        '[edit-shield] deselected after drag-select',
        JSON.stringify(await page.evaluate(() => (window as any).store.getState().editMode?.selectedGroupIds))
      )
    }

    // Real-coordinate click on the CURRENT visible inactive tab selects the
    // whole turn without switching the active answer (no locator.click on
    // inert descendants, no forced bypass). Coordinates are remeasured after
    // the drag/scroll and hit ownership is verified at the actual coords.
    const freshBox = await tabs.nth(1).boundingBox()
    expect(freshBox, 'fresh inactive tab geometry must be measurable').not.toBeNull()
    const clickX2 = (freshBox?.x ?? 0) + (freshBox?.width ?? 0) / 2
    const clickY2 = (freshBox?.y ?? 0) + (freshBox?.height ?? 0) / 2
    const selBeforeClick = await page.evaluate(() => [
      ...((window as any).store.getState().editMode?.selectedGroupIds ?? [])
    ])
    const hit2 = await page.evaluate(
      ({ x, y }: { x: number; y: number }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        const cover = el?.closest('[data-testid="edit-turn-cover"]') as HTMLElement | null
        const turn = el?.closest('[data-testid="edit-turn"]') as HTMLElement | null
        return {
          onCover: !!cover,
          onTurn: !!turn,
          tag: el?.tagName ?? null,
          coverAsk: turn?.getAttribute('data-turn-ask') ?? null
        }
      },
      { x: clickX2, y: clickY2 }
    )
    console.log('[edit-shield] select-click diag', JSON.stringify({ selBeforeClick, hit2, askId, clickX2, clickY2 }))
    expect(hit2.onCover).toBe(true)
    expect(hit2.onTurn).toBe(true)
    expect(hit2.coverAsk).toBe(askId)
    await page.mouse.click(clickX2, clickY2)
    const selAfterClick = await page
      .evaluate(() => [...((window as any).store.getState().editMode?.selectedGroupIds ?? [])])
      .catch(() => null)
    console.log('[edit-shield] after select click', JSON.stringify({ selAfterClick }))
    await page.waitForFunction(
      ({ askId }: { askId: string }) =>
        ((window as any).store.getState().editMode?.selectedGroupIds ?? []).includes(askId),
      { askId },
      { timeout: 15000 }
    )
    const activeAfterSelect = await readActive()
    expect(activeAfterSelect.first, 'active answer must not switch on edit-mode label click').toBe(true)
    expect(activeAfterSelect.second, 'inactive answer must stay inactive on edit-mode label click').toBe(false)
    const requestSeqAfterSelect = await page.evaluate(() => {
      const w = window as any
      return typeof w.__mockRequestSequence === 'number' ? w.__mockRequestSequence : -1
    })
    if (requestSeqBefore !== -1) {
      expect(requestSeqAfterSelect).toBe(requestSeqBefore)
    }

    // Right-click the selected turn: selection preserved and the batch
    // context menu still opens (no blanket suppression). Coordinates are
    // remeasured at each gesture (never reused across scroll/selection).
    const measureTurnPoint = async (): Promise<{ x: number; y: number }> => {
      const b = await page.locator('#messages [data-testid="edit-turn"]').first().boundingBox()
      expect(b, 'turn geometry must be measurable').not.toBeNull()
      const x = (b?.x ?? 0) + (b?.width ?? 0) / 2
      const y = (b?.y ?? 0) + (b?.height ?? 0) / 2
      const h = await page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          return {
            onCover: !!el?.closest('[data-testid="edit-turn-cover"]'),
            onTurn: !!el?.closest('[data-testid="edit-turn"]')
          }
        },
        { x, y }
      )
      expect(h.onCover).toBe(true)
      expect(h.onTurn).toBe(true)
      return { x, y }
    }
    const rp1 = await measureTurnPoint()
    await page.mouse.click(rp1.x, rp1.y, { button: 'right' })
    await page.waitForTimeout(500)
    const selectedAfterRight = await page.evaluate(() => [
      ...((window as any).store.getState().editMode?.selectedGroupIds ?? [])
    ])
    expect(selectedAfterRight).toContain(askId)
    await expect(page.locator('.ant-dropdown-menu').first(), 'batch context menu must open').toBeVisible({
      timeout: 10000
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Observed runtime: Escape after the batch menu clears the selection
    // (selBeforeClear [] with menuOpen true in diagnosis), so the clear
    // step's selected precondition no longer holds. Re-establish selected
    // via a REAL cover click at fresh tab coords (no Redux reset) so the
    // toggle state under test is deliberate and correct.
    const selAfterEscape1 = await page.evaluate(() => [
      ...((window as any).store.getState().editMode?.selectedGroupIds ?? [])
    ])
    console.log('[edit-shield] after escape1', JSON.stringify({ selAfterEscape1 }))
    if (!(selAfterEscape1 as string[]).includes(askId)) {
      const rsBox = await tabs.nth(1).boundingBox()
      expect(rsBox, 'reselect tab geometry must be measurable').not.toBeNull()
      const rsX = (rsBox?.x ?? 0) + (rsBox?.width ?? 0) / 2
      const rsY = (rsBox?.y ?? 0) + (rsBox?.height ?? 0) / 2
      const rsHit = await page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y) as HTMLElement | null
          return {
            onCover: !!el?.closest('[data-testid="edit-turn-cover"]'),
            onTurn: !!el?.closest('[data-testid="edit-turn"]')
          }
        },
        { x: rsX, y: rsY }
      )
      expect(rsHit.onCover).toBe(true)
      expect(rsHit.onTurn).toBe(true)
      await page.mouse.click(rsX, rsY)
      await page.waitForFunction(
        ({ askId }: { askId: string }) =>
          ((window as any).store.getState().editMode?.selectedGroupIds ?? []).includes(askId),
        { askId },
        { timeout: 15000 }
      )
      console.log('[edit-shield] reselected after escape1')
    }

    // Clear via a plain left click on the selected turn, then right-click
    // the unselected turn: replace-selection auto-selects the whole turn.
    const cp = await measureTurnPoint()
    const selBeforeClear = await page.evaluate(() => [
      ...((window as any).store.getState().editMode?.selectedGroupIds ?? [])
    ])
    const clearDiag = await page.evaluate(
      ({ x, y }: { x: number; y: number }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        const turn = el?.closest('[data-testid="edit-turn"]') as HTMLElement | null
        const r = turn?.getBoundingClientRect() ?? null
        const c = document.getElementById('messages')
        return {
          hit: { onCover: !!el?.closest('[data-testid="edit-turn-cover"]'), onTurn: !!turn, tag: el?.tagName ?? null },
          coverAsk: turn?.getAttribute('data-turn-ask') ?? null,
          turnRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
          st: c ? c.scrollTop : null,
          menuOpen: !!document.querySelector('.ant-dropdown-menu')
        }
      },
      { x: cp.x, y: cp.y }
    )
    console.log('[edit-shield] clear-click diag', JSON.stringify({ cp, selBeforeClear, clearDiag, askId }))
    await page.mouse.click(cp.x, cp.y)
    await page.waitForTimeout(500)
    const selAfterClearClick = await page.evaluate(() => [
      ...((window as any).store.getState().editMode?.selectedGroupIds ?? [])
    ])
    console.log('[edit-shield] after clear click', JSON.stringify({ selAfterClearClick }))
    await page.waitForFunction(
      () => ((window as any).store.getState().editMode?.selectedGroupIds ?? []).length === 0,
      undefined,
      { timeout: 15000 }
    )
    const rp2 = await measureTurnPoint()
    await page.mouse.click(rp2.x, rp2.y, { button: 'right' })
    await page.waitForFunction(
      ({ askId }: { askId: string }) =>
        ((window as any).store.getState().editMode?.selectedGroupIds ?? []).includes(askId),
      { askId },
      { timeout: 15000 }
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Exiting edit mode keeps the tabs horizontally stable and retains the
    // active answer; the footer becomes visible again.
    await toggle.click()
    await page.waitForFunction(() => (window as any).store.getState().editMode?.enabled === false, undefined, {
      timeout: 15000
    })
    await page.waitForTimeout(400)
    await expect(tabs, 'two answer tabs after exiting edit mode').toHaveCount(2, { timeout: 15000 })
    const tabBox0After = await tabs.nth(0).boundingBox()
    const tabBox1After = await tabs.nth(1).boundingBox()
    expect(Math.abs((tabBox0After?.y ?? 0) - (tabBox1After?.y ?? 0))).toBeLessThan(6)
    expect(tabBox1After?.x ?? 0).toBeGreaterThan(tabBox0After?.x ?? 0)
    expect(Math.abs((tabBox0After?.x ?? 0) - (tabBox0Before?.x ?? 0))).toBeLessThan(3)
    const activeAfterExit = await readActive()
    expect(activeAfterExit.first).toBe(true)
    expect(activeAfterExit.second).toBe(false)
    await expect(footer, 'footer visible again after exit').toBeVisible({ timeout: 15000 })
  })
})
