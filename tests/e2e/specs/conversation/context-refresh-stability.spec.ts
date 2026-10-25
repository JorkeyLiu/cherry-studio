/**
 * Context refresh stability — root regression correction E2E.
 *
 * User-explicit direction: complete-route context/window independence is kept;
 * the repeated waiting/hide state during ordinary streaming (TokenCount unmount
 * + context divider disappearance) is removed. Accepted retain alone solves the
 * blank flicker; no id-only reference freeze, no per-chunk zeroing.
 *
 * Real Electron anchored-route contract (shared fixture, disposable profile,
 * mocked provider, deterministic assertions):
 * - Seed an anchored main route (12 msgs / 6 turns) with a partial window
 *   (divider visible, TokenCount shows selected/total from Main authority).
 * - Start a slow-stream reply on the SAME topic/route/anchor.
 * - Framewise DURING chunks: TokenCount stays mounted with STABLE current/max
 *   (parsed from [data-testid="token-count-context"]; the live scalar estimate
 *   is asserted non-blank numeric separately, never text===baseline), and the
 *   context divider stays present with stable geometry (no disappearance).
 * - After settle, counts commit atomically to the new Main authority
 *   (selected/total re-fetched from Main, never assumed); divider persists.
 * - A second structural refresh (ordinary fast send) proves no invisible
 *   divider flash either. Edit-path UI coverage is NOT exercised here (named
 *   gap below); the structural append is the meaningful refresh action.
 *
 * Seams (existing only): #messages, [data-message-id],
 * [data-testid="token-count-context"], [data-testid="context-boundary"],
 * window.store (introspection), window.api.chatDb.ensureTopic /
 * pasteMessagesToTopic / fetchContextClosure (seed + Main authority),
 * window.keyv (supporting only). Sends go through the real textarea/Enter.
 * Never dispatches scrollToBottom or SEND_MESSAGE to fake input.
 *
 * Intended invocation (parent coordinates fresh build + focused run):
 *   pnpm build && pnpm test:e2e tests/e2e/specs/conversation/context-refresh-stability.spec.ts
 */
import type { Page } from '@playwright/test'

import { clearRequestLog, expect, test } from '../../fixtures/electron.fixture'
import { getSlowStreamReply, SLOW_STREAM_MARKER } from '../../fixtures/mock-openai-server'
import { cmContent, replaceEditorContent } from '../../utils/message-editor'
import { waitForChatReady } from '../../utils/wait-helpers'
import { activateTopic, letterMessageId, pad, prepareAssistant, seedSourceTopic } from '../../utils/branch-route-setup'

const MODEL = 'mock-model'
const DISPLAY_LIMIT = 10

function tokenCount(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-testid="token-count-context"]').first()
}

function divider(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-testid="context-boundary"]').first()
}

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

function routeKeyFor(topicId: string, branchId: string | null): string {
  return typeof branchId === 'string' && branchId.length > 0 ? `${topicId}:${branchId}` : topicId
}

async function setRouteAnchor(
  page: Page,
  assistantId: string,
  topicId: string,
  branchId: string | null,
  groupKey: string
): Promise<void> {
  const routeKey = routeKeyFor(topicId, branchId)
  await page.evaluate(
    ({ assistantId, routeKey, groupKey }: { assistantId: string; routeKey: string; groupKey: string }) => {
      const store = (window as any).store
      const current =
        store.getState().assistants.assistants.find((a: any) => a.id === assistantId)?.settings?.contextWindowAnchor ??
        {}
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId,
          settings: { contextWindowAnchor: { ...current, [routeKey]: { kind: 'active', groupKey } } }
        }
      })
    },
    { assistantId, routeKey, groupKey }
  )
  const persisted: string | null = await page.evaluate(
    ({ assistantId, routeKey }: { assistantId: string; routeKey: string }) => {
      const s = (window as any).store.getState()
      const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
      const anchor = assistant?.settings?.contextWindowAnchor?.[routeKey]
      return anchor?.kind === 'active' ? (anchor.groupKey as string) : null
    },
    { assistantId, routeKey }
  )
  expect(persisted).toBe(groupKey)
}

