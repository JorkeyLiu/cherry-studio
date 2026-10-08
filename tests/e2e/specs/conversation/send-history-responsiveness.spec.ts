/**
 * Send-history responsiveness (history-fanout contract regression).
 *
 * Core acceptance: "many rounds, multi-model answer history -> one ordinary
 * single-model send". History is seeded through Main authority (typed IPC:
 * assistants/addTopic + chatDb.ensureTopic + chatDb.pasteMessagesToTopic,
 * read back via real sidebar click + loaded Redux + read-only Main reads);
 * the send under test is always the ordinary short single-model path with
 * zero mention chips and exactly one provider request. The simultaneous
 * multi-request case is NOT added here (the old baseline already owns the
 * C100 triple); this spec never requests 3 models at once.
 *
 * Window math (current production constants, not invented thresholds):
 * - fetch window hard cap: clampWindowCount max 100 messages.
 * - renderer viewport bound: 200 groups.
 * - seed: 20 turns x (1 user + 3 assistants sharing one askId) = 80 messages
 *   in 40 askId groups (20 user singletons + 20 assistant triples), fully
 *   inside both bounds so the cold load is the ACTUAL FULL window (Main 80,
 *   loaded 80, no trim). Group counts are computed by real askId grouping;
 *   groups and messages are never confused.
 * - content is purely synthetic (`shr-*` markers); no real profile is touched
 *   (shared disposable-profile fixture).
 *
 * No millisecond performance walls: Playwright asserts actual behavior and
 * authority (exact new IDs in Redux/DOM/Main, single request, anchor/route
 * stability, history selection/content preservation, follow-bottom), while
 * structural/count protection lives in the component test
 * (MessageGroup.historyFanout). Requires a fresh production build before the
 * run (`pnpm build`, then `pnpm test:e2e <this file>`); this file is
 * preparation only and was never executed here.
 */
import type { Page } from '@playwright/test'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getRequestLog,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

// ---------------------------------------------------------------------------
// Local constants (mirror production bounds; see header math)
// ---------------------------------------------------------------------------

const TURNS = 20
const ASSISTANTS_PER_TURN = 3
const SEED_MESSAGES = TURNS * (1 + ASSISTANTS_PER_TURN) // 80
const SEED_GROUPS = TURNS * 2 // 40: one user singleton + one assistant triple per turn
const WINDOW_MESSAGE_HARD_CAP = 100
const STAMP = '2026-01-01T00:00:00.000Z'

const HISTORY_MODELS = [
  { id: 'shr-model-a', provider: 'mock-openai', name: 'SHR Model A', group: 'shr' },
  { id: 'shr-model-b', provider: 'mock-openai', name: 'SHR Model B', group: 'shr' },
  { id: 'shr-model-c', provider: 'mock-openai', name: 'SHR Model C', group: 'shr' }
] as const

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

// ---------------------------------------------------------------------------
// Spec-local helpers (no shared-harness changes)
// ---------------------------------------------------------------------------

async function ensureDisplayCount(page: Page, limit: number): Promise<void> {
  await page.evaluate((value: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: value })
  }, limit)
  const displayOk = await page.evaluate(() => (window as any).store.getState().messages.displayCount)
  expect(displayOk).toBe(limit)
}

async function getLiveAssistantId(page: Page): Promise<string> {
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

/** Real fold-display setting (expanded vs compact are the two render states). */
async function ensureFoldMode(page: Page, mode: 'expanded' | 'compact'): Promise<void> {
  await page.evaluate((value: 'expanded' | 'compact') => {
    const store = (window as any).store
    store.dispatch({ type: 'settings/setFoldDisplayMode', payload: value })
  }, mode)
  const foldOk = await page.evaluate(() => (window as any).store.getState().settings.foldDisplayMode)
  expect(foldOk).toBe(mode)
}

/**
 * 20 history turns; every turn is 1 user + 3 SUCCESS assistants sharing the
 * user's id as askId, each assistant carrying distinct synthetic model
 * metadata. foldSelected starts on the first answer of every triple.
 */
function buildHistoryFanoutEntries(topicId: string, assistantId: string) {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const askIds: string[] = []
  const tripleMembers: string[][] = []
  let order = 0
  const push = (role: string, content: string, extra: Record<string, unknown> = {}): string => {
    const msgId = `${topicId}-shr-${pad(order, 5)}`
    const blockId = `${topicId}-shrb-${pad(order, 5)}`
    entries.push({
      message: {
        id: msgId,
        topicId,
        role,
        assistantId,
        createdAt: STAMP,
        updatedAt: STAMP,
        status: 'success',
        blocks: [blockId],
        sortOrder: order,
        ...extra
      },
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content,
          status: 'success',
          createdAt: STAMP,
          updatedAt: STAMP
        }
      ]
    })
    order += 1
    return msgId
  }
  for (let turn = 0; turn < TURNS; turn++) {
    const askId = push('user', `shr-history-user-t${pad(turn, 2)} synthetic ordinary question`)
    askIds.push(askId)
    const members: string[] = []
    for (let slot = 0; slot < ASSISTANTS_PER_TURN; slot++) {
      const model = HISTORY_MODELS[slot]
      members.push(
        push('assistant', `shr-history-answer-t${pad(turn, 2)}-s${slot} synthetic`, {
          askId,
          foldSelected: slot === 0,
          model: { ...model },
          modelId: model.id
        })
      )
    }
    tripleMembers.push(members)
  }
  return { entries, askIds, tripleMembers }
}

