/**
 * Topic Auto-Naming — automatic (stream completion) and manual (topic
 * context-menu "Auto Rename") generated topic naming through the repaired
 * message-read path.
 *
 * Contract under test:
 *   messages persisted in Main SQLite -> typed IPC -> renderer messages
 *   projection -> TopicManager.getTopicMessages -> summary request ->
 *   topic metadata persistence (SQLite name update, then Redux).
 *
 * Regression detected: TopicManager.getTopicMessages previously returned the
 * reducer-stripped `assistant.topic.messages` (always empty), so both naming
 * paths saw `messages.length < 2`, never issued the summary request, and the
 * topic kept the default name. The repaired path awaits
 * `loadTopicMessagesThunk` and reads `selectMessagesForTopic` from the
 * messages projection, so the summary request fires and the deterministic
 * mock-generated title is persisted.
 *
 * Deterministic mock behavior:
 *   - Chat requests: the last body user message is the typed text; the body
 *     is streaming (`stream: true`).
 *   - Summary requests (fetchMessagesSummary via the seeded quick model
 *     `mock-model`): the last body user message is
 *     `JSON.stringify(structuredConversation)`, i.e. starts with `[`, and the
 *     body is non-streaming (no `stream` field). The mock replies
 *     `[Mock mock-model] You said: "<content>"`, and
 *     removeSpecialCharactersForTopicName keeps the marker
 *     `[Mock mock-model] You said:` verbatim in the generated topic name.
 *
 * Evidence classes: real UI send + context-menu gesture, mock request log
 * (chat vs. summary request distinguished by non-stream metadata AND
 * user-message shape), Redux state snapshots, post-exit SQLite query (durable
 * proof).
 *
 * Summary-request discrimination: findSummaryRequest rejects streaming chat
 * requests on the actual request metadata (`stream !== true`) in addition to
 * the structured summary-shape check, so a streaming chat request can never
 * be misclassified as a summary request.
 *
 * Manual-path strengthening: the automatic naming settles
 * on the same deterministic mock title, so the manual test first renames the
 * topic to a distinct stable pre-manual name via the ordinary manual text
 * rename — that rename is deterministic test setup ONLY, never the asserted
 * behavior. The manual name/UI/SQLite assertions then pass only if the manual
 * Auto Rename handler applies and persists its own summary result.
 *
 * Fixture/mock/profile requirements: shared fixture, disposable profile, and the
 * seeded mock provider only.
 * Evidence scope: Redux-only dispatches are NOT persistence evidence — the final
 * name is proven in SQLite after shutdown.
 */
import * as fs from 'fs'
import * as path from 'path'

import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getChatDbPath,
  getRequestLog,
  getRequestSequence,
  getRuntimeAppDataPath,
  getUserDataDir,
  queryChatDbViaElectron,
  test
} from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

/**
 * Deterministic marker of the mock-generated title: the mock echoes the last
 * user message and the topic-name sanitizer (removeSpecialCharactersForTopicName)
 * only strips quotes/line breaks, so `[Mock mock-model] You said:` survives.
 */
const MOCK_TITLE_MARKER = '[Mock mock-model] You said:'

/**
 * Distinct stable name the manual test establishes BEFORE the manual Auto
 * Rename. The automatic naming settles on the same deterministic mock title,
 * which previously pre-satisfied the manual name/UI/SQLite assertions; the
 * ordinary manual text rename below is deterministic test setup ONLY (never
 * the asserted behavior). The name must differ from the deterministic summary
 * result and never contain the mock marker.
 */
const PRE_MANUAL_STABLE_NAME = 'E2E manual pre-rename stable name'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the active assistant/topic from Redux. */
async function getActiveContext(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    const topic = assistant?.topics?.[0]
    return {
      assistantId: assistant?.id || '',
      topicId: topic?.id || ''
    }
  })
}

