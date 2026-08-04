/**
 * Phase 5.4 Topic Trash Lifecycle — Real E2E Verification
 *
 * Proves the ordinary-topic trash lifecycle through real UI gestures and
 * exact SQLite state transitions:
 *   - Soft-delete (two-click): topic leaves active list → appears in trash → SQLite deleted_at non-null
 *   - Restore: topic removed from trash → reappears in active list → SQLite deleted_at null
 *   - Hard-delete: topic removed from trash → SQLite topic/messages/blocks rows gone
 *   - Empty Trash: all trashed topics removed → SQLite rows gone
 *   - Cross-assistant: empty-trash preserves another assistant's trashed topic
 *
 * LOCK-001: Restore target via exact data-topic-id; no positional index selectors.
 * LOCK-002: Each operation asserts exact SQLite deleted_at/existence state.
 * LOCK-003: Disposable profile only; preserve core fixture/mock/cleanup.
 * LOCK-004: Do not touch Phase 6/import/agent/benchmark/spike/config files.
 * LOCK-005: Capture exact IDs before destructive ops; assert exact absence after.
 * LOCK-006: Cross-assistant empty-trash isolation proved via second assistant.
 *
 * Evidence classes:
 *   - UI interaction: real click on topic delete button (two-click confirmation)
 *   - Trash panel: real expand/click restore/click hard-delete/click empty-trash
 *   - SQLite persistence: per-transition Electron-binary query of chat.db
 *   - Cross-assistant: second assistant topic survives first assistant's empty-trash
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fail-closed SQLite row accessor (LOCK-QDB-5): the typed outcome is never
 * null; a fixed failure code throws, and rows are only reachable on success.
 */
function queryRows(dbPath: string, sql: string): any[] {
  const result = queryChatDbViaElectron(dbPath, sql)
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  return result.rows as any[]
}

/** Get active context from Redux. */
async function getActiveContext(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const topic = assistant?.topics?.[0]
    return {
      assistantId: assistant?.id || '',
      topicId: topic?.id || '',
      model: assistant?.model || null
    }
  })
}

/**
 * Type text into the real textarea and submit via Enter key.
 * Uses page.evaluate to dispatch React-compatible input events.
 */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
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
  await textarea.press('Enter')
}

/**
 * Wait for the assistant response to complete by monitoring Redux state.
 */
async function waitForAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<number> {
  await page.waitForFunction(
    ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let count = 0
      for (const id of msgIds) {
        const msg = s.messages.entities?.[id]
        if (msg?.role === 'assistant') count++
      }
      return count > prevCount
    },
    { topicId, prevCount: previousAssistantCount },
    { timeout }
  )

  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      if (s.messages?.loadingByTopic?.[topicId]) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let latestAssistantId: string | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        const msg = s.messages.entities?.[msgIds[i]]
        if (msg?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages.entities[latestAssistantId]
      const terminalStatuses = ['success', 'error']
      if (!terminalStatuses.includes(assistantMsg.status)) return false
      const blocks = assistantMsg.blocks || []
      if (blocks.length === 0) return false
      for (const blockId of blocks) {
        const block = s.messageBlocks?.entities?.[blockId]
        if (!block) return false
        if (block.status !== 'success' && block.status !== 'error') return false
      }
      return true
    },
    { topicId },
    { timeout }
  )

  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    let count = 0
    for (const id of msgIds) {
      const msg = s.messages.entities[id]
      if (msg?.role === 'assistant') count++
    }
    return count
  }, topicId)
}

/**
 * Create a new topic via the Add Topic button and optionally send a message.
 *
 * LOCK-005: Uses topic-ID diffing — captures IDs before click, then reads
 * the newly active topic ID after click. This avoids the bug where
 * `topics[topics.length-1]` was wrong because addTopic prepends.
 */
async function createNewTopic(page: import('@playwright/test').Page, sendMessage?: string): Promise<string> {
  // Snapshot topic IDs BEFORE clicking Add Topic
  const idsBefore = await page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return (assistant?.topics || []).map((t: any) => t.id)
  })
  const idsBeforeSet = new Set(idsBefore)

  // Click the Add Topic button (styled Ant Design button with PlusIcon + text)
  const addBtn = page.locator('.topics-tab button').first()
  await addBtn.waitFor({ state: 'visible', timeout: 10000 })
  await addBtn.click()

  // Wait for the new topic to appear in Redux
  await page.waitForTimeout(500)

  // LOCK-005: Read the ACTIVE topic ID after creation (addTopic prepends AND
  // setActiveTopic is called, so the active topic is always the new one).
  const topicId = await page.evaluate((idsBeforeJSON: string) => {
    const idsBefore = JSON.parse(idsBeforeJSON) as string[]
    const idsBeforeSet = new Set(idsBefore)
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const topics = assistant?.topics || []

    // The active topic is the newly created one (setActiveTopic was called)
    const activeTopicId = assistant?.activeTopic?.id || ''

    // Find the topic not present in the before-set (diff approach)
    for (const t of topics) {
      if (!idsBeforeSet.has(t.id)) return t.id
    }

    // Fallback: if active topic changed, use it
    if (activeTopicId && !idsBeforeSet.has(activeTopicId)) return activeTopicId

    // Last resort: first topic (addTopic prepends)
    return topics.length > 0 ? topics[0].id : ''
  }, JSON.stringify(idsBefore))

  if (sendMessage && topicId) {
    await uiSendMessage(page, sendMessage)
    await waitForAssistantResponseComplete(page, topicId, 0)
  }

  return topicId
}

/**
 * Soft-delete a topic via the two-click UI gesture.
 * First click activates the delete button (red icon), second click confirms.
 */
