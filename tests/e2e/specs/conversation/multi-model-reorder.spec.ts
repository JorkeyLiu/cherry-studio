/**
 * Phase 5.4 multi-model assistant append and message-group reorder.
 *
 * Evidence classes:
 *   - UI interaction: assistant menubar model action, model popup selection,
 *     and real dnd-kit sortable drag
 *   - Product request: local mock server request body and selected model
 *   - SQLite persistence: exact message IDs and sort_order before/after reload
 *     and after Electron shutdown
 *
 * LOCK-001: The second response is created through the production UI action and
 * local mock request path; no Redux response fabrication is used.
 * LOCK-002: Reorder uses the production dnd-kit control, which invokes
 * reorderMessageGroupThunk; no reducer action is dispatched by this spec.
 * LOCK-003: Exact assistant IDs, request model/body, and SQLite order are asserted.
 * LOCK-004: The shared fixture owns a disposable profile and cleanup.
 * LOCK-005: This spec does not modify ordinary-chat/topic lifecycle coverage.
 */
import * as fs from 'fs'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getChatDbPath,
  getRequestSequence,
  queryChatDbViaElectron,
  test
} from '../../fixtures/electron.fixture'

type Page = import('@playwright/test').Page

async function uiSendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ text }) => {
      const el = document.querySelector('.inputbar textarea, textarea[placeholder]') as HTMLTextAreaElement | null
      if (!el) throw new Error('Textarea not found')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!setter) throw new Error('Textarea native value setter not found')
      setter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { text }
  )
  await expect(textarea).toHaveValue(text)
  await textarea.press('Enter')
}

async function getTopicContext(page: Page): Promise<{ topicId: string; assistantId: string }> {
  return page.evaluate(() => {
    const state = (window as any).store.getState()
    const assistant = state.assistants.assistants[0]
    const topic = assistant?.topics?.[0]
    if (!assistant?.id || !topic?.id) throw new Error('Active assistant/topic is unavailable')
    return { topicId: topic.id, assistantId: assistant.id }
  })
}

