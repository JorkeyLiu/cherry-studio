/**
 * Cross-topic history reference (Reference submenu) — INTEGRATED E2E.
 *
 * Durable asset guarding the coherent cross-topic reference workflow:
 * - Real UI creation: message More menu → Clone Topic submenu → Reference.
 * - The new target topic's history is a LIVE reference to the source route
 *   endpoint: the foreign prefix keeps the canonical SOURCE stable IDs (never
 *   copied/restamped) and stays READ-ONLY (excluded from the target route's
 *   Main-authoritative mutableMessageIds); the target owns its own writable
 *   suffix.
 * - Divider `history-reference-divider` renders at the prefix/suffix boundary
 *   with a LIVE source title link.
 * - Precise navigation: the divider link jumps to the source topic + captured
 *   route + exact anchor message.
 * - Live source rename through the REAL Main path (`updateTopicMetadata`) while
 *   the target is active: Main invalidates the target's reference metadata from
 *   authority and the divider title reflects the rename (no Redux-only fake).
 * - The read-only foreign prefix hides the edit/delete mutation controls while
 *   a target-owned suffix message keeps them (Main mutableMessageIds contract).
 * - Source deletion → the divider shows the missing label; the target topic and
 *   its own suffix survive (no cascade).
 * - Re-activation re-derives the relation from authority (reload persistence
 *   within the session).
 *
 * Evidence classes: real UI gestures (creation, submenu, navigation, sends),
 * Redux snapshots (loaded projection + Main capability + reference metadata),
 * and read-only authority probes via `getRawTopic`.
 *
 * A second case closes the remaining product promises that need the Main
 * authority and a real relaunch, not just an in-session re-activation:
 * - NONNULL captured source branch: the reference is created from a
 *   branch-owned source message while the source topic is on an internal
 *   branch route (`sourceBranchId` = that branch). Clicking the divider link
 *   while the source's active branch is DIFFERENT (main) must switch the
 *   source to the EXACT captured branch and land the captured stable endpoint
 *   in view.
 * - App relaunch durability: the relation (sourceTopicId + sourceBranchId +
 *   anchor), the read-only foreign prefix (canonical branch-route IDs), the
 *   target-owned writable suffix, and the reference target's sidebar presence
 *   (a fully local-only Redux/DB registration, never synced) all persist
 *   across a same-profile close/relaunch.
 *
 * Standard fixture, fresh build, disposable profile, mock provider.
 */
import { expect, getChatDbPath, getUserDataDir, test } from '../../fixtures/electron.fixture'
import { clickToolbarBranch, listBranches } from '../../utils/branch-route-setup'
import { closeElectronWithExactCleanup } from '../../utils/electron-cleanup'
import { findProcessesByUserDataDir, terminateProcessesByUserDataDir } from '../../utils/process-cleanup'
import { relaunchSameProfile } from '../../utils/restart-electron-profile'
import { waitForAppReady } from '../../utils/wait-helpers'

const DISPLAY_LIMIT = 20
const SOURCE_TOTAL = 12
// Assistant message index: the Reference/Copy submenu lives in the message More
// menu, which is rendered for non-user messages only (MessageMenubar
// more-menu). An assistant anchor (odd index in buildSourceEntries) is required.
const ANCHOR_IDX = 9
// Fork the source's internal branch at a mid assistant message (odd index).
const FORK_IDX = 5

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

async function prepareDisplayCountAndAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, DISPLAY_LIMIT)
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

function buildSourceEntries(
  sourceTopicId: string,
  assistantId: string
): Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  for (let i = 0; i < SOURCE_TOTAL; i++) {
    const msgId = `${sourceTopicId}-msg-${pad(i, 5)}`
    const blockId = `${sourceTopicId}-block-${pad(i, 5)}`
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const prevUserIdx = i % 2 === 0 ? i : i - 1
    // `assistantId` is required: Message resolves the menubar assistant from
    // `message.assistantId`, and a missing assistant renders no message toolbar
    // (so the More menu / Reference submenu could never open).
    const message: Record<string, unknown> = {
      id: msgId,
      topicId: sourceTopicId,
      role,
      assistantId,
      content: `${role} ${i}`,
      createdAt: `2026-07-19T00:00:${pad(i, 2)}.000Z`,
      updatedAt: `2026-07-19T00:00:${pad(i, 2)}.000Z`,
      status: 'success',
      blocks: [blockId],
      sortOrder: i
    }
    if (role === 'assistant') {
      message.askId = `${sourceTopicId}-msg-${pad(prevUserIdx, 5)}`
      message.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      message.modelId = 'mock-model'
    }
    entries.push({
      message,
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: `source ${role} ${i}`,
          status: 'success',
          createdAt: `2026-07-19T00:00:${pad(i, 2)}.000Z`,
          updatedAt: `2026-07-19T00:00:${pad(i, 2)}.000Z`
        }
      ]
    })
  }
  return entries
}

async function activateTopicAndWaitLoaded(page: any, topicId: string, atLeast = 1): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
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
}

