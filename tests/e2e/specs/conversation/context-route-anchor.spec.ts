/**
 * Context route-anchor regressions — focused INTEGRATED E2E.
 *
 * Covers the two user-reported couplings without touching production/docs:
 *   (A) branch switch / current-max TokenCount coupled to the loaded viewport
 *       and growing on load-more.
 *   (B) true branch / clone above the context-start divider wrongly clamping
 *       the anchor to last instead of the current assistant contextCount default.
 *
 * Evidence tier: INTEGRATED via the standard fixture (fresh build, disposable
 * profile, mock provider). Seeding uses the approved `assistants/addTopic` +
 * `chatDb.ensureTopic` + `pasteMessagesToTopic` pattern only. No direct SQLite
 * writes. Authority reads (`fetchContextClosure`, `fetchMessagesWindow`) are
 * caller-local and never publish into Redux. No hand-rolled launch/profile/mock.
 *
 * Viewport proof: every route is seeded longer than the latest limit
 * (DISPLAY_LIMIT=10) and each activation asserts the truncated Redux/DOM
 * window (exact tail IDs, hasMoreBefore=true). The suite never forces a fully
 * loaded Redux that would mask the viewport-coupling bug.
 *
 * UI paths used (all existing production controls, no ad-hoc harness):
 *   - TokenCount block `[data-testid="token-count-context"]` (click = re-anchor).
 *   - Context divider `[data-testid="context-boundary"]`.
 *   - True-branch toolbar `[data-testid="msg-true-branch-btn"]` via
 *     `branch-route-setup.clickToolbarBranch` (assistant-only, owner-only).
 *   - Flat fork-divider peer switches
 *     `branch-fork-selected/toggle/list/item-parent/item-<branchId>` (same
 *     mechanism as `true-branch.spec.ts`).
 *   - Clone prefix via the existing overflow Copy Topic
 *     (`message-more-menu-btn` -> portal `message-copy-topic-btn`), the same
 *     event bridge as `s62-answer-branch-insert.spec.ts`. The suite does not
 *     count IPC calls; it asserts observable state + authority.
 *   - Load-more via genuine `page.mouse.wheel` over `#messages` (the keeper
 *     contract from `true-branch.spec.ts`); no `scrollTop` assignment, no
 *     dispatched scroll event, no synthetic Redux publication.
 *
 * Pending behavior: the production closure hook falls back to the bounded
 * viewport while no fresh validated closure is cached. This suite asserts the
 * settled authoritative projection (TokenCount == closure selected/total) and
 * polls stability after load-more. It cannot deterministically block the
 * closure IPC with existing helpers, so frame-by-frame pending-no-bounded-count
 * is a documented coverage gap (see test annotations).
 *
 * Actual-window supplement (no count-only reliance): every route additionally
 * asserts the exact ordered closure membership (fetchContextClosure messages
 * IDs + block association + synthetic texts, excluding before-anchor prefix
 * and main-only suffix, including branch-owned/nested contents; same-anchor
 * IDs unchanged across load-more), the exact mock outbound payload on a real
 * Inputbar send (ordered user prompts + retained assistants, exact arrays so
 * missing/off-route extras fail; pre-anchor and main-only contents excluded;
 * prior history stable with only the deliberate new turn growing), and the UI
 * anchor highlight + divider adjacency corresponding to the same closure
 * start (MessageMenubar `context-anchor-btn[data-context-anchor-active]`
 * plus divider-immediately-follows-boundary source order (newest-first).
 */

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { waitForAppReady, waitForChatReady } from '../../utils/wait-helpers'
import {
  clickToolbarBranch,
  letterMessageId,
  listBranches,
  pad,
  prepareAssistant,
  seedSourceTopic
} from '../../utils/branch-route-setup'

const DISPLAY_LIMIT = 10
const LOAD_DELTA_Y = -560
const LOAD_MAX_WHEELS = 24
const LOAD_GROWTH_TIMEOUT_MS = 30000

// ---------------------------------------------------------------------------
// Shared helpers (spec-local, no fixture-global edits)
// ---------------------------------------------------------------------------

async function seedContextCount(page: any, contextCount: number | null): Promise<void> {
  const assistantId: string = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(assistantId, 'live assistant id must exist').toBeTruthy()
  await page.evaluate(
    ({ assistantId, contextCount }: { assistantId: string; contextCount: number | null }) => {
      ;(window as any).store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: { assistantId, settings: { contextCount } }
      })
    },
    { assistantId, contextCount }
  )
  const check = await page.evaluate(
    ({ assistantId }: { assistantId: string }) =>
      (window as any).store.getState().assistants.assistants.find((a: any) => a.id === assistantId)?.settings
        ?.contextCount ?? 'missing',
    { assistantId }
  )
  expect(check).toBe(contextCount)
}

async function getAssistantId(page: any): Promise<string> {
  const id: string = await page.evaluate(() => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? '')
  expect(id).not.toBe('')
  return id
}

function routeKeyFor(topicId: string, branchId: string | null): string {
  return typeof branchId === 'string' && branchId.length > 0 ? `${topicId}:${branchId}` : topicId
}

async function setRouteAnchor(
  page: any,
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
  const persisted = await getRouteAnchor(page, assistantId, topicId, branchId)
  expect(persisted).toBe(groupKey)
}

async function getRouteAnchor(
  page: any,
  assistantId: string,
  topicId: string,
  branchId: string | null
): Promise<string | null> {
  const routeKey = routeKeyFor(topicId, branchId)
  return page.evaluate(
    ({ assistantId, routeKey }: { assistantId: string; routeKey: string }) => {
      const s = (window as any).store.getState()
      const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
      const anchor = assistant?.settings?.contextWindowAnchor?.[routeKey]
      return anchor?.kind === 'active' ? (anchor.groupKey as string) : null
    },
    { assistantId, routeKey }
  )
}

async function getTokenCountText(page: any): Promise<string> {
  const raw: string | null = await page.locator('[data-testid="token-count-context"]').first().textContent()
  return (raw ?? '').replace(/\s+/g, '')
}

async function expectTokenCount(page: any, current: number, max: number, timeout = 30000): Promise<void> {
  await expect(page.locator('[data-testid="token-count-context"]').first()).toHaveText(
    new RegExp(`^\\s*${current}\\s*\\/\\s*${max}\\s*$`),
    { timeout }
  )
}

async function fetchClosureAuthority(
  page: any,
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

async function fetchClosureFull(
  page: any,
  topicId: string,
  branchId: string | null,
  anchorGroupKey: string
): Promise<{
  ids: string[]
  roles: string[]
  contents: string[]
  blockIds: string[]
  selected: number
  total: number
  boundary: string | null
  first: string | null
  last: string | null
}> {
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
  const messages: any[] = res.value.messages ?? []
  const blocks: any[] = res.value.blocks ?? []
  const byId = new Map<string, any>()
  for (const b of blocks) byId.set(b.id as string, b)
  const ids: string[] = messages.map((m: any) => m.id as string)
  const roles: string[] = messages.map((m: any) => m.role as string)
  const contents: string[] = messages.map((m: any) => {
    const blockIds: string[] = (m.blocks ?? []) as string[]
    const texts: string[] = []
    for (const bid of blockIds) {
      const b = byId.get(bid)
      if (b && typeof (b as any).content === 'string') texts.push((b as any).content as string)
    }
    return texts.join('\n')
  })
  const blockIds: string[] = blocks.map((b: any) => b.id as string)
  // Block/message association invariant: every message resolves to exactly its
  // own block(s); every block belongs to exactly one returned message.
  for (const m of messages) {
    const mBlocks: string[] = (m.blocks ?? []) as string[]
    expect(mBlocks.length, `closure message ${m.id} must own at least one block`).toBeGreaterThan(0)
    for (const bid of mBlocks) {
      const b = byId.get(bid)
      expect(b, `block ${bid} for message ${m.id} must be in closure blocks`).toBeTruthy()
      expect((b as any).messageId, `block ${bid} must belong to message ${m.id}`).toBe(m.id)
    }
  }
  return {
    ids,
    roles,
    contents,
    blockIds,
    selected: c.selectedTurnCount,
    total: c.totalTurnCount,
    boundary: c.boundaryMessageId,
    first: c.firstMessageId,
    last: c.lastMessageId
  }
}

/** Extract ordered (role, text) pairs from a mock chat-completions request. */
function extractOutboundPairs(productReq: any): Array<{ role: string; text: string }> {
  const raw: any[] = ((productReq?.parsed as any)?.messages ?? []) as any[]
  return raw.map((m: any) => {
    const role = String(m?.role ?? '')
    const content: unknown = (m as any)?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = (content as any[])
        .map((p: any) => {
          if (typeof p === 'string') return p
          if (p && typeof p === 'object' && typeof (p as any).text === 'string') return (p as any).text as string
          return JSON.stringify(p)
        })
        .join('\n')
    } else if (content != null) text = JSON.stringify(content)
    return { role, text }
  })
}