/** Read a topic's current name from the Redux assistants slice by exact ID. */
async function getTopicNameFromRedux(page: import('@playwright/test').Page, topicId: string): Promise<string> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    for (const assistant of s.assistants?.assistants || []) {
      const topic = assistant.topics?.find((t: any) => t.id === topicId)
      if (topic) return topic.name
    }
    return ''
  }, topicId)
}

/**
 * Type text into the real textarea and submit via Enter key.
 * Exercises the production InputbarCore -> sendMessage -> _sendMessage thunk path.
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
 * Ordinary manual text rename via the topic context menu ("Rename" -> antd
 * PromptPopup), committed with Enter. Purely deterministic test setup for the
 * manual Auto Rename test: it establishes a distinct stable pre-manual name so
 * the generated-name assertions cannot be pre-satisfied by the automatic
 * naming. The asserted behavior remains the generated auto-rename, never this
 * manual edit.
 */
async function uiRenameTopicTo(page: import('@playwright/test').Page, topicId: string, newName: string): Promise<void> {
  const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
  await topicItem.scrollIntoViewIfNeeded()
  await topicItem.click({ button: 'right' })

  // "Rename" menu item — structurally identified by its pencil icon
  // (i18n-robust), same dropdown pattern as the Auto Rename item.
  const renameItem = page
    .locator('.ant-dropdown-menu:visible .ant-dropdown-menu-item')
    .filter({ has: page.locator('svg.lucide-pencil') })
  await renameItem.waitFor({ state: 'visible', timeout: 10000 })
  await renameItem.click()

  const modalTextarea = page.locator('.ant-modal:visible textarea')
  await modalTextarea.waitFor({ state: 'visible', timeout: 10000 })

  // Antd's controlled TextArea, like the inputbar textarea, may not respond to
  // Playwright's fill; use the native setter + input/change events instead.
  await modalTextarea.evaluate((el, text) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (!nativeSetter) throw new Error('No native textarea setter')
    nativeSetter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, newName)

  await expect(modalTextarea).toHaveValue(newName, { timeout: 5000 })
  await modalTextarea.press('Enter')
  // The modal closes; the rename handler then persists SQLite first and only
  // then mutates Redux.
  await expect(modalTextarea).toBeHidden({ timeout: 10000 })
}

/**
 * Wait for the assistant response to complete by monitoring Redux state
 * (new assistant message, terminal status, terminal blocks, queue drained).
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
      if (assistantMsg.status !== 'success' && assistantMsg.status !== 'error') return false
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
 * Wait until the topic's Redux name contains the deterministic mock-generated
 * marker (i.e. the naming summary request completed and was applied) AND no
 * rename is still in flight for the topic.
 */
