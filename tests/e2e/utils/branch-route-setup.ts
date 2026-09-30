/**
 * Branch-route E2E setup primitives (setup-only, no test boundaries).
 *
 * Shared by `true-branch.spec.ts` (letter-leading synthetic message IDs) and
 * `top-cross-route-provenance.spec.ts` (digit-leading UUID-like message IDs).
 * Each helper asserts only that its own setup IPC/action succeeded and
 * returns IDs/results. Route switching, wheel input, snapshot waits, viewport
 * phase, offset assertions, and regression-specific synchronization stay in
 * the specs and are never hidden here.
 */
import { expect } from '@playwright/test'

export function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

/**
 * Production-realistic UUID-like fixture IDs (digit-leading).
 * Production writers use raw UUIDs commonly starting with digits where
 * `CSS.escape` changes the string; letter-leading synthetic IDs are blind to
 * the raw-`getElementById` contract. Every generated ID here starts with a
 * digit so any planned restore anchor exercises the escape gap.
 */
export function uuidLike(index: number): string {
  const raw = `${index.toString(16).padStart(8, '0')}9e2a3b4c4d5e8f901234567890ab`.slice(0, 32)
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`
}

/** Letter-leading synthetic message ID for a seeded source topic. */
export function letterMessageId(topicId: string, index: number): string {
  return `${topicId}-msg-${pad(index, 5)}`
}

export async function prepareAssistant(page: any, displayCount: number): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, displayCount)
  const liveAssistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

export interface SeedSourceTopicOptions {
  assistantId: string
  topicId: string
  name: string
  total: number
  messageIdForIndex: (index: number) => string
  contentPrefix: string
  /** Exact-content override per index (default: `${contentPrefix}${pad(index, 5)}`). */
  contentForIndex?: (index: number) => string
}

export async function seedSourceTopic(page: any, options: SeedSourceTopicOptions): Promise<string[]> {
  const { assistantId, topicId, name, total, messageIdForIndex, contentPrefix, contentForIndex } = options
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
  expect(addOk.ok).toBe(true)
  const entries: any[] = []
  const ids: string[] = []
  for (let i = 0; i < total; i++) {
    const msgId = messageIdForIndex(i)
    const blockId = `${topicId}-block-${pad(i, 5)}`
    ids.push(msgId)
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const msg: any = {
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
    if (role === 'assistant') {
      msg.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      msg.modelId = 'mock-model'
      msg.askId = ids[i - 1]
    }
    entries.push({
      message: msg,
      blocks: [
        {
          id: blockId,
          messageId: msgId,
          type: 'main_text',
          content: contentForIndex ? contentForIndex(i) : `${contentPrefix}${pad(i, 5)}`,
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
      entries: any
    }) => {
      try {
        const api: any = (window as any).api.chatDb
        const ensured = await api.ensureTopic({ topicId, assistantId, name })
        if (!ensured || ensured.ok !== true) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
        const pasted = await api.pasteMessagesToTopic({ topicId, entries })
        if (!pasted || pasted.ok !== true) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId, name, entries }
  )
  expect(persist.ok, `seed failed: ${(persist as any).err}`).toBe(true)
  return ids
}

/**
 * Small 4-message ownership topology (setup-only): exact IDs
 * `${topicId}-msg-00000..00003` with blocks `${topicId}-block-00000..00003`
 * and contents `other-topic-0..3`, alternating user/assistant roles.
 */
export async function seedSmallTopic(page: any, assistantId: string, topicId: string, name: string): Promise<string[]> {
  return seedSourceTopic(page, {
    assistantId,
    topicId,
    name,
    total: 4,
    messageIdForIndex: (i: number) => letterMessageId(topicId, i),
    contentPrefix: 'other-topic-',
    contentForIndex: (i: number) => `other-topic-${i}`
  })
}

export async function activateTopic(page: any, topicId: string, atLeast: number): Promise<void> {
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

export async function clickToolbarBranch(page: any, messageId: string): Promise<void> {
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
    // Hover flakiness near edges; the button click below uses force fallback.
  }
  const btn = container.locator('[data-testid="msg-true-branch-btn"]')
  await expect(btn, `true-branch toolbar button for ${messageId} must be attached`).toBeAttached({ timeout: 10000 })
  try {
    await btn.click({ timeout: 8000 })
  } catch {
    await btn.click({ force: true } as any)
  }
}

export async function listBranches(page: any, topicId: string): Promise<any[]> {
  const res: any = await page.evaluate(
    async (tid: string) => (window as any).api.chatDb.listBranches({ topicId: tid }),
    topicId
  )
  expect(res?.ok, `listBranches failed: ${JSON.stringify(res)}`).toBe(true)
  return res.value.branches as any[]
}
