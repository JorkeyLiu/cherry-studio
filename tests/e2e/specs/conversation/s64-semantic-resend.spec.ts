/**
 * S64 — Semantic resend/regenerate (AUTHORED, NOT RUN).
 *
 * Two real-UI scenarios over Main authority (no contextBridge counting):
 * 1) Resend full group: authority user u1 + assistants a1/a2 (same askId);
 *    disposable Redux removal makes a2 window-outside; real click on the user
 *    container `msg-regenerate-btn` (confirm false). Both executions are
 *    proven by waiting for exactly 2 new mock product requests after the
 *    captured sequence (queue is serial, 90s timeout), each request's
 *    `messages` structurally containing a `{role:'user'}` entry whose content
 *    includes the authority user raw text. a1 completion is awaited in Redux;
 *    a2 completion is awaited via the read-only `fetchMessages` authority
 *    probe (a2 is never in Redux). Redux asserts a2 stays absent from ids and
 *    entities while a1 is visible success. Post-exit SQLite proves a1/a2
 *    final success, old assistant blocks deleted, and exactly 2
 *    `sync_resend_attempt` rows (ask_id=u1, removed_block_ids_json holding
 *    each member's old block).
 * 2) Regenerate with missing user projection: selected assistant carries a
 *    truthy modelId; disposable Redux removal of u1 + its block; real click
 *    on the assistant container `msg-regenerate-btn`. One new product request
 *    is awaited and structurally asserted to carry the authority user raw
 *    content as a `{role:'user'}` message (not a JSON-stringify rough match).
 *    No missing-user failure is proven by request-occurred + assistant
 *    completed-success (no i18n-key text assertion). Redux asserts u1 is
 *    never injected. Post-exit SQLite proves a1 final success, one attempt
 *    row (ask_id=u1, removed block holds the old assistant block), and the
 *    authority user + old user block still exist (projection-only removal
 *    deletes nothing).
 *
 * The regenerate self-modelId omit path (no configured assistant model) is
 * covered by shared/Main/renderer unit tests; this spec keeps the live
 * assistant model intact.
 *
 * Evidence boundary: NEVER counts IPC calls (contextBridge immutable).
 * Seed/read-only probes only: ensureTopic/pasteMessagesToTopic,
 * getRawTopic/fetchMessages. No second mutation after the click. Each test
 * closes the app explicitly (S62/S63 pattern) before post-exit SQLite.
 */
