/**
 * S63 — Semantic plural delete (INTEGRATED E2E, real UI).
 *
 * Covers the unified `delete-messages-with-dependents` command end to end:
 * - Real MessageMenubar delete click (`data-testid="message-delete-button"`,
 *   locale-independent; `confirmDeleteMessage=false` so no dialog blocks the
 *   click) on a loaded user target with a window-outside assistant dependent.
 * - The click carries stable root IDs only; Main expands the full user +
 *   same-askId set in one transaction and returns the authority response
 *   (expanded IDs incl. the unloaded dependent, full segment catalog,
 *   previous/remaining user keys, restore groups, affected snapshots).
 * - Renderer converges the loaded intersection from the response (no
 *   injection of the unloaded member), replaces segments from the authority
 *   catalog, and transfers the anchor by previous/remaining keys.
 * - Post-exit SQLite proves no residue of the expanded deletion set in
 *   messages / message_blocks / topic_segment_messages.
 *
 * Partial projection is a DELIBERATE TEST-ONLY disposable Redux removal of
 * exactly one assistant dependent (+ block) before the click: Main/SQLite
 * stay complete, so the test proves authority expansion beyond the window.
 * The test itself issues NO second delete mutation after the click.
 *
 * Evidence boundary: this E2E NEVER counts IPC calls. contextBridge is
 * immutable from page.evaluate, so any monkeypatch of window.api.chatDb
 * cannot intercept the production datasource path and its call counts are
 * invalid evidence. Exactly-once / root-payload / expansion are proven by
 * the repo unit tests (shared contracts, datasource, thunk); E2E proves
 * only known-seed observable state (loaded projection, Redux segments,
 * anchor, read-only Main probes, post-exit SQLite). Read-only APIs allowed
 * here are fetch/getRaw/listSegments — never a second delete.
 *
 * Segment seed intentionally carries NO color: this exercises the
 * segmentToWire no-color omission fix (never `color: undefined`, otherwise
 * the shared JSON walker rejects the envelope as STORAGE_ERROR).
 *
 * Standard fixture, fresh build, disposable profile. The delete path never
 * calls an external provider (no mock provider interaction needed).
 */
import * as fs from 'fs'
import { expect, test } from '../../fixtures/electron.fixture'
import { getChatDbPath, queryChatDbViaElectron } from '../../fixtures/electron.fixture'

