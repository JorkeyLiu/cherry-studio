/**
 * Phase 5.4 multi-model assistant append and answer-group authority reorder.
 *
 * Evidence classes:
 *   - UI interaction: assistant menubar model action, model popup selection,
 *     and real dnd-kit sortable drag
 *   - Product request: local mock server request body and selected model
 *   - SQLite persistence: exact message IDs and sort_order before/after reload
 *     and after Electron shutdown
 *   - Redux projection: loaded ID set is permuted, never injected
 *
 * LOCK-001: The second response is created through the production UI action and
 * local mock request path; no Redux response fabrication is used.
 * LOCK-002: Reorder uses the production dnd-kit control, which invokes
 * reorderMessageGroupThunk (semantic `chatdb:reorder-answer-group` command);
 * no reducer action is dispatched by this spec.
 * LOCK-003: Exact assistant IDs, request model/body, and SQLite order are asserted.
 * LOCK-004: The shared fixture owns a disposable profile and cleanup.
 * LOCK-005: This spec does not modify ordinary-chat/topic lifecycle coverage.
 * LOCK-006: displayCount is explicitly set to 10 via the existing
 * `newMessages/setDisplayCount` store action and verified by readback before
 * seeding; foldDisplayMode is pinned to expanded. The target topic is
 * pre-seeded through Main authority (ensureTopic + pasteMessagesToTopic,
 * 6 rounds = 12 authority rows / 12 viewport groups) while inactive, then
 * first cold activation builds the real loaded projection (loaded < authority).
 * UI append adds one assistant (+1 = 13 authority rows) with the tail answer
 * group fully loaded. Assertions prove only the group authority slots move
 * in SQLite, group-outside order is untouched, and Redux never injects
 * window-outside entities.
 */
import * as fs from 'fs'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getChatDbPath,
  getRequestSequence,
  queryChatDbViaElectron,
  queryChatDbViaElectronWithRetry,
  test
} from '../../fixtures/electron.fixture'

type Page = import('@playwright/test').Page

/** Window size locked for this spec: 6 seed rounds (12 rows) + 1 append (14 rows) > 10. */
const DISPLAY_COUNT = 10

/** Set displayCount via the existing store action and verify by readback (S62/S63 pattern). */
async function ensureDisplayCount(page: Page, limit: number): Promise<void> {
  await page.evaluate((value: number) => {
    const store = (window as any).store
    store.dispatch({ type: 'newMessages/setDisplayCount', payload: value })
  }, limit)
  const displayOk = await page.evaluate(() => (window as any).store.getState().messages.displayCount)
  expect(displayOk).toBe(limit)
}

/**
 * Pin foldDisplayMode to 'expanded' via the existing settings action and verify
 * by readback. Expanded mode renders both group members as full-width segmented
 * items (both visible targets for the dnd-kit drag); compact mode renders
 * overlapping avatars with negative margins, which is unsuitable for dragging.
 */
async function ensureExpandedFoldMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as any).store
    store.dispatch({ type: 'settings/setFoldDisplayMode', payload: 'expanded' })
  })
  const foldOk = await page.evaluate(() => (window as any).store.getState().settings.foldDisplayMode)
  expect(foldOk).toBe('expanded')
}

/**
 * Test-side mirror of production `deriveStableGroupId`
 * (src/renderer/src/pages/home/Messages/messageRenderLayers.ts): length-prefix
 * each id as `${id.length}:${id}`, joined by `|`. The E2E bundle cannot import
 * the renderer module, so the algorithm is mirrored here and the spec asserts
 * the rendered `data-stable-group-id` attribute equals the mirrored value,
 * which fail-closes on any production algorithm drift.
 */
function deriveStableGroupIdMirror(ids: readonly string[]): string {
  if (ids.length === 0) return 'group:empty'
  return ids.map((id) => `${id.length}:${id}`).join('|')
}

async function getLiveAssistantId(page: Page): Promise<string> {
  const liveAssistantId = await page.evaluate(
    () =>
      (window as any).store.getState().assistants?.assistants?.[0]?.id ??
      (window as any).store.getState().assistants?.defaultAssistant?.id ??
      null
  )
  expect(liveAssistantId, 'live assistant id must exist').toBeTruthy()
  return liveAssistantId as string
}

function padSeedIndex(n: number): string {
  return String(n).padStart(5, '0')
}

