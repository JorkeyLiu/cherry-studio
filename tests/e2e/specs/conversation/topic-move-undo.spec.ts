/**
 * Phase 5.4 topic move and message delete undo/redo coverage.
 *
 * Operations are performed through the rendered UI. Redux supplies the
 * independent expected message/block snapshots; SQLite is queried at every
 * transition and again after Electron shutdown.
 */
import * as fs from 'fs'
import * as path from 'path'

import {
  expect,
  getChatDbPath,
  getRuntimeAppDataPath,
  getUserDataDir,
  queryChatDbViaElectron,
  test
} from '../../fixtures/electron.fixture'

type Page = import('@playwright/test').Page

const esc = (value: string) => value.replace(/'/g, "''")

async function getState(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).store.getState()
    const assistants = state.assistants.assistants
    const activeTopic = state.runtime.chat.activeTopic
    return {
      assistants: assistants.map((assistant: any) => ({
        id: assistant.id,
        name: assistant.name,
        topicIds: (assistant.topics || []).map((topic: any) => topic.id),
        topics: (assistant.topics || []).map((topic: any) => ({ id: topic.id, name: topic.name }))
      })),
      activeTopicId: activeTopic?.id || ''
    }
  })
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate((value: string) => {
    const element = document.querySelector('.inputbar textarea, textarea[placeholder]') as HTMLTextAreaElement | null
    if (!element) throw new Error('Chat textarea not found')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) throw new Error('Textarea value setter not found')
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, text)
  await expect(textarea).toHaveValue(text)
  await textarea.press('Enter')
}

async function waitForAssistantReply(page: Page, topicId: string): Promise<void> {
  await page.waitForFunction(
    ({ topicId }) => {
      const state = (window as any).store?.getState()
      const ids = state?.messages?.messageIdsByTopic?.[topicId] || []
      const messages = ids.map((id: string) => state.messages.entities[id]).filter(Boolean)
      const assistant = [...messages].reverse().find((message: any) => message.role === 'assistant')
      if (!assistant || !['success', 'error'].includes(assistant.status)) return false
      if (state.messages.loadingByTopic?.[topicId]) return false
      return (assistant.blocks || []).every((blockId: string) => {
        const block = state.messageBlocks.entities[blockId]
        return block && ['success', 'error'].includes(block.status)
      })
    },
    { topicId },
    { timeout: 60000 }
  )
}

async function createTopicFromUI(page: Page, assistantId: string, expectedCount: number): Promise<string> {
  const beforeIds = await page.evaluate((assistantId: string) => {
    const assistant = (window as any).store
      .getState()
      .assistants.assistants.find((item: any) => item.id === assistantId)
    return (assistant?.topics || []).map((topic: any) => topic.id)
  }, assistantId)
  const addTopic = page.locator('.topics-tab button').first()
  await addTopic.waitFor({ state: 'visible' })
  await addTopic.click()
  await page.waitForFunction(
    ({ assistantId, expectedCount }) => {
      const state = (window as any).store?.getState()
      const assistant = state?.assistants?.assistants?.find((item: any) => item.id === assistantId)
      return (state?.runtime?.chat?.activeTopic?.id || '') !== '' && (assistant?.topics?.length || 0) >= expectedCount
    },
    { assistantId, expectedCount }
  )
  return page.evaluate(
    ({ assistantId, beforeIds }) => {
      const assistant = (window as any).store
        .getState()
        .assistants.assistants.find((item: any) => item.id === assistantId)
      const created = (assistant?.topics || []).find((topic: any) => !beforeIds.includes(topic.id))
      if (!created) throw new Error('Created topic was not found by topic ID diff')
      return created.id
    },
    { assistantId, beforeIds }
  )
}