async function prepareLargeWindowAndAssistant(page: any): Promise<string> {
  await page.evaluate((limit: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: limit })
  }, 50)
  const displayOk = await page.evaluate(() => (window as any).store.getState().messages.displayCount)
  expect(displayOk).toBe(50)
  const liveAssistantId = await page.evaluate(
    () =>
      (window as any).store.getState().assistants?.assistants?.[0]?.id ??
      (window as any).store.getState().assistants?.defaultAssistant?.id ??
      null
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

test.describe('S63 semantic delete — integrated UI', () => {
  test.setTimeout(180000)

  test('real menu delete expands a window-outside dependent via Main authority', async ({
    mainWindow,
    electronApp
  }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'S63 INTEGRATED UI: deterministic seed (user u1 + assistants a1/a2, user u2, no-color segment [u1,a1,u2]); disposable partial projection removes a2 locally; real delete-button click (data-testid=message-delete-button, confirmDeleteMessage=false) → deleteMessagesWithDependents (roots [u1]); Redux converges loaded intersection (u1/a1 gone, u2 kept, a2 never injected) + segments [u2] + anchor u1→u2; read-only listSegments matches; post-exit SQLite has no deleted residue. No IPC call counting (contextBridge immutable; exactly-once by unit tests).'
    })
    const page = mainWindow
    const liveAssistantId = await prepareLargeWindowAndAssistant(page)
    const topicId = `s63-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const u1 = `${topicId}-u1`
    const a1 = `${topicId}-a1`
    const a2 = `${topicId}-a2`
    const u2 = `${topicId}-u2`
    const segId = `${topicId}-seg1`
    const name = `S63 Delete ${topicId}`

    const mkMsg = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
      id,
      topicId,
      role,
      assistantId: liveAssistantId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: [`${topicId}-block-${id.slice(topicId.length + 1)}`],
      ...extra
    })
    const mkBlock = (ownerId: string) => ({
      id: `${topicId}-block-${ownerId.slice(topicId.length + 1)}`,
      messageId: ownerId,
      type: 'main_text',
      content: `s63-content-${ownerId}`,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
    const entries = [
      { message: mkMsg(u1, 'user'), blocks: [mkBlock(u1)] },
      { message: mkMsg(a1, 'assistant', { askId: u1, model, modelId: 'mock-model' }), blocks: [mkBlock(a1)] },
      { message: mkMsg(a2, 'assistant', { askId: u1, model, modelId: 'mock-model' }), blocks: [mkBlock(a2)] },
      { message: mkMsg(u2, 'user'), blocks: [mkBlock(u2)] }
    ]

    // Seed: Redux topic shell + Main-authoritative rows + one segment.
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
      async ({ topicId, assistantId, name, entries, segId, u1, a1, u2 }: any) => {
        try {
          const api = (window as any).api.chatDb as any
          const ensured = await api.ensureTopic({ topicId, assistantId, name })
          if (!ensured?.ok) return { ok: false, err: `ensureTopic ${JSON.stringify(ensured)}` }
          const pasted = await api.pasteMessagesToTopic({ topicId, entries })
          if (!pasted?.ok) return { ok: false, err: `paste ${JSON.stringify(pasted)}` }
          const seg = await api.upsertSegment({ segmentId: segId, topicId, name: 's63-seg', messageIds: [u1, a1, u2] })
          if (!seg?.ok) return { ok: false, err: `segment ${JSON.stringify(seg)}` }
          return { ok: true }
        } catch (e) {
          return { ok: false, err: e instanceof Error ? e.message : String(e) }
        }
      },
      { topicId, assistantId: liveAssistantId, name, entries, segId, u1, a1, u2 }
    )
    expect(persist.ok, `persist failed: ${(persist as any).err}`).toBe(true)

    await activateTopicAndWaitForBootstrap(page, topicId, 4)

    // Segment must be projected before the click so the replace assertion is meaningful.
    await page.waitForFunction(
      ({ topicId, segId }: { topicId: string; segId: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.topicSegments?.segmentsByTopic?.[topicId] ?? []
        return ids.includes(segId)
      },
      { topicId, segId },
      { timeout: 30000 }
    )

    // DELIBERATE TEST-ONLY DISPOSABLE PROJECTION — not product behavior.
    // Remove exactly one assistant dependent (a2) + its companion block from
    // Redux slices only, so the click target (u1) stays loaded while Main
    // still owns the complete user + a1/a2 set. Must not mutate resident
    // registry, segments, generation, or SQLite.
    const a2BlockId: string = await page.evaluate(
      ({ missingId }: { missingId: string }) => {
        const msg = (window as any).store.getState().messages?.entities?.[missingId] as any
        return (Array.isArray(msg?.blocks) && msg.blocks.length > 0 ? msg.blocks[0] : null) as string
      },
      { missingId: a2 }
    )
    expect(a2BlockId, 'a2 companion block must exist').toBeTruthy()
    await page.evaluate(
      ({ topicId, missingId, missingBlockId }: { topicId: string; missingId: string; missingBlockId: string }) => {
        const store = (window as any).store
        store.dispatch({ type: 'newMessages/removeMessages', payload: { topicId, messageIds: [missingId] } })
        store.dispatch({ type: 'messageBlocks/removeManyBlocks', payload: [missingBlockId] })
      },
      { topicId, missingId: a2, missingBlockId: a2BlockId }
    )
    const partial = await page.evaluate(
      ({ topicId, missingId }: { topicId: string; missingId: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        return { count: ids.length, hasMissing: ids.includes(missingId) }
      },
      { topicId, missingId: a2 }
    )
    expect(partial.hasMissing).toBe(false)
    expect(partial.count).toBe(3)
    // Main still owns all 4 despite the disposable local removal.
    const mainComplete: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.getRawTopic({ topicId })
      },
      { topicId }
    )
    expect(mainComplete.ok).toBe(true)
    expect((mainComplete.value?.messages ?? []).map((m: any) => m.id).sort()).toEqual([u1, a1, a2, u2].sort())

    // Test setup via store (not product behavior): disable the confirm dialog
    // so the click reaches the semantic command directly, and pin the anchor
    // to the doomed first group to prove authority-key transfer u1→u2.
    await page.evaluate(
      ({ assistantId, topicId, u1 }: { assistantId: string; topicId: string; u1: string }) => {
        const store = (window as any).store
        store.dispatch({ type: 'settings/setConfirmDeleteMessage', payload: false })
        store.dispatch({
          type: 'assistants/updateAssistantSettings',
          payload: { assistantId, settings: { contextWindowAnchor: { [topicId]: { kind: 'active', groupKey: u1 } } } }
        })
      },
      { assistantId: liveAssistantId, topicId, u1 }
    )

    // No bridge monkeypatch: contextBridge is immutable, so call counting
    // here would be invalid evidence. The real UI click below is the only
    // delete mutation; exactly-once is proven by unit tests.

    // Real UI: hover the user target, click its menubar delete button.
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const container = page.locator(`[id="message-${esc(u1)}"][data-message-id="${esc(u1)}"]`).first()
    await expect(container, `message container ${u1} must be visible`).toBeVisible({ timeout: 15000 })
    await page.evaluate((id: string) => {
      const e = typeof CSS !== 'undefined' && (CSS as any).escape ? (CSS as any).escape(id) : id
      const el = document.querySelector(`[id="message-${e}"][data-message-id="${e}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    }, u1)
    try {
      await container.hover({ timeout: 8000 })
    } catch {
      // Menubar buttons are also reachable without a settled hover in most layouts.
    }
    const deleteBtn = container.locator('[data-testid="message-delete-button"]')
    await expect(deleteBtn, 'locale-independent delete button must be attached').toBeAttached({ timeout: 10000 })
    await deleteBtn.click({ timeout: 10000 })

    // Redux converges the loaded intersection: u1 + loaded a1 gone, u2 stays,
    // and the unloaded a2 is NOT injected.
    await page.waitForFunction(
      ({ topicId, u1, a1, a2, u2 }: Record<string, string>) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        const entities: Record<string, any> = s.messages?.entities ?? {}
        return !ids.includes(u1) && !ids.includes(a1) && !ids.includes(a2) && ids.includes(u2) && !entities[a2]
      },
      { topicId, u1, a1, a2, u2 },
      { timeout: 30000 }
    )

    // Known-seed observable state (no recorded response): the loaded
    // projection initially dropped a2, so after the real click a2 must still
    // be absent (never injected); the loaded intersection u1/a1 is gone and
    // u2 is retained. Authority expansion beyond the loaded member (a2) is
    // jointly proven by a2 never being loaded here + SQLite proving a2 rows
    // are gone below. Expanded IDs / exactly-once / root payload are proven
    // by shared/datasource/thunk unit tests, not by E2E monkeypatch.
    const loadedAfter: any = await page.evaluate(
      ({ topicId, u1, a1, a2, u2 }: Record<string, string>) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.messages?.messageIdsByTopic?.[topicId] ?? []
        const entities: Record<string, any> = s.messages?.entities ?? {}
        return {
          ids: [...ids],
          hasU1: ids.includes(u1),
          hasA1: ids.includes(a1),
          hasA2: ids.includes(a2),
          hasU2: ids.includes(u2),
          entityA2: !!entities[a2]
        }
      },
      { topicId, u1, a1, a2, u2 }
    )
    expect(loadedAfter.hasU1).toBe(false)
    expect(loadedAfter.hasA1).toBe(false)
    expect(loadedAfter.hasA2).toBe(false)
    expect(loadedAfter.entityA2).toBe(false)
    expect(loadedAfter.hasU2).toBe(true)

    // Seed was [u1,a1,u2]; deleting roots [u1] must leave exactly [u2] with
    // the same segment id/name (observable Redux projection).
    const reduxSegments: any = await page.evaluate(
      ({ topicId }: { topicId: string }) => {
        const s = (window as any).store.getState()
        const ids: string[] = s.topicSegments?.segmentsByTopic?.[topicId] ?? []
        const entities: Record<string, any> = s.topicSegments?.segments?.entities ?? {}
        return ids.map((id) => ({ id, name: entities[id]?.name ?? null, messageIds: entities[id]?.messageIds ?? null }))
      },
      { topicId }
    )
    expect(reduxSegments).toHaveLength(1)
    expect(reduxSegments[0].id).toBe(segId)
    expect(reduxSegments[0].name).toBe('s63-seg')
    expect(reduxSegments[0].messageIds).toEqual([u2])

    // READ-ONLY Main probe (no second delete): authority segment catalog
    // must match the Redux projection.
    const segsProbe: any = await page.evaluate(
      async ({ topicId }: { topicId: string }) => {
        const api: any = (window as any).api.chatDb
        return await api.listSegments({ topicId })
      },
      { topicId }
    )
    expect(segsProbe.ok).toBe(true)
    expect((segsProbe.value as any[]).map((sg: any) => ({ id: sg.id, messageIds: sg.messageIds }))).toEqual([
      { id: segId, messageIds: [u2] }
    ])

    // Anchor transfers by authority keys: doomed first group u1 → new first u2.
    const anchorKey: any = await page.evaluate(
      ({ assistantId, topicId }: { assistantId: string; topicId: string }) => {
        const s = (window as any).store.getState()
        const asst = (s.assistants?.assistants ?? []).find((a: any) => a.id === assistantId)
        return asst?.settings?.contextWindowAnchor?.[topicId]?.groupKey ?? null
      },
      { assistantId: liveAssistantId, topicId }
    )
    expect(anchorKey).toBe(u2)

    // Post-exit SQLite authority probe: no residue of the expanded set.
    await electronApp.close()
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
    const q = (v: string) => v.replace(/'/g, "''")
    const inList = [u1, a1, a2].map((v) => `'${q(v)}'`).join(',')
    const msgRows = await pollDbUntil(
      dbPath!,
      `SELECT id FROM messages WHERE topic_id = '${q(topicId)}'`,
      (rows) => rows.length === 1 && rows[0].id === u2
    )
    expect(msgRows.map((r: any) => r.id)).toEqual([u2])
    const blockRows = await pollDbUntil(
      dbPath!,
      `SELECT id FROM message_blocks WHERE message_id IN (${inList})`,
      (rows) => rows.length === 0
    )
    expect(blockRows).toEqual([])
    const segRows = await pollDbUntil(
      dbPath!,
      `SELECT message_id FROM topic_segment_messages WHERE segment_id = '${q(segId)}'`,
      (rows) => rows.length === 1 && rows[0].message_id === u2
    )
    expect(segRows.map((r: any) => r.message_id)).toEqual([u2])
    const segGone = await pollDbUntil(
      dbPath!,
      `SELECT message_id FROM topic_segment_messages WHERE message_id IN (${inList})`,
      (rows) => rows.length === 0
    )
    expect(segGone).toEqual([])
  })
})