/** 6 user/assistant rounds = 12 messages / 12 viewport groups, deterministic order. */
function buildSeedEntries(
  topicId: string,
  assistantId: string
): Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> {
  const entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> = []
  const stamp = '2026-01-01T00:00:00.000Z'
  for (let round = 0; round < 6; round++) {
    const userIndex = round * 2
    const assistantIndex = round * 2 + 1
    const userId = `${topicId}-msg-${padSeedIndex(userIndex)}`
    const assistantMsgId = `${topicId}-msg-${padSeedIndex(assistantIndex)}`
    const userBlockId = `${userId}-block`
    const assistantBlockId = `${assistantMsgId}-block`
    entries.push({
      message: {
        id: userId,
        topicId,
        role: 'user',
        assistantId,
        createdAt: stamp,
        updatedAt: stamp,
        status: 'success',
        blocks: [userBlockId],
        sortOrder: userIndex
      },
      blocks: [
        {
          id: userBlockId,
          messageId: userId,
          type: 'main_text',
          content: `mmr-seed-user-${round}`,
          status: 'success',
          createdAt: stamp,
          updatedAt: stamp
        }
      ]
    })
    entries.push({
      message: {
        id: assistantMsgId,
        topicId,
        role: 'assistant',
        assistantId,
        createdAt: stamp,
        updatedAt: stamp,
        status: 'success',
        blocks: [assistantBlockId],
        sortOrder: assistantIndex,
        askId: userId,
        model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' },
        modelId: 'mock-model'
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantMsgId,
          type: 'main_text',
          content: `mmr-seed-assistant-${round}`,
          status: 'success',
          createdAt: stamp,
          updatedAt: stamp
        }
      ]
    })
  }
  return entries
}

/**
 * Create the target topic while it is NOT active (no click), then pre-seed
 * 6 rounds through Main authority. Mirrors the S62 addTopic + ensureTopic +
 * pasteMessagesToTopic pattern.
 */
async function seedTargetTopicViaMainAuthority(
  page: Page,
  liveAssistantId: string,
  topicId: string,
  topicName: string,
  entries: Array<{ message: Record<string, unknown>; blocks: Array<Record<string, unknown>> }>
): Promise<void> {
  const addOk = await page.evaluate(
    ({ topicId, assistantId, name }: { topicId: string; assistantId: string; name: string }) => {
      try {
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
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) }
      }
    },
    { topicId, assistantId: liveAssistantId, name: topicName }
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
    { topicId, assistantId: liveAssistantId, name: topicName, entries }
  )
  expect(persist.ok, `Main authority seed failed: ${(persist as any).err}`).toBe(true)
  console.log(`[E2E] Main authority pre-seed complete topic=${topicId} entries=${entries.length}`)
}

/** Read-only Main authority order via getRawTopic (no Redux mutation). */
async function getAuthorityIds(page: Page, topicId: string): Promise<string[]> {
  const raw: any = await page.evaluate(
    async ({ topicId }: { topicId: string }) => {
      const api: any = (window as any).api.chatDb
      return await api.getRawTopic({ topicId })
    },
    { topicId }
  )
  expect(raw?.ok, `getRawTopic failed for ${topicId}`).toBe(true)
  const messages: any[] = raw?.value?.messages ?? []
  return messages.map((m: any) => m.id as string)
}

/**
 * First cold activation of the inactive target topic: click once, then wait
 * for loading complete, tail group loaded, and loaded < authority. Never
 * touches removeMessages or messageIdsByTopic directly.
 */
async function activateTargetTopicAndWaitForColdWindow(
  page: Page,
  topicId: string,
  tailSeedId: string,
  authorityCount: number
): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()
  console.log(`[E2E] First cold activation topic=${topicId} tail=${tailSeedId} authority=${authorityCount}`)
  await page.waitForFunction(
    ({
      topicId,
      tailId,
      authorityCount,
      minLoaded
    }: {
      topicId: string
      tailId: string
      authorityCount: number
      minLoaded: number
    }) => {
      const s = (window as any).store.getState()
      const ids = s.messages?.messageIdsByTopic?.[topicId]
      const loading = s.messages?.loadingByTopic?.[topicId]
      if (!Array.isArray(ids)) return false
      if (loading === true) return false
      if (!ids.includes(tailId)) return false
      if (ids.length < minLoaded) return false
      if (!(ids.length < authorityCount)) return false
      return true
    },
    { topicId, tailId: tailSeedId, authorityCount, minLoaded: DISPLAY_COUNT },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (atLeast: number) => document.querySelectorAll('#messages [data-message-id]').length >= atLeast,
    DISPLAY_COUNT,
    { timeout: 30000 }
  )
}