async function createSecondAssistantViaUI(page: Page): Promise<{ id: string; name: string }> {
  const before = await getState(page)
  const assistantName = `E2E Move Target ${Date.now()}`
  // LOCK-NAV: the assistant list panel always renders; no tab switching needed.
  await expect(page.locator('.assistants-tab')).toBeVisible()
  await page.getByRole('button', { name: 'Add Assistant', exact: true }).click()
  const search = page.getByPlaceholder('Search assistants...')
  await search.fill(assistantName)
  const customPreset = page.locator('.agent-item').filter({ hasText: assistantName }).first()
  await customPreset.waitFor({ state: 'visible', timeout: 10000 })
  await customPreset.click()
  await page.waitForFunction(
    (beforeIds: string[]) => {
      const state = (window as any).store?.getState()
      return state?.assistants?.assistants?.some((assistant: any) => !beforeIds.includes(assistant.id))
    },
    before.assistants.map((assistant) => assistant.id)
  )
  const after = await getState(page)
  const created = after.assistants.find(
    (assistant) => !before.assistants.some((beforeAssistant) => beforeAssistant.id === assistant.id)
  )
  if (!created) throw new Error('Second assistant was not created through the UI')
  expect(created.name).toBe(assistantName)
  return { id: created.id, name: assistantName }
}

/**
 * LOCK-NAV: activate an assistant by clicking its row in the always-rendered
 * assistant list panel. There is no Assistants tab to switch to.
 */
async function activateAssistantViaUI(page: Page, assistantName: string): Promise<void> {
  await expect(page.locator('.assistants-tab')).toBeVisible()
  await page.getByText(assistantName, { exact: true }).first().click()
  await page.waitForTimeout(500)
}

/**
 * LOCK-NAV: the topics list panel always renders beside the assistant list;
 * assert its readiness instead of switching to a Topics tab.
 */
async function assertTopicsPanelReady(page: Page): Promise<void> {
  await expect(page.locator('.topics-tab')).toBeVisible()
}

function queryRows(dbPath: string, sql: string): any[] {
  const result = queryChatDbViaElectron(dbPath, sql)
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return result.rows as any[]
}

type ExpectedMessage = {
  id: string
  topicId: string
  role: string
  assistantId: string
  content: unknown
  sortOrder: number
  blockIds: string[]
}

type ExpectedBlock = {
  id: string
  messageId: string
  type: string
  content: unknown
  status: string
  sortOrder: number
}

type TopicSnapshot = {
  messageIds: string[]
  messages: ExpectedMessage[]
  blocks: ExpectedBlock[]
}

async function captureTopicMessages(page: Page, topicId: string): Promise<TopicSnapshot> {
  return page.evaluate((topicId: string) => {
    const state = (window as any).store.getState()
    const messageIds = [...(state.messages.messageIdsByTopic?.[topicId] || [])]
    return {
      messageIds,
      messages: messageIds.map((id, messageIndex) => {
        const message = state.messages.entities[id]
        return {
          id: message.id,
          topicId: message.topicId,
          role: message.role,
          assistantId: message.assistantId,
          content: message.content ?? null,
          // Redux's ordered messageIdsByTopic is the renderer order source;
          // the entity itself does not carry the persistence sort_order field.
          sortOrder: messageIndex,
          blockIds: [...(message.blocks || [])]
        }
      }),
      blocks: messageIds.flatMap((id) => {
        const message = state.messages.entities[id]
        return (message?.blocks || []).map((blockId: string, blockIndex: number) => {
          const block = state.messageBlocks.entities[blockId]
          return {
            id: block.id,
            messageId: block.messageId,
            type: block.type,
            content: block.content ?? null,
            status: block.status,
            // Each message's ordered block ID array is the renderer order
            // source; block entities do not carry persistence sort_order.
            sortOrder: blockIndex
          }
        })
      })
    }
  }, topicId)
}

function getMessageRows(dbPath: string, messageIds: string[]) {
  const messageList = messageIds.map((id) => `'${esc(id)}'`).join(',')
  return messageIds.length
    ? queryRows(
        dbPath,
        `SELECT id, topic_id, role, assistant_id, content, sort_order FROM messages WHERE id IN (${messageList})`
      )
    : []
}