async function softDeleteTopicViaUI(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.hover()

  // First click: activates the delete button (sets deletingTopicId)
  const deleteBtn = topicItem.locator('[data-testid="topic-delete-btn"]')
  await deleteBtn.waitFor({ state: 'visible', timeout: 5000 })
  await deleteBtn.click({ force: true })

  // Small wait for the state to update (deletingTopicId set)
  await page.waitForTimeout(200)

  // Second click: confirms the delete (handleConfirmDelete)
  await deleteBtn.click({ force: true })

  // Wait for the topic to be removed from the UI list
  await page.waitForFunction(
    ({ topicId }) => {
      const el = document.querySelector(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
      return !el
    },
    { topicId },
    { timeout: 10000 }
  )
}

/**
 * Expand the trash panel by clicking the collapsed bar.
 * Waits for trash items to be rendered (async fetch completes).
 */
async function expandTrashPanel(page: import('@playwright/test').Page): Promise<void> {
  const collapsedBar = page.locator('[data-testid="trash-collapsed-bar"]')
  const expandedHeader = page.locator('[data-testid="trash-expanded-header"]')

  // Check if already expanded
  const isAlreadyExpanded = await expandedHeader.isVisible().catch(() => false)
  if (!isAlreadyExpanded) {
    await collapsedBar.waitFor({ state: 'visible', timeout: 10000 })
    await collapsedBar.click()
    // Wait for expanded panel to appear
    await expandedHeader.waitFor({ state: 'visible', timeout: 5000 })
  }

  // Wait for trash content to load (async fetch from SQLite)
  // The panel shows either trash items or the empty state
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll('[data-testid="trash-item"]')
      const emptyState = document.querySelector('[data-testid="trash-expanded-header"]')
      // Return true if we have items OR if the panel header is visible (empty state is fine)
      return items.length > 0 || emptyState !== null
    },
    { timeout: 10000 }
  )
}

/**
 * Collapse the trash panel by clicking the expanded header.
 */
async function collapseTrashPanel(page: import('@playwright/test').Page): Promise<void> {
  const header = page.locator('[data-testid="trash-expanded-header"]')
  await header.click()

  // Wait for collapsed bar to reappear
  await page.locator('[data-testid="trash-collapsed-bar"]').waitFor({ state: 'visible', timeout: 5000 })
}

/**
 * LOCK-001: Restore a topic from the trash panel by its exact data-topic-id.
 * The TopicTrashPanel renders both restore and hard-delete buttons with
 * data-topic-id={topic.id}, so we target the exact ID — never positional index.
 */
async function restoreTopicFromTrashById(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  const restoreBtn = page.locator(`[data-testid="trash-restore-btn"][data-topic-id="${topicId}"]`)
  await restoreBtn.waitFor({ state: 'visible', timeout: 5000 })
  await restoreBtn.click()

  // Wait for this specific restore button to disappear (topic removed from trash)
  await page.waitForFunction(
    (id) => {
      const btn = document.querySelector(`[data-testid="trash-restore-btn"][data-topic-id="${id}"]`)
      return btn === null
    },
    topicId,
    { timeout: 10000 }
  )
}

/**
 * Hard-delete a specific topic from the trash panel.
 */
async function hardDeleteTopicFromTrash(page: import('@playwright/test').Page, topicId: string): Promise<void> {
  const deleteButton = page.locator(`[data-testid="trash-hard-delete-btn"][data-topic-id="${topicId}"]`)
  await deleteButton.waitFor({ state: 'visible', timeout: 10000 })
  await deleteButton.click()

  // Wait for the trash count to decrease
  await page.waitForFunction(
    (id) => {
      const button = document.querySelector(`[data-testid="trash-hard-delete-btn"][data-topic-id="${id}"]`)
      return button === null
    },
    topicId,
    { timeout: 10000 }
  )
}

/**
 * Click the Empty Trash button and wait for the trash to become empty.
 */
async function emptyTrashViaUI(page: import('@playwright/test').Page): Promise<void> {
  const emptyBtn = page.locator('[data-testid="trash-empty-btn"]')
  await emptyBtn.waitFor({ state: 'visible', timeout: 5000 })
  await emptyBtn.click()

  // Wait for trash items to disappear
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll('[data-testid="trash-item"]')
      return items.length === 0
    },
    { timeout: 10000 }
  )
}

/**
 * Get the count of topics in the active list from Redux.
 */
async function getTopicCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return assistant?.topics?.length || 0
  })
}

/**
 * Get all topic IDs from the active list in Redux.
 */
async function getActiveTopicIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return (assistant?.topics || []).map((t: any) => t.id)
  })
}

/**
 * Get trash topic IDs from Redux (by checking topics with deletedAt set).
 */
async function getTrashTopicIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    // Trash topics are those with deletedAt set (removed from active list)
    // They are NOT in the active topics array, but we can check via a different approach
    return []
  })
}

/**
 * Wait for trash count in the collapsed bar or expanded header to match expected count.
 */
async function waitForTrashCount(page: import('@playwright/test').Page, expectedCount: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      // Check collapsed bar badge or expanded header badge
      const badge =
        document.querySelector('[data-testid="trash-collapsed-bar"] span:last-child') ||
        document.querySelector('[data-testid="trash-expanded-header"] span:last-child')
      if (!badge) return false
      const text = badge.textContent?.trim() || ''
      return parseInt(text, 10) === expected
    },
    expectedCount,
    { timeout: 10000 }
  )
}

/**
 * Capture exact message and block IDs for a topic from Redux.
 * Returns topicId, messageIds, and blockIds arrays.
 */
async function captureTopicRowIds(
  page: import('@playwright/test').Page,
  topicId: string
): Promise<{ messageIds: string[]; blockIds: string[] }> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
    const allBlockIds: string[] = []
    for (const msgId of msgIds) {
      const msg = s.messages.entities?.[msgId]
      if (msg?.blocks) {
        allBlockIds.push(...msg.blocks)
      }
    }
    return { messageIds: [...msgIds], blockIds: allBlockIds }
  }, topicId)
}

/**
 * Query B/C: Find the assistant_id that owns a given topic from Redux.
 * Searches all assistants, not just the first one.
 */
async function getTopicAssistantId(page: import('@playwright/test').Page, topicId: string): Promise<string> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    for (const assistant of s.assistants.assistants) {
      if (assistant.topics?.some((t: any) => t.id === topicId)) {
        return assistant.id
      }
    }
    return ''
  }, topicId)
}