/** Renderer message snapshot shape consumed by the reorder assertions. */
interface AssistantMessageSnapshot {
  id: string
  askId: string
  status: string
  modelId: unknown
  blockIds: string[]
}

async function getAssistantMessages(page: Page, topicId: string): Promise<AssistantMessageSnapshot[]> {
  return page.evaluate((id: string) => {
    const state = (window as any).store.getState()
    const messageIds = state.messages.messageIdsByTopic[id] || []
    return messageIds
      .map((messageId: string) => state.messages.entities[messageId])
      .filter((message: any) => message?.role === 'assistant')
      .map((message: any) => ({
        id: message.id,
        askId: message.askId,
        status: message.status,
        // Baseline assistant creation stores the structured model; modelId is
        // optional on the Message wire shape and is not present on every send path.
        modelId: message.model?.id ?? message.modelId,
        blockIds: [...(message.blocks || [])]
      }))
  }, topicId)
}

async function getLoadedIds(page: Page, topicId: string): Promise<string[]> {
  return page.evaluate((id: string) => {
    const state = (window as any).store.getState()
    return [...(state.messages.messageIdsByTopic[id] || [])]
  }, topicId)
}

async function waitForAssistantCount(page: Page, topicId: string, count: number): Promise<void> {
  await page.waitForFunction(
    ({ topicId, count }: { topicId: string; count: number }) => {
      const state = (window as any).store?.getState()
      const messageIds = state?.messages?.messageIdsByTopic?.[topicId] || []
      return messageIds.filter((id: string) => state.messages.entities[id]?.role === 'assistant').length >= count
    },
    { topicId, count },
    { timeout: 60000 }
  )

  await page.waitForFunction(
    ({ topicId, count }: { topicId: string; count: number }) => {
      const state = (window as any).store?.getState()
      if (state?.messages?.loadingByTopic?.[topicId]) return false
      const messages = (state?.messages?.messageIdsByTopic?.[topicId] || [])
        .map((id: string) => state.messages.entities[id])
        .filter((message: any) => message?.role === 'assistant')
      if (messages.length < count) return false
      return messages.slice(-count).every((message: any) => {
        if (message.status !== 'success') return false
        return (message.blocks || []).every((blockId: string) => {
          const block = state.messageBlocks?.entities?.[blockId]
          return block && block.status === 'success'
        })
      })
    },
    { topicId, count },
    { timeout: 60000 }
  )
}