async function getAssistantMessages(page: Page, topicId: string) {
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

function queryTopicMessages(dbPath: string, topicId: string) {
  const escapedTopicId = topicId.replace(/'/g, "''")
  const result = queryChatDbViaElectron(
    dbPath,
    `SELECT id, topic_id, role, ask_id, status, sort_order FROM messages WHERE topic_id = '${escapedTopicId}' ORDER BY sort_order, id`
  )
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

function assistantOrder(rows: ReturnType<typeof queryTopicMessages>) {
  return rows.filter((row) => row.role === 'assistant').map(({ id, sort_order }) => ({ id, sort_order }))
}

test.describe('Phase 5.4: Multi-model append and reorder', () => {
  test.setTimeout(300000)

  test('appends through assistant model UI and persists exact group reorder', async ({ electronApp, mainWindow }) => {
    const page = mainWindow
    const { topicId } = await getTopicContext(page)

    await test.step('Create baseline conversation through the real UI', async () => {
      clearRequestLog()
      const requestSequenceBeforeBaseline = getRequestSequence()
      await uiSendMessage(page, 'Phase 5.4 multi-model baseline')
      await waitForAssistantCount(page, topicId, 1)

      const request = findProductRequestAfter(requestSequenceBeforeBaseline)
      expect(request).not.toBeNull()
      expect(request!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))
      expect(request!.parsed?.messages).toEqual(
        expect.arrayContaining([{ role: 'user', content: 'Phase 5.4 multi-model baseline' }])
      )
    })

    const baselineAssistant = (await getAssistantMessages(page, topicId))[0]
    expect(baselineAssistant).toBeDefined()
    expect(baselineAssistant.askId).toBeTruthy()
    expect(baselineAssistant.modelId).toBe('mock-model')

    await test.step('Append second assistant response through the real model popup', async () => {
      const mentionButton = page.locator(`#message-${baselineAssistant.id} [data-testid="assistant-mention-model"]`)
      await expect(mentionButton).toBeVisible()
      const requestSequenceBeforeAppend = getRequestSequence()
      await mentionButton.click()

      const modelOption = page.getByTestId('chat-model-option-mock-model')
      await expect(modelOption).toBeVisible()
      await modelOption.click()

      await waitForAssistantCount(page, topicId, 2)
      const appendRequest = findProductRequestAfter(requestSequenceBeforeAppend)
      expect(appendRequest).not.toBeNull()
      expect(appendRequest!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))
      expect(appendRequest!.parsed?.messages).toEqual(
        expect.arrayContaining([{ role: 'user', content: 'Phase 5.4 multi-model baseline' }])
      )
    })

    const assistantMessages = await getAssistantMessages(page, topicId)
    expect(assistantMessages).toHaveLength(2)
    const appendedAssistant = assistantMessages.find((message) => message.id !== baselineAssistant.id)
    expect(appendedAssistant).toBeDefined()
    expect(appendedAssistant!.askId).toBe(baselineAssistant.askId)
    expect(appendedAssistant!.modelId).toBe('mock-model')
    expect(appendedAssistant!.id).not.toBe(baselineAssistant.id)

    // Messages keeps layout variants mounted; target the group instance that
    // contains the currently rendered message cards.
    const group = page
      .locator(`#message-group-${baselineAssistant.askId}`)
      .filter({ has: page.locator(`[data-message-id="${baselineAssistant.id}"]`) })
      .last()
    await expect(group).toBeVisible()
    await expect(group.locator(`[data-message-id="${baselineAssistant.id}"]`)).toHaveCount(1)
    await expect(group.locator(`[data-message-id="${appendedAssistant!.id}"]`)).toHaveCount(1)
    await expect(group.locator('.group-menu-bar')).toBeVisible()

    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()
    await expect.poll(() => fs.existsSync(dbPath!)).toBe(true)

    const beforeReorderRows = queryTopicMessages(dbPath!, topicId)
    const beforeReorderAssistantOrder = assistantOrder(beforeReorderRows)
    expect(beforeReorderAssistantOrder).toEqual([
      { id: baselineAssistant.id, sort_order: expect.any(Number) },
      { id: appendedAssistant!.id, sort_order: expect.any(Number) }
    ])
    expect(beforeReorderAssistantOrder[0]!.sort_order).toBeLessThan(beforeReorderAssistantOrder[1]!.sort_order)
    console.log(`[Phase 5.4] Exact assistant IDs before reorder: ${JSON.stringify(beforeReorderAssistantOrder)}`)

    await test.step('Reorder with the production dnd-kit control', async () => {
      const foldLayout = page.getByRole('img', { name: 'folder' }).last()
      await expect(foldLayout).toBeVisible()
      await foldLayout.click()
      const firstSortable = page.locator('.group-menu-bar [data-index="0"]:visible').last()
      const secondSortable = page.locator('.group-menu-bar [data-index="1"]:visible').last()
      await expect(firstSortable).toBeVisible()
      await expect(secondSortable).toBeVisible()

      const firstBox = await firstSortable.boundingBox()
      const secondBox = await secondSortable.boundingBox()
      expect(firstBox).not.toBeNull()
      expect(secondBox).not.toBeNull()
      await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(150)
      await page.mouse.move(secondBox!.x + secondBox!.width * 0.85, secondBox!.y + secondBox!.height / 2, {
        steps: 12
      })
      await page.mouse.up()

      await expect
        .poll(async () => assistantOrder(queryTopicMessages(dbPath!, topicId)))
        .toEqual([
          { id: appendedAssistant!.id, sort_order: expect.any(Number) },
          { id: baselineAssistant.id, sort_order: expect.any(Number) }
        ])
    })

    const afterReorderRows = queryTopicMessages(dbPath!, topicId)
    const afterReorderAssistantOrder = assistantOrder(afterReorderRows)
    expect(afterReorderAssistantOrder).toEqual([
      { id: appendedAssistant!.id, sort_order: expect.any(Number) },
      { id: baselineAssistant.id, sort_order: expect.any(Number) }
    ])
    expect(afterReorderAssistantOrder[0]!.sort_order).toBeLessThan(afterReorderAssistantOrder[1]!.sort_order)
    console.log(`[Phase 5.4] Exact assistant IDs after reorder: ${JSON.stringify(afterReorderAssistantOrder)}`)

    await test.step('Verify reordered SQLite order after renderer reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean((window as any).store?.getState()?.messages), { timeout: 30000 })
      await page.waitForFunction(
        ({ topicId, firstId, secondId }: { topicId: string; firstId: string; secondId: string }) => {
          const state = (window as any).store.getState()
          const ids = state.messages.messageIdsByTopic[topicId] || []
          return ids.includes(firstId) && ids.includes(secondId)
        },
        { topicId, firstId: appendedAssistant!.id, secondId: baselineAssistant.id },
        { timeout: 30000 }
      )
      expect(assistantOrder(queryTopicMessages(dbPath!, topicId))).toEqual(afterReorderAssistantOrder)
    })

    await test.step('Verify exact order after Electron shutdown', async () => {
      await electronApp.close()
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const shutdownRows = queryTopicMessages(dbPath!, topicId)
      expect(assistantOrder(shutdownRows)).toEqual(afterReorderAssistantOrder)
      console.log(`[Phase 5.4] Exact SQLite order after shutdown: ${JSON.stringify(assistantOrder(shutdownRows))}`)
    })
  })
})