function outboundUserTexts(productReq: any): string[] {
  return extractOutboundPairs(productReq)
    .filter((p) => p.role === 'user')
    .map((p) => p.text)
}

function outboundAssistantTexts(productReq: any): string[] {
  return extractOutboundPairs(productReq)
    .filter((p) => p.role === 'assistant')
    .map((p) => p.text)
}

async function uiSendMessage(page: any, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ selector, content }: { selector: string; content: string }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement | null
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, content)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { selector: '.inputbar textarea, textarea[placeholder]', content: text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

async function assistantCountForTopic(page: any, topicId: string): Promise<number> {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const ids = (s.messages?.messageIdsByTopic?.[tid] ?? []) as string[]
    let n = 0
    for (const id of ids) {
      if (s.messages?.entities?.[id]?.role === 'assistant') n += 1
    }
    return n
  }, topicId)
}

async function waitForAssistantResponseComplete(
  page: any,
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

/**
 * Anchor highlight + divider boundary correspondence (same closure start).
 * Uses the existing MessageMenubar `context-anchor-btn` active marker rather
 * than divider existence alone, plus DOM source-order adjacency (newest-first
 * source: divider immediately follows the boundary message container,
 * i.e. boundIdx+1==divIdx per the column-reverse DOM-after-anchor production
 * placement in messageFlowNodes.ts).
 */
async function expectAnchorHighlightAndDivider(
  page: any,
  topicId: string,
  boundaryMessageId: string,
  preAnchorUserId: string | null
): Promise<void> {
  const divider = page.locator('[data-testid="context-boundary"]').first()
  await expect(divider, 'context divider must be visible for a partial window').toBeVisible({ timeout: 15000 })
  const order: string[] = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('#messages [data-testid="context-boundary"], #messages [data-message-id]')
    ) as HTMLElement[]
    return nodes.map((el) => {
      if (el.getAttribute('data-testid') === 'context-boundary') return '__DIVIDER__'
      return el.getAttribute('data-message-id') || ''
    })
  }, topicId)
  const divIdx = order.indexOf('__DIVIDER__')
  const boundIdx = order.indexOf(boundaryMessageId)
  expect(
    divIdx,
    `divider must be rendered in source order (have ${JSON.stringify(order.slice(0, 20))})`
  ).toBeGreaterThanOrEqual(0)
  expect(boundIdx, `boundary ${boundaryMessageId} must be rendered`).toBeGreaterThanOrEqual(0)
  expect(
    divIdx,
    `divider must immediately follow boundary ${boundaryMessageId} in newest-first source order (order=${JSON.stringify(order)})`
  ).toBe(boundIdx + 1)
  const esc = (id: string): string => id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const sel = `[id="message-${esc(boundaryMessageId)}"][data-message-id="${esc(boundaryMessageId)}"]`
  const container = page.locator(sel).first()
  await expect(container, `boundary container ${boundaryMessageId} must be visible`).toBeVisible({ timeout: 15000 })
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    // Hover flakiness; the count assertions below retry via Playwright.
  }
  await expect(
    container.locator('[data-testid="context-anchor-btn"][data-context-anchor-active="true"]'),
    `boundary ${boundaryMessageId} must carry the active anchor highlight`
  ).toHaveCount(1, { timeout: 15000 })
  if (preAnchorUserId) {
    const preSel = `[id="message-${esc(preAnchorUserId)}"][data-message-id="${esc(preAnchorUserId)}"]`
    const preLoaded: boolean = await page.evaluate(
      ({ tid, mid }: { tid: string; mid: string }) => {
        const ids = ((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? []) as string[]
        return ids.includes(mid)
      },
      { tid: topicId, mid: preAnchorUserId }
    )
    if (preLoaded) {
      const preContainer = page.locator(preSel).first()
      try {
        await preContainer.hover({ timeout: 8000 })
      } catch {
        // Hover flakiness; count assertion retries.
      }
      await expect(
        preContainer.locator('[data-testid="context-anchor-btn"][data-context-anchor-active="true"]'),
        `pre-anchor ${preAnchorUserId} must not carry the active anchor highlight`
      ).toHaveCount(0, { timeout: 10000 })
    } else {
      test.info().annotations.push({
        type: 'anchor-highlight-pre-anchor-unloaded',
        description: `pre-anchor ${preAnchorUserId} is outside the loaded viewport; highlight absence asserted only via closure exclusion, not DOM.`
      })
    }
  }
}
async function readLoadedProjection(
  page: any,
  topicId: string
): Promise<{ ids: string[]; domIds: string[]; domCount: number }> {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
    const domIds: string[] = Array.from(document.querySelectorAll('#messages [data-message-id]')).map(
      (el) => (el as HTMLElement).getAttribute('data-message-id') || ''
    )
    return { ids, domIds, domCount: domIds.length }
  }, topicId)
}

async function activateTruncatedTopic(page: any, topicId: string, expectedTailIds: string[]): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ tid, len }: { tid: string; len: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[tid]
      return Array.isArray(ids) && ids.length === len && s.messages?.loadingByTopic?.[tid] !== true
    },
    { tid: topicId, len: expectedTailIds.length },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (len: number) => document.querySelectorAll('#messages [data-message-id]').length === len,
    expectedTailIds.length,
    { timeout: 30000 }
  )
  const proj = await readLoadedProjection(page, topicId)
  expect(proj.ids).toEqual(expectedTailIds)
  expect([...proj.domIds].sort()).toEqual([...expectedTailIds].sort())
}

async function waitActiveRoute(page: any, topicId: string, branchId: string | null): Promise<void> {
  await page.waitForFunction(
    ({ tid, bid }: { tid: string; bid: string | null }) => {
      const s = (window as any).store.getState()
      return (s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) === bid && s.messages?.loadingByTopic?.[tid] !== true
    },
    { tid: topicId, bid: branchId },
    { timeout: 30000 }
  )
}

/** Flat fork-divider peer switch (same mechanism as true-branch.spec.ts). */
async function switchRouteViaDivider(
  page: any,
  topicId: string,
  forkAnchorId: string,
  toBranchId: string | null
): Promise<void> {
  const takenSel = `[data-testid="branch-fork-selected-${forkAnchorId}"]`
  const toggleSel = `[data-testid="branch-fork-toggle-${forkAnchorId}"]`
  const takenCount = await page.locator(takenSel).first().count()
  const toggleCount = await page.locator(toggleSel).first().count()
  const opener = takenCount > 0 ? page.locator(takenSel).first() : page.locator(toggleSel).first()
  expect(takenCount + toggleCount, `fork divider for ${forkAnchorId} must be visible`).toBeGreaterThan(0)
  await expect(opener, 'fork divider opener must be visible').toBeVisible({ timeout: 30000 })
  // Legitimate user navigation to the target BEFORE the click (fixture
  // setup, not production): the opener is routinely off-viewport below the
  // fold after seeding/suffix (rect y far below the container bottom) and
  // Playwright's click-time auto-scroll races the keeper/layout settle from
  // the preceding anchor dispatch — the auto-scroll snaps away and the
  // pointer lands on a wrong SPAN/DIV at the viewport center (aria stays
  // false, no popup mount). An explicit scrollIntoViewIfNeeded plus a
  // bounded settle separates navigation from the single actual pointer click
  // below (no force click, no double click, no animation disabling); the
  // click-time auto-scroll is then a no-op and the pointer lands on the
  // opener. Diagnostic proof: isolated repro pre rect y=1184 vs container
  // 85..487 with scrollTop -751, immediate click posted rect unchanged +
  // pointerdown SPAN/DIV at y=444 with no mount; the same flow with prior
  // navigation settled to y=444 and mounted the popup (aria true).
  // Legitimate user navigation to the target BEFORE the click (fixture
  // setup, not production): the opener is routinely off-viewport after
  // seeding/suffix, and Playwright's click-time auto-scroll races the
  // keeper/layout settle from the preceding anchor dispatch — the auto-scroll
  // snaps away and the pointer lands on a wrong row (no popup mount).
  // Genuine wheel input toward the oldest edge (the same -560 gesture the
  // suite uses for load-more, keeper-aware, no scrollTop write, no force)
  // brings the divider into the viewport with bounded settles; the single
  // actual pointer click below then lands on the opener. Diagnostic proof:
  // isolated repro pre rect y=1184 vs container 85..487, immediate click
  // posted rect unchanged + pointer on SPAN/DIV at y=444 with no mount,
  // while the same flow with prior settle mounted the popup (aria true).
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  let inView = false
  for (let attempt = 0; attempt < 24 && !inView; attempt++) {
    const pos: { inView: boolean; above: boolean; below: boolean } = await page.evaluate(
      ({ takenSel, toggleSel }: { takenSel: string; toggleSel: string }) => {
        const openerEl = (document.querySelector(takenSel) ?? document.querySelector(toggleSel)) as HTMLElement | null
        const c = document.querySelector('#messages') as HTMLElement | null
        if (!openerEl || !c) return { inView: false, above: false, below: false }
        const r = openerEl.getBoundingClientRect()
        const cr = c.getBoundingClientRect()
        const ok = r.bottom > cr.top && r.top < cr.bottom && r.height > 0 && r.width > 0
        return { inView: ok, above: r.bottom <= cr.top, below: r.top >= cr.bottom }
      },
      { takenSel, toggleSel }
    )
    inView = pos.inView
    if (inView) break
    // Directional genuine wheel: opener below the fold (isolated repro
    // rect y=1184 vs container bottom 487) needs downward (+560, toward the
    // newer/bottom side) to draw it up into view; opener above needs -560.
    // Keeper-aware real input, no scrollTop write, no force.
    await page.mouse.wheel(0, pos.below ? 560 : -560)
    await page.waitForTimeout(220)
  }
  // Best-effort navigation: if genuine wheels cannot bring the opener into
  // overlap within budget (e.g. pagination growth chasing the target), fall
  // through to the single actual pointer click below and let the popup-open
  // assertion judge truthfully — never a second click, never force.
  if (!inView) {
    test.info().annotations.push({
      type: 'divider-nav-miss',
      description: `fork divider opener for ${forkAnchorId} stayed outside viewport overlap after genuine wheel navigation; proceeding to the single click for a truthful popup verdict`
    })
  }
  await page.waitForTimeout(600)
  await opener.click()
  const list = page.locator(`[data-testid="branch-fork-list-${forkAnchorId}"]`).first()
  await expect(list, 'fork divider popup must open').toBeVisible({ timeout: 15000 })
  const itemSel = toBranchId === null ? `branch-fork-item-parent-${forkAnchorId}` : `branch-fork-item-${toBranchId}`
  const item = list.locator(`[data-testid="${itemSel}"]`).first()
  await expect(item, `route peer ${itemSel} must be offered`).toBeVisible({ timeout: 15000 })
  // Post-send the popup peer can be reported outside the viewport even after
  // Playwright scrolls (same AntD portal clipping as Copy Topic). Visibility
  // above already proves the peer is offered; the click keeps the real UI
  // path with a DOM-click fallback only on viewport flake (no sleep, no IPC).
  try {
    await item.click({ timeout: 8000 })
  } catch {
    await item.evaluate((el: HTMLElement) => el.click())
  }
  await waitActiveRoute(page, topicId, toBranchId)
}