async function fetchClosureAuthority(
  page: Page,
  topicId: string,
  branchId: string | null,
  anchorGroupKey: string
): Promise<{ selected: number; total: number; boundary: string | null; first: string | null; last: string | null }> {
  const res: any = await page.evaluate(
    async ({
      topicId,
      branchId,
      anchorGroupKey
    }: {
      topicId: string
      branchId: string | null
      anchorGroupKey: string
    }) => {
      const api: any = (window as any).api.chatDb
      return await api.fetchContextClosure({ topicId, branchId, anchorGroupKey })
    },
    { topicId, branchId, anchorGroupKey }
  )
  expect(res?.ok, `fetchContextClosure failed: ${JSON.stringify(res)}`).toBe(true)
  const c = res.value.closure
  expect(c?.completeness).toBe('context-closure')
  expect(c?.topicId).toBe(topicId)
  expect(c?.anchorGroupKey).toBe(anchorGroupKey)
  return {
    selected: c.selectedTurnCount,
    total: c.totalTurnCount,
    boundary: c.boundaryMessageId,
    first: c.firstMessageId,
    last: c.lastMessageId
  }
}

async function expectTokenCount(page: Page, current: number, max: number, timeout = 30000): Promise<void> {
  await expect(page.locator('[data-testid="token-count-context"]').first()).toHaveText(
    new RegExp(`^\\s*${current}\\s*\\/\\s*${max}\\s*$`),
    { timeout }
  )
}

/** Parse the stable current/max part of TokenCount plus the live scalar separately. */
async function readTokenParts(page: Page): Promise<{
  countText: string
  current: number | null
  max: number | null
  scalarText: string
  scalarNumeric: number | null
}> {
  return page.evaluate(() => {
    const countEl = document.querySelector('[data-testid="token-count-context"]') as HTMLElement | null
    const countText = (countEl?.textContent ?? '').replace(/\s+/g, '')
    let current: number | null = null
    let max: number | null = null
    const m = countText.match(/^(\d+)\/(\d+|∞)$/)
    if (m) {
      current = Number(m[1])
      max = m[2] === '∞' ? null : Number(m[2])
    }
    // Live scalar: sibling estimate next to the count block (ArrowUp + number).
    // Never part of the current/max stability assertion; asserted non-blank separately.
    let scalarText = ''
    let scalarNumeric: number | null = null
    const host = countEl?.parentElement
    if (host) {
      const combined = (host.textContent ?? '').replace(/\s+/g, '')
      scalarText = combined.replace(countText, '')
      const digits = scalarText.replace(/[^\d]/g, '')
      if (digits.length > 0) scalarNumeric = Number(digits)
    }
    return { countText, current, max, scalarText, scalarNumeric }
  })
}

async function isStreaming(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const s = (window as any).store?.getState()
    if (!s?.messageBlocks?.entities) return false
    for (const block of Object.values(s.messageBlocks.entities) as any[]) {
      if (block?.type === 'main_text' && block?.status === 'streaming') return true
    }
    return false
  })
}

async function waitForStreamingStart(page: Page, timeout = 30000): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as any).store?.getState()
      if (!s?.messageBlocks?.entities) return false
      for (const block of Object.values(s.messageBlocks.entities) as any[]) {
        if (block?.type === 'main_text' && block?.status === 'streaming') return true
      }
      return false
    },
    undefined,
    { timeout }
  )
}

async function waitForStreamSettled(page: Page, expected: string, timeout = 90000): Promise<void> {
  await page.waitForFunction(
    (exp: string) => {
      const s = (window as any).store?.getState()
      if (!s?.messageBlocks?.entities) return false
      for (const block of Object.values(s.messageBlocks.entities) as any[]) {
        if (block?.type === 'main_text' && block?.content === exp && block?.status === 'success') return true
      }
      return false
    },
    expected,
    { timeout }
  )
}