function topicOrderSql(topicId: string): string {
  const escapedTopicId = topicId.replace(/'/g, "''")
  return `SELECT id, topic_id, role, ask_id, status, sort_order FROM messages WHERE topic_id = '${escapedTopicId}' ORDER BY sort_order, id`
}

function queryTopicMessages(dbPath: string, topicId: string) {
  const result = queryChatDbViaElectron(dbPath, topicOrderSql(topicId))
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return result.rows as Array<{
    id: string
    topic_id: string
    role: string
    ask_id: string | null
    status: string
    sort_order: number
  }>
}

/**
 * Wait for the SQLite authority order to converge to `expected` using the
 * bounded-retry query helper (transient TIMEOUT/SPAWN/SIGNAL/BUSY/LOCKED
 * retries, no fixed sleep). Returns the converged id list.
 */
async function pollTopicIdsUntil(dbPath: string, topicId: string, expected: string[]): Promise<string[]> {
  let captured: string[] | null = null
  await expect
    .poll(
      async () => {
        const res = await queryChatDbViaElectronWithRetry(dbPath, topicOrderSql(topicId))
        if (!res.ok) return null
        const rows = (res as unknown as { rows: unknown }).rows
        if (!Array.isArray(rows)) return null
        const ids = (rows as Array<{ id: unknown }>).map((row) => row.id)
        if (!ids.every((id): id is string => typeof id === 'string')) return null
        if (ids.length !== expected.length) return null
        if (!ids.every((id, index) => id === expected[index])) return null
        captured = ids
        return ids
      },
      { timeout: 30000, intervals: [250, 500, 1000] }
    )
    .not.toBeNull()
  return captured!
}

function assistantOrder(rows: ReturnType<typeof queryTopicMessages>) {
  return rows.filter((row) => row.role === 'assistant').map(({ id, sort_order }) => ({ id, sort_order }))
}

test.describe('Phase 5.4: Multi-model append and answer-group authority reorder', () => {
  test.setTimeout(600000)

  test('appends through assistant model UI and persists exact group-slots reorder', async ({
    electronApp,
    mainWindow
  }) => {
    const page = mainWindow

    await test.step('Lock displayCount=10 and expanded fold mode before seeding', async () => {
      await ensureDisplayCount(page, DISPLAY_COUNT)
      await ensureExpandedFoldMode(page)
    })

    // LOCK-006: Main authority pre-seed while the target topic is NOT active,
    // so the first cold activation builds a real loaded projection smaller
    // than authority (displayCount only constrains cold bootstrap).
    const liveAssistantId = await getLiveAssistantId(page)
    const topicId = `mmr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topicName = `MMR reorder ${topicId}`
    const seedEntries = buildSeedEntries(topicId, liveAssistantId)
    const tailSeedAssistantId = seedEntries[seedEntries.length - 1]!.message.id as string
    const tailSeedAskId = seedEntries[seedEntries.length - 1]!.message.askId as string

    await test.step('Pre-seed 6 rounds through Main authority while target stays inactive', async () => {
      await seedTargetTopicViaMainAuthority(page, liveAssistantId, topicId, topicName, seedEntries)
      const authorityIds = await getAuthorityIds(page, topicId)
      expect(authorityIds).toHaveLength(12)
      expect(authorityIds[authorityIds.length - 1]).toBe(tailSeedAssistantId)
      console.log(`[E2E] Pre-seed authority=12 loaded=0 topic=${topicId}`)
    })

    await test.step('First cold activation builds real loaded projection (loaded < authority)', async () => {
      await activateTargetTopicAndWaitForColdWindow(page, topicId, tailSeedAssistantId, 12)
      const loadedIds = await getLoadedIds(page, topicId)
      const authorityIds = await getAuthorityIds(page, topicId)
      expect(authorityIds).toHaveLength(12)
      expect(loadedIds.length).toBeGreaterThanOrEqual(DISPLAY_COUNT)
      expect(loadedIds.length).toBeLessThan(authorityIds.length)
      expect(loadedIds).toContain(tailSeedAssistantId)
      console.log(`[E2E] Cold window loaded=${loadedIds.length} authority=${authorityIds.length} topic=${topicId}`)
    })

    const seedAssistants = await getAssistantMessages(page, topicId)
    expect(seedAssistants.length).toBeGreaterThan(0)
    expect(seedAssistants.length).toBeLessThan(6)
    const tailBaseline = seedAssistants[seedAssistants.length - 1]!
    expect(tailBaseline.id).toBe(tailSeedAssistantId)
    expect(tailBaseline.askId).toBe(tailSeedAskId)
    expect(tailBaseline.askId).toBeTruthy()
    expect(tailBaseline.modelId).toBe('mock-model')

    await test.step('Append second assistant response through the real model popup', async () => {
      clearRequestLog()
      const mentionButton = page.locator(`#message-${tailBaseline.id} [data-testid="assistant-mention-model"]`)
      await expect(mentionButton).toBeVisible()
      const requestSequenceBeforeAppend = getRequestSequence()
      await mentionButton.click()

      const modelOption = page.getByTestId('chat-model-option-mock-model')
      await expect(modelOption).toBeVisible()
      await modelOption.click()

      await waitForAssistantCount(page, topicId, seedAssistants.length + 1)
      const appendRequest = findProductRequestAfter(requestSequenceBeforeAppend)
      expect(appendRequest).not.toBeNull()
      expect(appendRequest!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))
      console.log(`[E2E] UI append complete tail=${tailBaseline.id} topic=${topicId}`)
    })

    const assistantMessages = await getAssistantMessages(page, topicId)
    const tailGroup = assistantMessages.filter((message) => message.askId === tailBaseline.askId)
    expect(tailGroup).toHaveLength(2)
    const appendedAssistant = tailGroup.find((message) => message.id !== tailBaseline.id)
    expect(appendedAssistant).toBeDefined()
    expect(appendedAssistant!.modelId).toBe('mock-model')
    expect(appendedAssistant!.id).not.toBe(tailBaseline.id)

    await test.step('Verify authority=13 with loaded < authority and tail group fully loaded', async () => {
      const authorityIds = await getAuthorityIds(page, topicId)
      expect(authorityIds).toHaveLength(13)
      const loadedIds = await getLoadedIds(page, topicId)
      expect(loadedIds.length).toBeLessThan(authorityIds.length)
      expect(loadedIds).toContain(tailBaseline.id)
      expect(loadedIds).toContain(appendedAssistant!.id)
      console.log(`[E2E] Post-append loaded=${loadedIds.length} authority=${authorityIds.length} topic=${topicId}`)
    })

    // Pin the fold layout to expanded BEFORE locating the drag control:
    // production default is already 'expanded' (store/settings.ts), but the
    // spec must not depend on ambient settings state.
    await ensureExpandedFoldMode(page)

    // Locate the tail answer group by the production stable group id
    // (Messages.tsx renders `data-stable-group-id={deriveStableGroupId(...)}`
    // on the group wrapper). Never by `#message-group-${askId}`: the askId is
    // not unique per group and the DOM id is sanitized, so it cannot address
    // a group exactly.
    const expectedStableGroupId = deriveStableGroupIdMirror([tailBaseline.id, appendedAssistant!.id])
    const group = page
      .locator(`#messages [data-stable-group-id="${expectedStableGroupId}"]`)
      .filter({ has: page.locator(`.message[data-message-id="${tailBaseline.id}"]`) })
      .filter({ has: page.locator(`.message[data-message-id="${appendedAssistant!.id}"]`) })
    await expect(group).toHaveCount(1)
    await expect(group).toHaveAttribute('data-stable-group-id', expectedStableGroupId)
    await expect(group).toBeVisible()
    await expect(group.locator(`.message[data-message-id="${tailBaseline.id}"]`)).toHaveCount(1)
    await expect(group.locator(`.message[data-message-id="${appendedAssistant!.id}"]`)).toHaveCount(1)
    await expect(group.locator('.group-menu-bar')).toBeVisible()

    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!)).toBe(true)

    const beforeReorderRows = queryTopicMessages(dbPath!, topicId)
    const beforeReorderIds = beforeReorderRows.map((row) => row.id)
    const beforeLoadedIds = await getLoadedIds(page, topicId)
    // LOCK-006: the seed exceeds the window — old messages are window-outside.
    expect(beforeReorderIds.length).toBeGreaterThan(beforeLoadedIds.length)
    const firstIdx = beforeReorderIds.indexOf(tailBaseline.id)
    const secondIdx = beforeReorderIds.indexOf(appendedAssistant!.id)
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).not.toBe(firstIdx)
    // Same-askId assistants can occupy non-contiguous authority slots: the real
    // UI append uses a loaded-relative insert index. Production reorder swaps
    // the two original slots, so no adjacency is assumed here.
    const expectedAfterReorder = beforeReorderIds.map((id, index) =>
      index === firstIdx ? appendedAssistant!.id : index === secondIdx ? tailBaseline.id : id
    )

    await test.step('Reorder with the production dnd-kit control', async () => {
      // Group-scoped sortable items (ItemRenderer renders `data-index`; the
      // Sortable passes index per item). No global `.last()`: the spec owns
      // exactly one group locator, so both items must live inside it.
      const firstSortable = group.locator('[data-index="0"]')
      const secondSortable = group.locator('[data-index="1"]')
      await expect(firstSortable).toHaveCount(1)
      await expect(secondSortable).toHaveCount(1)
      await expect(
        firstSortable.locator(`[data-testid="answer-group-selector"][data-message-id="${tailBaseline.id}"]`)
      ).toHaveCount(1)
      await expect(
        secondSortable.locator(`[data-testid="answer-group-selector"][data-message-id="${appendedAssistant!.id}"]`)
      ).toHaveCount(1)
      await group.scrollIntoViewIfNeeded()
      await firstSortable.scrollIntoViewIfNeeded()
      await secondSortable.scrollIntoViewIfNeeded()
      await expect(firstSortable).toBeVisible()
      await expect(secondSortable).toBeVisible()

      const firstBox = await firstSortable.boundingBox()
      const secondBox = await secondSortable.boundingBox()
      expect(firstBox).not.toBeNull()
      expect(secondBox).not.toBeNull()
      const startX = firstBox!.x + firstBox!.width / 2
      const startY = firstBox!.y + firstBox!.height / 2
      const targetX = secondBox!.x + secondBox!.width * 0.85
      const targetY = secondBox!.y + secondBox!.height / 2
      // Production PointerSensor activates past distance 8 (Sortable.tsx);
      // the drag path must travel strictly farther, or no reorder fires.
      expect(Math.abs(targetX - startX)).toBeGreaterThan(8)
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      await page.waitForTimeout(150)
      await page.mouse.move(targetX, targetY, { steps: 12 })
      await page.mouse.up()

      // The tail answer group swaps in SQLite; nothing else moves.
      await pollTopicIdsUntil(dbPath!, topicId, expectedAfterReorder)
    })

    await test.step('Verify only group slots moved in SQLite; group-outside order intact', async () => {
      const afterReorderRows = queryTopicMessages(dbPath!, topicId)
      const afterReorderIds = afterReorderRows.map((row) => row.id)
      expect(afterReorderIds).toEqual(expectedAfterReorder)
      // Authority order outside the group is byte-identical to before.
      expect(afterReorderRows.filter((_, index) => index !== firstIdx && index !== secondIdx)).toEqual(
        beforeReorderRows.filter((_, index) => index !== firstIdx && index !== secondIdx)
      )
      const afterAssistantOrder = assistantOrder(afterReorderRows)
      expect(afterAssistantOrder).toContainEqual({ id: appendedAssistant!.id, sort_order: expect.any(Number) })
      expect(afterAssistantOrder).toContainEqual({ id: tailBaseline.id, sort_order: expect.any(Number) })
    })

    await test.step('Verify Redux loaded IDs permuted without window-outside injection', async () => {
      const afterLoadedIds = await getLoadedIds(page, topicId)
      // Same projection size, same member set — no window-outside injection.
      expect(afterLoadedIds).toHaveLength(beforeLoadedIds.length)
      expect(new Set(afterLoadedIds)).toEqual(new Set(beforeLoadedIds))
      for (const id of beforeReorderIds) {
        if (!beforeLoadedIds.includes(id)) {
          expect(afterLoadedIds).not.toContain(id)
        }
      }
      // The loaded tail slots follow the swapped authority order.
      const loadedFirst = afterLoadedIds.indexOf(tailBaseline.id)
      const loadedSecond = afterLoadedIds.indexOf(appendedAssistant!.id)
      expect(loadedFirst).toBeGreaterThanOrEqual(0)
      expect(loadedSecond).toBeGreaterThanOrEqual(0)
      expect(loadedSecond).toBeLessThan(loadedFirst)
    })

    await test.step('Verify reordered SQLite order after renderer reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean((window as any).store?.getState()?.messages), { timeout: 30000 })
      await page.waitForFunction(
        ({ topicId, firstId, secondId }: { topicId: string; firstId: string; secondId: string }) => {
          const state = (window as any).store.getState()
          if (state.messages.loadingByTopic?.[topicId] === true) return false
          const ids = state.messages.messageIdsByTopic[topicId] || []
          return ids.includes(firstId) && ids.includes(secondId)
        },
        { topicId, firstId: appendedAssistant!.id, secondId: tailBaseline.id },
        { timeout: 30000 }
      )
      const reloadedRows = queryTopicMessages(dbPath!, topicId)
      expect(reloadedRows.map((row) => row.id)).toEqual(expectedAfterReorder)
      // Reloaded projection still carries the swapped tail without injection.
      const reloadedIds = await getLoadedIds(page, topicId)
      expect(reloadedIds.indexOf(appendedAssistant!.id)).toBeLessThan(reloadedIds.indexOf(tailBaseline.id))
    })

    await test.step('Verify exact order after Electron shutdown', async () => {
      const expectedAfterShutdown = expectedAfterReorder
      // Explicit close; the shared fixture owns the disposable profile and its
      // secondary teardown cleanup (S62/S63 pattern) — no extra cleanup here.
      await electronApp.close()
      await expect.poll(() => fs.existsSync(dbPath!), { timeout: 30000, intervals: [250, 500] }).toBe(true)
      const shutdownIds = await pollTopicIdsUntil(dbPath!, topicId, expectedAfterShutdown)
      expect(shutdownIds).toEqual(expectedAfterShutdown)
    })
  })
})