async function seedTopicViaMainAuthority(
  page: Page,
  liveAssistantId: string,
  topicId: string,
  entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
): Promise<void> {
  const addOk = await page.evaluate(
    ({ topicId, assistantId, name, stamp }: { topicId: string; assistantId: string; name: string; stamp: string }) => {
      try {
        const store = (window as any).store
        store.dispatch({
          type: 'assistants/addTopic',
          payload: {
            assistantId,
            topic: { id: topicId, assistantId, name, createdAt: stamp, updatedAt: stamp }
          }
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name: `SendHistory ${topicId}`, stamp: STAMP }
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
        const api = (window as any).api as any
        const chatDb = api?.chatDb
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
    { topicId, assistantId: liveAssistantId, name: `SendHistory ${topicId}`, entries }
  )
  expect(persist.ok, `Main authority seed failed: ${(persist as any).err}`).toBe(true)
}

/** Real sidebar click activation; waits for the FULL seeded window to load. */
async function activateTopicFull(page: Page, topicId: string): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  await page.waitForFunction(
    ({ topicId, expected }: { topicId: string; expected: number }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      return Array.isArray(ids) && ids.length === expected && loading !== true
    },
    { topicId, expected: SEED_MESSAGES },
    { timeout: 60000 }
  )
  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#messages [data-message-id]:not([data-testid="answer-group-selector"])').length >=
      expected,
    SEED_MESSAGES,
    { timeout: 30000 }
  )
}

/** Actual askId group count from loaded Redux (groups, not messages). */
async function loadedAskIdGroupCount(page: Page, topicId: string): Promise<number> {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const ids: string[] = s.messages?.messageIdsByTopic?.[tid] ?? []
    const groups = new Set<string>()
    for (const id of ids) {
      const m = s.messages?.entities?.[id]
      if (!m) continue
      groups.add(m.role === 'assistant' && m.askId ? `assistant:${m.askId}` : `message:${m.role}:${m.id}`)
    }
    return groups.size
  }, topicId)
}

async function mainMessageCount(page: Page, topicId: string): Promise<number> {
  return page.evaluate(async (tid: string) => {
    const res = await (window as any).api.chatDb.fetchMessages({ topicId: tid })
    if (!res || res.ok !== true) throw new Error('fetchMessages failed')
    return res.value.messages.length
  }, topicId)
}

async function authoritativeSelectedId(page: Page, topicId: string, memberIds: string[]): Promise<string | null> {
  const raw: any = await page.evaluate(
    async ({ topicId }: { topicId: string }) => await (window as any).api.chatDb.getRawTopic({ topicId }),
    { topicId }
  )
  expect(raw?.ok, `getRawTopic failed for ${topicId}`).toBe(true)
  const messages: any[] = raw?.value?.messages ?? []
  const selected = messages.filter((m: any) => memberIds.includes(m.id) && (m as any).foldSelected === true)
  return selected.length === 1 ? (selected[0].id as string) : null
}

/** Real UI send: native-setter input event + Enter on the production textarea. */
async function uiSendOrdinary(page: Page, text: string): Promise<void> {
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
  // Zero chips: ordinary single-model send must carry no mention chips.
  const chips = await page.locator('#inputbar .anticon-close').count()
  expect(chips, 'ordinary send must carry zero mention chips').toBe(0)
  await expect(textarea).toBeEnabled({ timeout: 5000 })
  await textarea.press('Enter')
}