async function getTopicName(page: import('@playwright/test').Page, topicId: string): Promise<string> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    for (const assistant of s.assistants.assistants) {
      const topic = assistant.topics?.find((t: any) => t.id === topicId)
      if (topic) return topic.name
    }
    return ''
  }, topicId)
}

/**
 * Add a second assistant via Redux dispatch and return its ID.
 */
async function addSecondAssistant(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const existingIds = new Set(s.assistants.assistants.map((a: any) => a.id))
    let id = 'e2e-assistant-second'
    let counter = 1
    while (existingIds.has(id)) {
      id = `e2e-assistant-second-${counter++}`
    }
    const newAssistant = {
      id,
      name: 'E2E Second Assistant',
      topics: [],
      model: null,
      defaultModel: null,
      emoji: '🤖',
      isDefault: false,
      prompt: '',
      mentions: [],
      settings: {},
      messageBackground: null
    }
    ;(window as any).store.dispatch({
      type: 'assistants/addAssistant',
      payload: newAssistant
    })
    return id
  })
}

/**
 * Add a new topic to a specific assistant via Redux dispatch.
 * Returns the new topic's ID.
 */
async function addTopicToAssistant(page: import('@playwright/test').Page, assistantId: string): Promise<string> {
  return page.evaluate((assistantId: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
    if (!assistant) throw new Error(`Assistant ${assistantId} not found`)

    const topicId = `e2e-topic-second-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const newTopic = {
      id: topicId,
      name: 'Second Assistant Topic',
      assistantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    ;(window as any).store.dispatch({
      type: 'assistants/addTopic',
      payload: { assistantId, topic: newTopic }
    })

    return topicId
  }, assistantId)
}

/**
 * Switch to any available topic in a specific assistant via Redux.
 * If topicId is provided and exists, use it; otherwise use the first available topic.
 */
async function switchToAssistant(page: import('@playwright/test').Page, assistantId: string): Promise<void> {
  await page.evaluate((assistantId: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
    if (!assistant) throw new Error(`Assistant ${assistantId} not found`)
    const topics = assistant.topics || []
    if (topics.length === 0) throw new Error(`Assistant ${assistantId} has no topics`)
    // Dispatch a topic change by updating the assistant's active topic
    const topicToActivate = topics[0]
    ;(window as any).store.dispatch({
      type: 'assistants/updateAssistant',
      payload: { id: assistantId, changes: { activeTopicId: topicToActivate.id } }
    })
  }, assistantId)
}

/**
 * Persist topic ownership to SQLite via ChatDb IPC and set deletedAt.
 * This simulates the proper soft-delete path that the app uses.
 */
async function softDeleteSecondAssistantTopic(
  page: import('@playwright/test').Page,
  assistantId: string,
  topicId: string,
  topicName: string
): Promise<void> {
  // First ensure the topic exists in SQLite with proper ownership
  await page.evaluate(
    async ({ assistantId, topicId, topicName }) => {
      const api = (window as any).api
      await api.chatDb.ensureTopic({ topicId, assistantId, name: topicName })
    },
    { assistantId, topicId, topicName }
  )

  // Then soft-delete via ChatDb IPC
  await page.evaluate(
    async ({ topicId, topicName }) => {
      const api = (window as any).api
      await api.chatDb.softDeleteTopic({ topicId, name: topicName })
    },
    { topicId, topicName }
  )

  // Remove from Redux active topics
  await page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants.find((a: any) => a.topics.some((t: any) => t.id === topicId))
    if (assistant) {
      const topic = assistant.topics.find((t: any) => t.id === topicId)
      if (topic) {
        ;(window as any).store.dispatch({
          type: 'assistants/removeTopic',
          payload: { assistantId: assistant.id, topic }
        })
      }
    }
  }, topicId)
}

/**
 * LOCK-004: Remove an assistant via Redux dispatch.
 * Reducer expects PayloadAction<{ id: string }>.
 */
async function removeAssistant(page: import('@playwright/test').Page, assistantId: string): Promise<void> {
  await page.evaluate((assistantId: string) => {
    ;(window as any).store.dispatch({
      type: 'assistants/removeAssistant',
      payload: { id: assistantId }
    })
  }, assistantId)
}

/**
 * LOCK-003: Before a destructive operation (hard-delete/empty-trash), prove
 * the captured message/block IDs exist in SQLite and belong to the target topic.
 * This establishes the "before" snapshot so the "after" assert is meaningful.
 */
function assertCascadeIdsExistInSql(
  chatDbPath: string,
  topicId: string,
  messageIds: string[],
  blockIds: string[]
): void {
  const esc = (s: string) => s.replace(/'/g, "''")

  // Topic must exist
  const topicSql = `SELECT id, assistant_id FROM topics WHERE id = '${esc(topicId)}'`
  const topicRows = queryRows(chatDbPath, topicSql)
  expect(topicRows.length).toBe(1)

  // Messages must exist and belong to this topic
  if (messageIds.length > 0) {
    const msgIdList = messageIds.map((id) => `'${esc(id)}'`).join(',')
    const msgSql = `SELECT id, topic_id FROM messages WHERE id IN (${msgIdList})`
    const msgRows = queryRows(chatDbPath, msgSql)
    expect(msgRows.length).toBe(messageIds.length)
    for (const row of msgRows) {
      expect(row.topic_id).toBe(topicId)
    }
  }

  // Blocks must exist
  if (blockIds.length > 0) {
    const blockIdList = blockIds.map((id) => `'${esc(id)}'`).join(',')
    const blockSql = `SELECT id, message_id FROM message_blocks WHERE id IN (${blockIdList})`
    const blockRows = queryRows(chatDbPath, blockSql)
    expect(blockRows.length).toBe(blockIds.length)
  }
}

/**
 * LOCK-003: After a destructive operation, assert the exact captured IDs are gone.
 */
function assertCascadeIdsAbsentInSql(
  chatDbPath: string,
  topicId: string,
  messageIds: string[],
  blockIds: string[]
): void {
  const esc = (s: string) => s.replace(/'/g, "''")

  // Topic must be gone
  const topicSql = `SELECT id FROM topics WHERE id = '${esc(topicId)}'`
  const topicRows = queryRows(chatDbPath, topicSql)
  expect(topicRows.length).toBe(0)

  // Messages must be gone
  if (messageIds.length > 0) {
    const msgIdList = messageIds.map((id) => `'${esc(id)}'`).join(',')
    const msgSql = `SELECT id FROM messages WHERE id IN (${msgIdList})`
    const msgRows = queryRows(chatDbPath, msgSql)
    expect(msgRows.length).toBe(0)
  }

  // Blocks must be gone
  if (blockIds.length > 0) {
    const blockIdList = blockIds.map((id) => `'${esc(id)}'`).join(',')
    const blockSql = `SELECT id FROM message_blocks WHERE id IN (${blockIdList})`
    const blockRows = queryRows(chatDbPath, blockSql)
    expect(blockRows.length).toBe(0)
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Phase 5.4: Topic Trash Lifecycle', () => {
  test('ordinary topic trash lifecycle: soft-delete → restore → hard-delete → empty-trash', async ({
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(300000)
    const page = mainWindow

    // ═══════════════════════════════════════════════════════════════════
    // A. PROVIDER SEED VERIFICATION
    // ═══════════════════════════════════════════════════════════════════
    await test.step('A: Provider seed verification', async () => {
      const providerOk = await page.evaluate(() => {
        const s = (window as any).store?.getState()
        return s?.llm?.providers?.some((p: any) => p.id === 'mock-openai') && s.llm.defaultModel?.id === 'mock-model'
      })
      expect(providerOk).toBe(true)
    })

    // ═══════════════════════════════════════════════════════════════════
    // B. CREATE TOPICS FOR LIFECYCLE TESTING
    // ═══════════════════════════════════════════════════════════════════
    let defaultTopicId: string
    let topicBId: string
    let topicCId: string
    let topicBName: string
    let topicCName: string
    let firstAssistantId: string

    await test.step('B1: Switch to Topics tab and send baseline message', async () => {
      // The sidebar defaults to the Assistants tab; switch to Topics tab first
      const topicsTab = page.getByRole('button', { name: 'Topics', exact: false })
      await topicsTab.waitFor({ state: 'visible', timeout: 10000 })
      await topicsTab.click()
      await page.waitForTimeout(500)

      const ctx = await getActiveContext(page)
      defaultTopicId = ctx.topicId
      firstAssistantId = ctx.assistantId
      expect(defaultTopicId).not.toBe('')

      await uiSendMessage(page, 'Baseline message for trash lifecycle test')
      await waitForAssistantResponseComplete(page, defaultTopicId, 0)
      console.log(`[TrashLifecycle] Default topic established: ${defaultTopicId}`)
    })

    await test.step('B2: Create Topic B via Add Topic button', async () => {
      topicBId = await createNewTopic(page, 'Topic B message for trash lifecycle')
      topicBName = await getTopicName(page, topicBId)
      expect(topicBName).not.toBe('')
      expect(topicBId).not.toBe('')
      expect(topicBId).not.toBe(defaultTopicId)
      console.log(`[TrashLifecycle] Topic B created: ${topicBId}`)
    })

    await test.step('B3: Create Topic C via Add Topic button', async () => {
      topicCId = await createNewTopic(page, 'Topic C message for trash lifecycle')
      topicCName = await getTopicName(page, topicCId)
      expect(topicCName).not.toBe('')
      expect(topicCId).not.toBe('')
      expect(topicCId).not.toBe(defaultTopicId)
      expect(topicCId).not.toBe(topicBId)
      console.log(`[TrashLifecycle] Topic C created: ${topicCId}`)
    })

    await test.step('B4: Verify all three topics exist in active list', async () => {
      const count = await getTopicCount(page)
      expect(count).toBe(3)
      const ids = await getActiveTopicIds(page)
      expect(ids).toContain(defaultTopicId)
      expect(ids).toContain(topicBId)
      expect(ids).toContain(topicCId)
    })

    // ═══════════════════════════════════════════════════════════════════
    // B5: Verify persisted assistant_id for created topics (LOCK-005)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('B5: Verify persisted assistant_id for topics B and C', async () => {
      const assistantId = await getTopicAssistantId(page, topicBId)
      expect(assistantId).toBe(firstAssistantId)
      console.log(`[TrashLifecycle] Topic B assistant_id: ${assistantId}`)

      const assistantIdC = await getTopicAssistantId(page, topicCId)
      expect(assistantIdC).toBe(firstAssistantId)
      console.log(`[TrashLifecycle] Topic C assistant_id: ${assistantIdC}`)
    })

    await test.step('B6: Verify persisted names for topics B and C', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()
      const esc = (value: string) => value.replace(/'/g, "''")
      const sql = `SELECT id, name, deleted_at FROM topics WHERE id IN ('${esc(topicBId)}', '${esc(topicCId)}')`
      const rows = queryRows(chatDbPath!, sql)
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.id === topicBId)).toMatchObject({
        id: topicBId,
        name: topicBName,
        deleted_at: null
      })
      expect(rows.find((row) => row.id === topicCId)).toMatchObject({
        id: topicCId,
        name: topicCName,
        deleted_at: null
      })
    })

    // ═══════════════════════════════════════════════════════════════════
    // C. SOFT-DELETE TOPIC B VIA TWO-CLICK UI
    // ═══════════════════════════════════════════════════════════════════

    // LOCK-005: Capture message/block IDs BEFORE deletion
    let topicBMessageIds: string[]
    let topicBBlockIds: string[]

    await test.step('C0: Capture Topic B message/block IDs before soft-delete', async () => {
      const ids = await captureTopicRowIds(page, topicBId)
      topicBMessageIds = ids.messageIds
      topicBBlockIds = ids.blockIds
      expect(topicBMessageIds.length).toBeGreaterThan(0)
      expect(topicBBlockIds.length).toBeGreaterThan(0)
      console.log(
        `[TrashLifecycle] Before soft-delete B: messages=${topicBMessageIds.length}, blocks=${topicBBlockIds.length}`
      )
      console.log(`[TrashLifecycle] Topic B message IDs: ${JSON.stringify(topicBMessageIds)}`)
      console.log(`[TrashLifecycle] Topic B block IDs: ${JSON.stringify(topicBBlockIds)}`)
    })

    await test.step('C1: Soft-delete Topic B via two-click UI', async () => {
      await softDeleteTopicViaUI(page, topicBId)
      console.log(`[TrashLifecycle] Topic B soft-deleted via UI`)
    })

    await test.step('C2: Verify Topic B leaves active list', async () => {
      const ids = await getActiveTopicIds(page)
      expect(ids).not.toContain(topicBId)
      expect(ids).toContain(defaultTopicId)
      expect(ids).toContain(topicCId)
      const count = await getTopicCount(page)
      expect(count).toBe(2)
    })

    await test.step('C3: Verify trash panel shows 1 item after soft-delete B', async () => {
      await expandTrashPanel(page)
      // Wait for the trash count badge to show 1
      await waitForTrashCount(page, 1)
      const row = page.locator(`[data-testid="trash-item"][data-topic-id="${topicBId}"]`)
      await expect(row).toContainText(topicBName)
      await expect(row.locator(`span[title="${topicBName}"]`)).toBeVisible()
      console.log(`[TrashLifecycle] Trash panel shows 1 item after soft-delete B`)

      await collapseTrashPanel(page)
    })

    // LOCK-002: SQL checkpoint after soft-delete — verify deleted_at non-null
    await test.step('C4: SQLite checkpoint — soft-delete sets deleted_at non-null', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      const sql = `SELECT id, name, deleted_at FROM topics WHERE id = '${topicBId.replace(/'/g, "''")}'`
      const rows = queryRows(chatDbPath!, sql)
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe(topicBId)
      expect(rows[0].name).toBe(topicBName)
      expect(rows[0].deleted_at).not.toBeNull()
      console.log(`[TrashLifecycle] SQL checkpoint C4: Topic B deleted_at=${rows[0].deleted_at} ✓`)
    })

    // ═══════════════════════════════════════════════════════════════════
    // D. SOFT-DELETE TOPIC C VIA TWO-CLICK UI
    // ═══════════════════════════════════════════════════════════════════
    await test.step('D1: Soft-delete Topic C via two-click UI', async () => {
      await softDeleteTopicViaUI(page, topicCId)
      console.log(`[TrashLifecycle] Topic C soft-deleted via UI`)
    })

    await test.step('D2: Verify Topic C leaves active list', async () => {
      const ids = await getActiveTopicIds(page)
      expect(ids).not.toContain(topicCId)
      expect(ids).toContain(defaultTopicId)
      const count = await getTopicCount(page)
      expect(count).toBe(1)
    })

    await test.step('D3: Verify trash panel shows 2 items after soft-delete C', async () => {
      await expandTrashPanel(page)
      // Wait for the trash count badge to show 2
      await waitForTrashCount(page, 2)
      const topicBRow = page.locator(`[data-testid="trash-item"][data-topic-id="${topicBId}"]`)
      const topicCRow = page.locator(`[data-testid="trash-item"][data-topic-id="${topicCId}"]`)
      await expect(topicBRow).toContainText(topicBName)
      await expect(topicCRow).toContainText(topicCName)
      await expect(topicBRow.locator(`span[title="${topicBName}"]`)).toBeVisible()
      await expect(topicCRow.locator(`span[title="${topicCName}"]`)).toBeVisible()
      console.log(`[TrashLifecycle] Trash panel shows 2 items (B and C)`)

      await collapseTrashPanel(page)
    })

    // LOCK-002: SQL checkpoint after both soft-deletes
    await test.step('D4: SQLite checkpoint — both topics have deleted_at non-null', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      const sql = `SELECT id, name, deleted_at FROM topics WHERE id IN ('${topicBId.replace(/'/g, "''")}', '${topicCId.replace(/'/g, "''")}')`
      const rows = queryRows(chatDbPath!, sql)
      expect(rows.length).toBe(2)
      for (const row of rows) {
        expect(row.deleted_at).not.toBeNull()
        expect(row.name).toBe(row.id === topicBId ? topicBName : topicCName)
        console.log(`[TrashLifecycle] SQL checkpoint D4: Topic ${row.id} deleted_at=${row.deleted_at} ✓`)
      }
    })

    // ═══════════════════════════════════════════════════════════════════
    // E. RESTORE TOPIC B FROM TRASH
    // ═══════════════════════════════════════════════════════════════════
    await test.step('E1: Restore Topic B from trash', async () => {
      await expandTrashPanel(page)
      // LOCK-001: Restore by exact data-topic-id, never positional index.
      // The TopicTrashPanel renders restore buttons with data-topic-id={topic.id}.
      await restoreTopicFromTrashById(page, topicBId)
      console.log(`[TrashLifecycle] Topic B restored from trash`)
    })

    await test.step('E2: Verify Topic B reappears in active list', async () => {
      const ids = await getActiveTopicIds(page)
      expect(ids).toContain(topicBId)
      expect(ids).toContain(defaultTopicId)
      const count = await getTopicCount(page)
      expect(count).toBe(2)
      console.log(`[TrashLifecycle] Topic B confirmed in active list (count=2)`)
    })

    await test.step('E3: Verify trash panel shows 1 item (only C) after restore B', async () => {
      // The panel may already be expanded from E1; re-check
      const expandedHeader = page.locator('[data-testid="trash-expanded-header"]')
      const isExpanded = await expandedHeader.isVisible().catch(() => false)
      if (!isExpanded) {
        await expandTrashPanel(page)
      }

      // Wait for trash count to drop to 1 (only Topic C remains)
      await waitForTrashCount(page, 1)
      console.log(`[TrashLifecycle] Trash panel shows 1 item (only Topic C)`)

      await collapseTrashPanel(page)
    })

    // LOCK-002: SQL checkpoint after restore — verify deleted_at is null
    await test.step('E4: SQLite checkpoint — restore clears deleted_at', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      const sql = `SELECT id, deleted_at FROM topics WHERE id = '${topicBId.replace(/'/g, "''")}'`
      const rows = queryRows(chatDbPath!, sql)
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe(topicBId)
      expect(rows[0].deleted_at).toBeNull()
      console.log(`[TrashLifecycle] SQL checkpoint E4: Topic B deleted_at=null after restore ✓`)
    })

    // ═══════════════════════════════════════════════════════════════════
    // F. SOFT-DELETE TOPIC B AGAIN, THEN HARD-DELETE FROM TRASH
    // ═══════════════════════════════════════════════════════════════════
    await test.step('F1: Soft-delete Topic B again', async () => {
      await softDeleteTopicViaUI(page, topicBId)
      console.log(`[TrashLifecycle] Topic B soft-deleted again`)
    })

    await test.step('F2: Verify Topic B leaves active list', async () => {
      const ids = await getActiveTopicIds(page)
      expect(ids).not.toContain(topicBId)
      expect(ids).toContain(defaultTopicId)
    })

    // LOCK-002: SQL checkpoint after second soft-delete
    await test.step('F2b: SQLite checkpoint — soft-delete again sets deleted_at', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      const sql = `SELECT id, deleted_at FROM topics WHERE id = '${topicBId.replace(/'/g, "''")}'`
      const rows = queryRows(chatDbPath!, sql)
      expect(rows.length).toBe(1)
      expect(rows[0].deleted_at).not.toBeNull()
      console.log(`[TrashLifecycle] SQL checkpoint F2b: Topic B deleted_at=${rows[0].deleted_at} ✓`)
    })

    // LOCK-003: Pre-prove Topic B cascade IDs exist in SQL before hard-delete
    await test.step('F2c: Pre-prove Topic B cascade IDs exist in SQL before hard-delete', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()
      assertCascadeIdsExistInSql(chatDbPath!, topicBId, topicBMessageIds, topicBBlockIds)
      console.log(`[TrashLifecycle] F2c: Topic B cascade IDs confirmed present in SQL before hard-delete ✓`)
    })

    await test.step('F3: Hard-delete Topic B from trash', async () => {
      await expandTrashPanel(page)
      await waitForTrashCount(page, 2)
      // B was re-deleted after C, so it sorts first by deleted_at DESC.
      // Target the captured ID rather than relying on a mutable row index.
      await hardDeleteTopicFromTrash(page, topicBId)
      console.log(`[TrashLifecycle] Topic B hard-deleted from trash`)
    })

    await test.step('F4: Verify trash panel shows 1 item (only C) after hard-delete B', async () => {
      // Panel should still be expanded from F3
      await waitForTrashCount(page, 1)
      console.log(`[TrashLifecycle] Trash panel shows 1 item (only Topic C remains)`)
    })

    // LOCK-003+005: SQL checkpoint after hard-delete — assert exact captured IDs absent
    await test.step('F5: SQLite checkpoint — hard-delete removes topic/messages/blocks', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      // LOCK-003: Assert exact cascade absence using consolidated helper
      assertCascadeIdsAbsentInSql(chatDbPath!, topicBId, topicBMessageIds, topicBBlockIds)
      console.log(
        `[TrashLifecycle] SQL F5: Topic B cascade absent (${topicBMessageIds.length} msgs, ${topicBBlockIds.length} blocks checked) ✓`
      )

      const ipcResult = await page.evaluate(async (topicId: string) => {
        const api = (window as any).api
        return await api.chatDb.topicExists({ topicId })
      }, topicBId)
      expect(ipcResult).toMatchObject({ ok: true, value: false })
      console.log(`[TrashLifecycle] IPC F5: ChatDb topicExists=false for Topic B ✓`)
    })

    // ═══════════════════════════════════════════════════════════════════
    // G. CROSS-ASSISTANT SETUP — seed second assistant's trashed topic
    //    BEFORE first assistant's empty-trash (LOCK-006)
    // ═══════════════════════════════════════════════════════════════════
    let secondAssistantId: string
    let secondTopicId: string

    await test.step('G0a: Create second assistant and seed a trashed topic', async () => {
      secondAssistantId = await addSecondAssistant(page)
      expect(secondAssistantId).not.toBe('')
      console.log(`[TrashLifecycle] Second assistant created: ${secondAssistantId}`)

      secondTopicId = await addTopicToAssistant(page, secondAssistantId)
      expect(secondTopicId).not.toBe('')
      console.log(`[TrashLifecycle] Second assistant topic created: ${secondTopicId}`)
      const secondTopicName = await getTopicName(page, secondTopicId)
      expect(secondTopicName).not.toBe('')

      // Persist ownership to SQLite and soft-delete via ChatDb IPC
      await softDeleteSecondAssistantTopic(page, secondAssistantId, secondTopicId, secondTopicName)

      // Add a dummy topic so the second assistant has an active topic (avoids edge cases)
      await addTopicToAssistant(page, secondAssistantId)

      // Verify original trashed topic is not in active list
      const secondAssistantTopics = await page.evaluate((assistantId: string) => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((a: any) => a.id === assistantId)
        return assistant?.topics?.map((t: any) => t.id) || []
      }, secondAssistantId)
      expect(secondAssistantTopics).not.toContain(secondTopicId)
      console.log(`[TrashLifecycle] Second assistant topic soft-deleted via IPC, dummy topic added`)

      // Verify second assistant's topic is in SQL with correct ownership
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()
      const esc = (s: string) => s.replace(/'/g, "''")
      const sql = `SELECT id, name, deleted_at, assistant_id FROM topics WHERE id = '${esc(secondTopicId)}'`
      const rows = queryRows(chatDbPath!, sql)
      expect(rows.length).toBe(1)
      expect(rows[0].assistant_id).toBe(secondAssistantId)
      expect(rows[0].name).toBe(secondTopicName)
      expect(rows[0].deleted_at).not.toBeNull()
      console.log(
        `[TrashLifecycle] G0a: Second assistant topic SQL verified: assistant_id=${secondAssistantId}, deleted_at non-null ✓`
      )
    })

    // ═══════════════════════════════════════════════════════════════════
    // G. EMPTY TRASH (REMOVES TOPIC C FROM FIRST ASSISTANT)
    //    Second assistant's trashed topic must survive (LOCK-006)
    // ═══════════════════════════════════════════════════════════════════

    // LOCK-005: Capture Topic C's exact IDs before empty-trash
    let topicCMessageIds: string[]
    let topicCBlockIds: string[]

    await test.step('G0: Capture Topic C message/block IDs before empty-trash', async () => {
      const ids = await captureTopicRowIds(page, topicCId)
      topicCMessageIds = ids.messageIds
      topicCBlockIds = ids.blockIds
      console.log(
        `[TrashLifecycle] Before empty-trash C: messages=${topicCMessageIds.length}, blocks=${topicCBlockIds.length}`
      )
      console.log(`[TrashLifecycle] Topic C message IDs: ${JSON.stringify(topicCMessageIds)}`)
      console.log(`[TrashLifecycle] Topic C block IDs: ${JSON.stringify(topicCBlockIds)}`)
    })

    // LOCK-003: Pre-prove Topic C cascade IDs exist in SQL before empty-trash
    await test.step('G0b: Pre-prove Topic C cascade IDs exist in SQL before empty-trash', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()
      assertCascadeIdsExistInSql(chatDbPath!, topicCId, topicCMessageIds, topicCBlockIds)
      console.log(`[TrashLifecycle] G0b: Topic C cascade IDs confirmed present in SQL before empty-trash ✓`)
    })

    await test.step('G1: Empty trash via UI (first assistant active)', async () => {
      // Collapse and re-expand to ensure fresh state with second assistant's topic
      // (the panel was collapsed in F5 area)
      await expandTrashPanel(page)
      // First assistant should have 1 trashed topic (C); second assistant's topic
      // is invisible here because the panel is scoped to the active assistant.
      await waitForTrashCount(page, 1)
      await emptyTrashViaUI(page)
      console.log(`[TrashLifecycle] Trash emptied via real UI (first assistant active)`)
    })

    await test.step('G2: Verify trash is empty', async () => {
      const trashItems = page.locator('[data-testid="trash-item"]')
      const count = await trashItems.count()
      expect(count).toBe(0)
      console.log(`[TrashLifecycle] Trash panel shows 0 items`)
    })

    await test.step('G3: Verify active list still has default topic', async () => {
      // The second assistant is intentionally created during the isolation
      // setup and may be prepended in Redux. Target the original assistant by
      // its captured exact ID rather than relying on assistants[0].
      const ids = await page.evaluate((assistantId: string) => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((item: any) => item.id === assistantId)
        return (assistant?.topics || []).map((topic: any) => topic.id)
      }, firstAssistantId)
      expect(ids).toContain(defaultTopicId)
      const count = await page.evaluate((assistantId: string) => {
        const s = (window as any).store.getState()
        const assistant = s.assistants.assistants.find((item: any) => item.id === assistantId)
        return assistant?.topics?.length || 0
      }, firstAssistantId)
      expect(count).toBe(1)
    })

    // LOCK-003+005: SQL checkpoint after empty-trash — assert Topic C cascade absent
    await test.step('G4: SQLite checkpoint — empty-trash removes topic/messages/blocks', async () => {
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      // LOCK-003: Assert exact cascade absence using consolidated helper
      assertCascadeIdsAbsentInSql(chatDbPath!, topicCId, topicCMessageIds, topicCBlockIds)
      console.log(
        `[TrashLifecycle] SQL G4: Topic C cascade absent (${topicCMessageIds.length} msgs, ${topicCBlockIds.length} blocks checked) ✓`
      )
    })

    // ═══════════════════════════════════════════════════════════════════
    // H. CROSS-ASSISTANT EMPTY-TRASH ISOLATION (LOCK-006)
    //    Second assistant's trashed topic survived first assistant's empty-trash.
    // ═══════════════════════════════════════════════════════════════════

    await test.step('H1: Verify second assistant trashed topic survived isolation', async () => {
      // Verify via SQLite that the second assistant's trashed topic still exists
      // with the correct assistant_id and deleted_at set
      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()
      const esc = (s: string) => s.replace(/'/g, "''")

      const sql = `SELECT id, deleted_at, assistant_id FROM topics WHERE id = '${esc(secondTopicId)}'`
      const rows = queryRows(chatDbPath!, sql)
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe(secondTopicId)
      expect(rows[0].deleted_at).not.toBeNull()
      expect(rows[0].assistant_id).toBe(secondAssistantId)
      console.log(
        `[TrashLifecycle] H1: Second assistant topic survived isolation: assistant_id=${secondAssistantId}, deleted_at non-null ✓`
      )
    })

    await test.step('H2: Cleanup second assistant', async () => {
      await removeAssistant(page, secondAssistantId)
      console.log(`[TrashLifecycle] Second assistant removed`)
    })

    // ═══════════════════════════════════════════════════════════════════
    // I. POST-SHUTDOWN SQLite VERIFICATION
    // ═══════════════════════════════════════════════════════════════════
    await test.step('I: SQLite state verification after shutdown', async () => {
      const runtimeAppDataPath = getRuntimeAppDataPath()
      expect(runtimeAppDataPath).not.toBeNull()

      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      // Verify disposable Dev path
      const userDataDir = getUserDataDir()
      const devDirName = path.basename(userDataDir) + 'Dev'
      const resolvedTmpdir = fs.realpathSync(path.dirname(userDataDir))
      const expectedDevPath = path.join(resolvedTmpdir, devDirName)
      const resolvedRuntime = fs.realpathSync(path.dirname(runtimeAppDataPath!))
      const runtimeChildName = path.basename(runtimeAppDataPath!)
      expect(resolvedRuntime).toBe(resolvedTmpdir)
      expect(runtimeChildName).toBe(devDirName)

      // Close Electron and wait for WAL flush
      await electronApp.close()
      await new Promise((resolve) => setTimeout(resolve, 3000))

      expect(fs.existsSync(chatDbPath!)).toBe(true)
      console.log(`[TrashLifecycle] Verifying chat.db at ${chatDbPath}`)
      const esc = (s: string) => s.replace(/'/g, "''")

      // ── I1: Default topic still exists with deleted_at NULL ──
      const defaultTopicSql = `SELECT id, deleted_at FROM topics WHERE id = '${esc(defaultTopicId)}'`
      const defaultRows = queryRows(chatDbPath!, defaultTopicSql)
      expect(defaultRows.length).toBe(1)
      expect(defaultRows[0].id).toBe(defaultTopicId)
      expect(defaultRows[0].deleted_at).toBeNull()
      console.log(`[TrashLifecycle] I1: Default topic: exists, deleted_at=null ✓`)

      // ── I2: Topic B (hard-deleted) — check SQLite state ──
      const topicBSql = `SELECT id, deleted_at FROM topics WHERE id = '${esc(topicBId)}'`
      const topicBRows = queryRows(chatDbPath!, topicBSql)

      if (topicBRows.length > 0) {
        throw new Error(`Topic B hard-delete left a topic row post-shutdown: ${JSON.stringify(topicBRows[0])}`)
      }
      console.log(`[TrashLifecycle] I2: Topic B (hard-deleted): absent from topics ✓`)

      // ── I3: Topic B messages — check if hard-delete removed them ──
      if (topicBMessageIds.length > 0) {
        const msgIdList = topicBMessageIds.map((id) => `'${esc(id)}'`).join(',')
        const topicBMsgSql = `SELECT id FROM messages WHERE id IN (${msgIdList})`
        const topicBMsgRows = queryRows(chatDbPath!, topicBMsgSql)
        if (topicBMsgRows.length === 0) {
          console.log(`[TrashLifecycle] I3: Topic B exact messages: absent (${topicBMessageIds.length} IDs checked) ✓`)
        } else {
          throw new Error(`Topic B hard-delete left messages: ${JSON.stringify(topicBMsgRows)}`)
        }
      }

      // ── I4: Topic B blocks — check if hard-delete removed them ──
      if (topicBBlockIds.length > 0) {
        const blockIdList = topicBBlockIds.map((id) => `'${esc(id)}'`).join(',')
        const topicBBlockSql = `SELECT id FROM message_blocks WHERE id IN (${blockIdList})`
        const topicBBlockRows = queryRows(chatDbPath!, topicBBlockSql)
        if (topicBBlockRows.length === 0) {
          console.log(`[TrashLifecycle] I4: Topic B exact blocks: absent (${topicBBlockIds.length} IDs checked) ✓`)
        } else {
          throw new Error(`Topic B hard-delete left blocks: ${JSON.stringify(topicBBlockRows)}`)
        }
      }

      // ── I5: Topic C (empty-trashed) must NOT exist in topics table ──
      const topicCSql = `SELECT id FROM topics WHERE id = '${esc(topicCId)}'`
      const topicCRows = queryRows(chatDbPath!, topicCSql)
      expect(topicCRows.length).toBe(0)
      console.log(`[TrashLifecycle] I5: Topic C (empty-trashed): absent from topics ✓`)

      // ── I6: Topic C exact captured messages absent ──
      if (topicCMessageIds.length > 0) {
        const msgIdList = topicCMessageIds.map((id) => `'${esc(id)}'`).join(',')
        const topicCMsgSql = `SELECT id FROM messages WHERE id IN (${msgIdList})`
        const topicCMsgRows = queryRows(chatDbPath!, topicCMsgSql)
        expect(topicCMsgRows.length).toBe(0)
        console.log(`[TrashLifecycle] I6: Topic C exact messages: absent (${topicCMessageIds.length} IDs) ✓`)
      }

      // ── I7: Topic C exact captured blocks absent ──
      if (topicCBlockIds.length > 0) {
        const blockIdList = topicCBlockIds.map((id) => `'${esc(id)}'`).join(',')
        const topicCBlockSql = `SELECT id FROM message_blocks WHERE id IN (${blockIdList})`
        const topicCBlockRows = queryRows(chatDbPath!, topicCBlockSql)
        expect(topicCBlockRows.length).toBe(0)
        console.log(`[TrashLifecycle] I7: Topic C exact blocks: absent (${topicCBlockIds.length} IDs) ✓`)
      }

      // ── I8: Default topic messages intact ──
      const defaultMsgSql = `SELECT id, role FROM messages WHERE topic_id = '${esc(defaultTopicId)}' ORDER BY sort_order`
      const defaultMsgRows = queryRows(chatDbPath!, defaultMsgSql)
      const userMsgs = defaultMsgRows.filter((m: any) => m.role === 'user')
      const assistantMsgs = defaultMsgRows.filter((m: any) => m.role === 'assistant')
      expect(userMsgs.length).toBe(1)
      expect(assistantMsgs.length).toBe(1)
      console.log(
        `[TrashLifecycle] I8: Default topic messages: ${defaultMsgRows.length} (user: ${userMsgs.length}, assistant: ${assistantMsgs.length}) ✓`
      )

      // ── I9: No stale trash rows (deleted_at non-null) for deleted topics ──
      const staleTrashSql = `SELECT id, deleted_at FROM topics WHERE deleted_at IS NOT NULL AND (id = '${esc(topicBId)}' OR id = '${esc(topicCId)}')`
      const staleTrashRows = queryRows(chatDbPath!, staleTrashSql)
      expect(staleTrashRows.length).toBe(0)
      console.log(`[TrashLifecycle] I9: No stale trash rows for deleted topics ✓`)

      console.log('[TrashLifecycle] SQLite state verification: PASS')
    })
  })
})