async function waitForAssistantComplete(
  page: Page,
  topicId: string,
  prevAssistantCount: number,
  timeout = 90000
): Promise<void> {
  await page.waitForFunction(
    ({ tid, prev }: { tid: string; prev: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const ids = (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
      let n = 0
      for (const id of ids) {
        if (s.messages?.entities?.[id]?.role === 'assistant') n += 1
      }
      return n > prev
    },
    { tid: topicId, prev: prevAssistantCount },
    { timeout }
  )
  await page.waitForFunction(
    ({ tid }: { tid: string }) => {
      const s = (window as any).store?.getState()
      if (!s || s.messages?.loadingByTopic?.[tid] === true) return false
      const ids = (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
      let latest: string | null = null
      for (let i = ids.length - 1; i >= 0; i--) {
        if (s.messages?.entities?.[ids[i]]?.role === 'assistant') {
          latest = ids[i]
          break
        }
      }
      if (!latest) return false
      const msg = s.messages.entities[latest]
      if (msg.status !== 'success' && msg.status !== 'error') return false
      const blocks = (msg.blocks ?? []) as string[]
      if (blocks.length === 0) return false
      for (const b of blocks) {
        const block = s.messageBlocks?.entities?.[b]
        if (!block || (block.status !== 'success' && block.status !== 'error')) return false
      }
      return true
    },
    { tid: topicId },
    { timeout }
  )
}

test.describe('Context refresh stability (no hide during ordinary stream)', () => {
  test('slow-stream chunks retain TokenCount counts and divider geometry; stable send commits atomically', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    const page = mainWindow as Page
    clearRequestLog()
    await waitForChatReady(page)

    // Seed an anchored main route: 12 messages / 6 turns (user even indices).
    const assistantId = await prepareAssistant(page, DISPLAY_LIMIT)
    const topicId = `refresh-stability-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const TOTAL = 12
    const seededIds = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `refresh-stability ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'stability-seed-'
    })
    expect(seededIds).toHaveLength(TOTAL)
    expect(seededIds[0]).toBe(`${topicId}-msg-${pad(0, 5)}`)

    // Partial window: anchor at the turn-3 user message (index 4) so the Main
    // authority reports selected < total and the divider must render.
    const anchorId = seededIds[4]
    await setRouteAnchor(page, assistantId, topicId, null, anchorId)

    // Activate the topic: truncated latest-10 window proves a real viewport
    // read while the closure stays full-route (no window dependency).
    const expectedTail = seededIds.slice(TOTAL - DISPLAY_LIMIT, TOTAL)
    await activateTopic(page, topicId, DISPLAY_LIMIT)
    const loaded: { ids: string[]; domCount: number } = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      return { ids, domCount }
    }, topicId)
    expect(loaded.ids).toEqual(expectedTail)
    expect(loaded.domCount).toBe(DISPLAY_LIMIT)

    // Main authority is the expected counts — never assumed from seed shape.
    const authority = await fetchClosureAuthority(page, topicId, null, anchorId)
    expect(authority.total).toBe(6)
    expect(authority.selected).toBeLessThan(authority.total)
    expect(authority.boundary).toBe(authority.first)
    await expectTokenCount(page, authority.selected, authority.total)

    // Divider must render AND actually intersect the visible #messages viewport
    // (not an offscreen baseline from a different scroll position).
    await expect(divider(page), 'context divider must render for the partial window').toBeVisible({ timeout: 15000 })
    await divider(page).scrollIntoViewIfNeeded()
    const inView = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="context-boundary"]') as HTMLElement | null
      const c = document.querySelector('#messages') as HTMLElement | null
      if (!el || !c) return { ok: false, rect: null, cont: null }
      const r = el.getBoundingClientRect()
      const cr = c.getBoundingClientRect()
      const ok = r.bottom > cr.top && r.top < cr.bottom && r.height > 0 && r.width > 0
      return {
        ok,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        cont: { top: cr.top, bottom: cr.bottom }
      }
    })
    expect(inView.ok, `divider must intersect visible #messages viewport (got ${JSON.stringify(inView)})`).toBe(true)
    const baselineBox = await divider(page).boundingBox()
    expect(baselineBox, 'divider must have geometry').not.toBeNull()
    expect(baselineBox!.width, 'divider width must not collapse at baseline').toBeGreaterThan(0)
    const baselineToolbarBox = await tokenCount(page).boundingBox()
    expect(baselineToolbarBox, 'TokenCount must have geometry at baseline').not.toBeNull()

    // Slow stream on the SAME topic/route/anchor through the real input.
    await uiSendMessage(page, `refresh stability slow stream ${SLOW_STREAM_MARKER}`)
    await waitForStreamingStart(page)

    // Retained baseline captured AFTER the send's structural commit (user turn
    // landed, streaming started) and BEFORE prolonged chunks: the send is a
    // legitimate structural append, so Main may already commit the grown
    // authority (pre+1 turn) before/during early streaming. Never assume the
    // pre-send seed count is unchanged — re-fetch Main as the committed
    // baseline and assert the UI retains exactly that (never blank/0).
    const sendAuthority = await fetchClosureAuthority(page, topicId, null, anchorId)
    expect(sendAuthority.total, 'send must grow total by exactly one turn').toBe(authority.total + 1)
    expect(sendAuthority.selected, 'send must grow selected by exactly one turn').toBe(authority.selected + 1)
    const retained = await readTokenParts(page)
    expect(retained.countText.length, 'retained TokenCount text must be non-blank after send').toBeGreaterThan(0)
    expect(retained.current, 'retained current must equal post-send committed authority').toBe(sendAuthority.selected)
    expect(retained.max, 'retained max must equal post-send committed authority').toBe(sendAuthority.total)
    expect(retained.current, 'retained current must never be a 0 reset').toBeGreaterThan(0)

    // Framewise DURING chunks: no disappearance, no blank/0 reset. Geometry
    // compared only at the same isLoading (streaming) state — never streaming
    // pause controls vs the settled terminal state.
    let sawGrowth = false
    let frameCount = 0
    let scalarSamples: Array<number | null> = []
    for (let i = 0; i < 30; i++) {
      expect(await isStreaming(page), `frame ${i} must sample genuine streaming state`).toBe(true)
      await expect(tokenCount(page), `TokenCount must stay mounted during chunk frame ${i}`).toBeVisible({
        timeout: 5000
      })
      expect(await tokenCount(page).count(), `TokenCount container present at frame ${i}`).toBe(1)
      const parts = await readTokenParts(page)
      expect(parts.countText.length, `TokenCount text must never blank at frame ${i}`).toBeGreaterThan(0)
      expect(parts.current, `TokenCount current must retain committed count at frame ${i}`).toBe(sendAuthority.selected)
      expect(parts.max, `TokenCount max must retain committed count at frame ${i}`).toBe(sendAuthority.total)
      expect(parts.scalarText.length, `live scalar estimate must stay non-blank at frame ${i}`).toBeGreaterThan(0)
      scalarSamples.push(parts.scalarNumeric)
      await expect(divider(page), `divider must persist during chunk frame ${i}`).toBeVisible({ timeout: 5000 })
      expect(await divider(page).count(), `divider count must stay 1 at frame ${i}`).toBe(1)
      const box = await divider(page).boundingBox()
      expect(box, `divider must keep geometry at frame ${i}`).not.toBeNull()
      if (baselineBox && box) {
        expect(Math.abs(box.x - baselineBox.x), `divider x must not shift at frame ${i}`).toBeLessThanOrEqual(2)
        expect(box.width, `divider width must not collapse at frame ${i}`).toBeGreaterThan(0)
      }
      if (baselineToolbarBox) {
        const tb = await tokenCount(page).boundingBox()
        if (tb) {
          expect(Math.abs(tb.y - baselineToolbarBox.y), `toolbar y must hold at frame ${i}`).toBeLessThanOrEqual(4)
        }
      }
      const grown = await page.evaluate(() => {
        const s = (window as any).store?.getState()
        for (const block of Object.values(s?.messageBlocks?.entities ?? {}) as any[]) {
          if (block?.type === 'main_text' && block?.status === 'streaming' && (block?.content?.length ?? 0) > 0)
            return true
        }
        return false
      })
      if (grown) sawGrowth = true
      frameCount += 1
      await page.waitForTimeout(400)
      const settled = await page.evaluate((exp: string) => {
        const s = (window as any).store?.getState()
        for (const block of Object.values(s?.messageBlocks?.entities ?? {}) as any[]) {
          if (block?.type === 'main_text' && block?.content === exp && block?.status === 'success') return true
        }
        return false
      }, getSlowStreamReply(MODEL))
      if (settled) break
    }
    expect(frameCount, 'must have sampled at least one streaming frame').toBeGreaterThan(0)
    expect(sawGrowth, 'must have sampled genuine mid-stream growth').toBe(true)
    await waitForStreamSettled(page, getSlowStreamReply(MODEL))
    test.info().annotations.push({
      type: 'refresh-stability-frames',
      description: `streaming frames=${frameCount} sawGrowth=${sawGrowth} committed=${sendAuthority.selected}/${sendAuthority.total} scalarSamples=${JSON.stringify(scalarSamples.slice(0, 8))}`
    })

    // Settled: counts commit atomically to the Main authority for the same
    // anchor. The turn committed at send time; completion must not add a
    // second turn or blank interim — settled equals the committed baseline.
    const grownAuthority = await fetchClosureAuthority(page, topicId, null, anchorId)
    expect(grownAuthority.total, 'settle must keep the send-committed total (no second growth)').toBe(
      sendAuthority.total
    )
    expect(grownAuthority.selected, 'settle must keep the send-committed selected').toBe(sendAuthority.selected)
    expect(grownAuthority.boundary).toBe(grownAuthority.first)
    await expectTokenCount(page, grownAuthority.selected, grownAuthority.total)
    const settledParts = await readTokenParts(page)
    expect(settledParts.current).toBe(grownAuthority.selected)
    expect(settledParts.max).toBe(grownAuthority.total)
    expect(settledParts.scalarText.length, 'settled scalar must be non-blank').toBeGreaterThan(0)
    expect(await tokenCount(page).count(), 'TokenCount stays mounted after settle').toBe(1)
    await expect(divider(page), 'divider persists after settle').toBeVisible({ timeout: 15000 })
    expect(await divider(page).count(), 'divider count stays 1 after settle').toBe(1)

    // Structural refresh: a second ordinary send commits atomically with no
    // invisible divider flash and no 0/empty interim. Edit-path UI (message
    // toolbar edit/resend) is deliberately NOT exercised here — named gap:
    // edit-refresh-no-flash remains uncovered by this spec.
    test.info().annotations.push({
      type: 'coverage-gap',
      description:
        'edit-refresh-no-flash: in-place message edit refresh path not exercised; structural append is the refresh action here'
    })
    const prevAssist = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const ids = (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
      let n = 0
      for (const id of ids) {
        if (s.messages?.entities?.[id]?.role === 'assistant') n += 1
      }
      return n
    }, topicId)
    await uiSendMessage(page, `refresh stability second send ${Date.now()}`)
    // Interim polling during the second refresh: counts (window-independent)
    // never blank/0-reset. Divider DOM presence is load-window dependent: it
    // renders only when its boundary message is resident. Assert divider
    // presence exactly when the boundary is loaded; otherwise record the
    // window effect explicitly (never a pass-by-absence).
    for (let i = 0; i < 20; i++) {
      const p = await readTokenParts(page)
      expect(p.countText.length, `second-refresh TokenCount must never blank at poll ${i}`).toBeGreaterThan(0)
      expect(p.current, `second-refresh current must never 0-reset at poll ${i}`).toBeGreaterThan(0)
      const boundaryDom: { inRedux: boolean; inDom: boolean } = await page.evaluate(
        ({ tid, bid }: { tid: string; bid: string | null }) => {
          if (!bid) return { inRedux: false, inDom: false }
          const ids = ((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? []) as string[]
          const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(bid) : bid
          return {
            inRedux: ids.includes(bid),
            inDom: !!document.querySelector(`#messages [data-message-id="${esc}"]`)
          }
        },
        { tid: topicId, bid: grownAuthority.boundary }
      )
      if (boundaryDom.inDom) {
        // Boundary message element is rendered: the divider must render with
        // it (any absence here is a genuine invisible flash, not windowing).
        expect(await divider(page).count(), `rendered-boundary divider must persist at poll ${i}`).toBe(1)
      } else {
        test.info().annotations.push({
          type: 'divider-window-effect',
          description: `poll ${i}: boundary inRedux=${boundaryDom.inRedux} inDom=false so divider DOM absence is windowing, not a flash`
        })
      }
      const done: boolean = await page.evaluate(
        ({ tid, prev }: { tid: string; prev: number }) => {
          const s = (window as any).store?.getState()
          const ids = (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
          let n = 0
          for (const id of ids) {
            if (s.messages?.entities?.[id]?.role === 'assistant') n += 1
          }
          return n > prev
        },
        { tid: topicId, prev: prevAssist }
      )
      if (done) break
      await page.waitForTimeout(300)
    }
    await waitForAssistantComplete(page, topicId, prevAssist)
    const finalAuthority = await fetchClosureAuthority(page, topicId, null, anchorId)
    expect(finalAuthority.total, 'second send must grow total by one more turn').toBe(grownAuthority.total + 1)
    expect(finalAuthority.selected, 'second send must grow selected by one more turn').toBe(grownAuthority.selected + 1)
    await expectTokenCount(page, finalAuthority.selected, finalAuthority.total)
    // Bring the boundary back into the loaded window with genuine wheel input
    // (keeper-aware, no scrollTop writes), then prove the divider renders with
    // geometry — no invisible flash when its anchor message is resident.
    expect(finalAuthority.boundary, 'final authority must keep the same boundary').toBe(grownAuthority.boundary)
    const msgBox = await page.locator('#messages').first().boundingBox()
    if (msgBox) await page.mouse.move(msgBox.x + msgBox.width / 2, msgBox.y + msgBox.height / 2)
    let boundaryInDom = false
    for (let attempt = 0; attempt < 24 && !boundaryInDom; attempt++) {
      boundaryInDom = await page.evaluate((bid: string | null) => {
        if (!bid) return false
        const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(bid) : bid
        return !!document.querySelector(`#messages [data-message-id="${esc}"]`)
      }, finalAuthority.boundary)
      if (boundaryInDom) break
      await page.mouse.wheel(0, -560)
      await page.waitForTimeout(300)
    }
    expect(boundaryInDom, 'boundary message must load into DOM after genuine wheel input').toBe(true)
    await expect(divider(page), 'divider renders once its boundary is resident').toBeVisible({ timeout: 15000 })
    expect(await divider(page).count(), 'divider count stays 1 once boundary resident').toBe(1)
    const finalBox = await divider(page).boundingBox()
    expect(finalBox, 'divider must have geometry once resident').not.toBeNull()
    expect(finalBox!.width, 'resident divider width must not collapse').toBeGreaterThan(0)
  })

  test('in-place save-only edit retains TokenCount counts and resident divider; content commits with turn membership intact', async ({
    mainWindow
  }) => {
    test.setTimeout(240000)
    const page = mainWindow as Page
    clearRequestLog()
    await waitForChatReady(page)

    // Same anchored main route shape as the stream test: 12 msgs / 6 turns,
    // anchor at turn-3 user message (index 4) so TokenCount shows selected/total.
    const assistantId = await prepareAssistant(page, DISPLAY_LIMIT)
    const topicId = `refresh-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const TOTAL = 12
    const seededIds = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `refresh-edit ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'edit-seed-'
    })
    expect(seededIds).toHaveLength(TOTAL)

    const anchorId = seededIds[4]
    await setRouteAnchor(page, assistantId, topicId, null, anchorId)
    const expectedTail = seededIds.slice(TOTAL - DISPLAY_LIMIT, TOTAL)
    await activateTopic(page, topicId, DISPLAY_LIMIT)
    const loaded: { ids: string[]; domCount: number } = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      const domCount = document.querySelectorAll('#messages [data-message-id]').length
      return { ids, domCount }
    }, topicId)
    expect(loaded.ids).toEqual(expectedTail)

    const baselineAuthority = await fetchClosureAuthority(page, topicId, null, anchorId)
    expect(baselineAuthority.total).toBe(6)
    expect(baselineAuthority.selected).toBeLessThan(baselineAuthority.total)
    expect(baselineAuthority.boundary).toBe(baselineAuthority.first)
    await expectTokenCount(page, baselineAuthority.selected, baselineAuthority.total)

    // Keep the boundary resident BEFORE the edit so an unloaded-boundary
    // window effect is never misread as flicker. Genuine wheel input only
    // (keeper-aware, no scrollTop writes), mirroring the first test tail.
    const msgBox = await page.locator('#messages').first().boundingBox()
    if (msgBox) await page.mouse.move(msgBox.x + msgBox.width / 2, msgBox.y + msgBox.height / 2)
    let boundaryInDom = false
    for (let attempt = 0; attempt < 24 && !boundaryInDom; attempt++) {
      boundaryInDom = await page.evaluate((bid: string | null) => {
        if (!bid) return false
        const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(bid) : bid
        return !!document.querySelector(`#messages [data-message-id="${esc}"]`)
      }, baselineAuthority.boundary)
      if (boundaryInDom) break
      await page.mouse.wheel(0, -560)
      await page.waitForTimeout(300)
    }
    expect(boundaryInDom, 'boundary message must load into DOM before edit sampling').toBe(true)
    await expect(divider(page), 'divider must render once boundary resident (pre-edit)').toBeVisible({
      timeout: 15000
    })
    expect(await divider(page).count(), 'divider count stays 1 pre-edit').toBe(1)
    const editBaselineBox = await divider(page).boundingBox()
    expect(editBaselineBox, 'divider must have geometry pre-edit').not.toBeNull()
    expect(editBaselineBox!.width, 'resident divider width must not collapse pre-edit').toBeGreaterThan(0)
    const preParts = await readTokenParts(page)
    expect(preParts.current).toBe(baselineAuthority.selected)
    expect(preParts.max).toBe(baselineAuthority.total)
    expect(preParts.scalarText.length, 'pre-edit scalar must be non-blank').toBeGreaterThan(0)

    // Edit target: a user message on the current route that is resident next
    // to the divider window. Index 6 is user role (even), inside the tail and
    // reachable after the boundary pagination load. Save-only path preserves
    // turn membership (no resend, no new turns); the resend/regenerate path
    // would add turns and needs a grown Main expectation instead — NOT used.
    const targetId = seededIds[6]
    expect(targetId).toBeTruthy()
    const targetMeta: { role: string | null; blockId: string; oldContent: string | null; askLink: string | null } =
      await page.evaluate((mid: string) => {
        const s = (window as any).store.getState()
        const msg = s.messages?.entities?.[mid]
        const blockId: string = msg?.blocks?.[0] ?? ''
        const block = blockId ? s.messageBlocks?.entities?.[blockId] : null
        let askLink: string | null = null
        for (const m of Object.values(s.messages?.entities ?? {}) as any[]) {
          if (m?.role === 'assistant' && m?.askId === mid) {
            askLink = m.id
            break
          }
        }
        return { role: msg?.role ?? null, blockId, oldContent: (block?.content as string) ?? null, askLink }
      }, targetId)
    expect(targetMeta.role).toBe('user')
    expect(targetMeta.blockId).not.toBe('')
    expect(targetMeta.oldContent).toBe(`edit-seed-${pad(6, 5)}`)
    expect(targetMeta.askLink, 'target user turn must keep its assistant ask-link').toBeTruthy()
    const editedText = `stability-edited-${Date.now()}`

    // Per-rAF-style sampling helper: mounted/count/text/geometry for the
    // count plus divider presence/geometry plus editor state in one paragraph.
    // Geometry asserts stay to x/width (no y-freeze: the open editor modal
    // legitimately changes real heights; only unmount/blank/collapse is a bug).
    async function sampleEditFrame(label: string): Promise<string> {
      const s: {
        tokenCount: number
        dividerCount: number
        editorOpen: boolean
        boundaryInDom: boolean
      } = await page.evaluate(
        ({ bid }: { bid: string | null }) => {
          const esc = bid && typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(bid) : (bid ?? '')
          return {
            tokenCount: document.querySelectorAll('[data-testid="token-count-context"]').length,
            dividerCount: document.querySelectorAll('[data-testid="context-boundary"]').length,
            editorOpen: !!document.querySelector('.message-editor-area'),
            boundaryInDom: bid ? !!document.querySelector(`#messages [data-message-id="${esc}"]`) : false
          }
        },
        { bid: baselineAuthority.boundary }
      )
      const parts = await readTokenParts(page)
      const box = await divider(page)
        .boundingBox()
        .catch(() => null)
      return (
        `${label}: boundaryInDom=${s.boundaryInDom} tokenMounted=${s.tokenCount} ` +
        `countText=${JSON.stringify(parts.countText)} current=${parts.current} max=${parts.max} ` +
        `scalarLen=${parts.scalarText.length} dividerCount=${s.dividerCount} ` +
        `dividerBox=${box ? `${Math.round(box.x)},${Math.round(box.width)}x${Math.round(box.height)}` : 'null'} ` +
        `editorOpen=${s.editorOpen}`
      )
    }
    async function expectEditFrameStable(label: string): Promise<string> {
      const line = await sampleEditFrame(label)
      const s: { tokenCount: number; dividerCount: number; boundaryInDom: boolean } = await page.evaluate(
        ({ bid }: { bid: string | null }) => {
          const esc = bid && typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(bid) : (bid ?? '')
          return {
            tokenCount: document.querySelectorAll('[data-testid="token-count-context"]').length,
            dividerCount: document.querySelectorAll('[data-testid="context-boundary"]').length,
            boundaryInDom: bid ? !!document.querySelector(`#messages [data-message-id="${esc}"]`) : false
          }
        },
        { bid: baselineAuthority.boundary }
      )
      // Boundary is kept resident by construction; any absence here is window
      // movement, recorded, never asserted as flicker — but the suite holds
      // the resident precondition so divider presence stays meaningful.
      expect(s.boundaryInDom, `${label}: boundary must stay resident (else window effect, not flicker)`).toBe(true)
      expect(s.tokenCount, `${label}: TokenCount must stay mounted (no unmount during edit)`).toBe(1)
      expect(s.dividerCount, `${label}: resident divider must persist (no unmount during edit)`).toBe(1)
      const parts = await readTokenParts(page)
      expect(parts.countText.length, `${label}: TokenCount text must never blank`).toBeGreaterThan(0)
      expect(parts.current, `${label}: current must retain committed count (save-only preserves turns)`).toBe(
        baselineAuthority.selected
      )
      expect(parts.max, `${label}: max must retain committed count (save-only preserves turns)`).toBe(
        baselineAuthority.total
      )
      expect(parts.scalarText.length, `${label}: live scalar must stay non-blank`).toBeGreaterThan(0)
      const box = await divider(page).boundingBox()
      expect(box, `${label}: divider must keep geometry`).not.toBeNull()
      if (editBaselineBox && box) {
        expect(Math.abs(box.x - editBaselineBox.x), `${label}: divider x must not shift`).toBeLessThanOrEqual(2)
        expect(box.width, `${label}: divider width must not collapse`).toBeGreaterThan(0)
      }
      return line
    }

    const timeline: string[] = []
    timeline.push(await sampleEditFrame('pre-edit-baseline'))

    // Real UI edit (normal toolbar action, existing seams only): hover reveals
    // the menubar, msg-edit-btn opens the editor, the CodeMirror helper stages
    // the change through the real onChange path, save-btn commits authoritatively.
    const msgContainer = page.locator(`[data-message-id="${targetId}"]`)
    await msgContainer.scrollIntoViewIfNeeded()
    await expect(msgContainer, 'edit target must be visible').toBeVisible({ timeout: 15000 })
    timeline.push(await expectEditFrameStable('target-in-view'))
    await msgContainer.hover()
    timeline.push(await expectEditFrameStable('after-hover'))
    const editBtn = msgContainer.locator('[data-testid="msg-edit-btn"]')
    await editBtn.waitFor({ state: 'visible', timeout: 10000 })
    await editBtn.click()
    const editorArea = msgContainer.locator('.message-editor-area')
    await expect(editorArea, 'editor must open').toBeVisible({ timeout: 5000 })
    timeline.push(await expectEditFrameStable('editor-open'))
    const editorWrapper = editorArea.locator('.editing-message')
    await expect(editorWrapper, 'editing wrapper must render').toBeVisible({ timeout: 5000 })
    const cmEditor = cmContent(editorArea)
    await expect(cmEditor, 'CodeMirror content must mount').toBeVisible({ timeout: 5000 })
    await replaceEditorContent(page, editorArea, editedText)
    await expect(cmEditor).toContainText(editedText, { timeout: 5000 })
    timeline.push(await expectEditFrameStable('staged-edit'))

    // Commit: save-only. Poll the background invalidation window with the
    // same resident assertions — no unmount of the count while Main commits.
    const saveBtn = editorArea.locator('.message-editor-save-btn')
    await expect(saveBtn, 'save button must render').toBeVisible()
    await saveBtn.click()
    for (let i = 0; i < 20; i++) {
      timeline.push(await expectEditFrameStable(`post-save-poll-${i}`))
      const editorGone: boolean = await page.evaluate(() => !document.querySelector('.message-editor-area'))
      const reduxContent: string | null = await page.evaluate(
        ({ mid }: { mid: string }) => {
          const s = (window as any).store.getState()
          const msg = s.messages?.entities?.[mid]
          const bid: string = msg?.blocks?.[0] ?? ''
          return bid ? ((s.messageBlocks?.entities?.[bid]?.content as string) ?? null) : null
        },
        { mid: targetId }
      )
      if (editorGone && reduxContent === editedText) break
      await page.waitForTimeout(300)
    }
    await expect(editorArea, 'editor must close after authoritative save').not.toBeVisible({ timeout: 10000 })

    // Authoritative accepted replacement: Redux block exact, turn membership
    // intact (same message id resident, same assistant ask-link, no new ids),
    // Main closure counts unchanged (save-only adds no turns).
    const settledContent: string | null = await page.evaluate(
      ({ mid }: { mid: string }) => {
        const s = (window as any).store.getState()
        const msg = s.messages?.entities?.[mid]
        const bid: string = msg?.blocks?.[0] ?? ''
        return bid ? ((s.messageBlocks?.entities?.[bid]?.content as string) ?? null) : null
      },
      { mid: targetId }
    )
    expect(settledContent, 'edited block must carry the authoritative replacement').toBe(editedText)
    const settledMembership: { present: boolean; askLink: string | null; topicOk: boolean } = await page.evaluate(
      ({ tid, mid }: { tid: string; mid: string }) => {
        const s = (window as any).store.getState()
        const ids = (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
        const msg = s.messages?.entities?.[mid]
        let askLink: string | null = null
        for (const m of Object.values(s.messages?.entities ?? {}) as any[]) {
          if (m?.role === 'assistant' && m?.askId === mid) {
            askLink = m.id
            break
          }
        }
        return { present: ids.includes(mid), askLink, topicOk: msg?.topicId === tid }
      },
      { tid: topicId, mid: targetId }
    )
    expect(settledMembership.present, 'edited turn id must stay in the current route').toBe(true)
    expect(settledMembership.topicOk, 'edited message must stay on the same topic').toBe(true)
    expect(settledMembership.askLink, 'assistant ask-link must survive the save-only edit').toBe(targetMeta.askLink)

    const settledAuthority = await fetchClosureAuthority(page, topicId, null, anchorId)
    expect(settledAuthority.total, 'save-only edit must not add turns (direct Main expectation)').toBe(
      baselineAuthority.total
    )
    expect(settledAuthority.selected, 'save-only edit must not move the selected window').toBe(
      baselineAuthority.selected
    )
    expect(settledAuthority.boundary, 'boundary must stay the first message').toBe(settledAuthority.first)
    expect(settledAuthority.boundary).toBe(baselineAuthority.boundary)
    await expectTokenCount(page, settledAuthority.selected, settledAuthority.total)
    timeline.push(await expectEditFrameStable('post-settle'))
    test.info().annotations.push({
      type: 'refresh-edit-stability-timeline',
      description:
        `target=${targetId} old=${JSON.stringify(targetMeta.oldContent)} new=${JSON.stringify(editedText)} ` +
        `askLink=${targetMeta.askLink} committed=${settledAuthority.selected}/${settledAuthority.total}\n` +
        timeline.join('\n')
    })
  })
})