function getBlockRows(dbPath: string, blockIds: string[]) {
  const blockList = blockIds.map((id) => `'${esc(id)}'`).join(',')
  return blockIds.length
    ? queryRows(
        dbPath,
        `SELECT id, message_id, type, content, status, sort_order FROM message_blocks WHERE id IN (${blockList})`
      )
    : []
}

function assertMessageRows(dbPath: string, topicId: string, snapshot: TopicSnapshot, expected: boolean) {
  const messages = getMessageRows(dbPath, snapshot.messageIds)
  const blocks = getBlockRows(
    dbPath,
    snapshot.blocks.map((block) => block.id)
  )

  if (!expected) {
    expect(messages).toHaveLength(0)
    expect(blocks).toHaveLength(0)
    return
  }

  const messageRowsById = new Map(messages.map((row) => [row.id, row]))
  const blockRowsById = new Map(blocks.map((row) => [row.id, row]))
  expect(messages).toHaveLength(snapshot.messages.length)
  expect(blocks).toHaveLength(snapshot.blocks.length)
  expect(snapshot.messageIds.map((id) => messageRowsById.get(id))).toEqual(
    snapshot.messages.map((message) => ({
      id: message.id,
      topic_id: topicId,
      role: message.role,
      assistant_id: message.assistantId,
      content: message.content,
      sort_order: message.sortOrder
    }))
  )
  expect(snapshot.blocks.map((block) => block.id)).toEqual(snapshot.messages.flatMap((message) => message.blockIds))
  expect(snapshot.blocks.map((block) => blockRowsById.get(block.id))).toEqual(
    snapshot.blocks.map((block) => ({
      id: block.id,
      message_id: block.messageId,
      type: block.type,
      content: block.content,
      status: block.status,
      sort_order: block.sortOrder
    }))
  )
}

async function assertReduxSnapshot(page: Page, topicId: string, snapshot: TopicSnapshot, expected: boolean) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ topicId, snapshot, expected }) => {
          const state = (window as any).store.getState()
          const messageIds = state.messages.messageIdsByTopic?.[topicId] || []
          if (!expected) {
            return (
              messageIds.every((id: string) => !snapshot.messageIds.includes(id)) &&
              snapshot.blocks.every((block) => !state.messageBlocks.entities?.[block.id])
            )
          }
          if (JSON.stringify(messageIds) !== JSON.stringify(snapshot.messageIds)) return false
          return snapshot.messages.every((message) => {
            const current = state.messages.entities?.[message.id]
            return (
              current &&
              current.id === message.id &&
              current.topicId === message.topicId &&
              current.role === message.role &&
              current.assistantId === message.assistantId &&
              (current.content ?? null) === message.content &&
              (current.sortOrder ?? snapshot.messages.indexOf(message)) === message.sortOrder &&
              JSON.stringify(current.blocks || []) === JSON.stringify(message.blockIds)
            )
          })
        },
        { topicId, snapshot, expected }
      )
    )
    .toBe(true)
}