import * as fs from 'fs'
import {
  expect,
  findProductRequestAfter,
  getRequestLog,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { getChatDbPath, queryChatDbViaElectron } from '../../fixtures/electron.fixture'

async function prepareWindow(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, 50)
  const liveAssistantId = await page.evaluate(
    () =>
      (window as any).store.getState().assistants?.assistants?.[0]?.id ??
      (window as any).store.getState().assistants?.defaultAssistant?.id ??
      null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

async function activateTopic(page: any, topicId: string, atLeast: number): Promise<void> {
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
}

function isProductRequest(entry: any): boolean {
  return entry?.method === 'POST' && (entry?.url === '/v1/chat/completions' || entry?.url === '/chat/completions')
}

function productRequestsAfter(seqBefore: number): any[] {
  return getRequestLog().filter((e: any) => isProductRequest(e) && e.sequence >= seqBefore)
}

/** Structured user-content check: a {role:'user'} message containing the raw text. */
function requestCarriesAuthorityUser(entry: any, raw: string): boolean {
  const messages = (entry?.parsed as any)?.messages
  if (!Array.isArray(messages)) return false
  return messages.some((m: any) => {
    if (!m || m.role !== 'user') return false
    const c = m.content
    if (typeof c === 'string') return c.includes(raw)
    if (Array.isArray(c)) {
      return c.some((p: any) => typeof p?.text === 'string' && p.text.includes(raw))
    }
    return false
  })
}

async function pollDbUntil(
  dbPath: string,
  sql: string,
  validate: (rows: any[]) => boolean,
  timeoutMs = 30000
): Promise<any[]> {
  let captured: any[] | null = null
  await expect
    .poll(
      () => {
        const res = queryChatDbViaElectron(dbPath, sql)
        if (!res.ok) return null
        const rows = (res as any).rows as any[]
        if (!Array.isArray(rows)) return null
        if (!validate(rows)) return null
        captured = rows
        return rows
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] }
    )
    .not.toBeNull()
  return captured!
}

test.describe('S64 semantic resend/regenerate — authored not run', () => {
  test.setTimeout(180000)

  test('resend expands a window-outside group member via authority without injection', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'S64 AUTHORED NOT RUN: seed u1+a1/a2 (askId u1); disposable Redux removal of a2; real user-container msg-regenerate-btn click (confirmRegenerateMessage=false); exactly 2 new mock product requests each structurally carrying the authority user content; a1 Redux success + a2 authority success via read-only fetchMessages; a2 never in Redux ids/entities; post-exit SQLite a1/a2 success, old assistant blocks gone, 2 sync_resend_attempt rows (ask_id=u1, removed ids match).'
    })
    const page = mainWindow
    const liveAssistantId = await prepareWindow(page)
    const topicId = `s64-resend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const u1 = `${topicId}-u1`
    const a1 = `${topicId}-a1`
    const a2 = `${topicId}-a2`
    const authorityContent = 's64-authority-user-raw-content'
    const userBlockId = `${topicId}-block-u1`
    const oldA1BlockId = `${topicId}-block-a1`
    const oldA2BlockId = `${topicId}-block-a2`
    const mkMsg = (id: string, role: string, blockId: string, extra: Record<string, unknown> = {}) => ({
      id,
      topicId,
      role,
      assistantId: liveAssistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      ...extra
    })
    const mkBlock = (id: string, ownerId: string, content: string) => ({
      id,
      messageId: ownerId,
      type: 'main_text',
      content,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' }
    const entries = [
      { message: mkMsg(u1, 'user', userBlockId), blocks: [mkBlock(userBlockId, u1, authorityContent)] },
      {
        message: mkMsg(a1, 'assistant', oldA1BlockId, { askId: u1, model, modelId: 'mock-model' }),
        blocks: [mkBlock(oldA1BlockId, a1, 'old-a1')]
      },
      {
        message: mkMsg(a2, 'assistant', oldA2BlockId, { askId: u1, model, modelId: 'mock-model' }),
        blocks: [mkBlock(oldA2BlockId, a2, 'old-a2')]
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
      { topicId, assistantId: liveAssistantId, name: `S64 Resend ${topicId}` }
    )
    const persist = await page.evaluate(
      async ({ topicId, assistantId, name, entries }: any) => {
        try {
          const api = (window as any).api.chatDb as any
          const e = await api.ensureTopic({ topicId, assistantId, name })
          if (!e?.ok) return { ok: false, err: `ensure ${JSON.stringify(e)}` }
          const p = await api.pasteMessagesToTopic({ topicId, entries })
          if (!p?.ok) return { ok: false, err: `paste ${JSON.stringify(p)}` }
          return { ok: true }
        } catch (err) {
          return { ok: false, err: err instanceof Error ? err.message : String(err) }
        }
      },
      { topicId, assistantId: liveAssistantId, name: `S64 Resend ${topicId}`, entries }
    )
    expect(persist.ok).toBe(true)
    await activateTopic(page, topicId, 3)
    await page.evaluate(() => {
      const store = (window as any).store
      store.dispatch({ type: 'settings/setConfirmRegenerateMessage', payload: false })
    })
    // Fallback-path precondition (shape-only, no content): the live assistant
    // carries no own model, so the user-resend effective model below must
    // resolve via the seeded global llm.defaultModel. The seed itself is
    // untouched — this only proves which fallback slot the click exercises.
    const fallbackPre = await page.evaluate(() => {
      const s = (window as any).store.getState()
      const live = s.assistants?.assistants?.[0]
      const global = s.llm?.defaultModel
      const complete = (m: any) =>
        !!m &&
        typeof m.id === 'string' &&
        m.id.length > 0 &&
        typeof m.provider === 'string' &&
        m.provider.length > 0 &&
        typeof m.name === 'string' &&
        m.name.length > 0 &&
        typeof m.group === 'string' &&
        m.group.length > 0
      return { ownAbsent: live?.model == null, globalComplete: complete(global) }
    })
    expect(fallbackPre.ownAbsent).toBe(true)
    expect(fallbackPre.globalComplete).toBe(true)
    // DELIBERATE TEST-ONLY DISPOSABLE PROJECTION: remove a2 + block from
    // Redux only; Main/SQLite stay complete.
    await page.evaluate(
      ({ topicId, missingId, missingBlockId }: { topicId: string; missingId: string; missingBlockId: string }) => {
        const store = (window as any).store
        store.dispatch({ type: 'newMessages/removeMessages', payload: { topicId, messageIds: [missingId] } })
        store.dispatch({ type: 'messageBlocks/removeManyBlocks', payload: [missingBlockId] })
      },
      { topicId, missingId: a2, missingBlockId: oldA2BlockId }
    )
    const seqBefore = getRequestSequence()
    // Pre-click baseline: prove reset→final actually happened after the
    // click (seed status is already `success`, so a bare success wait is
    // vacuous). The first non-vacuous signal is new product requests;
    // updatedAt/blocks change is asserted after completion.
    const a1Before = await page.evaluate(
      ({ a1 }: { a1: string }) => {
        const m = (window as any).store.getState().messages?.entities?.[a1] as any
        return { updatedAt: m?.updatedAt as string | undefined, blocks: [...(m?.blocks ?? [])] as string[] }
      },
      { a1 }
    )
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const container = page.locator(`[id="message-${esc(u1)}"][data-message-id="${esc(u1)}"]`).first()
    await expect(container).toBeVisible({ timeout: 15000 })
    try {
      await container.hover({ timeout: 8000 })
    } catch {}
    await container.locator('[data-testid="msg-regenerate-btn"]').click({ timeout: 10000 })
    // Both executions happened: exactly 2 new product requests (queue serial).
    // This poll runs FIRST so the later success wait proves the reset→final
    // transition rather than the seeded `success` value.
    await expect
      .poll(() => productRequestsAfter(seqBefore).length, { timeout: 90000, intervals: [500, 1000, 2000] })
      .toBe(2)
    // Loaded visible execution completes via the mock provider.
    await page.waitForFunction(
      ({ a1 }: { a1: string }) => {
        const m = (window as any).store.getState().messages?.entities?.[a1] as any
        return m?.status === 'success' || m?.status === 'error'
      },
      { a1 },
      { timeout: 90000 }
    )
    // Reset→final proof: the execution rewrote a1 (updatedAt advanced and
    // the stale seed block is gone from the loaded projection).
    const a1After = await page.evaluate(
      ({ a1, oldBlockId }: { a1: string; oldBlockId: string }) => {
        const s = (window as any).store.getState()
        const m = s.messages?.entities?.[a1] as any
        return {
          updatedAt: m?.updatedAt as string | undefined,
          blocks: [...(m?.blocks ?? [])] as string[],
          oldBlockLoaded: !!s.messageBlocks?.entities?.[oldBlockId]
        }
      },
      { a1, oldBlockId: oldA1BlockId }
    )
    expect(a1After.oldBlockLoaded).toBe(false)
    expect(a1After.blocks).not.toContain(oldA1BlockId)
    if (a1Before.updatedAt && a1After.updatedAt) {
      expect(a1After.updatedAt >= a1Before.updatedAt).toBe(true)
    }
    const reqs = productRequestsAfter(seqBefore)
    expect(reqs).toHaveLength(2)
    for (const req of reqs) {
      expect(requestCarriesAuthorityUser(req, authorityContent)).toBe(true)
    }
    // First-request cross-check via the sequence API.
    expect(findProductRequestAfter(seqBefore)).not.toBeNull()
    // a1 visible success in Redux.
    const a1State = await page.evaluate(
      ({ a1 }: { a1: string }) => {
        return (window as any).store.getState().messages?.entities?.[a1] as any
      },
      { a1 }
    )
    expect(a1State?.status).toBe('success')
    // Window-outside member completes in Main authority (read-only probe).
    await expect
      .poll(
        async () => {
          const r: any = await page.evaluate(
            async ({ topicId }: { topicId: string }) => {
              const api: any = (window as any).api.chatDb
              return await api.fetchMessages({ topicId })
            },
            { topicId }
          )
          if (!r?.ok) return null
          const m = ((r.value?.messages ?? []) as any[]).find((x: any) => x.id === a2)
          return m?.status ?? null
        },
        { timeout: 60000, intervals: [500, 1000] }
      )
      .toBe('success')
    // a2 never injected into the loaded projection.
    const loadedAfter = await page.evaluate(
      ({ topicId, a1, a2 }: { topicId: string; a1: string; a2: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        const entities: Record<string, any> = s.messages?.entities ?? {}
        return { ids: [...ids], hasA1: ids.includes(a1), hasA2: ids.includes(a2), entityA2: !!entities[a2] }
      },
      { topicId, a1, a2 }
    )
    expect(loadedAfter.hasA1).toBe(true)
    expect(loadedAfter.hasA2).toBe(false)
    expect(loadedAfter.entityA2).toBe(false)
    // Post-exit SQLite authority probe.
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const q = (v: string) => v.replace(/'/g, "''")
    const msgRows = await pollDbUntil(
      dbPath!,
      `SELECT id, status FROM messages WHERE topic_id = '${q(topicId)}' AND id IN ('${q(a1)}','${q(a2)}')`,
      (rows) => rows.length === 2
    )
    for (const row of msgRows) {
      expect((row as any).status).toBe('success')
    }
    expect(msgRows.map((r: any) => r.id).sort()).toEqual([a1, a2].sort())
    // Old seed blocks replaced by new final blocks.
    const goneBlocks = await pollDbUntil(
      dbPath!,
      `SELECT id FROM message_blocks WHERE id IN ('${q(oldA1BlockId)}','${q(oldA2BlockId)}')`,
      (rows) => rows.length === 0
    )
    expect(goneBlocks).toEqual([])
    // Exactly 2 execution attempt rows, one per member.
    const attemptRows = await pollDbUntil(
      dbPath!,
      `SELECT message_id, ask_id, removed_block_ids_json FROM sync_resend_attempt WHERE topic_id = '${q(topicId)}'`,
      (rows) => rows.length === 2
    )
    expect(attemptRows.map((r: any) => r.message_id).sort()).toEqual([a1, a2].sort())
    for (const row of attemptRows) {
      expect((row as any).ask_id).toBe(u1)
    }
    const removedByMsg = new Map<string, string[]>(
      attemptRows.map((r: any) => [r.message_id as string, JSON.parse(r.removed_block_ids_json as string) as string[]])
    )
    expect(removedByMsg.get(a1)).toContain(oldA1BlockId)
    expect(removedByMsg.get(a2)).toContain(oldA2BlockId)
  })

  test('regenerate with window-outside user uses authority snapshot without injection', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'S64 AUTHORED NOT RUN: seed u1+a1 (assistant carries truthy modelId); disposable Redux removal of u1+user block; real assistant-container msg-regenerate-btn click; exactly 1 new product request structurally carrying the authority user raw content as {role:user}; a1 completes success; u1 never injected; post-exit SQLite a1 success + 1 attempt row (ask_id=u1, removed holds old assistant block) with authority user and old user block still present.'
    })
    const page = mainWindow
    const liveAssistantId = await prepareWindow(page)
    const topicId = `s64-regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const u1 = `${topicId}-u1`
    const a1 = `${topicId}-a1`
    const authorityContent = 's64-authority-user-raw-content'
    const userBlockId = `${topicId}-block-u1`
    const oldA1BlockId = `${topicId}-block-a1`
    const mkMsg = (id: string, role: string, blockId: string, extra: Record<string, unknown> = {}) => ({
      id,
      topicId,
      role,
      assistantId: liveAssistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [blockId],
      ...extra
    })
    const mkBlock = (id: string, ownerId: string, content: string) => ({
      id,
      messageId: ownerId,
      type: 'main_text',
      content,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' }
    const entries = [
      { message: mkMsg(u1, 'user', userBlockId), blocks: [mkBlock(userBlockId, u1, authorityContent)] },
      {
        message: mkMsg(a1, 'assistant', oldA1BlockId, { askId: u1, model, modelId: 'mock-model' }),
        blocks: [mkBlock(oldA1BlockId, a1, 'old-a1')]
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
      { topicId, assistantId: liveAssistantId, name: `S64 Regen ${topicId}` }
    )
    const persist = await page.evaluate(
      async ({ topicId, assistantId, name, entries }: any) => {
        const api = (window as any).api.chatDb as any
        const e = await api.ensureTopic({ topicId, assistantId, name })
        if (!e?.ok) return { ok: false }
        const p = await api.pasteMessagesToTopic({ topicId, entries })
        if (!p?.ok) return { ok: false }
        return { ok: true }
      },
      { topicId, assistantId: liveAssistantId, name: `S64 Regen ${topicId}`, entries }
    )
    expect(persist.ok).toBe(true)
    await activateTopic(page, topicId, 2)
    await page.evaluate(() => {
      const store = (window as any).store
      store.dispatch({ type: 'settings/setConfirmRegenerateMessage', payload: false })
    })
    // DELIBERATE TEST-ONLY DISPOSABLE PROJECTION: remove u1 + block from
    // Redux only; Main/SQLite stay complete (no deletion).
    await page.evaluate(
      ({ topicId, uid, blockId }: { topicId: string; uid: string; blockId: string }) => {
        const store = (window as any).store
        store.dispatch({ type: 'newMessages/removeMessages', payload: { topicId, messageIds: [uid] } })
        store.dispatch({ type: 'messageBlocks/removeManyBlocks', payload: [blockId] })
      },
      { topicId, uid: u1, blockId: userBlockId }
    )
    const seqBefore = getRequestSequence()
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const container = page.locator(`[id="message-${esc(a1)}"][data-message-id="${esc(a1)}"]`).first()
    await expect(container).toBeVisible({ timeout: 15000 })
    try {
      await container.hover({ timeout: 8000 })
    } catch {}
    await container.locator('[data-testid="msg-regenerate-btn"]').click({ timeout: 10000 })
    // Exactly one new product request carrying the authority user content
    // as a structured {role:'user'} message (missing-user path sends none).
    await expect
      .poll(() => productRequestsAfter(seqBefore).length, { timeout: 90000, intervals: [500, 1000, 2000] })
      .toBe(1)
    const reqs = productRequestsAfter(seqBefore)
    expect(reqs).toHaveLength(1)
    expect(requestCarriesAuthorityUser(reqs[0], authorityContent)).toBe(true)
    expect(findProductRequestAfter(seqBefore)).not.toBeNull()
    // Assistant completes success (no missing-user failure).
    await page.waitForFunction(
      ({ a1 }: { a1: string }) => {
        const m = (window as any).store.getState().messages?.entities?.[a1] as any
        return m?.status === 'success'
      },
      { a1 },
      { timeout: 90000 }
    )
    // Authority user never injected into Redux.
    const userInjected = await page.evaluate(
      ({ topicId, uid }: { topicId: string; uid: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        return ids.includes(uid) || !!s.messages?.entities?.[uid]
      },
      { topicId, uid: u1 }
    )
    expect(userInjected, 'authority user must not be injected into Redux').toBe(false)
    // Post-exit SQLite authority probe.
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const q = (v: string) => v.replace(/'/g, "''")
    const a1Rows = await pollDbUntil(
      dbPath!,
      `SELECT id, status FROM messages WHERE topic_id = '${q(topicId)}' AND id = '${q(a1)}'`,
      (rows) => rows.length === 1
    )
    expect((a1Rows[0] as any).status).toBe('success')
    const attemptRows = await pollDbUntil(
      dbPath!,
      `SELECT message_id, ask_id, removed_block_ids_json FROM sync_resend_attempt WHERE topic_id = '${q(topicId)}'`,
      (rows) => rows.length === 1
    )
    expect((attemptRows[0] as any).message_id).toBe(a1)
    expect((attemptRows[0] as any).ask_id).toBe(u1)
    expect(JSON.parse((attemptRows[0] as any).removed_block_ids_json as string) as string[]).toContain(oldA1BlockId)
    // Authority user and its old block survive (projection-only removal).
    const userRows = await pollDbUntil(
      dbPath!,
      `SELECT id, status FROM messages WHERE topic_id = '${q(topicId)}' AND id = '${q(u1)}'`,
      (rows) => rows.length === 1
    )
    expect((userRows[0] as any).status).toBe('success')
    const userBlockRows = await pollDbUntil(
      dbPath!,
      `SELECT id FROM message_blocks WHERE id = '${q(userBlockId)}'`,
      (rows) => rows.length === 1
    )
    expect((userBlockRows[0] as any).id).toBe(userBlockId)
    const oldABlockGone = await pollDbUntil(
      dbPath!,
      `SELECT id FROM message_blocks WHERE id = '${q(oldA1BlockId)}'`,
      (rows) => rows.length === 0
    )
    expect(oldABlockGone).toEqual([])
  })
})