/** Wait until the topic grows by the new user + stub and both succeed. */
async function waitOrdinaryReplyComplete(
  page: Page,
  topicId: string,
  expectedTotal: number,
  timeout = 120000
): Promise<void> {
  await page.waitForFunction(
    ({ topicId, expectedTotal }: { topicId: string; expectedTotal: number }) => {
      const s = (window as any).store?.getState()
      if (!s || s.messages?.loadingByTopic?.[topicId]) return false
      const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
      // New rows must have landed first: history alone already satisfies the
      // tail-success shape below, so length growth is the new-send gate.
      if (ids.length < expectedTotal) return false
      let userOk = false
      let assistantOk = false
      for (let i = ids.length - 1; i >= 0; i--) {
        const m = s.messages?.entities?.[ids[i]]
        if (!m) continue
        if (m.role === 'user' && !userOk) userOk = true
        if (m.role === 'assistant' && !assistantOk) {
          if (m.status !== 'success' && m.status !== 'error') return false
          const blocks: string[] = m.blocks ?? []
          if (blocks.length === 0) return false
          for (const b of blocks) {
            const block = s.messageBlocks?.entities?.[b]
            if (!block || (block.status !== 'success' && block.status !== 'error')) return false
          }
          assistantOk = true
        }
        if (userOk && assistantOk) return true
      }
      return false
    },
    { topicId, expectedTotal },
    { timeout }
  )
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Send-history responsiveness: multi-model history, ordinary single send', () => {
  test.setTimeout(300000)

  test('history fanout seed loads the full window; one ordinary send adds user+stub with history preserved', async ({
    mainWindow
  }) => {
    const page = mainWindow
    await waitForAppReady(page)

    // Seed the full 80-message / 40-group history through Main authority.
    expect(SEED_MESSAGES).toBeLessThanOrEqual(WINDOW_MESSAGE_HARD_CAP)
    await ensureDisplayCount(page, WINDOW_MESSAGE_HARD_CAP)
    const liveAssistantId = await getLiveAssistantId(page)
    const topicId = `shr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const built = buildHistoryFanoutEntries(topicId, liveAssistantId)
    expect(built.entries.length).toBe(SEED_MESSAGES)
    await seedTopicViaMainAuthority(page, liveAssistantId, topicId, built.entries)

    // Cold activation must load the ACTUAL FULL window: Main 80, loaded 80.
    await test.step('full-window history activation', async () => {
      await activateTopicFull(page, topicId)
      expect(await mainMessageCount(page, topicId)).toBe(SEED_MESSAGES)
      expect(await loadedAskIdGroupCount(page, topicId)).toBe(SEED_GROUPS)
      const currentRoute = await page.evaluate(
        (tid: string) => (window as any).store.getState().messages?.currentTopicId ?? tid,
        topicId
      )
      expect(currentRoute).toBeTruthy()
    })

    // History contract before the send: every triple keeps 3 SUCCESS answers
    // with distinct models and exactly one fold-selected member (Main proof).
    await test.step('history triple contract (Main authority)', async () => {
      for (let turn = 0; turn < TURNS; turn++) {
        const members = built.tripleMembers[turn]
        const selected = await authoritativeSelectedId(page, topicId, members)
        expect(selected, `turn ${turn} must keep its first answer selected`).toBe(members[0])
      }
      const distinctModels = await page.evaluate(
        ({ topicId, askId }: { topicId: string; askId: string }) => {
          const s = (window as any).store.getState()
          const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
          const models = new Set<string>()
          for (const id of ids) {
            const m = s.messages?.entities?.[id]
            if (m?.role === 'assistant' && m.askId === askId) models.add(String(m.modelId ?? m.model?.id ?? ''))
          }
          return [...models].sort()
        },
        { topicId, askId: built.askIds[0] }
      )
      expect(distinctModels).toEqual(['shr-model-a', 'shr-model-b', 'shr-model-c'])
    })

    // Capture pre-send stability anchors: context anchor, current route, and
    // one mid-history triple's selection + content.
    const probeTurn = 5
    const probeMembers = built.tripleMembers[probeTurn]
    const preAnchor = await page.evaluate(() => {
      const s = (window as any).store.getState()
      const owner = s.assistants?.assistants?.[0]
      return JSON.stringify(owner?.settings?.contextWindowAnchor ?? null)
    })
    const preRoute = await page.evaluate(() => {
      const s = (window as any).store.getState()
      return String(s.messages?.currentTopicId ?? '')
    })
    const preProbeContent = await page.evaluate(
      ({ topicId, memberId }: { topicId: string; memberId: string }) => {
        const s = (window as any).store.getState()
        const m = s.messages?.entities?.[memberId]
        const blockId = m?.blocks?.[0] ?? ''
        return String(s.messageBlocks?.entities?.[blockId]?.content ?? '')
      },
      { topicId, memberId: probeMembers[1] }
    )
    expect(preProbeContent).toContain(`shr-history-answer-t${pad(probeTurn, 2)}-s1`)

    // Both fold render states show the same history triple rows: expanded
    // first, then compact; the ordinary send below runs in compact mode.
    await test.step('expanded + compact render states', async () => {
      await ensureFoldMode(page, 'expanded')
      for (const id of probeMembers) {
        await expect(page.locator(`#messages [data-message-id="${id}"]`).first()).toBeAttached({ timeout: 15000 })
      }
      await ensureFoldMode(page, 'compact')
      for (const id of probeMembers) {
        await expect(page.locator(`#messages [data-message-id="${id}"]`).first()).toBeAttached({ timeout: 15000 })
      }
      const compactSelected = await authoritativeSelectedId(page, topicId, probeMembers)
      expect(compactSelected, 'mode switch must not move history selection').toBe(probeMembers[0])
    })

    // One ordinary short send: zero chips, exactly one provider request.
    const marker = `shr-ordinary-send-${Date.now()} synthetic`
    let sendSeqBefore = 0
    await test.step('ordinary single-model send', async () => {
      clearRequestLog()
      sendSeqBefore = getRequestSequence()
      await uiSendOrdinary(page, marker)
      await waitOrdinaryReplyComplete(page, topicId, SEED_MESSAGES + 2)
    })

    // Post-send authority: Main +2 (user + single stub), loaded +2, the new
    // rows exist under exact IDs in both Redux and the DOM.
    await test.step('post-send authority (+2 rows, exact new IDs)', async () => {
      expect(await mainMessageCount(page, topicId)).toBe(SEED_MESSAGES + 2)
      const loaded: string[] = await page.evaluate(
        (tid: string) => [...((window as any).store.getState().messages?.messageIdsByTopic?.[tid] ?? [])],
        topicId
      )
      expect(loaded.length).toBe(SEED_MESSAGES + 2)
      const tail = await page.evaluate((ids: string[]) => {
        const s = (window as any).store.getState()
        return ids.slice(-2).map((id) => ({ id, role: String(s.messages?.entities?.[id]?.role ?? '') }))
      }, loaded)
      expect(tail.map((t) => t.role)).toEqual(['user', 'assistant'])
      for (const t of tail) {
        await expect(page.locator(`#messages [data-message-id="${t.id}"]`).first()).toBeVisible({ timeout: 15000 })
      }
      // New user row carries the exact marker text (Redux block read).
      const userContent = await page.evaluate((userId: string) => {
        const s = (window as any).store.getState()
        const m = s.messages?.entities?.[userId]
        const blockId = m?.blocks?.[0] ?? ''
        return String(s.messageBlocks?.entities?.[blockId]?.content ?? '')
      }, tail[0].id)
      expect(userContent).toContain(marker)
    })

    // Exactly one provider request served the ordinary send (zero chips
    // already asserted at send time; the triple-request case stays out).
    await test.step('single provider request proof', async () => {
      const productReq = findProductRequestAfter(sendSeqBefore)
      expect(productReq, 'ordinary send must emit exactly one product request').not.toBeNull()
      expect(productReq!.method).toBe('POST')
      expect(productReq!.url).toBe('/v1/chat/completions')
      expect((productReq!.parsed as any)?.stream).toBe(true)
      expect((productReq!.parsed as any)?.model).toBe('mock-model')
      const messages = (productReq!.parsed as any)?.messages as Array<{ role: string; content: string }>
      expect(messages.filter((m) => m.role === 'user').at(-1)?.content).toContain(marker)
      // No second product POST: the ordinary path fans out to one request only.
      const productPosts = getRequestLog().filter(
        (e: any) => e.sequence >= sendSeqBefore && e.method === 'POST' && e.url === '/v1/chat/completions'
      )
      expect(productPosts.length).toBe(1)
    })

    // Stability: context anchor + current route unchanged; probed history
    // triple keeps its selection and content; the send followed bottom.
    await test.step('history + viewport stability after send', async () => {
      const postAnchor = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const owner = s.assistants?.assistants?.[0]
        return JSON.stringify(owner?.settings?.contextWindowAnchor ?? null)
      })
      expect(postAnchor).toBe(preAnchor)
      const postRoute = await page.evaluate(() =>
        String((window as any).store.getState().messages?.currentTopicId ?? '')
      )
      expect(postRoute).toBe(preRoute)

      const postSelected = await authoritativeSelectedId(page, topicId, probeMembers)
      expect(postSelected, 'history triple selection must survive the send').toBe(probeMembers[0])
      const postProbeContent = await page.evaluate(
        ({ topicId, memberId }: { topicId: string; memberId: string }) => {
          const s = (window as any).store.getState()
          const m = s.messages?.entities?.[memberId]
          const blockId = m?.blocks?.[0] ?? ''
          return String(s.messageBlocks?.entities?.[blockId]?.content ?? '')
        },
        { topicId, memberId: probeMembers[1] }
      )
      expect(postProbeContent).toBe(preProbeContent)

      // Follow-bottom: the newest row is rendered and the column-reverse
      // container rests at bottom (stable data markers, no ms thresholds).
      const atBottom = await page.evaluate(() => {
        const box = document.getElementById('messages') as HTMLElement | null
        if (!box) return false
        return Math.abs(box.scrollTop) <= 100
      })
      expect(atBottom, 'ordinary send must follow bottom').toBe(true)
    })
  })
})