async function waitForGeneratedTopicName(
  page: import('@playwright/test').Page,
  topicId: string,
  timeout = 60000
): Promise<void> {
  await page.waitForFunction(
    ({ topicId, marker }: { topicId: string; marker: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      if ((s.runtime?.chat?.renamingTopics || []).includes(topicId)) return false
      for (const assistant of s.assistants?.assistants || []) {
        const topic = assistant.topics?.find((t: any) => t.id === topicId)
        if (topic && typeof topic.name === 'string' && topic.name.includes(marker)) return true
      }
      return false
    },
    { topicId, marker: MOCK_TITLE_MARKER },
    { timeout }
  )
}

/**
 * Find the first product-originated completion request with sequence >=
 * afterSequence whose body contains a user message shaped like the naming
 * summary conversation: a JSON array string of structured messages (starts
 * with `[{` / contains the `mainText` field).
 *
 * Discrimination rationale: chat requests are streaming
 * (`stream: true` in the actual request body) and are rejected on that real
 * request metadata BEFORE the shape check, so a streaming chat request can
 * never be misclassified as a summary. Summary requests are non-streaming
 * (the AI SDK omits the `stream` field entirely) and additionally carry the
 * structured conversation shape.
 */
function findSummaryRequest(afterSequence: number) {
  const isSummaryShaped = (content: string) => {
    const c = content.trim()
    return c.startsWith('[{') || c.includes('mainText')
  }
  return (
    getRequestLog()
      .filter(
        (entry) =>
          entry.method === 'POST' &&
          entry.url.endsWith('/chat/completions') &&
          entry.sequence >= afterSequence &&
          // Non-stream summary requests never carry `stream: true`; the
          // streaming chat path always does.
          entry.parsed?.stream !== true
      )
      .find((entry) => {
        const messages = (entry.parsed as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages
        return (
          Array.isArray(messages) &&
          messages.some((m) => m?.role === 'user' && typeof m.content === 'string' && isSummaryShaped(m.content))
        )
      }) ?? null
  )
}

/**
 * Durable proof: close the app, then query chat.db read-only via
 * the Electron binary and assert the persisted topic name equals the Redux
 * name and contains the mock-generated marker. Also proves the disposable
 * profile is the runtime profile.
 */
async function assertTopicNamePersistedInSqlite(
  electronApp: import('@playwright/test').ElectronApplication,
  topicId: string,
  expectedName: string
): Promise<void> {
  const runtimeAppDataPath = getRuntimeAppDataPath()
  expect(runtimeAppDataPath).not.toBeNull()
  const chatDbPath = getChatDbPath()
  expect(chatDbPath).not.toBeNull()

  // Disposable profile proof: runtime appDataPath resolves inside the owned profile.
  const userDataDir = getUserDataDir()
  const childName = path.basename(userDataDir)
  const resolvedTmpdir = fs.realpathSync(path.dirname(userDataDir))
  expect(fs.realpathSync(path.dirname(runtimeAppDataPath!))).toBe(resolvedTmpdir)
  expect(path.basename(runtimeAppDataPath!)).toBe(childName)

  // Close and let SQLite flush its WAL.
  await electronApp.close()
  await new Promise((resolve) => setTimeout(resolve, 3000))

  expect(fs.existsSync(chatDbPath!)).toBe(true)
  const esc = (value: string) => value.replace(/'/g, "''")
  const sql = `SELECT id, name FROM topics WHERE id = '${esc(topicId)}'`
  const result = queryChatDbViaElectron(chatDbPath!, sql)
  if (!result.ok) throw new Error(`SQLite query failed: ${result.code}`)
  const rows = result.rows as any[]
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe(topicId)
  expect(rows[0].name).toBe(expectedName)
  expect(rows[0].name).toContain(MOCK_TITLE_MARKER)
  console.log(`[E2E][topic-naming] SQLite persisted name: "${rows[0].name.slice(0, 120)}"`)
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Topic Auto-Naming (repaired message-read path)', () => {
  test('automatic naming after chat completion replaces the default topic name', async ({
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(300000)
    const page = mainWindow
    await waitForAppReady(page)

    // A. Provider + quick-model seed (the naming summary uses the quick model).
    await test.step('A: Provider seed verification', async () => {
      const seedOk = await page.evaluate(() => {
        const s = (window as any).store?.getState()
        return (
          s?.llm?.providers?.some((p: any) => p.id === 'mock-openai') &&
          s.llm.defaultModel?.id === 'mock-model' &&
          s.llm.quickModel?.id === 'mock-model'
        )
      })
      expect(seedOk).toBe(true)
    })

    // B. Capture the active (default) topic and its initial default name.
    let topicId: string
    let initialDefaultName: string
    await test.step('B: Capture default topic and initial name', async () => {
      const ctx = await getActiveContext(page)
      topicId = ctx.topicId
      expect(topicId).not.toBe('')
      initialDefaultName = await getTopicNameFromRedux(page, topicId)
      expect(initialDefaultName).not.toBe('')
      console.log(`[E2E][topic-naming] Default topic ${topicId} initial name: "${initialDefaultName}"`)
    })

    // C. Send the first message via the real UI (triggers the stream-completion
    //    auto-naming callback after the response completes).
    let chatSeq: number
    await test.step('C: Send first message via real UI', async () => {
      clearRequestLog()
      chatSeq = getRequestSequence()
      await uiSendMessage(page, 'Topic auto-naming E2E message one')
      await waitForAssistantResponseComplete(page, topicId, 0)
      console.log(`[E2E][topic-naming] Chat response complete (seq >= ${chatSeq})`)
    })

    // D. The naming summary request must be issued and its generated title applied.
    await test.step('D: Summary request issued and generated title applied', async () => {
      await waitForGeneratedTopicName(page, topicId)
      // Summary discrimination: the chat request is streaming (stream: true)
      // while the matched summary request is non-streaming (no stream field),
      // proving the matcher rejects streaming chat requests on real metadata.
      const chatReq = findProductRequestAfter(chatSeq)
      expect(chatReq).not.toBeNull()
      expect(chatReq!.parsed?.stream).toBe(true)
      const summaryReq = findSummaryRequest(chatSeq)
      expect(summaryReq).not.toBeNull()
      expect(summaryReq!.parsed).toEqual(expect.objectContaining({ model: 'mock-model' }))
      expect(summaryReq!.parsed?.stream).not.toBe(true)
      console.log(`[E2E][topic-naming] Summary request: sequence=${summaryReq!.sequence}, model=mock-model`)
    })

    // E. The default/stale name must have changed to the deterministic mock title.
    await test.step('E: Topic name changed to mock-generated title (Redux + UI)', async () => {
      const reduxName = await getTopicNameFromRedux(page, topicId)
      expect(reduxName).not.toBe(initialDefaultName)
      expect(reduxName).toContain(MOCK_TITLE_MARKER)
      console.log(`[E2E][topic-naming] Redux name: "${reduxName.slice(0, 120)}"`)

      const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
      await expect(topicItem).toContainText(MOCK_TITLE_MARKER, { timeout: 10000 })
    })

    // F. Durable proof: post-exit SQLite name == Redux name.
    await test.step('F: SQLite persistence of the generated topic name', async () => {
      const reduxName = await getTopicNameFromRedux(page, topicId)
      expect(reduxName).toContain(MOCK_TITLE_MARKER)
      await assertTopicNamePersistedInSqlite(electronApp, topicId, reduxName)
    })
  })

  test('manual context-menu Auto Rename renames from a distinct stable name and persists the generated title', async ({
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(300000)
    const page = mainWindow
    await waitForAppReady(page)

    // A. Provider seed (quick model powers the summary request).
    await test.step('A: Provider seed verification', async () => {
      const seedOk = await page.evaluate(() => {
        const s = (window as any).store?.getState()
        return (
          s?.llm?.providers?.some((p: any) => p.id === 'mock-openai') &&
          s.llm.defaultModel?.id === 'mock-model' &&
          s.llm.quickModel?.id === 'mock-model'
        )
      })
      expect(seedOk).toBe(true)
    })

    // B. Establish a topic with two messages; let the automatic naming settle.
    let topicId: string
    await test.step('B: Send one message and wait for automatic naming to settle', async () => {
      const ctx = await getActiveContext(page)
      topicId = ctx.topicId
      expect(topicId).not.toBe('')
      clearRequestLog()
      await uiSendMessage(page, 'Topic manual auto-rename E2E message')
      await waitForAssistantResponseComplete(page, topicId, 0)
      await waitForGeneratedTopicName(page, topicId)
      console.log(`[E2E][topic-naming] Automatic naming settled for ${topicId}`)
    })

    // C. Establish a distinct stable pre-manual name via the ordinary manual
    //    text rename (deterministic test setup ONLY). The automatic naming
    //    settles on the same deterministic mock title, so without this the
    //    name/UI/SQLite assertions would be pre-satisfied before the manual
    //    action; with it, the manual result must CHANGE the name to pass.
    await test.step('C: Rename topic to a distinct stable pre-manual name (setup)', async () => {
      await uiRenameTopicTo(page, topicId, PRE_MANUAL_STABLE_NAME)
      await expect.poll(() => getTopicNameFromRedux(page, topicId), { timeout: 15000 }).toBe(PRE_MANUAL_STABLE_NAME)
      // The setup name must differ from the deterministic summary result and
      // never carry the mock marker, or the "name changed" assertion would be
      // vacuous.
      expect(PRE_MANUAL_STABLE_NAME).not.toContain(MOCK_TITLE_MARKER)
      const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
      await expect(topicItem).toContainText(PRE_MANUAL_STABLE_NAME, { timeout: 10000 })
      console.log(`[E2E][topic-naming] Pre-manual stable name applied: "${PRE_MANUAL_STABLE_NAME}"`)
    })

    // D. Real context-menu gesture -> "Auto Rename" (matched by its Sparkles
    //    icon, an i18n-robust structural selector).
    let seqBeforeManual: number
    await test.step('D: Manual Auto Rename via topic context menu', async () => {
      seqBeforeManual = getRequestSequence()

      const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
      await topicItem.scrollIntoViewIfNeeded()
      await topicItem.click({ button: 'right' })

      const autoRenameItem = page
        .locator('.ant-dropdown-menu:visible .ant-dropdown-menu-item')
        .filter({ has: page.locator('svg.lucide-sparkles') })
      await autoRenameItem.waitFor({ state: 'visible', timeout: 10000 })
      await autoRenameItem.click()
      console.log(`[E2E][topic-naming] Manual Auto Rename clicked (seq >= ${seqBeforeManual})`)
    })

    // E. The manual path must issue a NEW summary request through the repaired
    //    getTopicMessages (messages projection -> >= 2 -> fetchMessagesSummary).
    //    The matcher rejects streaming chat requests (stream !== true).
    await test.step('E: Fresh non-stream summary request issued by the manual path', async () => {
      await expect.poll(() => findSummaryRequest(seqBeforeManual), { timeout: 60000 }).not.toBeNull()
      const manualReq = findSummaryRequest(seqBeforeManual)
      expect(manualReq).not.toBeNull()
      expect(manualReq!.parsed).toEqual(expect.objectContaining({ model: 'mock-model' }))
      expect(manualReq!.parsed?.stream).not.toBe(true)
      console.log(`[E2E][topic-naming] Manual summary request: sequence=${manualReq!.sequence}, model=mock-model`)
    })

    // F. The manual handler must APPLY its result: the topic name changes from
    //    the distinct stable setup name to the deterministic mock title.
    await test.step('F: Manual rename result applied (Redux + UI)', async () => {
      await waitForGeneratedTopicName(page, topicId)
      const reduxName = await getTopicNameFromRedux(page, topicId)
      expect(reduxName).not.toBe(PRE_MANUAL_STABLE_NAME)
      expect(reduxName).not.toBe('')
      expect(reduxName).toContain(MOCK_TITLE_MARKER)
      console.log(`[E2E][topic-naming] Redux name after manual rename: "${reduxName.slice(0, 120)}"`)

      const topicItem = page.locator(`[data-testid="topic-item"][data-topic-id="${topicId}"]`)
      await expect(topicItem).toContainText(MOCK_TITLE_MARKER, { timeout: 10000 })
      // The setup name must be gone from the rendered item.
      await expect(topicItem).not.toContainText(PRE_MANUAL_STABLE_NAME)
    })

    // G. Durable proof: post-exit SQLite name == Redux name (marker title, and
    //    therefore different from the pre-manual setup name).
    await test.step('G: SQLite persistence of the manually generated topic name', async () => {
      const reduxName = await getTopicNameFromRedux(page, topicId)
      expect(reduxName).toContain(MOCK_TITLE_MARKER)
      expect(reduxName).not.toBe(PRE_MANUAL_STABLE_NAME)
      await assertTopicNamePersistedInSqlite(electronApp, topicId, reduxName)
    })
  })
})