async function hoverMessageAndOpenMore(page: any, messageId: string): Promise<void> {
  const escAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const e = escAttr(messageId)
  const sel = `[id="message-${e}"][data-message-id="${e}"]`
  let container = page.locator(sel).first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 15000 })
  await page.evaluate((id: string) => {
    const esc = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const el = document.querySelector(`[id="message-${esc}"][data-message-id="${esc}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
  }, messageId)
  container = page.locator(sel).first()
  await expect(container).toBeVisible({ timeout: 15000 })
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    await container.hover({ force: true, timeout: 5000 } as any)
  }
  const moreBtn = container.locator('[data-testid="message-more-menu-btn"]')
  await expect(moreBtn).toBeAttached({ timeout: 10000 })
  try {
    await moreBtn.click({ timeout: 5000 } as any)
  } catch {
    await moreBtn.evaluate((el: HTMLElement) => el.click())
  }
  await expect(page.locator('.ant-dropdown').first()).toBeVisible({ timeout: 10000 })
}

async function clickReferenceSubmenu(page: any): Promise<void> {
  const title = page.locator('[data-testid="message-copy-topic-btn"]')
  await expect(title, 'Clone Topic submenu title must be unique').toHaveCount(1)
  // Open the portaled Ant submenu and click the Reference child via DOM events:
  // the submenu popup sits at the viewport edge, so Playwright's
  // viewport-reachable hover/click actionability cannot be used. React
  // synthesizes onMouseEnter from a bubbling mouseover.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const trigger = document.querySelector('[data-testid="message-copy-topic-btn"]') as HTMLElement | null
          if (!trigger) return 'no-trigger'
          trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          const child = document.querySelector('[data-testid="message-copy-topic-reference-btn"]') as HTMLElement | null
          if (!child) return 'no-child'
          child.click()
          return 'clicked'
        }),
      { timeout: 10000, intervals: [100, 250] }
    )
    .toBe('clicked')
}

async function uiSendMessage(page: any, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.fill(text)
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

async function waitForTargetTopic(page: any, sourceTopicId: string, anchorId: string): Promise<string> {
  await page.waitForFunction(
    ({ sourceTopicId, anchorId }: { sourceTopicId: string; anchorId: string }) => {
      const s = (window as any).store.getState()
      const refs = s.messages?.historyReferenceByTopic ?? {}
      for (const tid of Object.keys(refs)) {
        if (tid === sourceTopicId) continue
        const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
        if (refs[tid]?.sourceTopicId === sourceTopicId && ids.includes(anchorId)) return true
      }
      return false
    },
    { sourceTopicId, anchorId },
    { timeout: 30000 }
  )
  const targetId: string | null = await page.evaluate(
    ({ sourceTopicId, anchorId }: { sourceTopicId: string; anchorId: string }) => {
      const s = (window as any).store.getState()
      const refs = s.messages?.historyReferenceByTopic ?? {}
      for (const tid of Object.keys(refs)) {
        if (tid === sourceTopicId) continue
        const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
        if (refs[tid]?.sourceTopicId === sourceTopicId && ids.includes(anchorId)) return tid
      }
      return null
    },
    { sourceTopicId, anchorId }
  )
  expect(targetId, 'target reference topic must be found').not.toBeNull()
  return targetId as string
}

async function getRawTopicIds(page: any, topicId: string): Promise<string[]> {
  const raw: any = await page.evaluate(
    async (tid: string) => await (window as any).api.chatDb.getRawTopic({ topicId: tid }),
    topicId
  )
  expect(raw?.ok, `getRawTopic failed: ${JSON.stringify(raw)}`).toBe(true)
  return (raw.value?.messages ?? []).map((m: any) => m.id as string)
}

/**
 * Seed one topic through the Main capability + project it into the live
 * assistant list (setup-only; the sidebar is the Redux projection).
 */
async function seedTopicAndProject(
  page: any,
  topicId: string,
  assistantId: string,
  name: string,
  entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
): Promise<void> {
  const seeded = await page.evaluate(
    async ({
      topicId,
      assistantId,
      name,
      entries
    }: {
      topicId: string
      assistantId: string
      name: string
      entries: any
    }) => {
      const api = (window as any).api as any
      const ensured = await api.chatDb.ensureTopic({ topicId, assistantId, name })
      if (!ensured || ensured.ok !== true) return { ok: false, err: JSON.stringify(ensured) }
      const pasted = await api.chatDb.pasteMessagesToTopic({ topicId, entries })
      if (!pasted || pasted.ok !== true) return { ok: false, err: JSON.stringify(pasted) }
      return { ok: true }
    },
    { topicId, assistantId, name, entries }
  )
  expect(seeded.ok).toBe(true)
  await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
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
    },
    { topicId, assistantId, name }
  )
}

/** Main-authoritative effective route IDs for one topic route (null = main). */
async function fetchLatestRouteIds(
  page: any,
  topicId: string,
  branchId: string | null,
  limit = 100
): Promise<string[]> {
  const probe: any = await page.evaluate(
    async ({ topicId, branchId, limit }: { topicId: string; branchId: string | null; limit: number }) =>
      await (window as any).api.chatDb.fetchMessagesWindow({ kind: 'latest', topicId, branchId, limit }),
    { topicId, branchId, limit }
  )
  expect(probe?.ok, `fetchMessagesWindow failed: ${JSON.stringify(probe)}`).toBe(true)
  return (probe.value?.messages ?? []).map((m: any) => m.id as string)
}

async function countAssistants(page: any, topicId: string): Promise<number> {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
    return ids.filter((id) => s.messages?.entities?.[id]?.role === 'assistant').length
  }, topicId)
}

/** Wait for a completed assistant reply and return the newest assistant ID. */
async function waitForLatestAssistantComplete(page: any, topicId: string, prevCount: number): Promise<string> {
  await page.waitForFunction(
    ({ tid, prev }: { tid: string; prev: number }) => {
      const s = (window as any).store.getState()
      if (s.messages?.loadingByTopic?.[tid] === true) return false
      const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
      let n = 0
      let latest: any = null
      for (const id of ids) {
        const m = s.messages?.entities?.[id]
        if (m?.role === 'assistant') {
          n += 1
          latest = m
        }
      }
      return n > prev && !!latest && latest.status === 'success'
    },
    { tid: topicId, prev: prevCount },
    { timeout: 90000 }
  )
  const latestId: string | null = await page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
    for (let i = ids.length - 1; i >= 0; i--) {
      if (s.messages?.entities?.[ids[i]]?.role === 'assistant') return ids[i]
    }
    return null
  }, topicId)
  expect(latestId, 'assistant reply id must exist').toBeTruthy()
  return latestId as string
}

async function sidebarTopicIds(page: any): Promise<string[]> {
  return page.evaluate(() =>
    ((window as any).store.getState().assistants.assistants as any[])
      .flatMap((a: any) => (a.topics ?? []).map((t: any) => t.id))
      .sort()
  )
}

/** Hover a message container (best-effort force fallback), for toolbar probes. */
async function hoverMessage(page: any, messageId: string): Promise<void> {
  const container = page.locator(`[data-message-id="${messageId}"]`).first()
  await expect(container, `message container ${messageId} must be visible`).toBeVisible({ timeout: 15000 })
  try {
    await container.hover({ timeout: 8000 })
  } catch {
    await container.hover({ force: true, timeout: 5000 } as any)
  }
}

/** True when the message row intersects the #messages viewport. */
async function isMessageVisible(page: any, messageId: string): Promise<boolean> {
  return page.evaluate((id: string) => {
    const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
    const container = document.querySelector('#messages') as HTMLElement | null
    const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
    if (!container || !el) return false
    const c = container.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.bottom > c.top && r.top < c.bottom
  }, messageId)
}

const PERSIST_WIRE_KEY = 'persist:cherry-studio'

async function waitPersistRehydrated(page: any): Promise<void> {
  await page.waitForFunction(
    (key: string) => {
      try {
        const wire = localStorage.getItem(key)
        if (!wire) return false
        const outer = JSON.parse(wire)
        const meta = typeof outer._persist === 'string' ? JSON.parse(outer._persist) : null
        return !!meta && meta.rehydrated === true
      } catch {
        return false
      }
    },
    PERSIST_WIRE_KEY,
    { timeout: 60000 }
  )
}

/**
 * Pre-close durability observation: the redux-persist wire already carries the
 * target topic inside the assistants slice (the local-only registration the
 * relaunch must restore). Polled, never a fixed sleep.
 */
async function waitPersistWireHasTopic(page: any, topicId: string): Promise<void> {
  await page.waitForFunction(
    ({ key, tid }: { key: string; tid: string }) => {
      try {
        const wire = localStorage.getItem(key)
        if (!wire) return false
        const outer = JSON.parse(wire)
        if (typeof outer.assistants !== 'string') return false
        const slice = JSON.parse(outer.assistants) as { assistants?: Array<{ topics?: Array<{ id: string }> }> }
        return (slice.assistants ?? []).some((a) => (a.topics ?? []).some((t) => t.id === tid))
      } catch {
        return false
      }
    },
    { key: PERSIST_WIRE_KEY, tid: topicId },
    { timeout: 30000 }
  )
}

// --- Read-only multi-answer strip scenario (layout regression) ------------
// The read-only foreign prefix (and a within-topic inherited branch prefix)
// renders the answer group through the inert/disabled selector path. The
// reported regression: the expanded segmented list stacked full-width rows
// instead of the enabled horizontal model-tab strip. Geometry is read from the
// real selector rects and the container's computed flex layout.
const SOURCE_TOTAL_STRIP = 15
const STRIP_ROW_TOL = 2

/**
 * Source topic for the read-only multi-answer strip scenario:
 *  3 filler rounds (idx 0..5) -> answer group (user idx 6 + two assistant
 *  variants idx 7,8 sharing the askId and the SAME model name) -> 3 trailing
 *  filler rounds (idx 9..14). The SECOND assistant (idx 8) is the reference
 *  anchor (assistant = odd index, exposes the More menu), so the reference
 *  prefix contains the whole answer group. The trailing rounds keep a rendered
 *  viewport after the group and give a fork target AFTER the group.
 */
function buildStripSourceEntries(
  topicId: string,
  assistantId: string
): {
  entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
  firstAssistantId: string
  anchorId: string
  forkAssistantId: string
  /** anchor-inclusive prefix length (indices 0..8 = 9) */
  prefixCount: number
} {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const stamp = '2026-07-19T00:00:00.000Z'
  const model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
  const push = (index: number, role: string, content: string, extra: Record<string, unknown> = {}): string => {
    const msgId = `${topicId}-msg-${pad(index, 5)}`
    const blockId = `${topicId}-block-${pad(index, 5)}`
    entries.push({
      message: {
        id: msgId,
        topicId,
        role,
        assistantId,
        content,
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
  for (let r = 0; r < 3; r++) {
    const userIndex = r * 2
    const assistantIndex = r * 2 + 1
    const userId = push(userIndex, 'user', `strip-fill-user-${r} ${'filler words '.repeat(20)}`)
    push(assistantIndex, 'assistant', `strip-fill-assistant-${r} ${'filler words '.repeat(20)}`, {
      askId: userId,
      model,
      modelId: 'mock-model'
    })
  }
  const askId = push(6, 'user', `strip-target-ask ${'filler words '.repeat(8)}`)
  const firstAssistantId = push(7, 'assistant', `strip-target-first ${'filler words '.repeat(24)}`, {
    askId,
    model,
    modelId: 'mock-model'
  })
  // foldSelected on the anchor: expanded fold mode displays ONLY the selected
  // member's body, so the anchor must be the shown member for its More menu
  // (the Reference submenu entry) to be reachable.
  const anchorId = push(8, 'assistant', `strip-target-second ${'filler words '.repeat(24)}`, {
    askId,
    foldSelected: true,
    model,
    modelId: 'mock-model'
  })
  let forkAssistantId = ''
  for (let r = 0; r < 3; r++) {
    const userIndex = 9 + r * 2
    const assistantIndex = 9 + r * 2 + 1
    const userId = push(userIndex, 'user', `strip-tail-user-${r} ${'filler words '.repeat(20)}`)
    const tailAssistantId = push(
      assistantIndex,
      'assistant',
      `strip-tail-assistant-${r} ${'filler words '.repeat(20)}`,
      {
        askId: userId,
        model,
        modelId: 'mock-model'
      }
    )
    if (r === 1) forkAssistantId = tailAssistantId
  }
  return { entries, firstAssistantId, anchorId, forkAssistantId, prefixCount: 9 }
}

interface StripSelectorRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

interface AnswerStripGeometry {
  rects: StripSelectorRect[]
  containerClass: string
  ariaDisabled: string | null
  display: string
  flexDirection: string
}

/** Read the real selector rects + container layout for one answer group. */
async function readAnswerStrip(page: any, memberIds: string[]): Promise<AnswerStripGeometry> {
  return page.evaluate((ids: string[]) => {
    const esc = (v: string) => (typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(v) : v)
    const rects = ids.map((id) => {
      const el = document.querySelector(
        `[data-testid="answer-group-selector"][data-message-id="${esc(id)}"]`
      ) as HTMLElement | null
      if (!el) throw new Error(`answer selector ${id} not found`)
      const r = el.getBoundingClientRect()
      return { id, x: r.x, y: r.y, width: r.width, height: r.height }
    })
    const first = document.querySelector(
      `[data-testid="answer-group-selector"][data-message-id="${esc(ids[0])}"]`
    ) as HTMLElement | null
    const container = first?.closest('.segmented-list, .avatar-group') as HTMLElement | null
    const cs = container ? getComputedStyle(container) : null
    return {
      rects,
      containerClass: container?.className ?? '',
      ariaDisabled: container?.getAttribute('aria-disabled') ?? null,
      display: cs?.display ?? '',
      flexDirection: cs?.flexDirection ?? ''
    }
  }, memberIds)
}

/** `[E2E]` diagnostic: the observed container layout + tab rects for one strip. */
function logStrip(label: string, strip: AnswerStripGeometry): void {
  console.log(
    `[E2E][strip] ${label} display=${strip.display} flexDirection=${strip.flexDirection} aria-disabled=${strip.ariaDisabled} class="${strip.containerClass}" rects=${JSON.stringify(
      strip.rects.map((r) => ({
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height)
      }))
    )}`
  )
}

/** A strip must be a single row with horizontally advancing tabs in order. */
function assertHorizontalStrip(rects: StripSelectorRect[]): void {
  expect(rects.length).toBeGreaterThanOrEqual(2)
  const ys = rects.map((r) => r.y)
  expect(Math.max(...ys) - Math.min(...ys), 'model tabs must share one row (never stacked)').toBeLessThanOrEqual(
    STRIP_ROW_TOL
  )
  for (let i = 1; i < rects.length; i++) {
    expect(rects[i].x, 'model tabs must advance horizontally in loaded order').toBeGreaterThan(rects[i - 1].x)
  }
}

test.describe('Cross-topic history reference', () => {
  test.skip(process.platform !== 'darwin', 'requires macOS disposable-profile Electron lane')

  test('reference creation: live readonly prefix, precise navigation, live rename, suffix survival on source delete', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: real submenu Reference creation → live foreign prefix keeps canonical source stable IDs + readonly capability → divider at boundary with live title link → precise source/topic/anchor navigation → live rename without reload → target-owned suffix send → source soft delete leaves prefix missing + suffix survives. Redux + getRawTopic authority probes.'
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)

    // --- Seed source topic with a deterministic conversation -------------
    const sourceTopicId = `ref-src-${Date.now()}`
    const sourceName = 'Reference Source Topic'
    const entries = buildSourceEntries(sourceTopicId, assistantId)
    const seeded = await page.evaluate(
      async ({
        topicId,
        assistantId,
        name,
        entries
      }: {
        topicId: string
        assistantId: string
        name: string
        entries: any
      }) => {
        const api = (window as any).api as any
        const ensured = await api.chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: JSON.stringify(ensured) }
        const pasted = await api.chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: JSON.stringify(pasted) }
        return { ok: true }
      },
      { topicId: sourceTopicId, assistantId, name: sourceName, entries }
    )
    expect(seeded.ok).toBe(true)

    // The seed above is a Main capability; the sidebar is the Redux
    // projection, so project the topic into the live assistant list before
    // the sidebar activation click.
    await page.evaluate(
      ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
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
      },
      { topicId: sourceTopicId, assistantId, name: sourceName }
    )

    await activateTopicAndWaitLoaded(page, sourceTopicId, SOURCE_TOTAL)
    const anchorId = `${sourceTopicId}-msg-${pad(ANCHOR_IDX, 5)}`
    const sourceOrderedIds = await getRawTopicIds(page, sourceTopicId)
    const expectedPrefix = sourceOrderedIds.slice(0, ANCHOR_IDX + 1)
    expect(expectedPrefix[expectedPrefix.length - 1]).toBe(anchorId)

    // --- Create the reference via the real submenu -----------------------
    await hoverMessageAndOpenMore(page, anchorId)
    await clickReferenceSubmenu(page)
    const targetTopicId = await waitForTargetTopic(page, sourceTopicId, anchorId)

    // Reference metadata: captured source endpoint, available status, boundary
    // = last foreign-prefix message.
    const meta = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages.historyReferenceByTopic[tid],
      targetTopicId
    )
    expect(meta.sourceTopicId).toBe(sourceTopicId)
    expect(meta.sourceBranchId).toBeNull()
    expect(meta.anchorMessageId).toBe(anchorId)
    expect(meta.status).toBe('available')
    expect(meta.boundaryMessageId).toBe(anchorId)

    // Foreign prefix shares canonical SOURCE stable IDs (no copy/restamp) and
    // is READ-ONLY (excluded from the target route's mutableMessageIds).
    const targetLoad = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return {
        ids: s.messages.messageIdsByTopic[tid] ?? [],
        mutable: s.messages.mutableMessageIdsByTopic[tid] ?? [],
        route: s.messages.mutableRouteByTopic[tid] ?? null,
        currentTopicId: s.messages.currentTopicId
      }
    }, targetTopicId)
    expect(targetLoad.currentTopicId).toBe(targetTopicId)
    expect(targetLoad.ids.slice(0, expectedPrefix.length)).toEqual(expectedPrefix)
    for (const id of expectedPrefix) {
      expect(targetLoad.mutable.includes(id), `prefix ${id} must be readonly in the target route`).toBe(false)
    }

    // --- Divider + live title + precise navigation -----------------------
    const divider = page.locator('[data-testid="history-reference-divider"]')
    await expect(divider).toBeVisible({ timeout: 15000 })
    await expect(divider).toHaveAttribute('data-reference-status', 'available')
    const link = page.locator('[data-testid="history-reference-divider-link"]')
    await expect(link).toBeVisible()
    await expect(link).toContainText(sourceName)

    // --- Live rename via the REAL Main path (persist + invalidation) ------
    // NOT a Redux-only fake: the rename is written through the actual Main
    // capability `updateTopicMetadata` (a source-mutation channel). Main then
    // pushes a history-reference invalidation to the ACTIVE target, which
    // re-reads and refreshes its reference metadata (sourceName) from
    // authority; only afterwards the real caller projects the new name into
    // Redux (useAssistant updateTopic), which the live divider title reflects.
    const renamedName = 'Renamed Reference Source'
    const renamed = await page.evaluate(
      async ({ topicId, name }: { topicId: string; name: string }) =>
        await (window as any).api.chatDb.updateTopicMetadata({ topicId, name }),
      { topicId: sourceTopicId, name: renamedName }
    )
    expect(renamed?.ok, `updateTopicMetadata must persist the rename: ${JSON.stringify(renamed)}`).toBe(true)

    // Main -> renderer invalidation refreshes the active target's reference
    // metadata from authority, independent of any Redux projection.
    await page.waitForFunction(
      ({ tid, name }: { tid: string; name: string }) =>
        (window as any).store.getState().messages?.historyReferenceByTopic?.[tid]?.sourceName === name,
      { tid: targetTopicId, name: renamedName },
      { timeout: 30000 }
    )

    // Real rename caller projects the new name into Redux AFTER the Main write.
    await page.evaluate(
      ({ sourceTopicId, newName }: { sourceTopicId: string; newName: string }) => {
        const store = (window as any).store
        const s = store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.topics.some((t: any) => t.id === sourceTopicId))
        if (!assistant) throw new Error('source assistant not found')
        const topic = assistant.topics.find((t: any) => t.id === sourceTopicId)
        store.dispatch({
          type: 'assistants/updateTopic',
          payload: { assistantId: assistant.id, topic: { ...topic, name: newName } }
        })
      },
      { sourceTopicId, newName: renamedName }
    )
    await expect(link).toContainText(renamedName)

    // --- Read-only foreign prefix hides edit/delete controls -------------
    // The prefix keeps the source's canonical IDs and is excluded from the
    // target route's Main-authoritative mutableMessageIds, so the mutation
    // controls (edit/delete) are hidden on a prefix message.
    const prefixContainer = page.locator(`[data-message-id="${anchorId}"]`).first()
    await expect(prefixContainer).toBeVisible({ timeout: 15000 })
    try {
      await prefixContainer.hover({ timeout: 8000 })
    } catch {
      await prefixContainer.hover({ force: true, timeout: 5000 } as any)
    }
    // The prefix menubar mounts (so the hide below is capability-specific)…
    await expect(prefixContainer.locator('[data-testid="message-more-menu-btn"]')).toBeAttached({ timeout: 15000 })
    // …but its mutation controls are hidden for the read-only foreign prefix.
    await expect(prefixContainer.locator('[data-testid="message-delete-button"]')).toHaveCount(0)
    await expect(prefixContainer.locator('[data-testid="msg-edit-btn"]')).toHaveCount(0)

    // Divider click → source topic + captured route + exact anchor.
    await link.click()
    await page.waitForFunction(
      ({ sourceTopicId, anchorId }: { sourceTopicId: string; anchorId: string }) => {
        const s = (window as any).store.getState()
        if (s.messages?.currentTopicId !== sourceTopicId) return false
        const ids = s.messages.messageIdsByTopic[sourceTopicId] ?? []
        return ids.includes(anchorId)
      },
      { sourceTopicId, anchorId },
      { timeout: 30000 }
    )
    const navRoute = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null
    }, sourceTopicId)
    expect(navRoute).toBeNull()

    // --- Target-owned writable suffix ------------------------------------
    await activateTopicAndWaitLoaded(page, targetTopicId, expectedPrefix.length)
    const suffixText = 'target-owned suffix message'
    await uiSendMessage(page, suffixText)
    const suffixId = await page.waitForFunction(
      ({ tid, prefixLen }: { tid: string; prefixLen: number }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
        const own = ids.filter((id) => id.startsWith(`${tid}-`) || s.messages.entities[id]?.topicId === tid)
        return own.length > 0 && ids.length > prefixLen ? ids[ids.length - 1] : false
      },
      { tid: targetTopicId, prefixLen: expectedPrefix.length },
      { timeout: 60000 }
    )
    const addedId = (await suffixId.jsonValue()) as string
    expect(typeof addedId).toBe('string')
    const added = await page.evaluate((id: string) => (window as any).store.getState().messages.entities[id], addedId)
    expect(added?.topicId).toBe(targetTopicId)

    // Positive control: the target-OWNED suffix message exposes the delete
    // control, proving the prefix hide above is capability-specific.
    const suffixContainer = page.locator(`[data-message-id="${addedId}"]`).first()
    await expect(suffixContainer).toBeVisible({ timeout: 15000 })
    try {
      await suffixContainer.hover({ timeout: 8000 })
    } catch {
      await suffixContainer.hover({ force: true, timeout: 5000 } as any)
    }
    await expect(suffixContainer.locator('[data-testid="message-delete-button"]')).toHaveCount(1)

    // The source prefix is untouched by the target's own writes.
    const sourceAfterSend = await getRawTopicIds(page, sourceTopicId)
    expect(sourceAfterSend).toEqual(sourceOrderedIds)

    // --- Re-activation re-derives the relation from authority ------------
    await activateTopicAndWaitLoaded(page, sourceTopicId, 1)
    await activateTopicAndWaitLoaded(page, targetTopicId, expectedPrefix.length + 1)
    await expect(page.locator('[data-testid="history-reference-divider"]')).toBeVisible({ timeout: 15000 })
    const metaAfterReload = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages.historyReferenceByTopic[tid],
      targetTopicId
    )
    expect(metaAfterReload?.sourceTopicId).toBe(sourceTopicId)
    expect(metaAfterReload?.status).toBe('available')

    // --- Source soft delete → prefix missing, suffix survives ------------
    // Capture the target's own writable suffix from the effective authority
    // while the source is still available. `getRawTopic` on the target's main
    // route returns the effective history (foreign prefix + own suffix), so the
    // exact owned rows are the raw IDs outside the captured foreign prefix. This
    // read happens after the re-activation above has settled the send (loading
    // false), so the suffix set is deterministic.
    const targetAuthorityBeforeDelete = await getRawTopicIds(page, targetTopicId)
    const expectedSuffix = targetAuthorityBeforeDelete.filter((id) => !expectedPrefix.includes(id))
    expect(expectedSuffix, 'target must own a writable suffix distinct from the foreign prefix').toContain(addedId)

    const deleted = await page.evaluate(
      async ({ topicId, name }: { topicId: string; name: string }) =>
        await (window as any).api.chatDb.softDeleteTopic({ topicId, name }),
      { topicId: sourceTopicId, name: renamedName }
    )
    expect(deleted?.ok).toBe(true)

    await expect(page.locator('[data-testid="history-reference-divider"]')).toHaveAttribute(
      'data-reference-status',
      'missing',
      { timeout: 30000 }
    )
    await expect(page.locator('[data-testid="history-reference-divider-missing"]')).toBeVisible()
    await expect(page.locator('[data-testid="history-reference-divider-link"]')).toHaveCount(0)

    // Source gone → the target authority omits the foreign prefix entirely and
    // preserves EXACTLY the target-owned suffix (no cascade, no prefix leak).
    const targetAuthority = await getRawTopicIds(page, targetTopicId)
    expect(targetAuthority).toEqual(expectedSuffix)
    for (const id of expectedPrefix) {
      expect(targetAuthority, `foreign prefix ${id} must be omitted after source deletion`).not.toContain(id)
    }
  })

  test('branch-anchored reference: exact source branch switch + same-profile relaunch persistence', async ({
    mainWindow,
    electronApp,
    mockPort,
    ownedTmpRoot
  }) => {
    test.setTimeout(420000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED: reference created from a branch-OWNED source message (captured sourceBranchId = the internal branch, NONNULL) while the source is on that branch; divider link click while the source active branch is main switches the source to the EXACT captured branch and lands the stable branch-owned endpoint in view; the relation (source/branch/anchor), the read-only canonical foreign prefix, the target-owned writable suffix, and the target topic sidebar presence all survive a same-profile close/relaunch. Redux snapshots + Main fetchMessagesWindow/getRawTopic authority probes + redux-persist wire rehydration.'
    })

    const userDataDir = getUserDataDir()
    const page = mainWindow
    await waitForAppReady(page)
    const assistantId = await prepareDisplayCountAndAssistant(page)

    // --- Seed source topic (main) and fork a NONNULL internal branch ------
    const sourceTopicId = `refbr-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sourceName = 'Branch Reference Source'
    const entries = buildSourceEntries(sourceTopicId, assistantId)
    await seedTopicAndProject(page, sourceTopicId, assistantId, sourceName, entries)
    await activateTopicAndWaitLoaded(page, sourceTopicId, SOURCE_TOTAL)
    const sourceOrderedIds = await getRawTopicIds(page, sourceTopicId)
    expect(sourceOrderedIds).toHaveLength(SOURCE_TOTAL)
    const forkAnchorId = `${sourceTopicId}-msg-${pad(FORK_IDX, 5)}`

    await clickToolbarBranch(page, forkAnchorId)
    await page.waitForFunction(
      ({ tid, len }: { tid: string; len: number }) => {
        const s = (window as any).store.getState()
        const ids = s.messages?.messageIdsByTopic?.[tid]
        return Array.isArray(ids) && ids.length === len && s.messages?.loadingByTopic?.[tid] !== true
      },
      { tid: sourceTopicId, len: FORK_IDX + 1 },
      { timeout: 30000 }
    )
    const branches = await listBranches(page, sourceTopicId)
    expect(branches).toHaveLength(1)
    expect(branches[0].anchorMessageId).toBe(forkAnchorId)
    expect(branches[0].parentBranchId).toBeNull()
    const sourceBranchId = branches[0].id as string
    expect(typeof sourceBranchId).toBe('string')
    expect(sourceBranchId.length).toBeGreaterThan(0)

    // Main-authoritative branch effective route: the shared prefix through the
    // fork anchor (canonical SOURCE stable IDs, no copy/restamp).
    const branchPrefixIds = await fetchLatestRouteIds(page, sourceTopicId, sourceBranchId)
    expect(branchPrefixIds).toEqual(sourceOrderedIds.slice(0, FORK_IDX + 1))

    // Own a branch-distinct suffix through the REAL UI send while the branch is
    // active, so the captured source branch is content-distinct from main (not
    // merely a different route label).
    const prevBranchAssistants = await countAssistants(page, sourceTopicId)
    await uiSendMessage(page, 'branch-owned source message')
    const branchAnchorId = await waitForLatestAssistantComplete(page, sourceTopicId, prevBranchAssistants)
    const branchEffectiveIds = await fetchLatestRouteIds(page, sourceTopicId, sourceBranchId)
    expect(branchEffectiveIds).toHaveLength(FORK_IDX + 1 + 2)
    expect(branchEffectiveIds.slice(0, FORK_IDX + 1)).toEqual(sourceOrderedIds.slice(0, FORK_IDX + 1))
    expect(branchEffectiveIds, 'the branch must own its distinct suffix').toContain(branchAnchorId)
    const mainRouteIdsAfterBranch = await fetchLatestRouteIds(page, sourceTopicId, null)
    expect(mainRouteIdsAfterBranch).toEqual(sourceOrderedIds)
    expect(mainRouteIdsAfterBranch, 'the branch-owned anchor must be absent from the main route').not.toContain(
      branchAnchorId
    )

    // --- Create the reference from the branch-owned message ---------------
    await hoverMessageAndOpenMore(page, branchAnchorId)
    await clickReferenceSubmenu(page)
    const targetTopicId = await waitForTargetTopic(page, sourceTopicId, branchAnchorId)

    const meta = await page.evaluate(
      (tid: string) => (window as any).store.getState().messages.historyReferenceByTopic[tid],
      targetTopicId
    )
    expect(meta.sourceTopicId).toBe(sourceTopicId)
    expect(meta.sourceBranchId, 'captured source branch must be the NONNULL internal branch').toBe(sourceBranchId)
    expect(meta.anchorMessageId).toBe(branchAnchorId)
    expect(meta.status).toBe('available')
    expect(meta.boundaryMessageId).toBe(branchAnchorId)

    // The foreign prefix is the source BRANCH effective route through the
    // branch-owned anchor (canonical source IDs) and stays READ-ONLY.
    const expectedPrefix = branchEffectiveIds
    const targetLoad = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return {
        ids: s.messages.messageIdsByTopic[tid] ?? [],
        mutable: s.messages.mutableMessageIdsByTopic[tid] ?? [],
        route: s.messages.mutableRouteByTopic[tid] ?? null,
        currentTopicId: s.messages.currentTopicId
      }
    }, targetTopicId)
    expect(targetLoad.currentTopicId).toBe(targetTopicId)
    expect(targetLoad.ids.slice(0, expectedPrefix.length)).toEqual(expectedPrefix)
    for (const id of expectedPrefix) {
      expect(targetLoad.mutable.includes(id), `prefix ${id} must be readonly in the target route`).toBe(false)
    }

    const divider = page.locator('[data-testid="history-reference-divider"]')
    await expect(divider).toBeVisible({ timeout: 15000 })
    await expect(divider).toHaveAttribute('data-reference-status', 'available')
    const link = page.locator('[data-testid="history-reference-divider-link"]')
    await expect(link).toBeVisible()
    await expect(link).toContainText(sourceName)

    // --- Target-owned writable suffix (real send on the target) -----------
    const prevTargetAssistants = await countAssistants(page, targetTopicId)
    await uiSendMessage(page, 'target-owned suffix message')
    const suffixAnchorId = await waitForLatestAssistantComplete(page, targetTopicId, prevTargetAssistants)
    const targetRawAfterSend = await getRawTopicIds(page, targetTopicId)
    const expectedSuffix = targetRawAfterSend.filter((id) => !expectedPrefix.includes(id))
    expect(expectedSuffix, 'target must own a writable suffix distinct from the foreign prefix').toContain(
      suffixAnchorId
    )
    expect(expectedSuffix.length).toBeGreaterThanOrEqual(2)

    // Read-only foreign prefix hides mutation controls; the owned suffix keeps them.
    await hoverMessage(page, branchAnchorId)
    const prefixContainer = page.locator(`[data-message-id="${branchAnchorId}"]`).first()
    await expect(prefixContainer.locator('[data-testid="message-more-menu-btn"]')).toBeAttached({ timeout: 15000 })
    await expect(prefixContainer.locator('[data-testid="message-delete-button"]')).toHaveCount(0)
    await expect(prefixContainer.locator('[data-testid="msg-edit-btn"]')).toHaveCount(0)
    await hoverMessage(page, suffixAnchorId)
    const suffixContainer = page.locator(`[data-message-id="${suffixAnchorId}"]`).first()
    await expect(suffixContainer.locator('[data-testid="message-delete-button"]')).toHaveCount(1)

    // --- Divider link switches the source to the EXACT captured branch -----
    // Even when the source's active branch is DIFFERENT (main) at click time.
    const navBefore = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(navBefore, 'source starts on the captured branch after creation').toBe(sourceBranchId)
    await page.evaluate((tid: string) => {
      ;(window as any).store.dispatch({
        type: 'topicBranch/activeBranchSet',
        payload: { topicId: tid, branchId: null }
      })
    }, sourceTopicId)
    await page.waitForFunction(
      (tid: string) => ((window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null) === null,
      sourceTopicId,
      { timeout: 15000 }
    )

    await link.click()
    await page.waitForFunction(
      ({ tid, bid, anchor }: { tid: string; bid: string; anchor: string }) => {
        const s = (window as any).store.getState()
        if (s.messages?.currentTopicId !== tid) return false
        if ((s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null) !== bid) return false
        const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
        return ids.includes(anchor)
      },
      { tid: sourceTopicId, bid: sourceBranchId, anchor: branchAnchorId },
      { timeout: 30000 }
    )
    const navAfter = await page.evaluate(
      (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
      sourceTopicId
    )
    expect(navAfter, 'divider link must switch the source to its EXACT captured branch').toBe(sourceBranchId)
    await page.waitForFunction(
      (id: string) => {
        const escId = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
        const container = document.querySelector('#messages') as HTMLElement | null
        const el = document.querySelector(`[id="message-${escId}"][data-message-id="${escId}"]`) as HTMLElement | null
        if (!container || !el) return false
        const c = container.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.bottom > c.top && r.top < c.bottom
      },
      branchAnchorId,
      { timeout: 30000 }
    )
    expect(
      await isMessageVisible(page, branchAnchorId),
      'the captured branch-owned endpoint must be visible after the switch'
    ).toBe(true)

    // --- Same-profile relaunch durability ---------------------------------
    const chatDbPath = getChatDbPath()
    expect(chatDbPath).not.toBeNull()
    await waitPersistWireHasTopic(page, targetTopicId)
    await electronApp.close()
    const relaunched = await relaunchSameProfile({ userDataDir, ownedTmpRoot, mockPort })
    try {
      const page2 = relaunched.page
      await waitForAppReady(page2)
      await page2.evaluate((limit: number) => {
        ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
      }, DISPLAY_LIMIT)
      await waitPersistRehydrated(page2)

      // The target's fully local-only registration (never synced) restored the
      // sidebar entry: proves DB + Redux persistence, not a session artifact.
      await expect(
        page2.locator(`[data-testid="topic-item"][data-topic-id="${targetTopicId}"]`),
        'reference target must remain in the sidebar after relaunch'
      ).toBeVisible({ timeout: 30000 })
      const topicsAfterReload = await sidebarTopicIds(page2)
      expect(topicsAfterReload).toContain(targetTopicId)
      expect(topicsAfterReload).toContain(sourceTopicId)

      // Re-activation re-derives the relation + capability from Main authority.
      await activateTopicAndWaitLoaded(page2, targetTopicId, expectedPrefix.length + expectedSuffix.length)
      await page2.waitForFunction(
        (tid: string) =>
          (window as any).store.getState().messages?.historyReferenceByTopic?.[tid]?.status === 'available',
        targetTopicId,
        { timeout: 30000 }
      )
      const meta2 = await page2.evaluate(
        (tid: string) => (window as any).store.getState().messages.historyReferenceByTopic[tid],
        targetTopicId
      )
      expect(meta2.sourceTopicId).toBe(sourceTopicId)
      expect(meta2.sourceBranchId, 'captured nonnull source branch must persist').toBe(sourceBranchId)
      expect(meta2.anchorMessageId).toBe(branchAnchorId)
      expect(meta2.status).toBe('available')

      const t2 = await page2.evaluate((tid: string) => {
        const s = (window as any).store.getState()
        return {
          ids: s.messages.messageIdsByTopic[tid] ?? [],
          mutable: s.messages.mutableMessageIdsByTopic[tid] ?? [],
          route: s.messages.mutableRouteByTopic[tid] ?? null
        }
      }, targetTopicId)
      expect(t2.route).toBeNull()
      for (const id of expectedSuffix) {
        expect(t2.mutable, `owned suffix ${id} must stay mutable after relaunch`).toContain(id)
      }
      for (const id of expectedPrefix) {
        expect(t2.mutable.includes(id), `prefix ${id} must stay readonly after relaunch`).toBe(false)
      }
      const targetRawAfterRelaunch = await getRawTopicIds(page2, targetTopicId)
      expect(targetRawAfterRelaunch, 'relaunch must preserve the exact prefix + owned suffix').toEqual(
        targetRawAfterSend
      )
      await expect(page2.locator('[data-testid="history-reference-divider"]')).toBeVisible({ timeout: 15000 })
      await expect(page2.locator('[data-testid="history-reference-divider"]')).toHaveAttribute(
        'data-reference-status',
        'available'
      )
      await expect(page2.locator('[data-testid="history-reference-divider-link"]')).toContainText(sourceName)
    } finally {
      await closeElectronWithExactCleanup(userDataDir, {
        close: () => relaunched.app.close(),
        findExactProcesses: findProcessesByUserDataDir,
        terminateExactProcesses: (profileDir) => terminateProcessesByUserDataDir(profileDir, null)
      })
      // Process-settle only (not a correctness gate).
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  })

  test('read-only multi-answer group keeps the horizontal expanded strip (reference prefix + inherited branch)', async ({
    mainWindow
  }) => {
    test.setTimeout(300000)
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED layout regression: an owned source answer group (user + two assistant variants sharing askId/model name) renders the expanded horizontal model-tab strip; its cross-topic Reference clone (read-only foreign prefix, Main mutableMessageIds excluded) and the same group inherited through a within-topic child branch must keep the SAME horizontal strip geometry (single row, same tab advance) while staying inert/read-only. Real selector rects + container computed flex layout.'
    })

    const page = mainWindow
    const assistantId = await prepareDisplayCountAndAssistant(page)

    // Pin expanded fold mode: the reported regression only manifests there.
    await page.evaluate(() => {
      ;(window as any).store.dispatch({ type: 'settings/setFoldDisplayMode', payload: 'expanded' })
    })
    expect(await page.evaluate(() => (window as any).store.getState().settings.foldDisplayMode)).toBe('expanded')

    // --- Seed source with a multi-answer group + trailing filler ----------
    const sourceTopicId = `refstrip-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sourceName = 'Reference Strip Source'
    const built = buildStripSourceEntries(sourceTopicId, assistantId)
    await seedTopicAndProject(page, sourceTopicId, assistantId, sourceName, built.entries)
    await activateTopicAndWaitLoaded(page, sourceTopicId, SOURCE_TOTAL_STRIP)

    const memberIds = [built.firstAssistantId, built.anchorId]

    // --- Source (owned, main route): ENABLED horizontal strip -------------
    const sourceStrip = await readAnswerStrip(page, memberIds)
    expect(sourceStrip.containerClass, 'source group must render the segmented list').toContain('segmented-list')
    expect(sourceStrip.ariaDisabled, 'source group must be owned/enabled').toBeNull()
    expect(sourceStrip.display, 'enabled expanded list must be a flex strip').toBe('flex')
    expect(sourceStrip.flexDirection).toBe('row')
    assertHorizontalStrip(sourceStrip.rects)
    logStrip('source(enabled)', sourceStrip)

    // --- Reference clone on the group's last assistant --------------------
    await hoverMessageAndOpenMore(page, built.anchorId)
    await clickReferenceSubmenu(page)
    const targetTopicId = await waitForTargetTopic(page, sourceTopicId, built.anchorId)

    // Confirm the read-only contract that drives the disabled path: the group
    // members are excluded from the target route's Main-authoritative
    // mutableMessageIds.
    const targetCapability = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      return {
        currentTopicId: s.messages?.currentTopicId,
        mutable: (s.messages?.mutableMessageIdsByTopic?.[tid] ?? []) as string[]
      }
    }, targetTopicId)
    expect(targetCapability.currentTopicId).toBe(targetTopicId)
    for (const id of memberIds) {
      expect(targetCapability.mutable, `reference prefix member ${id} must be read-only`).not.toContain(id)
    }

    // Fresh mount of the target from authority: the read-only group must
    // evaluate its capability from Main state (a group DOM carried over from
    // the source activation is not the read-only presentation). Reload, then
    // re-establish the deterministic settings and activate the target.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean((window as any).store?.getState()?.messages), { timeout: 30000 })
    await prepareDisplayCountAndAssistant(page)
    await page.evaluate(() => {
      ;(window as any).store.dispatch({ type: 'settings/setFoldDisplayMode', payload: 'expanded' })
    })
    await activateTopicAndWaitLoaded(page, targetTopicId, built.prefixCount)

    // --- Target foreign prefix (READ-ONLY): DISABLED but same strip --------
    const targetStrip = await readAnswerStrip(page, memberIds)
    expect(targetStrip.containerClass, 'reference prefix group must render the segmented list').toContain(
      'segmented-list'
    )
    expect(targetStrip.ariaDisabled, 'reference prefix group must be read-only/disabled').toBe('true')
    expect(targetStrip.display, 'read-only expanded list must stay a flex strip (no stacked rows)').toBe('flex')
    expect(targetStrip.flexDirection).toBe('row')
    assertHorizontalStrip(targetStrip.rects)
    const sourceAdvance = sourceStrip.rects[1].x - sourceStrip.rects[0].x
    const targetAdvance = targetStrip.rects[1].x - targetStrip.rects[0].x
    expect(
      Math.abs(sourceAdvance - targetAdvance),
      'enabled and read-only strips must lay tabs out with the same horizontal advance'
    ).toBeLessThanOrEqual(4)
    logStrip('reference(disabled)', targetStrip)

    // --- Child true branch on the SOURCE (fork AFTER the group) -----------
    // The branch route inherits the group through its prefix; the inherited
    // members are not branch-owned, so the group is read-only there too and
    // must keep the same horizontal strip.
    await activateTopicAndWaitLoaded(page, sourceTopicId, SOURCE_TOTAL_STRIP)
    await clickToolbarBranch(page, built.forkAssistantId)
    await page.waitForFunction(
      ({ tid, memberId }: { tid: string; memberId: string }) => {
        const s = (window as any).store.getState()
        const active = s.topicBranch?.activeBranchIdByTopic?.[tid] ?? null
        if (!active) return false
        if (s.messages?.loadingByTopic?.[tid] === true) return false
        const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
        return ids.includes(memberId)
      },
      { tid: sourceTopicId, memberId: built.firstAssistantId },
      { timeout: 30000 }
    )
    const branchStrip = await readAnswerStrip(page, memberIds)
    expect(branchStrip.containerClass, 'inherited branch group must render the segmented list').toContain(
      'segmented-list'
    )
    expect(branchStrip.ariaDisabled, 'inherited branch group must be read-only/disabled').toBe('true')
    expect(branchStrip.display, 'inherited branch expanded list must stay a flex strip').toBe('flex')
    expect(branchStrip.flexDirection).toBe('row')
    assertHorizontalStrip(branchStrip.rects)
    expect(
      Math.abs(branchStrip.rects[1].x - branchStrip.rects[0].x - sourceAdvance),
      'inherited branch strip must match the enabled strip horizontal advance'
    ).toBeLessThanOrEqual(4)
    logStrip('inherited-branch(disabled)', branchStrip)
  })
})