test.describe('Phase 5.4: Topic move and message delete undo/redo', () => {
  test('moves a topic between assistants and persists delete undo/redo state', async ({ electronApp, mainWindow }) => {
    test.setTimeout(300000)
    const page = mainWindow
    const dbPath = getChatDbPath()
    expect(dbPath).not.toBeNull()

    const initial = await getState(page)
    const source = initial.assistants[0]
    if (!source) throw new Error('Default assistant is unavailable')

    await assertTopicsPanelReady(page)
    const topicToMove = source.topics[0]
    if (!topicToMove) throw new Error('Default topic is unavailable')
    const secondTopicId = await createTopicFromUI(page, source.id, source.topicIds.length + 1)
    expect(secondTopicId).not.toBe(topicToMove.id)
    await sendMessage(page, 'Phase 5.4 move and delete undo exact SQLite message')
    await waitForAssistantReply(page, secondTopicId)
    const beforeMoveSnapshot = await captureTopicMessages(page, secondTopicId)
    expect(beforeMoveSnapshot.messageIds.length).toBeGreaterThanOrEqual(2)
    expect(beforeMoveSnapshot.blocks.length).toBeGreaterThan(0)
    expect(beforeMoveSnapshot.messages.every((message) => message.assistantId === source.id)).toBe(true)
    assertMessageRows(dbPath!, secondTopicId, beforeMoveSnapshot, true)
    const beforeMoveRows = queryRows(
      dbPath!,
      `SELECT id, assistant_id, name, deleted_at FROM topics WHERE id = '${esc(secondTopicId)}'`
    )
    expect(beforeMoveRows).toHaveLength(1)
    expect(beforeMoveRows[0]).toMatchObject({ id: secondTopicId, assistant_id: source.id, deleted_at: null })

    const secondAssistant = await createSecondAssistantViaUI(page)
    await activateAssistantViaUI(page, source.name)
    await assertTopicsPanelReady(page)

    const sourceTopicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${secondTopicId}"]`)
    await sourceTopicItem.waitFor({ state: 'visible' })
    await sourceTopicItem.click({ button: 'right' })
    const moveMenu = page.locator('.ant-dropdown-menu-submenu').filter({ hasText: 'Move to' }).first()
    await moveMenu.waitFor({ state: 'visible' })
    await moveMenu.hover()
    const moveTarget = page
      .locator('.ant-dropdown-menu-submenu-popup')
      .getByText(secondAssistant.name, { exact: true })
      .last()
    await moveTarget.waitFor({ state: 'visible' })
    await moveTarget.click()

    await page.waitForFunction(
      ({ sourceId, targetId, topicId }) => {
        const assistants = (window as any).store.getState().assistants.assistants
        const source = assistants.find((assistant: any) => assistant.id === sourceId)
        const target = assistants.find((assistant: any) => assistant.id === targetId)
        return (
          !source?.topics?.some((topic: any) => topic.id === topicId) &&
          target?.topics?.some((topic: any) => topic.id === topicId)
        )
      },
      { sourceId: source.id, targetId: secondAssistant.id, topicId: secondTopicId }
    )

    let moveRows = queryRows(
      dbPath!,
      `SELECT id, assistant_id, name, deleted_at FROM topics WHERE id = '${esc(secondTopicId)}'`
    )
    expect(moveRows).toHaveLength(1)
    expect(moveRows[0]).toMatchObject({ id: secondTopicId, assistant_id: secondAssistant.id, deleted_at: null })

    await activateAssistantViaUI(page, secondAssistant.name)
    await assertTopicsPanelReady(page)
    await expect(page.locator(`[data-testid="topic-item"][data-topic-id="${secondTopicId}"]`)).toBeVisible()
    await activateAssistantViaUI(page, source.name)
    await assertTopicsPanelReady(page)
    await expect(page.locator(`[data-testid="topic-item"][data-topic-id="${secondTopicId}"]`)).toHaveCount(0)

    await activateAssistantViaUI(page, secondAssistant.name)
    await assertTopicsPanelReady(page)
    await page.locator(`[data-testid="topic-item"][data-topic-id="${secondTopicId}"]`).click()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      ({ topicId }) => {
        const state = (window as any).store?.getState()
        return (
          state?.messages?.currentTopicId === topicId && (state.messages.messageIdsByTopic?.[topicId]?.length || 0) >= 2
        )
      },
      { topicId: secondTopicId },
      { timeout: 30000 }
    )
    await waitForAssistantReply(page, secondTopicId)
    const captured = await captureTopicMessages(page, secondTopicId)
    expect(captured.messageIds).toEqual(beforeMoveSnapshot.messageIds)
    expect(
      captured.messages.map(({ id, content, role, topicId, sortOrder, blockIds }) => ({
        id,
        content,
        role,
        topicId,
        sortOrder,
        blockIds
      }))
    ).toEqual(
      beforeMoveSnapshot.messages.map(({ id, content, role, topicId, sortOrder, blockIds }) => ({
        id,
        content,
        role,
        topicId,
        sortOrder,
        blockIds
      }))
    )
    expect(captured.blocks).toEqual(beforeMoveSnapshot.blocks)
    expect(captured.messages.every((message) => message.assistantId === secondAssistant.id)).toBe(true)
    assertMessageRows(dbPath!, secondTopicId, captured, true)
    console.log(
      `[Phase 5.4] Redux snapshot before delete (after move): ${JSON.stringify({
        assistantIds: captured.messages.map(({ id, assistantId }) => ({ id, assistantId })),
        messages: captured.messages,
        blocks: captured.blocks
      })}`
    )

    const capturedMessageIds = captured.messageIds
    const capturedBlockIds = captured.blocks.map((block) => block.id)

    await page.locator('[data-testid="edit-mode-toggle"]').click()
    await page.waitForFunction(() => (window as any).store.getState().editMode.enabled === true)
    const userMessageId = captured.messages.find((message) => message.role === 'user')?.id
    if (!userMessageId) throw new Error('User message was not captured')
    const userMessage = page.locator(`[data-message-id="${userMessageId}"].message-user:visible`).first()
    await userMessage.scrollIntoViewIfNeeded()
    await expect(userMessage).toBeVisible()
    await userMessage.click()
    await page.waitForFunction((messageId: string) => {
      const state = (window as any).store.getState()
      return state.editMode.selectedGroupIds.includes(messageId)
    }, userMessageId)
    await page.keyboard.press('Meta+Backspace')
    await assertReduxSnapshot(page, secondTopicId, captured, false)
    assertMessageRows(dbPath!, secondTopicId, captured, false)

    await page.keyboard.press('Meta+z')
    await assertReduxSnapshot(page, secondTopicId, captured, true)
    assertMessageRows(dbPath!, secondTopicId, captured, true)
    const restored = await captureTopicMessages(page, secondTopicId)
    expect(restored).toEqual(captured)
    console.log(
      `[Phase 5.4] Redux snapshot after undo: ${JSON.stringify({ messages: restored.messages, blocks: restored.blocks })}`
    )

    await page.keyboard.press('Meta+Shift+z')
    await assertReduxSnapshot(page, secondTopicId, captured, false)
    assertMessageRows(dbPath!, secondTopicId, captured, false)

    moveRows = queryRows(
      dbPath!,
      `SELECT id, assistant_id, name, deleted_at FROM topics WHERE id = '${esc(secondTopicId)}'`
    )
    expect(moveRows[0]).toMatchObject({ id: secondTopicId, assistant_id: secondAssistant.id, deleted_at: null })

    const runtimeAppDataPath = getRuntimeAppDataPath()
    expect(runtimeAppDataPath).not.toBeNull()
    const userDataDir = getUserDataDir()
    // Explicit --user-data-dir override is preserved verbatim — no Dev suffix.
    const expectedChildName = path.basename(userDataDir)
    expect(path.basename(runtimeAppDataPath!)).toBe(expectedChildName)

    await electronApp.close()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(fs.existsSync(dbPath!)).toBe(true)
    const postShutdownTopicRows = queryRows(
      dbPath!,
      `SELECT id, assistant_id, name, deleted_at FROM topics WHERE id = '${esc(secondTopicId)}'`
    )
    expect(postShutdownTopicRows).toEqual(moveRows)
    const postShutdownMessageRows = getMessageRows(dbPath!, capturedMessageIds)
    const postShutdownBlockRows = getBlockRows(dbPath!, capturedBlockIds)
    expect(postShutdownMessageRows).toHaveLength(0)
    expect(postShutdownBlockRows).toHaveLength(0)
    console.log(
      `[Phase 5.4] SQLite after shutdown: ${JSON.stringify({
        topic: postShutdownTopicRows,
        expectedAbsentMessageIds: captured.messages.map(({ id, assistantId, content, sortOrder }) => ({
          id,
          assistantId,
          content,
          sortOrder
        })),
        expectedAbsentBlockIds: captured.blocks.map(({ id, messageId, content, sortOrder }) => ({
          id,
          messageId,
          content,
          sortOrder
        })),
        messages: postShutdownMessageRows,
        blocks: postShutdownBlockRows
      })}`
    )
  })
})
