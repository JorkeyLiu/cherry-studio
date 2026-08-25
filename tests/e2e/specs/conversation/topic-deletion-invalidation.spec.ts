/**
 * Authoritative topic deletion invalidation — bounded integrated E2E evidence.
 *
 * This spec covers only the single-window hard-delete and empty-trash
 * projection invalidation paths. It intentionally does not cover window or
 * context-closure eviction granularity, stale in-flight timing races, or
 * multi-window behavior.
 */

import type { Page } from '@playwright/test'

import { expect, getChatDbPath, queryChatDbViaElectron, test } from '../../fixtures/electron.fixture'

const MESSAGE_COUNT = 2

type SeededTopic = {
  topicId: string
  messageIds: string[]
  blockIds: string[]
}

type MessageBlockEntry = {
  message: Record<string, unknown>
  blocks: Array<Record<string, unknown>>
}

function queryRows(dbPath: string, sql: string): any[] {
  const result = queryChatDbViaElectron(dbPath, sql)
  if (result.ok === false) throw new Error(`SQLite query failed: ${result.code}`)
  return result.rows as any[]
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

async function prepareAssistant(page: Page): Promise<string> {
  await page.evaluate(() => {
    ;(window as any).store.dispatch({ type: 'newMessages/setDisplayCount', payload: 20 })
  })

  const assistantId = await page.evaluate(
    () => (window as any).store.getState().assistants?.assistants?.[0]?.id ?? null
  )
  expect(assistantId, 'live assistant id must exist').toBeTruthy()
  return assistantId as string
}

async function seedTopic(page: Page, assistantId: string, topicId: string): Promise<SeededTopic> {
  const name = `Deletion E2E ${topicId}`
  const messageIds = Array.from({ length: MESSAGE_COUNT }, (_, index) => `${topicId}-message-${index}`)
  const blockIds = messageIds.map((messageId) => `${messageId}-block`)
  const entries: MessageBlockEntry[] = messageIds.map((messageId, index) => {
    const blockId = blockIds[index]
    const role = index === 0 ? 'user' : 'assistant'
    const message: Record<string, unknown> = {
      id: messageId,
      topicId,
      role,
      assistantId,
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      updatedAt: `2026-01-01T00:00:0${index}.000Z`,
      status: 'success',
      blocks: [blockId],
      sortOrder: index
    }
    if (role === 'assistant') {
      message.model = { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model' }
      message.modelId = 'mock-model'
      message.askId = `${topicId}-ask`
    }

    return {
      message,
      blocks: [
        {
          id: blockId,
          messageId,
          type: 'main_text',
          content: `deletion-content-${index}`,
          status: 'success',
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
          updatedAt: `2026-01-01T00:00:0${index}.000Z`
        }
      ]
    }
  })

  const added = await page.evaluate(
    ({ assistantId, topicId, name }) => {
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
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    { assistantId, topicId, name }
  )
  expect(added.ok, `addTopic failed: ${(added as any).error}`).toBe(true)

  const persisted = await page.evaluate(
    async ({ assistantId, topicId, name, entries }) => {
      try {
        const chatDb = (window as any).api?.chatDb
        if (!chatDb) return { ok: false, error: 'chatDb unavailable' }
        const ensured = await chatDb.ensureTopic({ topicId, assistantId, name })
        if (!ensured?.ok) return { ok: false, error: `ensureTopic failed: ${JSON.stringify(ensured)}` }
        const pasted = await chatDb.pasteMessagesToTopic({ topicId, entries })
        if (!pasted?.ok) return { ok: false, error: `pasteMessagesToTopic failed: ${JSON.stringify(pasted)}` }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    { assistantId, topicId, name, entries }
  )
  expect(persisted.ok, `topic persistence failed: ${(persisted as any).error}`).toBe(true)

  return { topicId, messageIds, blockIds }
}

async function activateTopic(page: Page, topicId: string): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.waitFor({ state: 'attached', timeout: 15000 })
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.waitFor({ state: 'visible', timeout: 15000 })
  await topicItem.click()

  await page.waitForFunction(
    ({ topicId, expected }) => {
      const state = (window as any).store.getState()
      const ids = state.messages?.messageIdsByTopic?.[topicId]
      return Array.isArray(ids) && ids.length === expected && state.messages?.loadingByTopic?.[topicId] !== true
    },
    { topicId, expected: MESSAGE_COUNT },
    { timeout: 30000 }
  )
  await page.waitForFunction(
    (expected) => document.querySelectorAll('#messages .message[data-message-id]').length === expected,
    MESSAGE_COUNT,
    { timeout: 30000 }
  )
}

async function readProjection(page: Page, topic: SeededTopic) {
  return page.evaluate((topicId) => {
    const state = (window as any).store.getState()
    const messageIds: string[] = state.messages?.messageIdsByTopic?.[topicId] ?? []
    const messageEntities = messageIds.map((id) => state.messages?.entities?.[id] ?? null)
    const blockIds = messageEntities.flatMap((message: any) => message?.blocks ?? [])
    const domMessageIds = Array.from(document.querySelectorAll('#messages .message[data-message-id]')).map(
      (element) => (element as HTMLElement).dataset.messageId ?? ''
    )
    return {
      messageIds,
      messageEntities,
      blockIds,
      blockEntities: blockIds.map((id) => state.messageBlocks?.entities?.[id] ?? null),
      domMessageIds
    }
  }, topic.topicId)
}

async function assertProjectionPresent(page: Page, topic: SeededTopic): Promise<void> {
  const projection = await readProjection(page, topic)
  expect(projection.messageIds).toEqual(topic.messageIds)
  expect(projection.messageEntities.every(Boolean)).toBe(true)
  expect(projection.blockIds).toEqual(topic.blockIds)
  expect(projection.blockEntities.every(Boolean)).toBe(true)
  expect(projection.domMessageIds).toEqual(topic.messageIds.toReversed())
}

async function assertProjectionInvalidated(page: Page, topic: SeededTopic): Promise<void> {
  await page.waitForFunction(
    ({ topicId, messageIds, blockIds }) => {
      const state = (window as any).store.getState()
      const projectedIds: string[] = state.messages?.messageIdsByTopic?.[topicId] ?? []
      const messageEntities = state.messages?.entities ?? {}
      const blockEntities = state.messageBlocks?.entities ?? {}
      return (
        projectedIds.length === 0 &&
        messageIds.every((id) => !messageEntities[id]) &&
        blockIds.every((id) => !blockEntities[id])
      )
    },
    { topicId: topic.topicId, messageIds: topic.messageIds, blockIds: topic.blockIds },
    { timeout: 15000 }
  )

  const projection = await readProjection(page, topic)
  expect(projection.messageIds).toEqual([])
  expect(projection.messageEntities).toEqual([])
  expect(projection.blockIds).toEqual([])
  expect(projection.blockEntities).toEqual([])
  expect(projection.domMessageIds).not.toEqual(expect.arrayContaining(topic.messageIds))
}

async function assertSqliteCascadeAbsent(topic: SeededTopic): Promise<void> {
  const chatDbPath = getChatDbPath()
  expect(chatDbPath).not.toBeNull()
  const topicId = escapeSql(topic.topicId)
  const messageIds = topic.messageIds.map((id) => `'${escapeSql(id)}'`).join(',')
  const blockIds = topic.blockIds.map((id) => `'${escapeSql(id)}'`).join(',')

  expect(queryRows(chatDbPath!, `SELECT id FROM topics WHERE id = '${topicId}'`)).toEqual([])
  expect(queryRows(chatDbPath!, `SELECT id FROM messages WHERE id IN (${messageIds})`)).toEqual([])
  expect(queryRows(chatDbPath!, `SELECT id FROM message_blocks WHERE id IN (${blockIds})`)).toEqual([])
}

async function assertTopicMissing(page: Page, topicId: string): Promise<void> {
  const result = await page.evaluate(async (id) => {
    const chatDb = (window as any).api.chatDb
    const exists = await chatDb.topicExists({ topicId: id })
    const windowResult = await chatDb.fetchMessagesWindow({ kind: 'latest', topicId: id, limit: 20 })
    return { exists, windowResult }
  }, topicId)

  expect(result.exists).toMatchObject({ ok: true, value: false })
  expect(result.windowResult).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
}

test.describe('authoritative topic deletion invalidation — bounded single-window evidence', () => {
  test.setTimeout(180000)

  test('hard-deletes the active topic and invalidates its authoritative projection', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED E2E: standard fixture, Redux topic seed, typed Main ChatDb persistence/deletion, real topic activation, authoritative deletedTopicIds, renderer projection/DOM invalidation, missing-topic reads, and live SQLite cascade absence.'
    })

    const page = mainWindow
    const assistantId = await prepareAssistant(page)
    const survivor = await seedTopic(page, assistantId, `deletion-survivor-${Date.now()}`)
    const target = await seedTopic(page, assistantId, `deletion-hard-${Date.now()}`)

    await activateTopic(page, target.topicId)
    await assertProjectionPresent(page, target)

    const deletion = await page.evaluate(async (topicId) => {
      return await (window as any).api.chatDb.hardDeleteTopic({ topicId })
    }, target.topicId)
    expect(deletion).toMatchObject({ ok: true, value: { deletedTopicIds: [target.topicId] } })

    await assertProjectionInvalidated(page, target)
    await expect(page.locator('#messages .message[data-message-id]')).toHaveCount(0)
    await assertTopicMissing(page, target.topicId)
    await assertSqliteCascadeAbsent(target)

    await activateTopic(page, survivor.topicId)
    await assertProjectionPresent(page, survivor)
  })

  test('preserves soft-deleted projections until empty-trash returns authoritative IDs', async ({ mainWindow }) => {
    test.info().annotations.push({
      type: 'evidence-tier',
      description:
        'INTEGRATED E2E: typed soft-delete preserves resident renderer projections, then typed atomic empty-trash returns exact deletedTopicIds and invalidates both topic projections/DOM through the Main-to-renderer deletion event.'
    })

    const page = mainWindow
    const assistantId = await prepareAssistant(page)
    const survivor = await seedTopic(page, assistantId, `deletion-bulk-survivor-${Date.now()}`)
    const firstTarget = await seedTopic(page, assistantId, `deletion-bulk-first-${Date.now()}`)
    const secondTarget = await seedTopic(page, assistantId, `deletion-bulk-second-${Date.now()}`)

    await activateTopic(page, firstTarget.topicId)
    await assertProjectionPresent(page, firstTarget)
    await activateTopic(page, secondTarget.topicId)
    await assertProjectionPresent(page, secondTarget)

    const softDeletes = await page.evaluate(
      async ({ firstTopicId, secondTopicId }) => {
        const chatDb = (window as any).api.chatDb
        const first = await chatDb.softDeleteTopic({ topicId: firstTopicId, name: firstTopicId })
        const second = await chatDb.softDeleteTopic({ topicId: secondTopicId, name: secondTopicId })
        return { first, second }
      },
      { firstTopicId: firstTarget.topicId, secondTopicId: secondTarget.topicId }
    )
    expect(softDeletes.first).toMatchObject({ ok: true, value: null })
    expect(softDeletes.second).toMatchObject({ ok: true, value: null })

    // Soft-delete is preservation control evidence: it does not broadcast or
    // bump deletion invalidation, so resident projections remain available.
    await assertProjectionPresent(page, secondTarget)
    const firstProjection = await readProjection(page, firstTarget)
    expect(firstProjection.messageIds).toEqual(firstTarget.messageIds)

    const emptyTrash = await page.evaluate(async (assistantId) => {
      return await (window as any).api.chatDb.emptyTrashTopics({ assistantId })
    }, assistantId)
    expect(emptyTrash.ok).toBe(true)
    const deletedTopicIds = emptyTrash.value.deletedTopicIds as string[]
    expect(deletedTopicIds).toHaveLength(2)
    expect(new Set(deletedTopicIds)).toEqual(new Set([firstTarget.topicId, secondTarget.topicId]))

    await assertProjectionInvalidated(page, firstTarget)
    await assertProjectionInvalidated(page, secondTarget)
    await expect(page.locator('#messages .message[data-message-id]')).toHaveCount(0)
    await assertSqliteCascadeAbsent(firstTarget)
    await assertSqliteCascadeAbsent(secondTarget)

    await activateTopic(page, survivor.topicId)
    await assertProjectionPresent(page, survivor)
  })
})