async function wheelLoadOlder(page: any, topicId: string): Promise<{ before: string[]; after: string[] }> {
  // Strict pagination proof: the caller guarantees a freshly latest-limited
  // baseline (exactly DISPLAY_LIMIT) BEFORE any divider around-read can grow
  // the cache, so the current wheel action must strictly increase resident IDs.
  // Accepting an already-grown `before` (e.g. 17 after round-trips) or only
  // `> DISPLAY_LIMIT` without `after > before` would mask a broken load-more.
  //
  // Trigger note: the inverse InfiniteScroll library only fires at the true
  // oldest edge (scrollTop within ~2px of the absolute top). A 120px
  // proximity read must not stop genuine wheel input early; wheels continue
  // to the edge budget, then a deterministic poll waits for async
  // scroll/throttle/load completion before the strict growth assertions.
  const before = (await readLoadedProjection(page, topicId)).ids
  expect(before.length, 'wheel baseline must be exactly the latest-limited window').toBe(DISPLAY_LIMIT)
  const box = await page.locator('#messages').first().boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }
  let wheels = 0
  for (let i = 0; i < LOAD_MAX_WHEELS; i++) {
    const residentLen: number = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid]?.length ?? 0,
      topicId
    )
    if (residentLen > before.length) break
    await page.mouse.wheel(0, LOAD_DELTA_Y)
    wheels += 1
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await page.waitForTimeout(220)
    const stepped: number = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages?.messageIdsByTopic?.[tid]?.length ?? 0,
      topicId
    )
    if (stepped > before.length) break
  }
  // Deterministic convergence wait: async scroll/throttle/load may resolve
  // after the last wheel, so poll for growth before asserting.
  try {
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const ids = (window as any).store.getState().messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length > len
      },
      { tid: topicId, len: before.length },
      { timeout: LOAD_GROWTH_TIMEOUT_MS, polling: 250 }
    )
  } catch {
    // Fall through to the strict assertions below for a clear failure.
  }
  const after = (await readLoadedProjection(page, topicId)).ids
  const edge = await page.evaluate(() => {
    const el = document.querySelector('#messages') as HTMLElement | null
    if (!el) return null
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
  test.info().annotations.push({
    type: 'wheel-load-older-diagnostic',
    description: `synthetic diagnostic read-only (no scrollTop write, no dispatched scroll): wheels=${wheels}/${LOAD_MAX_WHEELS} deltaY=${LOAD_DELTA_Y} before=${before.length} after=${after.length} edge=${edge ? `${edge.scrollTop}/${edge.scrollHeight}/${edge.clientHeight}` : 'n/a'}`
  })
  // Causal growth proof: the current wheel action increased resident IDs, the
  // window exceeds the latest-10 viewport, and prior IDs are preserved as the
  // newest suffix in effective order (strictly-older prefix growth, no reorder).
  expect(after.length, 'wheel must strictly increase loaded IDs').toBeGreaterThan(before.length)
  expect(after.length).toBeGreaterThan(DISPLAY_LIMIT)
  expect(after.slice(after.length - before.length)).toEqual(before)
  return { before, after }
}

async function hoverMessageAndOpenMore(page: any, messageId: string): Promise<void> {
  const e = messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const sel = `[id="message-${e}"][data-message-id="${e}"]`
  let container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 15000 })
  await page.evaluate((id: string) => {
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
  }, messageId)
  container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible after scroll`).toBeVisible({ timeout: 15000 })
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    // Hover flakiness near edges; the more-button click below still proceeds.
  }
  const moreBtn = container.locator('[data-testid="message-more-menu-btn"]')
  await expect(moreBtn, `more-menu button for ${messageId} must be attached`).toBeAttached({ timeout: 10000 })
  try {
    await moreBtn.click({ timeout: 5000 } as any)
  } catch {
    await moreBtn.evaluate((el: HTMLElement) => el.click())
  }
  await expect(page.locator('.ant-dropdown').first(), 'dropdown portal must open').toBeVisible({ timeout: 10000 })
}

async function clickPortalCopyTopic(page: any): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(() => {
            const portals = Array.from(document.querySelectorAll('.ant-dropdown')) as HTMLElement[]
            const isShown = (el: HTMLElement): boolean => {
              const rect = el.getBoundingClientRect()
              if (rect.width === 0 && rect.height === 0) return false
              const style = window.getComputedStyle(el)
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
              return true
            }
            const holders = portals
              .filter(isShown)
              .filter((p) => p.querySelectorAll('[data-testid="message-copy-topic-btn"]').length === 1)
            if (holders.length !== 1) return false
            const target = holders[0].querySelector('[data-testid="message-copy-topic-btn"]') as HTMLElement | null
            if (!target) return false
            const menuItem = target.closest('[role="menuitem"]') as HTMLElement | null
            ;(menuItem ?? target).click()
            return true
          })
        } catch {
          return false
        }
      },
      { timeout: 10000, intervals: [100, 250] }
    )
    .toBe(true)
}

async function getRawTopicIds(page: any, topicId: string): Promise<string[]> {
  const raw: any = await page.evaluate(
    async (tid: string) => await (window as any).api.chatDb.getRawTopic({ topicId: tid }),
    topicId
  )
  expect(raw?.ok, `getRawTopic failed: ${JSON.stringify(raw)}`).toBe(true)
  return (raw.value?.messages ?? []).map((m: any) => m.id as string)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Context route-anchor regressions', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('(A) route switches + load-more keep authoritative current/max, not viewport', async ({ mainWindow }) => {
    test.setTimeout(420000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: seed 30-msg main, fresh branch latest-10 baseline then strict wheel growth (after>before) BEFORE any divider around-read can grow the cache, then branch suffix (28 vs 30 asymmetry) + real divider switches main->branch->main->branch, nested L2 proves non-main-only, settled TokenCount == closure selected/total per route. Pending frame-by-frame no-bounded-count is a gap: no existing helper deterministically blocks closure IPC, so only settled + stability polling is asserted.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const assistantId = await prepareAssistant(page, DISPLAY_LIMIT)
    await seedContextCount(page, 4)

    const topicId = `ctx-route-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const TOTAL = 30
    const sourceIds = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `CtxRouteA ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'ctx-route-a-'
    })
    // User turns are even indices; both route anchors live inside the latest
    // tail so anchor/divider auto-rebase never fires on a truncated window.
    // forkAnchor must lie inside the truncated latest-10 tail (indices 20..29)
    // so the real toolbar is rendered; 21 is assistant-owned, keeps the branch
    // prefix (22) asymmetric vs main (30) even before the suffix lands.
    const mainAnchor = sourceIds[20] // user turn inside the main tail window
    const forkAnchor = sourceIds[21] // assistant fork point inside the tail window
    await setRouteAnchor(page, assistantId, topicId, null, mainAnchor)

    // Activate main: truncated latest-10 window proves a real viewport read.
    const mainTail = sourceIds.slice(TOTAL - DISPLAY_LIMIT, TOTAL)
    await activateTruncatedTopic(page, topicId, mainTail)
    const mainProbe: any = await page.evaluate(
      async ({ tid, limit }: { tid: string; limit: number }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId: tid, limit }),
      { tid: topicId, limit: DISPLAY_LIMIT }
    )
    expect(mainProbe?.ok).toBe(true)
    expect(mainProbe.value.window.hasMoreBefore).toBe(true)

    // Fork L1 via the real toolbar (assistant anchor, owner-only).
    await clickToolbarBranch(page, forkAnchor)
    await waitActiveRoute(page, topicId, (await listBranches(page, topicId))[0].id as string)
    let branches = await listBranches(page, topicId)
    expect(branches).toHaveLength(1)
    const branchId = branches[0].id as string
    expect(branches[0].anchorMessageId).toBe(forkAnchor)

    // Fresh branch baseline BEFORE any divider around-read can grow the cache:
    // the toolbar fork lands via a production `latest` read, so the prefix-only
    // branch (22 msgs) must render exactly its latest DISPLAY_LIMIT tail with
    // authoritative hasMoreBefore=true. No topic re-click (cache-hit would keep
    // stale state) and no forced Redux hydration.
    const branchPrefixTail = sourceIds.slice(22 - DISPLAY_LIMIT, 22)
    expect(branchPrefixTail).toHaveLength(DISPLAY_LIMIT)
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len && s.messages?.loadingByTopic?.[tid] !== true
      },
      { tid: topicId, len: DISPLAY_LIMIT },
      { timeout: 30000 }
    )
    {
      const proj = await readLoadedProjection(page, topicId)
      expect(proj.ids, 'fresh branch window must be exactly the latest prefix tail').toEqual(branchPrefixTail)
      expect(proj.domCount).toBe(DISPLAY_LIMIT)
      const branchProbe: any = await page.evaluate(
        async ({ tid, bid, limit }: { tid: string; bid: string; limit: number }) =>
          await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId: tid, branchId: bid, limit }),
        { tid: topicId, bid: branchId, limit: DISPLAY_LIMIT }
      )
      expect(branchProbe?.ok).toBe(true)
      expect(branchProbe.value.window.hasMoreBefore).toBe(true)
      expect((branchProbe.value.messages as any[]).map((m: any) => m.id)).toEqual(branchPrefixTail)
    }

    // Early branch anchor inside the currently rendered window (user turn 18 is
    // the newest-but-one prefix user in the fresh tail). Two-phase anchors are
    // intentional: this prefix anchor proves load-more stability on the fresh
    // window; the suffix anchor below overwrites it for the final asymmetry.
    const branchEarlyAnchor = sourceIds[18]
    await setRouteAnchor(page, assistantId, topicId, branchId, branchEarlyAnchor)
    const branchEarlyAuth = await fetchClosureAuthority(page, topicId, branchId, branchEarlyAnchor)
    await expectTokenCount(page, branchEarlyAuth.selected, branchEarlyAuth.total)
    expect(await getRouteAnchor(page, assistantId, topicId, branchId)).toBe(branchEarlyAnchor)
    // Actual window membership (not counts): the early prefix anchor resolves to
    // exactly msgs 18..21 (2 turns), excluding the before-anchor prefix 0..17
    // and the main-only tail 22..29 (branch effective has no main-only rows).
    const earlyFullBefore = await fetchClosureFull(page, topicId, branchId, branchEarlyAnchor)
    const expectedEarlyIds = sourceIds.slice(18, 22)
    expect(earlyFullBefore.ids, 'early branch closure must be exactly msgs 18..21 in order').toEqual(expectedEarlyIds)
    expect(earlyFullBefore.roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(
      earlyFullBefore.contents,
      'early branch closure contents must equal the seeded synthetic texts in order'
    ).toEqual([18, 19, 20, 21].map((i) => `ctx-route-a-${pad(i, 5)}`))
    for (const pre of sourceIds.slice(0, 18)) {
      expect(earlyFullBefore.ids, `pre-anchor ${pre} must be excluded`).not.toContain(pre)
    }
    for (const mainOnly of sourceIds.slice(22, 30)) {
      expect(earlyFullBefore.ids, `main-only ${mainOnly} must be excluded from the branch route`).not.toContain(
        mainOnly
      )
    }
    expect(earlyFullBefore.first).toBe(branchEarlyAnchor)
    expect(earlyFullBefore.boundary).toBe(branchEarlyAnchor)
    const tokenBefore = await getTokenCountText(page)
    const anchorBefore = await getRouteAnchor(page, assistantId, topicId, branchId)

    // Causal load-more proof on the fresh window: the current wheel action must
    // strictly increase loaded IDs (after.length > before.length with
    // before.length == DISPLAY_LIMIT, prior IDs preserved as the newest suffix)
    // while the persisted anchor and settled TokenCount stay unchanged.
    const { before, after } = await wheelLoadOlder(page, topicId)
    expect(before, 'wheel baseline must be the fresh prefix tail').toEqual(branchPrefixTail)
    expect(await getRouteAnchor(page, assistantId, topicId, branchId)).toBe(anchorBefore)
    expect(await getTokenCountText(page)).toBe(tokenBefore)
    await expectTokenCount(page, branchEarlyAuth.selected, branchEarlyAuth.total)
    await expect
      .poll(async () => await getTokenCountText(page), { timeout: 3000, intervals: [250] })
      .toBe(`${branchEarlyAuth.selected}/${branchEarlyAuth.total}`)
    // Same-anchor closure stability across pagination: load-more must not move
    // the authoritative window membership.
    const earlyFullAfter = await fetchClosureFull(page, topicId, branchId, branchEarlyAnchor)
    expect(earlyFullAfter.ids, 'closure IDs for the same anchor must be unchanged before/after load-more').toEqual(
      earlyFullBefore.ids
    )
    expect(earlyFullAfter.contents).toEqual(earlyFullBefore.contents)
    expect(earlyFullAfter.roles).toEqual(earlyFullBefore.roles)

    // Branch suffix: 6 synthetic branch-owned messages (3 turns) so the branch
    // effective route (22 prefix + 6 suffix = 28) stays longer than the viewport
    // and asymmetric vs main (30). Caller-local insert; no Redux publication.
    const suffixUserIds: string[] = []
    const suffixEntries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
    for (let t = 0; t < 3; t++) {
      const uId = `${topicId}-bsuf-u-${pad(t, 2)}`
      const aId = `${topicId}-bsuf-a-${pad(t, 2)}`
      suffixUserIds.push(uId)
      suffixEntries.push(
        {
          message: {
            id: uId,
            topicId,
            role: 'user',
            assistantId,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            status: 'success',
            blocks: [`${uId}-block`],
            sortOrder: 1000 + t * 2
          },
          blocks: [
            {
              id: `${uId}-block`,
              messageId: uId,
              type: 'main_text',
              content: `ctx-route-a-suffix-u-${pad(t, 2)}`,
              status: 'success',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          ]
        },
        {
          message: {
            id: aId,
            topicId,
            role: 'assistant',
            assistantId,
            askId: uId,
            model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' },
            modelId: 'mock-model',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            status: 'success',
            blocks: [`${aId}-block`],
            sortOrder: 1000 + t * 2 + 1
          },
          blocks: [
            {
              id: `${aId}-block`,
              messageId: aId,
              type: 'main_text',
              content: `ctx-route-a-suffix-a-${pad(t, 2)}`,
              status: 'success',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          ]
        }
      )
    }
    // Deterministic suffix seeding: single batch at the fork anchor in entry order.
    const batch: any = await page.evaluate(
      async ({ tid, bid, anchor, entries }: { tid: string; bid: string; anchor: string; entries: any }) =>
        await (window as any).api.chatDb.insertMessagesAfterAnchor({
          topicId: tid,
          branchId: bid,
          afterMessageId: anchor,
          entries
        }),
      { tid: topicId, bid: branchId, anchor: forkAnchor, entries: suffixEntries }
    )
    expect(batch?.ok, `branch suffix batch failed: ${JSON.stringify(batch)}`).toBe(true)

    // Final branch anchor (route isolation): second suffix user turn, inside the
    // branch tail window. Overwrites the early prefix anchor used for the
    // load-more proof above; the suffix keeps the branch effective route (22
    // prefix + 6 suffix = 28) longer than the viewport and asymmetric vs main.
    const branchAnchor = suffixUserIds[1]
    await setRouteAnchor(page, assistantId, topicId, branchId, branchAnchor)

    // Divider round-trips AFTER the load-more proof: both routes are read
    // through production windowed around-loads (which merge and grow the cache).
    // Ordering is intentional — the causal wheel growth above ran on a fresh
    // latest-limited window, so later cache growth cannot masquerade as proof.
    await switchRouteViaDivider(page, topicId, forkAnchor, null)
    const mainAuth = await fetchClosureAuthority(page, topicId, null, mainAnchor)
    await expectTokenCount(page, mainAuth.selected, mainAuth.total)
    expect(await getRouteAnchor(page, assistantId, topicId, null)).toBe(mainAnchor)
    expect(await getTokenCountText(page)).toBe(`${mainAuth.selected}/${mainAuth.total}`)

    await switchRouteViaDivider(page, topicId, forkAnchor, branchId)
    const branchAuth = await fetchClosureAuthority(page, topicId, branchId, branchAnchor)
    // Asymmetric windows: branch total differs from main total.
    expect(branchAuth.total).not.toBe(mainAuth.total)
    await expectTokenCount(page, branchAuth.selected, branchAuth.total)
    expect(await getRouteAnchor(page, assistantId, topicId, branchId)).toBe(branchAnchor)
    const branchBoundary = page.locator('[data-testid="context-boundary"]').first()
    if (branchAuth.selected < branchAuth.total) {
      await expect(branchBoundary).toBeVisible({ timeout: 15000 })
    } else {
      await expect(branchBoundary).toHaveCount(0)
    }

    // Actual window membership for both routes (exact ordered IDs + synthetic
    // texts). Main: anchor 20 to end (10 msgs, 5 turns). Branch: suffix tail
    // from bsuf-u-01 (4 msgs, 2 turns); excludes the before-anchor prefix and
    // the main-only tail 22..29 while including the branch-owned suffix.
    const suffixIds = [
      suffixUserIds[0],
      `${topicId}-bsuf-a-${pad(0, 2)}`,
      suffixUserIds[1],
      `${topicId}-bsuf-a-${pad(1, 2)}`,
      suffixUserIds[2],
      `${topicId}-bsuf-a-${pad(2, 2)}`
    ]
    const expectedBranchIds = [
      suffixUserIds[1],
      `${topicId}-bsuf-a-${pad(1, 2)}`,
      suffixUserIds[2],
      `${topicId}-bsuf-a-${pad(2, 2)}`
    ]
    const branchFull = await fetchClosureFull(page, topicId, branchId, branchAnchor)
    expect(branchFull.ids, 'branch closure must be exactly the suffix tail in effective order').toEqual(
      expectedBranchIds
    )
    expect(branchFull.roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(branchFull.contents).toEqual([
      `ctx-route-a-suffix-u-${pad(1, 2)}`,
      `ctx-route-a-suffix-a-${pad(1, 2)}`,
      `ctx-route-a-suffix-u-${pad(2, 2)}`,
      `ctx-route-a-suffix-a-${pad(2, 2)}`
    ])
    expect(branchFull.first).toBe(branchAnchor)
    expect(branchFull.boundary).toBe(branchAnchor)
    expect(branchFull.last).toBe(suffixIds[suffixIds.length - 1])
    for (const pre of [...sourceIds.slice(0, 22), suffixIds[0], suffixIds[1]]) {
      expect(branchFull.ids, `before-anchor ${pre} must be excluded`).not.toContain(pre)
    }
    for (const mainOnly of sourceIds.slice(22, 30)) {
      expect(branchFull.ids, `main-only ${mainOnly} must be excluded from the branch route`).not.toContain(mainOnly)
    }
    const mainFull = await fetchClosureFull(page, topicId, null, mainAnchor)
    const expectedMainIds = sourceIds.slice(20, 30)
    expect(mainFull.ids, 'main closure must be exactly anchor-to-end in effective order').toEqual(expectedMainIds)
    expect(mainFull.contents).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29].map((i) => `ctx-route-a-${pad(i, 5)}`))
    expect(mainFull.first).toBe(mainAnchor)
    expect(mainFull.boundary).toBe(mainAnchor)
    // UI correspondence on the branch route: divider boundary + active anchor
    // highlight are the same closure start (not divider existence alone).
    await expectAnchorHighlightAndDivider(page, topicId, branchAnchor, sourceIds[20])
    // Main exact closure is pagination-stable (caller-local read, no publish).
    const mainFullRepeat = await fetchClosureFull(page, topicId, null, mainAnchor)
    expect(mainFullRepeat.ids).toEqual(mainFull.ids)
    expect(mainFullRepeat.contents).toEqual(mainFull.contents)

    // Switch back to main: each route keeps its own settled counts.
    await switchRouteViaDivider(page, topicId, forkAnchor, null)
    const mainAuth2 = await fetchClosureAuthority(page, topicId, null, mainAnchor)
    expect(mainAuth2).toEqual(mainAuth)
    await expectTokenCount(page, mainAuth2.selected, mainAuth2.total)
    expect(await getRouteAnchor(page, assistantId, topicId, null)).toBe(mainAnchor)

    // Back to branch after the main isolation check; the causal load-more proof
    // already ran on the fresh window above, so no second wheel is needed here.
    await switchRouteViaDivider(page, topicId, forkAnchor, branchId)
    await expectTokenCount(page, branchAuth.selected, branchAuth.total)

    // Ordinary send on the branch while the loaded viewport omits part
    // of the selected context (anchor earlier than oldest loaded). The divider
    // round-trips above grow the cache via production around-loads (resident
    // ~17, oldest prefix 11), so no reactivation to an exact latest-10 tail is
    // attempted here — that assumption is wrong after merges. Uses a genuinely
    // off-viewport omission anchor (prefix user 2): the effective branch route
    // is prefix 0..21 + 6 suffix = 28, while the resident viewport stays
    // bounded <28 with its oldest strictly newer than the anchor. No forced
    // full hydration: the viewport is left exactly as the round-trips left it,
    // the closure read is caller-local (never published), and the send is the
    // real Inputbar path to terminal. If the send races a cache refresh, the
    // exact assertions below capture the FAIL with expected-vs-actual (never
    // papered over by warming the cache via API injection).
    const omissionAnchor = sourceIds[2]
    await setRouteAnchor(page, assistantId, topicId, branchId, omissionAnchor)
    const omissionFull = await fetchClosureFull(page, topicId, branchId, omissionAnchor)
    const expectedOmissionIds = [...sourceIds.slice(2, 22), ...suffixIds]
    expect(omissionFull.ids, 'omission closure must be exactly prefix 2..21 + branch suffix in order').toEqual(
      expectedOmissionIds
    )
    expect(
      omissionFull.roles,
      'omission closure roles must strictly alternate user/assistant from the user anchor'
    ).toEqual(Array.from({ length: expectedOmissionIds.length }, (_, i) => (i % 2 === 0 ? 'user' : 'assistant')))
    expect(omissionFull.contents).toEqual([
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map(
        (i) => `ctx-route-a-${pad(i, 5)}`
      ),
      `ctx-route-a-suffix-u-${pad(0, 2)}`,
      `ctx-route-a-suffix-a-${pad(0, 2)}`,
      `ctx-route-a-suffix-u-${pad(1, 2)}`,
      `ctx-route-a-suffix-a-${pad(1, 2)}`,
      `ctx-route-a-suffix-u-${pad(2, 2)}`,
      `ctx-route-a-suffix-a-${pad(2, 2)}`
    ])
    for (const pre of sourceIds.slice(0, 2)) {
      expect(omissionFull.ids, `pre-anchor ${pre} must be excluded`).not.toContain(pre)
    }
    for (const mainOnly of sourceIds.slice(22, 30)) {
      expect(omissionFull.ids, `main-only ${mainOnly} must be excluded`).not.toContain(mainOnly)
    }
    expect(omissionFull.first).toBe(omissionAnchor)
    expect(omissionFull.boundary).toBe(omissionAnchor)
    expect(omissionFull.last).toBe(suffixIds[suffixIds.length - 1])
    await waitActiveRoute(page, topicId, branchId)
    const omissionLoaded = await readLoadedProjection(page, topicId)
    const branchEffectiveCount = 22 + suffixIds.length
    expect(
      omissionLoaded.ids.length,
      `branch viewport must stay bounded (< full effective ${branchEffectiveCount}, got ${omissionLoaded.ids.length})`
    ).toBeLessThan(branchEffectiveCount)
    expect(
      omissionLoaded.domCount,
      `rendered viewport must stay bounded (< full effective ${branchEffectiveCount}, got ${omissionLoaded.domCount})`
    ).toBeLessThan(branchEffectiveCount)
    expect(omissionLoaded.ids, 'viewport must omit the off-viewport omission anchor').not.toContain(omissionAnchor)
    expect(omissionLoaded.domIds, 'rendered viewport must omit the off-viewport omission anchor').not.toContain(
      omissionAnchor
    )
    const omissionAnchorIdx = expectedOmissionIds.indexOf(omissionAnchor)
    const oldestLoadedIdx = expectedOmissionIds.indexOf(omissionLoaded.ids[0])
    expect(oldestLoadedIdx, 'anchor must be earlier than the oldest loaded row').toBeGreaterThan(omissionAnchorIdx)
    // Stronger semantic precondition: at least one selected historical user
    // (ID and exact synthetic text) is actually absent from the projection,
    // so the send below proves request independence from the viewport rather
    // than asserting any arbitrary projection length.
    const historicalProbeId = sourceIds[4]
    const historicalProbeText = `ctx-route-a-${pad(4, 5)}`
    expect(expectedOmissionIds, 'probe must be part of the selected closure').toContain(historicalProbeId)
    expect(
      omissionLoaded.ids,
      `selected historical user ${historicalProbeId} must be absent from the viewport`
    ).not.toContain(historicalProbeId)
    expect(
      omissionLoaded.domIds,
      `selected historical user ${historicalProbeId} must be absent from the rendered viewport`
    ).not.toContain(historicalProbeId)
    const probeTextRendered: boolean = await page.evaluate(
      (probe: string) => document.querySelector('#messages')?.textContent?.includes(probe) ?? false,
      historicalProbeText
    )
    expect(probeTextRendered, `selected historical text ${historicalProbeText} must be absent from #messages`).toBe(
      false
    )
    const omissionFullRepeat = await fetchClosureFull(page, topicId, branchId, omissionAnchor)
    expect(omissionFullRepeat.ids, 'Main exact closure first: same-anchor membership stable across pagination').toEqual(
      omissionFull.ids
    )
    const mainFullBeforeSend = await fetchClosureFull(page, topicId, null, mainAnchor)
    expect(mainFullBeforeSend.ids).toEqual(mainFull.ids)
    const omissionHistoricalUsers = omissionFull.contents.filter((_, i) => i % 2 === 0)
    const omissionHistoricalAssistants = omissionFull.contents.filter((_, i) => i % 2 === 1)
    expect(omissionHistoricalUsers).toHaveLength(13)
    expect(omissionHistoricalAssistants).toHaveLength(13)
    const branchNewPrompt = `ctx-route-a-live-${topicId}`
    {
      const prevAssist = await assistantCountForTopic(page, topicId)
      clearRequestLog()
      const seq = getRequestSequence()
      await uiSendMessage(page, branchNewPrompt)
      await waitForAssistantResponseComplete(page, topicId, prevAssist)
      const productReq: any = findProductRequestAfter(seq)
      expect(productReq, 'mock must observe the ordinary branch send').not.toBeNull()
      expect(productReq.url).toBe('/v1/chat/completions')
      const pairs = extractOutboundPairs(productReq)
      const userTexts = pairs.filter((p) => p.role === 'user').map((p) => p.text)
      const assistantTexts = pairs.filter((p) => p.role === 'assistant').map((p) => p.text)
      // Full membership is asserted separately via the direct closure above;
      // the filtered model payload must carry exactly the historical users in
      // order plus the new prompt (filterLastAssistant retains interior
      // assistants because the new user is last; no system role is expected
      // for these synthetic turns — user sequence is the stable invariant).
      expect(
        userTexts,
        `branch outbound user sequence must be exactly the 13 historical users + new prompt (got ${JSON.stringify(userTexts)})`
      ).toEqual([...omissionHistoricalUsers, branchNewPrompt])
      expect(
        assistantTexts,
        `branch outbound assistant sequence must be exactly the 13 historical assistants (got ${JSON.stringify(assistantTexts)})`
      ).toEqual(omissionHistoricalAssistants)
      for (const preContent of sourceIds.slice(0, 2).map((_, k) => `ctx-route-a-${pad(k, 5)}`)) {
        expect(userTexts, `pre-anchor content ${preContent} must be excluded`).not.toContain(preContent)
      }
      for (const mainOnlyContent of [22, 24, 26, 28].map((i) => `ctx-route-a-${pad(i, 5)}`)) {
        expect(userTexts, `main-only content ${mainOnlyContent} must be excluded`).not.toContain(mainOnlyContent)
      }
      // Prior history stable and full: the grown closure keeps the previous
      // historical IDs as a strict prefix, only the deliberate new turn grows.
      const omissionGrown = await fetchClosureFull(page, topicId, branchId, omissionAnchor)
      expect(omissionGrown.ids.slice(0, omissionFull.ids.length)).toEqual(omissionFull.ids)
      expect(omissionGrown.ids.length).toBe(omissionFull.ids.length + 2)
      const mainFullAfterSend = await fetchClosureFull(page, topicId, null, mainAnchor)
      expect(mainFullAfterSend.ids, 'main route must be unchanged by the branch send').toEqual(mainFull.ids)
      // Restore the suffix-tail anchor for the nested proof below (route
      // isolation): the omission anchor was deliberate only for this send. The
      // ordinary send grew the branch route by exactly one turn, so the
      // restored suffix-tail closure keeps the pre-send IDs as a strict prefix
      // plus the deliberate new turn (prefix-stable growth, same as the
      // omission closure above).
      await setRouteAnchor(page, assistantId, topicId, branchId, branchAnchor)
      const branchFullRestored = await fetchClosureFull(page, topicId, branchId, branchAnchor)
      expect(branchFullRestored.ids.slice(0, expectedBranchIds.length)).toEqual(expectedBranchIds)
      expect(branchFullRestored.ids.length).toBe(expectedBranchIds.length + 2)
      await switchRouteViaDivider(page, topicId, forkAnchor, branchId)
      await expectTokenCount(page, branchFullRestored.selected, branchFullRestored.total)
    }

    // Nested L2 (non-main-only proof): fork from the branch-owned suffix via IPC
    // would bypass UI gating, so use the real toolbar on a branch-owned assistant.
    // The suffix tail assistant is branch-owned and inside the currently rendered
    // around-window (no forced hydration, no test-only runtime hooks).
    const nestedForkAssistant = `${topicId}-bsuf-a-${pad(2, 2)}`
    await clickToolbarBranch(page, nestedForkAssistant)
    branches = await listBranches(page, topicId)
    expect(branches).toHaveLength(2)
    const nestedId = (branches.find((b: any) => b.id !== branchId) as any).id as string
    await waitActiveRoute(page, topicId, nestedId)
    const nestedAnchor = await getRouteAnchor(page, assistantId, topicId, nestedId)
    expect(nestedAnchor, 'nested branch must establish a non-empty anchor').not.toBeNull()
    const nestedAuth = await fetchClosureAuthority(page, topicId, nestedId, nestedAnchor as string)
    await expectTokenCount(page, nestedAuth.selected, nestedAuth.total)
    // Nested effective contents: the fork lands after the parent anchor, so the
    // retained parent anchor carries over and the nested closure matches the
    // branch suffix tail exactly (branch-owned, non-main-only).
    expect(nestedAnchor, 'after-anchor nested fork must inherit the parent anchor').toBe(branchAnchor)
    const nestedFull = await fetchClosureFull(page, topicId, nestedId, nestedAnchor as string)
    expect(nestedFull.ids, 'nested closure must equal the branch suffix tail').toEqual(expectedBranchIds)
    expect(nestedFull.contents).toEqual(branchFull.contents)
  })

  test('(B) true branch above context-start inherits default, not last; retained fork inherits parent', async ({
    mainWindow
  }) => {
    test.setTimeout(420000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: contextCount=2, parent anchor late, real toolbar fork above the divider with 3-turn prefix proves destination anchor == default start (not last), TokenCount/divider == closure authority, TokenCount click idempotent; second retained-anchor fork inherits parent; parent anchor/settings untouched.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const assistantId = await prepareAssistant(page, DISPLAY_LIMIT)
    await seedContextCount(page, 2)

    const topicId = `ctx-branch-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 12 messages = 6 turns (even=user, odd=assistant).
    const TOTAL = 12
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `CtxBranchB ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'ctx-branch-b-'
    })
    // Parent anchor late: turn 4 user (msg index 8). Fork early above it.
    const parentAnchor = ids[8]
    const earlyForkAssistant = ids[5] // assistant of turn 2; prefix = msgs 0..5 (3 turns)
    const retainedForkAssistant = ids[9] // assistant of turn 4; at/after the parent anchor
    await setRouteAnchor(page, assistantId, topicId, null, parentAnchor)
    const contextCountBefore: number | null = await page.evaluate(
      ({ assistantId }: { assistantId: string }) =>
        (window as any).store.getState().assistants.assistants.find((a: any) => a.id === assistantId)?.settings
          ?.contextCount ?? null,
      { assistantId }
    )
    expect(contextCountBefore).toBe(2)

    await activateTruncatedTopic(page, topicId, ids.slice(TOTAL - DISPLAY_LIMIT, TOTAL))

    // Early fork via the real toolbar. Prefix turns: [0/1, 2/3, 4/5] (3 turns).
    // N=2 default start = turn index 1 (user ids[2]); last = turn index 2 (user ids[4]).
    await clickToolbarBranch(page, earlyForkAssistant)
    let branches = await listBranches(page, topicId)
    expect(branches).toHaveLength(1)
    const destBranchId = branches[0].id as string
    expect(branches[0].anchorMessageId).toBe(earlyForkAssistant)
    await waitActiveRoute(page, topicId, destBranchId)

    const destAnchor = await getRouteAnchor(page, assistantId, topicId, destBranchId)
    const expectedDefault = ids[2]
    const wrongLast = ids[4]
    expect(expectedDefault).not.toBe(wrongLast)
    expect(destAnchor, `out-of-range fork must resolve to default ${expectedDefault}, not last ${wrongLast}`).toBe(
      expectedDefault
    )
    const destAuth = await fetchClosureAuthority(page, topicId, destBranchId, destAnchor as string)
    expect(destAuth.total).toBe(3)
    expect(destAuth.selected).toBe(2)
    await expectTokenCount(page, 2, 3)
    const divider = page.locator('[data-testid="context-boundary"]').first()
    await expect(divider).toBeVisible({ timeout: 15000 })
    expect(destAuth.boundary).toBe(destAuth.first)
    // Actual window membership: exactly msgs 2..5 (turns 1..2), excluding the
    // before-anchor turn 0 and anything after the fork point.
    const destFull = await fetchClosureFull(page, topicId, destBranchId, destAnchor as string)
    expect(destFull.ids, 'default destination closure must be exactly msgs 2..5 in order').toEqual([
      ids[2],
      ids[3],
      ids[4],
      ids[5]
    ])
    expect(destFull.roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(destFull.contents).toEqual([2, 3, 4, 5].map((i) => `ctx-branch-b-${pad(i, 5)}`))
    expect(destFull.first).toBe(expectedDefault)
    expect(destFull.boundary).toBe(expectedDefault)
    await expectAnchorHighlightAndDivider(page, topicId, expectedDefault, ids[0])

    // TokenCount click is idempotent on the default (stays at the same anchor).
    await page.locator('[data-testid="token-count-context"]').first().click()
    await expectTokenCount(page, 2, 3)
    expect(await getRouteAnchor(page, assistantId, topicId, destBranchId)).toBe(expectedDefault)

    // Parent anchor/settings untouched by the out-of-range fork.
    expect(await getRouteAnchor(page, assistantId, topicId, null)).toBe(parentAnchor)
    const contextCountAfter: number | null = await page.evaluate(
      ({ assistantId }: { assistantId: string }) =>
        (window as any).store.getState().assistants.assistants.find((a: any) => a.id === assistantId)?.settings
          ?.contextCount ?? null,
      { assistantId }
    )
    expect(contextCountAfter).toBe(2)

    // Retained-anchor control: switch back to main, fork at/after the parent
    // anchor, and prove the destination inherits the parent anchor (not default).
    await switchRouteViaDivider(page, topicId, earlyForkAssistant, null)
    expect(await getRouteAnchor(page, assistantId, topicId, null)).toBe(parentAnchor)
    await clickToolbarBranch(page, retainedForkAssistant)
    branches = await listBranches(page, topicId)
    expect(branches).toHaveLength(2)
    const retainedId = (branches.find((b: any) => b.id !== destBranchId) as any).id as string
    await waitActiveRoute(page, topicId, retainedId)
    const retainedAnchor = await getRouteAnchor(page, assistantId, topicId, retainedId)
    expect(retainedAnchor, 'in-range fork must inherit the parent anchor, not the default').toBe(parentAnchor)
    const retainedAuth = await fetchClosureAuthority(page, topicId, retainedId, retainedAnchor as string)
    await expectTokenCount(page, retainedAuth.selected, retainedAuth.total)
    // Ordinary send on the N=2 default branch: the mock outbound payload must
    // carry exactly the 2 historical users in order plus the new prompt (and
    // the 2 historical assistants, since the new user is last and no trailing
    // assistant is filtered), excluding the pre-anchor turn and parent-only
    // suffix. Caller-local closure first, then the real Inputbar send; a
    // fallback to the loaded projection fails here with expected-vs-actual.
    await switchRouteViaDivider(page, topicId, earlyForkAssistant, destBranchId)
    await expectTokenCount(page, 2, 3)
    {
      const expectedUsers = [2, 4].map((i) => `ctx-branch-b-${pad(i, 5)}`)
      const expectedAssistants = [3, 5].map((i) => `ctx-branch-b-${pad(i, 5)}`)
      const destFullBefore = await fetchClosureFull(page, topicId, destBranchId, expectedDefault)
      expect(destFullBefore.ids).toEqual([ids[2], ids[3], ids[4], ids[5]])
      const newPrompt = `ctx-branch-b-live-${topicId}`
      const prevAssist = await assistantCountForTopic(page, topicId)
      clearRequestLog()
      const seq = getRequestSequence()
      await uiSendMessage(page, newPrompt)
      await waitForAssistantResponseComplete(page, topicId, prevAssist)
      const productReq: any = findProductRequestAfter(seq)
      expect(productReq, 'mock must observe the default-branch send').not.toBeNull()
      expect(productReq.url).toBe('/v1/chat/completions')
      const userTexts = outboundUserTexts(productReq)
      const assistantTexts = outboundAssistantTexts(productReq)
      expect(
        userTexts,
        `default-branch outbound users must be exactly [u2, u4, new] (got ${JSON.stringify(userTexts)})`
      ).toEqual([...expectedUsers, newPrompt])
      expect(
        assistantTexts,
        `default-branch outbound assistants must be exactly [a3, a5] (got ${JSON.stringify(assistantTexts)})`
      ).toEqual(expectedAssistants)
      expect(userTexts, 'pre-anchor user content must be excluded').not.toContain(`ctx-branch-b-${pad(0, 5)}`)
      for (const parentOnly of [6, 8, 10].map((i) => `ctx-branch-b-${pad(i, 5)}`)) {
        expect(userTexts, `parent-only content ${parentOnly} must be excluded`).not.toContain(parentOnly)
      }
      const destGrown = await fetchClosureFull(page, topicId, destBranchId, expectedDefault)
      expect(destGrown.ids.slice(0, destFullBefore.ids.length)).toEqual(destFullBefore.ids)
      expect(destGrown.ids.length).toBe(destFullBefore.ids.length + 2)
      expect(await getRouteAnchor(page, assistantId, topicId, null)).toBe(parentAnchor)
    }
  })

  test('(C) clone prefix above source anchor remaps IDs and lands on the default', async ({ mainWindow }) => {
    test.setTimeout(420000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: contextCount=2, source route is a branch (route isolation), real overflow Copy Topic UI clones an earlier prefix; destination IDs remapped, destination anchor == N=2 default, rendered count/divider == closure authority, source untouched. Infinite/null fallback stays in unit tests.'
    })
    const page = mainWindow
    await waitForAppReady(page)
    await waitForChatReady(page)
    const assistantId = await prepareAssistant(page, DISPLAY_LIMIT)
    await seedContextCount(page, 2)

    const topicId = `ctx-clone-c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const TOTAL = 30
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `CtxCloneC ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => letterMessageId(topicId, i),
      contentPrefix: 'ctx-clone-c-'
    })
    // Source anchor late on main; then fork a branch so the clone source route
    // is the branch (route isolation, preferably branch per acceptance).
    const sourceMainAnchor = ids[20] // user turn
    await setRouteAnchor(page, assistantId, topicId, null, sourceMainAnchor)
    const mainTail = ids.slice(TOTAL - DISPLAY_LIMIT, TOTAL)
    await activateTruncatedTopic(page, topicId, mainTail)

    const branchForkAssistant = ids[23] // assistant, visible in the tail window
    await clickToolbarBranch(page, branchForkAssistant)
    let branches = await listBranches(page, topicId)
    expect(branches).toHaveLength(1)
    const sourceBranchId = branches[0].id as string
    await waitActiveRoute(page, topicId, sourceBranchId)
    // Source branch anchor late (a branch-effective user row near the tail).
    const branchUsers: string[] = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const list: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      return list.filter((id) => s.messages?.entities?.[id]?.role === 'user')
    }, topicId)
    expect(branchUsers.length).toBeGreaterThanOrEqual(4)
    const sourceBranchAnchor = branchUsers[branchUsers.length - 1]
    await setRouteAnchor(page, assistantId, topicId, sourceBranchId, sourceBranchAnchor)
    const sourceBranchAuthBefore = await fetchClosureAuthority(page, topicId, sourceBranchId, sourceBranchAnchor)

    // Clone an earlier shared prefix via the real Copy Topic UI. ids[15] is an
    // assistant in the loaded tail window (14..23) and strictly earlier than
    // the source branch anchor, so the source anchor is excluded and the
    // destination must land on the N=2 default (not last). The anchor lies in
    // the shared prefix, so main and branch effective prefixes agree there.
    const cloneAnchorAssistant = ids[15]
    expect(cloneAnchorAssistant).not.toBe(sourceBranchAnchor)
    const sourceMainBefore = await getRawTopicIds(page, topicId)
    expect(sourceMainBefore).toHaveLength(TOTAL)
    const clonePrefixLen = sourceMainBefore.indexOf(cloneAnchorAssistant) + 1
    expect(clonePrefixLen).toBe(16)
    // Branch effective prefix before the clone (caller-local window probe, never
    // published into Redux): prefix 0..23.
    const branchWindowBefore: any = await page.evaluate(
      async ({ tid, bid }: { tid: string; bid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({
          kind: 'latest',
          topicId: tid,
          branchId: bid,
          limit: 100
        }),
      { tid: topicId, bid: sourceBranchId }
    )
    expect(branchWindowBefore?.ok).toBe(true)
    const branchEffectiveBefore: string[] = (branchWindowBefore.value.messages as any[]).map((m: any) => m.id)
    expect(branchEffectiveBefore).toHaveLength(24)
    expect(branchEffectiveBefore.slice(0, clonePrefixLen)).toEqual(sourceMainBefore.slice(0, clonePrefixLen))

    const topicsBefore: string[] = await page.evaluate(() =>
      (window as any).store.getState().assistants.assistants.flatMap((a: any) => (a.topics ?? []).map((t: any) => t.id))
    )
    await hoverMessageAndOpenMore(page, cloneAnchorAssistant)
    await clickPortalCopyTopic(page)
    // The clone creates a new logical topic with exactly the anchor-inclusive
    // prefix length (fresh IDs, same order/contents).
    let destTopicId = ''
    await page.waitForFunction(
      ({ before, len }: { before: string[]; len: number }) => {
        const s = (window as any).store.getState()
        const allIds = Object.keys(s.messages?.messageIdsByTopic ?? {})
        for (const tid of allIds) {
          if (before.includes(tid)) continue
          const list = s.messages?.messageIdsByTopic?.[tid] ?? []
          if (list.length === len) return true
        }
        return false
      },
      { before: topicsBefore, len: clonePrefixLen },
      { timeout: 60000 }
    )
    destTopicId = await page.evaluate(
      ({ before, len }: { before: string[]; len: number }) => {
        const s = (window as any).store.getState()
        const allIds = Object.keys(s.messages?.messageIdsByTopic ?? {})
        for (const tid of allIds) {
          if (before.includes(tid)) continue
          const list = s.messages?.messageIdsByTopic?.[tid] ?? []
          if (list.length === len) return tid
        }
        return ''
      },
      { before: topicsBefore, len: clonePrefixLen }
    )
    expect(destTopicId).not.toBe('')

    // Cloned IDs remapped (fresh), never the source stable IDs.
    const destIds = await getRawTopicIds(page, destTopicId)
    expect(destIds).toHaveLength(clonePrefixLen)
    expect(new Set(destIds).size).toBe(destIds.length)
    for (const id of destIds) {
      expect(sourceMainBefore).not.toContain(id)
      expect(branchEffectiveBefore).not.toContain(id)
    }

    // Destination anchor is the N=2 default of the cloned prefix, not last.
    // The clone (16 msgs) exceeds the latest-10 viewport, so the Redux list may
    // be truncated; derive user turns from the authoritative full window
    // (limit 100), never the bounded Redux projection.
    const destAnchor = await getRouteAnchor(page, assistantId, destTopicId, null)
    expect(destAnchor, 'clone destination must establish a non-empty anchor').not.toBeNull()
    const destWindowFull: any = await page.evaluate(
      async (tid: string) =>
        await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId: tid, limit: 100 }),
      destTopicId
    )
    expect(destWindowFull?.ok).toBe(true)
    const destFullIds: string[] = (destWindowFull.value.messages as any[]).map((m: any) => m.id)
    expect(destFullIds).toHaveLength(clonePrefixLen)
    const destUsers: string[] = (destWindowFull.value.messages as any[])
      .filter((m: any) => m.role === 'user')
      .map((m: any) => m.id)
    expect(destUsers.length).toBeGreaterThanOrEqual(3)
    const expectedDestDefault = destUsers[destUsers.length - 2]
    const wrongDestLast = destUsers[destUsers.length - 1]
    expect(expectedDestDefault).not.toBe(wrongDestLast)
    expect(destAnchor).toBe(expectedDestDefault)

    // Rendered count + divider match the authority closure.
    const destAuth = await fetchClosureAuthority(page, destTopicId, null, destAnchor as string)
    expect(destAuth.total).toBe(destUsers.length)
    expect(destAuth.selected).toBe(2)
    // Activate the clone destination through the real topic item (renders it).
    // The destination (16 msgs) exceeds the latest-10 viewport, so activation
    // loads the truncated tail; the settled TokenCount must still equal the
    // full-route authority (2/8), proving viewport independence.
    const destTail = destFullIds.slice(destFullIds.length - DISPLAY_LIMIT, destFullIds.length)
    await activateTruncatedTopic(page, destTopicId, destTail)
    await expectTokenCount(page, destAuth.selected, destAuth.total)
    await expect(page.locator('[data-testid="context-boundary"]').first()).toBeVisible({ timeout: 15000 })
    expect(destAuth.boundary).toBe(destAuth.first)
    // Actual window membership on the clone: the last 2 turns (4 msgs) with
    // contents equal to the cloned source prefix tail 12..15, excluding the
    // earlier cloned history 0..11. IDs are remapped, so contents carry the
    // equality (not stable IDs).
    const destFull = await fetchClosureFull(page, destTopicId, null, destAnchor as string)
    expect(destFull.ids, 'clone closure must be exactly the last 4 remapped IDs in order').toEqual(
      destFullIds.slice(destFullIds.length - 4, destFullIds.length)
    )
    expect(destFull.roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(destFull.contents).toEqual([12, 13, 14, 15].map((i) => `ctx-clone-c-${pad(i, 5)}`))
    expect(destFull.first).toBe(destAnchor)
    expect(destFull.boundary).toBe(destAnchor)
    for (const early of [0, 2, 4, 6, 8, 10].map((i) => `ctx-clone-c-${pad(i, 5)}`)) {
      expect(
        destFull.contents.filter((_, i) => i % 2 === 0),
        `earlier cloned user content ${early} must be excluded`
      ).not.toContain(early)
    }
    await expectAnchorHighlightAndDivider(page, destTopicId, destAnchor as string, destUsers[destUsers.length - 3])
    // Ordinary send on the clone default: outbound users must be exactly the
    // current last-2 user turn contents + the new prompt, omitting earlier
    // cloned history; parent source stays unchanged.
    {
      const expectedCloneUsers = [12, 14].map((i) => `ctx-clone-c-${pad(i, 5)}`)
      const expectedCloneAssistants = [13, 15].map((i) => `ctx-clone-c-${pad(i, 5)}`)
      const newPrompt = `ctx-clone-c-live-${destTopicId}`
      const prevAssist = await assistantCountForTopic(page, destTopicId)
      clearRequestLog()
      const seq = getRequestSequence()
      await uiSendMessage(page, newPrompt)
      await waitForAssistantResponseComplete(page, destTopicId, prevAssist)
      const productReq: any = findProductRequestAfter(seq)
      expect(productReq, 'mock must observe the clone-default send').not.toBeNull()
      expect(productReq.url).toBe('/v1/chat/completions')
      const userTexts = outboundUserTexts(productReq)
      const assistantTexts = outboundAssistantTexts(productReq)
      expect(
        userTexts,
        `clone outbound users must be exactly [u12, u14, new] (got ${JSON.stringify(userTexts)})`
      ).toEqual([...expectedCloneUsers, newPrompt])
      expect(
        assistantTexts,
        `clone outbound assistants must be exactly [a13, a15] (got ${JSON.stringify(assistantTexts)})`
      ).toEqual(expectedCloneAssistants)
      const destGrown = await fetchClosureFull(page, destTopicId, null, destAnchor as string)
      expect(destGrown.ids.slice(0, destFull.ids.length)).toEqual(destFull.ids)
      expect(destGrown.ids.length).toBe(destFull.ids.length + 2)
    }

    // Source untouched: same anchor, same authority counts, same message sets.
    branches = await listBranches(page, topicId)
    expect(branches).toHaveLength(1)
    expect(await getRouteAnchor(page, assistantId, topicId, sourceBranchId)).toBe(sourceBranchAnchor)
    const sourceBranchAuthAfter = await fetchClosureAuthority(page, topicId, sourceBranchId, sourceBranchAnchor)
    expect(sourceBranchAuthAfter).toEqual(sourceBranchAuthBefore)
    expect(await getRawTopicIds(page, topicId)).toEqual(sourceMainBefore)
    const branchWindowAfter: any = await page.evaluate(
      async ({ tid, bid }: { tid: string; bid: string }) =>
        await (window as any).api.chatDb.fetchMessagesWindow({
          kind: 'latest',
          topicId: tid,
          branchId: bid,
          limit: 100
        }),
      { tid: topicId, bid: sourceBranchId }
    )
    expect(branchWindowAfter?.ok).toBe(true)
    expect((branchWindowAfter.value.messages as any[]).map((m: any) => m.id)).toEqual(branchEffectiveBefore)
    expect(await getRouteAnchor(page, assistantId, topicId, null)).toBe(sourceMainAnchor)
  })
})
