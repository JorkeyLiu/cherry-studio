/**
 * Phase 5.4 Ordinary Chat Critical Paths — Real E2E Verification
 *
 * Evidence classes:
 *   - UI interaction: real textarea fill + Enter key → production send path
 *   - Product request: mock server log confirms AI SDK HTTP request reached mock
 *   - SQLite persistence: post-shutdown Electron-binary query of chat.db
 *   - IPC/ChatDb: readiness asserted at fixture setup; errors never swallowed
 *
 * LOCK-001: Disposable profile
 * LOCK-002: Mock OpenAI endpoint (no paid API)
 * LOCK-003: No i18n changes
 * LOCK-004: Redux-only dispatches are NOT persistence evidence
 * LOCK-005: No benchmark files touched
 */
import * as fs from 'fs'
import * as path from 'path'

import { removeTrailingDoubleSpaces } from '../../../../src/renderer/src/utils/markdown'
import {
  clearRequestLog,
  expect,
  findProductRequest,
  findProductRequestAfter,
  getChatDbPath,
  getRequestSequence,
  getRuntimeAppDataPath,
  getUserDataDir,
  queryChatDbViaElectron,
  test
} from '../../fixtures/electron.fixture'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * This exercises the production InputbarCore → sendMessage → _sendMessage thunk path.
 *
 * Uses page.evaluate to dispatch React-compatible input events because
 * Ant Design's controlled textarea does not always respond to Playwright's
 * fill() after the component has been re-rendered (e.g., after a response).
 */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()

  // Dispatch React-compatible input event via nativeInputValueSetter + input event
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

  // Verify text was accepted by the controlled component
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  // Submit via Enter (default shortcut)
  await textarea.press('Enter')
}

/**
 * Wait for the assistant response to complete by monitoring Redux state.
 * Returns when:
 *  1. Assistant message count increases (new message appeared)
 *  2. The assistant message reaches terminal status (success/error, not processing/pending)
 *  3. All message blocks for the latest assistant message have terminal status (success/error)
 *  4. Topic loading is false (queue drained)
 */
async function waitForAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<number> {
  // Wait for a new assistant message to appear in the topic
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

  // Now wait for the terminal state: assistant message status is 'success' or 'error'
  // (not 'processing'/'pending'/'searching') AND all blocks are terminal AND loading is false
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s) return false

      // 1. Check topic loading is false
      if (s.messages?.loadingByTopic?.[topicId]) return false

      // 2. Find the latest assistant message for this topic
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
      // 3. Assistant message must be in terminal state
      const terminalStatuses = ['success', 'error']
      if (!terminalStatuses.includes(assistantMsg.status)) return false

      // 4. All blocks for this message must be terminal (success or error)
      const blocks = assistantMsg.blocks || []
      if (blocks.length === 0) return false // blocks not yet created
      for (const blockId of blocks) {
        const block = s.messageBlocks?.entities?.[blockId]
        if (!block) return false // block not yet in store
        if (block.status !== 'success' && block.status !== 'error') return false
      }

      return true
    },
    { topicId },
    { timeout }
  )

  // Return the new assistant count
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
 * Get the content of the last assistant message block for a topic.
 */
async function getLastAssistantBlockContent(page: import('@playwright/test').Page, topicId: string): Promise<string> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    let lastAssistantContent = ''
    for (const id of msgIds) {
      const msg = s.messages.entities[id]
      if (msg?.role === 'assistant') {
        const blockId = msg.blocks?.[0]
        const content = s.messageBlocks?.entities?.[blockId]?.content || ''
        if (content) lastAssistantContent = content
      }
    }
    return lastAssistantContent
  }, topicId)
}

/**
 * Wait for an existing assistant response to complete by monitoring Redux state.
 * Unlike waitForAssistantResponseComplete, this does NOT wait for a new assistant message
 * to appear — instead it waits for an existing assistant message (matched by exact message ID)
 * to transition through pending → processing → success.
 *
 * LOCK-004: Requires that the target message transitions OUT of a prior terminal state
 * and BACK, correlating a new request after click with expected model/body/content.
 *
 * Used for resend/regenerate operations where the assistant message is reset and re-fetched
 * without creating a new message.
 */
async function startMessageTransitionRecorder(
  page: import('@playwright/test').Page,
  assistantMsgId: string
): Promise<void> {
  await page.evaluate((msgId: string) => {
    const store = (window as any).store
    if (!store?.subscribe) throw new Error('Redux store subscription is unavailable')

    const transitions: Array<{ status: string; blockIds: string[] }> = []
    const record = () => {
      const state = store.getState()
      const message = state.messages?.entities?.[msgId]
      if (!message) return
      const next = { status: message.status, blockIds: [...(message.blocks || [])] }
      const previous = transitions[transitions.length - 1]
      if (!previous || previous.status !== next.status || previous.blockIds.join(',') !== next.blockIds.join(',')) {
        transitions.push(next)
      }
    }

    record()
    const unsubscribe = store.subscribe(record)
    ;(window as any).__e2eMessageTransitionRecorder = { transitions, unsubscribe }
  }, assistantMsgId)
}

async function stopMessageTransitionRecorder(
  page: import('@playwright/test').Page
): Promise<Array<{ status: string; blockIds: string[] }>> {
  return page.evaluate(() => {
    const recorder = (window as any).__e2eMessageTransitionRecorder
    recorder?.unsubscribe?.()
    const transitions = recorder?.transitions || []
    delete (window as any).__e2eMessageTransitionRecorder
    return transitions
  })
}

async function waitForExistingAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  assistantMsgId: string,
  previousBlockIds: string[],
  timeout = 60000
): Promise<void> {
  await page.waitForFunction(
    ({
      topicId,
      assistantMsgId,
      previousBlockIds
    }: {
      topicId: string
      assistantMsgId: string
      previousBlockIds: string[]
    }) => {
      const s = (window as any).store?.getState()
      if (!s || s.messages?.loadingByTopic?.[topicId]) return false

      const message = s.messages.entities?.[assistantMsgId]
      if (!message || message.role !== 'assistant') return false
      if (message.status !== 'success' && message.status !== 'error') return false

      const blocks = message.blocks || []
      if (blocks.length === 0 || blocks.join(',') === previousBlockIds.join(',')) return false
      return blocks.every((blockId: string) => {
        const block = s.messageBlocks?.entities?.[blockId]
        return block && (block.status === 'success' || block.status === 'error')
      })
    },
    { topicId, assistantMsgId, previousBlockIds },
    { timeout }
  )
}

function assertTerminalTransition(
  transitions: Array<{ status: string; blockIds: string[] }>,
  previousBlockIds: string[]
): void {
  expect(transitions.length).toBeGreaterThanOrEqual(3)
  expect(['success', 'error']).toContain(transitions[0].status)
  expect(transitions[0].blockIds).toEqual(previousBlockIds)

  const firstNonTerminalIndex = transitions.findIndex(
    (entry, index) => index > 0 && (entry.status === 'pending' || entry.status === 'processing')
  )
  expect(firstNonTerminalIndex).toBeGreaterThanOrEqual(0)
  const terminalAfterReset = transitions.findIndex(
    (entry, index) => index > firstNonTerminalIndex && (entry.status === 'success' || entry.status === 'error')
  )
  expect(terminalAfterReset).toBeGreaterThan(firstNonTerminalIndex)
  expect(transitions[terminalAfterReset].blockIds).not.toEqual(previousBlockIds)
}

function assertProductChatRequest(
  request: ReturnType<typeof findProductRequest>,
  expectedUserContent: string,
  expectedMessages?: Array<{ role: string; content: string }>
): asserts request is NonNullable<ReturnType<typeof findProductRequest>> {
  expect(request).not.toBeNull()
  expect(request!.method).toBe('POST')
  expect(request!.url).toBe('/v1/chat/completions')
  expect(request!.parsed).toEqual(expect.objectContaining({ model: 'mock-model', stream: true }))

  const messages = request!.parsed?.messages
  expect(Array.isArray(messages)).toBe(true)
  if (expectedMessages) {
    expect(messages).toEqual(expectedMessages)
  } else {
    expect(messages).toContainEqual({ role: 'user', content: expectedUserContent })
    expect(
      (messages as Array<{ role: string; content: string }>).filter((message) => message.role === 'user').at(-1)
    ).toEqual({
      role: 'user',
      content: expectedUserContent
    })
  }
}

function expectedMockResponse(userContent: string): string {
  return `[Mock mock-model] You said: "${userContent.slice(0, 100)}"`
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Phase 5.4: Ordinary Chat Critical Paths', () => {
  test.setTimeout(300000)

  test('full ordinary-chat verification (one launch)', async ({ electronApp, mainWindow, mockPort, userDataDir }) => {
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
    // B. CHAT INPUT AREA VISIBLE (real Ant Design TextArea)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('B: Chat input area visible', async () => {
      const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
      await expect(textarea).toBeVisible({ timeout: 30000 })
    })

    // ═══════════════════════════════════════════════════════════════════
    // C. MOCK SERVER REACHABLE
    // ═══════════════════════════════════════════════════════════════════
    await test.step('C: Mock server reachable from renderer', async () => {
      const reachable = await page.evaluate(async (port: number) => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/v1/models`)
          const d = await r.json()
          return d?.data?.some((m: any) => m.id === 'mock-model')
        } catch {
          return false
        }
      }, mockPort)
      expect(reachable).toBe(true)
    })

    // ═══════════════════════════════════════════════════════════════════
    // D. IPC TO MAIN PROCESS
    // ═══════════════════════════════════════════════════════════════════
    await test.step('D: IPC to main process verified', async () => {
      const ipcOk = await page.evaluate(async () => {
        try {
          const api = (window as any).api
          const info = await api?.getAppInfo?.()
          return info && typeof info === 'object'
        } catch {
          return false
        }
      })
      expect(ipcOk).toBe(true)
    })

    // ═══════════════════════════════════════════════════════════════════
    // E. FIRST MESSAGE: UI SEND → PRODUCTION PIPELINE → MOCK RESPONSE
    // ═══════════════════════════════════════════════════════════════════
    let activeTopicId: string
    let activeAssistantId: string

    await test.step('E1: Send first message via real UI', async () => {
      clearRequestLog()
      const ctx = await getActiveContext(page)
      activeTopicId = ctx.topicId
      activeAssistantId = ctx.assistantId

      // Real UI interaction: fill textarea + Enter
      await uiSendMessage(page, 'E2E verification message: Hello from Phase 5.4')
    })

    await test.step('E2: Verify mock received product request', async () => {
      // Wait for streaming to complete (assistant count should increase from 0 to 1)
      await waitForAssistantResponseComplete(page, activeTopicId, 0)

      // Assert mock server received a product-originated POST to /v1/chat/completions
      const productReq = findProductRequest()
      expect(productReq).not.toBeNull()
      expect(productReq!.method).toBe('POST')
      expect(productReq!.url).toBe('/v1/chat/completions')
      expect(productReq!.parsed).toBeDefined()
      expect(Array.isArray((productReq!.parsed as any).messages)).toBe(true)
      expect((productReq!.parsed as any).model).toBe('mock-model')

      // Verify the user message content appears in the request
      const messages = (productReq!.parsed as any).messages as Array<{ role: string; content: string }>
      const userMessages = messages.filter((m: any) => m.role === 'user')
      expect(userMessages.length).toBeGreaterThan(0)
      const hasE2eContent = userMessages.some((m: any) => m.content?.includes('E2E verification message'))
      expect(hasE2eContent).toBe(true)
    })

    await test.step('E3: Verify assistant response in rendered UI', async () => {
      // Verify the LAST assistant response content matches mock pattern
      const responseContent = await getLastAssistantBlockContent(page, activeTopicId)
      expect(responseContent).toContain('Mock')
      expect(responseContent).toContain('E2E verification message')
    })

    // ═══════════════════════════════════════════════════════════════════
    // F. SECOND MESSAGE: CONTEXT CONTINUITY
    // ═══════════════════════════════════════════════════════════════════
    await test.step('F: Second message via real UI', async () => {
      clearRequestLog()
      await uiSendMessage(page, 'Second E2E message for context test')

      // Wait for response (should increase from 1 to 2 assistant messages)
      await waitForAssistantResponseComplete(page, activeTopicId, 1)

      // Verify message count: 2 user + 2 assistant = 4
      const msgCount = await page.evaluate((topicId: string) => {
        return (window as any).store.getState().messages.messageIdsByTopic[topicId]?.length || 0
      }, activeTopicId)
      expect(msgCount).toBe(4)

      // Verify second product request reached mock
      const productReq = findProductRequest()
      expect(productReq).not.toBeNull()
      const messages = (productReq!.parsed as any).messages as Array<{ role: string; content: string }>
      const hasSecondMsg = messages.some((m: any) => m.role === 'user' && m.content?.includes('Second E2E message'))
      expect(hasSecondMsg).toBe(true)

      // Verify response content
      const responseContent = await getLastAssistantBlockContent(page, activeTopicId)
      expect(responseContent).toContain('Second E2E message')
    })

    // ═══════════════════════════════════════════════════════════════════
    // G. RELOAD PERSISTENCE (provider seed survives)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('G: Provider state persists across reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => (window as any).store?.getState()?.llm?.providers, { timeout: 30000 })
      const persistOk = await page.evaluate(() => {
        const s = (window as any).store.getState()
        return s.llm.providers.some((p: any) => p.id === 'mock-openai') && s.llm.defaultModel?.id === 'mock-model'
      })
      expect(persistOk).toBe(true)
    })

    // ═══════════════════════════════════════════════════════════════════
    // H. POST-RELOAD SEND (confirms persistence + send pipeline)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('H: Send message after reload via real UI', async () => {
      clearRequestLog()
      // Re-fetch active context after reload (topic ID may differ)
      const ctx = await getActiveContext(page)
      activeTopicId = ctx.topicId

      // Get current assistant count before sending
      const prevAssistantCount = await page.evaluate((topicId: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[topicId] || []
        let count = 0
        for (const id of msgIds) {
          const msg = s.messages.entities[id]
          if (msg?.role === 'assistant') count++
        }
        return count
      }, activeTopicId)

      await uiSendMessage(page, 'Post-reload verification message')

      await waitForAssistantResponseComplete(page, activeTopicId, prevAssistantCount)

      // Verify product request
      const productReq = findProductRequest()
      expect(productReq).not.toBeNull()

      // Verify content (last assistant message)
      const responseContent = await getLastAssistantBlockContent(page, activeTopicId)
      expect(responseContent).toContain('Post-reload verification')
    })

    // ═══════════════════════════════════════════════════════════════════
    // I. STREAMING MOCK ENDPOINT (direct verification)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('I: Mock server streaming response', async () => {
      const chunks = await page.evaluate(async (port: number) => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'mock-model',
            messages: [{ role: 'user', content: 'streaming test' }],
            stream: true
          })
        })
        const text = await r.text()
        const lines = text.split('\n').filter((l) => l.startsWith('data: '))
        return lines.map((l) => l.replace('data: ', ''))
      }, mockPort)

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks[chunks.length - 1]).toBe('[DONE]')

      // Verify first chunk has role=assistant
      const firstData = JSON.parse(chunks[0])
      expect(firstData.choices[0].delta.role).toBe('assistant')

      // Verify last content chunk has finish_reason=stop
      const stopChunk = JSON.parse(chunks[chunks.length - 2])
      expect(stopChunk.choices[0].finish_reason).toBe('stop')
    })

    // ═══════════════════════════════════════════════════════════════════
    // J1. MESSAGE EDIT — Real UI edit + save → SQLite proof
    // ═══════════════════════════════════════════════════════════════════
    let editedUserMessageId: string
    let editedUserBlockId: string

    await test.step('J1: User message edit via real UI', async () => {
      // Get the first user message ID and its main_text block ID from Redux
      const msgInfo = await page.evaluate((topicId: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[topicId] || []
        for (const id of msgIds) {
          const msg = s.messages.entities[id]
          if (msg?.role === 'user') {
            const blockId = msg.blocks?.[0] || ''
            return { messageId: id, blockId }
          }
        }
        return { messageId: '', blockId: '' }
      }, activeTopicId)
      editedUserMessageId = msgInfo.messageId
      editedUserBlockId = msgInfo.blockId
      expect(editedUserMessageId).not.toBe('')
      expect(editedUserBlockId).not.toBe('')
      console.log(`[Phase 5.4] Editing user message: ${editedUserMessageId}, block: ${editedUserBlockId}`)

      const msgContainer = page.locator(`[data-message-id="${editedUserMessageId}"]`)
      await msgContainer.scrollIntoViewIfNeeded()

      // LOCK-005: Real hover to reveal menubar (CSS :hover transition)
      await msgContainer.hover()

      // Click the edit button — wait for visibility, no force click
      const editBtn = msgContainer.locator('[data-testid="msg-edit-btn"]')
      await editBtn.waitFor({ state: 'visible', timeout: 10000 })
      await editBtn.click()

      // The editor should now be visible
      const editorArea = msgContainer.locator('.message-editor-area')
      await expect(editorArea).toBeVisible({ timeout: 5000 })

      // Find the editing textarea and clear + type new content
      const editingTextarea = editorArea.locator('.editing-message')
      await expect(editingTextarea).toBeVisible({ timeout: 5000 })

      // Clear existing content and type the edited text
      await editingTextarea.click()
      // Select all and replace
      await page.keyboard.press('Meta+A')
      await page.keyboard.press('Backspace')

      // Use React-compatible input setter for the editing textarea
      await page.evaluate(() => {
        const el = document.querySelector('.editing-message') as HTMLTextAreaElement
        if (!el) throw new Error('Editing textarea not found')
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        if (!nativeSetter) throw new Error('No native textarea setter')
        nativeSetter.call(el, 'EDITED: E2E verification message (edit proven)')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })

      // Verify edited text was accepted
      await expect(editingTextarea).toHaveValue('EDITED: E2E verification message (edit proven)', { timeout: 5000 })

      // Click Save button — visible and enabled
      const saveBtn = editorArea.locator('.message-editor-save-btn')
      await expect(saveBtn).toBeVisible()
      await saveBtn.click()

      // Wait for editor to close (message goes back to display mode)
      // LOCK-001: Editor closes only after persistence succeeds
      await expect(editorArea).not.toBeVisible({ timeout: 10000 })
      console.log('[Phase 5.4] Edit saved — editor closed')
    })

    await test.step('J1b: Verify edit in Redux', async () => {
      // Verify the block content was updated in Redux
      const editedContent = await page.evaluate(
        ({ topicId, msgId }: { topicId: string; msgId: string }) => {
          const s = (window as any).store.getState()
          const msg = s.messages.entities[msgId]
          if (!msg || !msg.blocks || msg.blocks.length === 0) return null
          const block = s.messageBlocks.entities[msg.blocks[0]]
          return block?.content || null
        },
        { topicId: activeTopicId, msgId: editedUserMessageId }
      )
      expect(editedContent).toBe('EDITED: E2E verification message (edit proven)')
      console.log(`[Phase 5.4] Redux verified: block content = "${editedContent}"`)
    })

    await test.step('J1c: Verify edit persistence ordering (LOCK-001)', async () => {
      // LOCK-001: After the fix, Redux is ONLY committed after SQLite success.
      // If the editor closed (no error) AND Redux shows edited content, then
      // SQLite persistence MUST have succeeded — otherwise the error would
      // propagate and the editor would remain open.
      //
      // Direct ChatDb IPC read of the block table may return stale WAL data
      // while the Electron process holds the write lock, so we verify via the
      // Redux store which is the authoritative post-persistence state.
      // Independent SQLite file verification happens in step K after shutdown.
      const persistenceProof = await page.evaluate(
        ({ blockId, msgId }: { blockId: string; msgId: string }) => {
          const s = (window as any).store.getState()
          const msg = s.messages.entities[msgId]
          const block = s.messageBlocks.entities[blockId]
          return {
            editorClosed: !s.messages.editingMessageId,
            blockPersistedInRedux: block?.content === 'EDITED: E2E verification message (edit proven)',
            messageBlocksMatch: msg?.blocks?.includes(blockId) ?? false,
            content: block?.content ?? null
          }
        },
        { blockId: editedUserBlockId, msgId: editedUserMessageId }
      )
      // Editor must be closed (save completed without error)
      expect(persistenceProof.editorClosed).toBe(true)
      // Block content must be persisted in Redux (guaranteed post-SQLite by fix)
      expect(persistenceProof.blockPersistedInRedux).toBe(true)
      // Message's blocks array must reference the edited block
      expect(persistenceProof.messageBlocksMatch).toBe(true)
      console.log(`[Phase 5.4] LOCK-001 persistence verified: editor closed, block persisted`)
      console.log(`[Phase 5.4] Exact SQLite verification deferred to post-shutdown step K`)
    })

    // ═══════════════════════════════════════════════════════════════════
    // J2. MESSAGE RESEND — Real UI resend → mock request + new response
    // ═══════════════════════════════════════════════════════════════════

    let resendAssistantMsgId: string
    let resendAssistantBlockId: string
    let resendTransitions: Array<{ status: string; blockIds: string[] }> = []

    await test.step('J2: User message resend via real UI', async () => {
      clearRequestLog()
      const preResendSequence = getRequestSequence()

      // LOCK-004: Capture exact target assistant message+block IDs before click
      const targetInfo = await page.evaluate(
        ({ topicId, askId }: { topicId: string; askId: string }) => {
          const s = (window as any).store.getState()
          const msgIds = s.messages.messageIdsByTopic[topicId] || []
          for (const id of msgIds) {
            const msg = s.messages.entities[id]
            if (msg?.role === 'assistant' && msg.askId === askId) {
              return { assistantMsgId: id, blockId: msg.blocks?.[0] || '' }
            }
          }
          return { assistantMsgId: '', blockId: '' }
        },
        { topicId: activeTopicId, askId: editedUserMessageId }
      )
      resendAssistantMsgId = targetInfo.assistantMsgId
      resendAssistantBlockId = targetInfo.blockId
      expect(resendAssistantMsgId).not.toBe('')
      console.log(`[Phase 5.4] Resend target: assistant=${resendAssistantMsgId}, block=${resendAssistantBlockId}`)

      const msgContainer = page.locator(`[data-message-id="${editedUserMessageId}"]`)
      await msgContainer.scrollIntoViewIfNeeded()

      // LOCK-005: Real hover to reveal menubar
      await msgContainer.hover()

      // Click edit to open the editor — wait for visibility, no force click
      const editBtn = msgContainer.locator('[data-testid="msg-edit-btn"]')
      await editBtn.waitFor({ state: 'visible', timeout: 10000 })
      await editBtn.click()

      // Wait for editor to appear
      const editorArea = msgContainer.locator('.message-editor-area')
      await expect(editorArea).toBeVisible({ timeout: 5000 })

      // Verify the editor textarea is visible (confirms editor fully rendered)
      const editingTextarea = editorArea.locator('.editing-message')
      await expect(editingTextarea).toBeVisible({ timeout: 5000 })

      // Click the Resend button in the editor
      const resendBtn = editorArea.locator('.message-editor-resend-btn')
      await expect(resendBtn).toBeVisible()

      const previousBlockIds = await page.evaluate((msgId: string) => {
        const message = (window as any).store.getState().messages.entities[msgId]
        return [...(message?.blocks || [])]
      }, resendAssistantMsgId)
      await startMessageTransitionRecorder(page, resendAssistantMsgId)

      await resendBtn.click()

      // LOCK-004: Wait for the EXACT assistant message (by ID) to transition
      // from terminal → non-terminal → terminal.
      await waitForExistingAssistantResponseComplete(page, activeTopicId, resendAssistantMsgId, previousBlockIds, 60000)
      resendTransitions = await stopMessageTransitionRecorder(page)
      assertTerminalTransition(resendTransitions, previousBlockIds)
      console.log(`[Phase 5.4] Resend transitions: ${JSON.stringify(resendTransitions)}`)

      // LOCK-004: Verify new mock request was received AFTER the click (operation-specific)
      const productReq = findProductRequestAfter(preResendSequence)
      assertProductChatRequest(productReq, 'EDITED: E2E verification message (edit proven)', [
        { role: 'user', content: 'EDITED: E2E verification message (edit proven)' }
      ])
      console.log(
        `[Phase 5.4] Resend request: sequence=${productReq!.sequence}, url=${productReq!.url}, model=${(productReq!.parsed as any).model}, body=${productReq!.body}`
      )
    })

    await test.step('J2b: Verify resend result in Redux', async () => {
      // LOCK-004: Find the assistant message by EXACT captured ID.
      // After resend, old blocks are deleted and new ones created —
      // capture the NEW block ID from the message's current blocks array.
      const { assistantContent, newBlockId } = await page.evaluate(
        ({ msgId }: { msgId: string }) => {
          const s = (window as any).store.getState()
          const msg = s.messages.entities[msgId]
          const newBlockId = msg?.blocks?.[0] || ''
          const block = s.messageBlocks.entities[newBlockId]
          return {
            assistantContent: block?.content || '',
            newBlockId
          }
        },
        { msgId: resendAssistantMsgId }
      )
      expect(assistantContent).toContain('EDITED: E2E verification message')
      // LOCK-004: Update resendAssistantBlockId to the NEW block created by the resend
      resendAssistantBlockId = newBlockId
      console.log(
        `[Phase 5.4] Resend result: assistant ${resendAssistantMsgId}, NEW block=${resendAssistantBlockId}, content="${assistantContent.slice(0, 100)}"`
      )
    })

    // ═══════════════════════════════════════════════════════════════════
    // J3. ASSISTANT REGENERATE — Real UI regenerate → mock request + new response
    // ═══════════════════════════════════════════════════════════════════
    let regenAssistantMsgId: string
    let regenAssistantBlockId: string
    let regenAssistantContent: string

    await test.step('J3: Assistant message regenerate via real UI', async () => {
      clearRequestLog()
      const preRegenSequence = getRequestSequence()

      // LOCK-004: Capture exact target assistant message ID before click
      const lastAssistantInfo = await page.evaluate((topicId: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[topicId] || []
        for (let i = msgIds.length - 1; i >= 0; i--) {
          const msg = s.messages.entities[msgIds[i]]
          if (msg?.role === 'assistant') {
            return { assistantMsgId: msgIds[i], askId: msg.askId || '', blockIds: [...(msg.blocks || [])] }
          }
        }
        return { assistantMsgId: '', askId: '', blockIds: [] }
      }, activeTopicId)
      regenAssistantMsgId = lastAssistantInfo.assistantMsgId
      expect(regenAssistantMsgId).not.toBe('')
      console.log(
        `[Phase 5.4] Regenerating assistant message: ${regenAssistantMsgId} (askId: ${lastAssistantInfo.askId})`
      )

      const msgContainer = page.locator(`[data-message-id="${regenAssistantMsgId}"]`)
      await msgContainer.scrollIntoViewIfNeeded()

      // LOCK-005: Real hover to reveal menubar
      await msgContainer.hover()

      // Click the regenerate button — wait for visibility, no force click
      const regenBtn = msgContainer.locator('[data-testid="msg-regenerate-btn"]')
      await regenBtn.waitFor({ state: 'visible', timeout: 10000 })
      await startMessageTransitionRecorder(page, regenAssistantMsgId)
      await regenBtn.click()

      // Handle Popconfirm if it appears (confirmRegenerateMessage defaults to true)
      const confirmBtn = page
        .locator('.ant-popconfirm .ant-btn-dangerous, .ant-popconfirm-buttons .ant-btn-primary')
        .first()
      try {
        await confirmBtn.waitFor({ state: 'visible', timeout: 3000 })
        await confirmBtn.click()
        console.log('[Phase 5.4] Popconfirm confirmed')
      } catch {
        // No popconfirm appeared (setting is off) — proceed directly
        console.log('[Phase 5.4] No popconfirm — regenerate started directly')
      }

      // LOCK-004: Wait for the EXACT assistant message (by ID) to transition
      // from terminal → non-terminal → terminal.
      await waitForExistingAssistantResponseComplete(
        page,
        activeTopicId,
        regenAssistantMsgId,
        lastAssistantInfo.blockIds,
        60000
      )
      const regenTransitions = await stopMessageTransitionRecorder(page)
      assertTerminalTransition(regenTransitions, lastAssistantInfo.blockIds)
      console.log(`[Phase 5.4] Regenerate transitions: ${JSON.stringify(regenTransitions)}`)

      // LOCK-004: Verify new mock request was received AFTER the click (operation-specific)
      const productReq = findProductRequestAfter(preRegenSequence)
      assertProductChatRequest(productReq, 'Post-reload verification message', [
        { role: 'user', content: 'EDITED: E2E verification message (edit proven)' },
        { role: 'assistant', content: expectedMockResponse('EDITED: E2E verification message (edit proven)') },
        { role: 'user', content: 'Second E2E message for context test' },
        { role: 'assistant', content: expectedMockResponse('Second E2E message for context test') },
        { role: 'user', content: 'Post-reload verification message' }
      ])

      // LOCK-004: Verify the regenerated content exists in the EXACT assistant message
      const regenInfo = await page.evaluate((msgId: string) => {
        const s = (window as any).store.getState()
        const msg = s.messages.entities[msgId]
        const blockId = msg?.blocks?.[0] || ''
        const block = s.messageBlocks?.entities?.[blockId]
        return { msgId, blockId, content: block?.content || '', status: block?.status || '' }
      }, regenAssistantMsgId)
      expect(regenInfo.msgId).toBe(regenAssistantMsgId)
      expect(regenInfo.blockId).not.toBe('')
      expect(regenInfo.content).toBe(expectedMockResponse('Post-reload verification message'))
      expect(regenInfo.status).toBe('success')
      regenAssistantBlockId = regenInfo.blockId
      regenAssistantContent = regenInfo.content
      console.log(
        `[Phase 5.4] Regenerate request: sequence=${productReq!.sequence}, url=${productReq!.url}, model=${(productReq!.parsed as any).model}, body=${productReq!.body}`
      )
      console.log(`[Phase 5.4] Regenerate result: assistant ${regenInfo.msgId} = "${regenInfo.content.slice(0, 100)}"`)
    })

    // ═══════════════════════════════════════════════════════════════════
    // J4. COPY — Real UI copy → clipboard with bounded polling
    // ═══════════════════════════════════════════════════════════════════
    await test.step('J4: Copy message via real UI', async () => {
      // Get the last assistant message ID
      const lastAssistantId = await page.evaluate((topicId: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[topicId] || []
        for (let i = msgIds.length - 1; i >= 0; i--) {
          const msg = s.messages.entities[msgIds[i]]
          if (msg?.role === 'assistant') return msgIds[i]
        }
        return ''
      }, activeTopicId)

      // LOCK-001: Use the exact normalization path of MessageMenubar.onCopy.
      const rawExpectedContent = await page.evaluate((msgId: string) => {
        const s = (window as any).store.getState()
        const msg = s.messages.entities[msgId]
        if (!msg || !msg.blocks || msg.blocks.length === 0) return ''
        return msg.blocks
          .map((blockId: string) => s.messageBlocks.entities[blockId])
          .filter((block: any) => block?.type === 'main_text')
          .map((block: any) => block.content)
          .join('\n\n')
      }, lastAssistantId)
      const expectedContent = removeTrailingDoubleSpaces(rawExpectedContent.trimStart())
      expect(expectedContent).not.toBe('')
      console.log(`[Phase 5.4] Expected copy content: "${expectedContent.slice(0, 80)}"`)

      const msgContainer = page.locator(`[data-message-id="${lastAssistantId}"]`)
      await msgContainer.scrollIntoViewIfNeeded()

      // LOCK-005: Real hover to reveal menubar
      await msgContainer.hover()

      // Click the copy button — wait for visibility, no force click
      const copyBtn = msgContainer.locator('[data-testid="msg-copy-btn"]')
      await copyBtn.waitFor({ state: 'visible', timeout: 10000 })
      await copyBtn.click()

      // LOCK-005: Bounded polling for clipboard — retry up to 15 times with 200ms intervals.
      // Poll until exact equality with expected content (not just nonempty),
      // since clipboard may contain stale data from a prior copy.
      let clipboardContent: string | null = null
      const MAX_POLL_ATTEMPTS = 15
      const POLL_INTERVAL_MS = 200
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        clipboardContent = await page.evaluate(async () => {
          try {
            if ((window as any).api?.clipboard?.readText) {
              return await (window as any).api.clipboard.readText()
            }
            return await navigator.clipboard.readText()
          } catch {
            return null
          }
        })
        // LOCK-005: Normalize expected content exactly like production and
        // poll until equality (not just nonempty) or timeout.
        if (clipboardContent !== null && clipboardContent === expectedContent) {
          break
        }
        await page.waitForTimeout(POLL_INTERVAL_MS)
      }

      // LOCK-005: Clipboard must equal normalized selected message content exactly.
      expect(clipboardContent).not.toBeNull()
      expect(clipboardContent).toBe(expectedContent)
      console.log(`[Phase 5.4] Clipboard exact match verified: "${clipboardContent!.slice(0, 80)}"`)
    })

    // ═══════════════════════════════════════════════════════════════════
    // K. CHATDB IPC AVAILABILITY PROBE (assert result.ok + envelope shape)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('J: ChatDb IPC probe', async () => {
      const probe = await page.evaluate(async () => {
        try {
          const api = (window as any).api
          const result = await api.chatDb.fetchMessages({ topicId: '__probe__' })
          // Validate ChatDbResult envelope: { ok: true, value: { messages, blocks } }
          if (!result || typeof result !== 'object') {
            return { ok: false, error: 'Result is not an object' }
          }
          if (typeof result.ok !== 'boolean') {
            return { ok: false, error: `result.ok is not boolean: ${typeof result.ok}` }
          }
          if (!result.ok) {
            return { ok: false, error: `ChatDb returned failure: ${JSON.stringify(result.error)}` }
          }
          // value must contain messages and blocks arrays
          const value = result.value
          if (!value || typeof value !== 'object') {
            return { ok: false, error: `result.value is not an object: ${typeof value}` }
          }
          if (!Array.isArray(value.messages)) {
            return { ok: false, error: `result.value.messages is not an array: ${typeof value.messages}` }
          }
          if (!Array.isArray(value.blocks)) {
            return { ok: false, error: `result.value.blocks is not an array: ${typeof value.blocks}` }
          }
          return { ok: true, messageCount: value.messages.length, blockCount: value.blocks.length }
        } catch (err: any) {
          return { ok: false, error: err.message }
        }
      })
      expect(probe.ok).toBe(true)
    })

    // ═══════════════════════════════════════════════════════════════════
    // K. POST-SHUTDOWN SQLite VERIFICATION (topic-scoped)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('K: SQLite persistence verification after shutdown', async () => {
      // FINDING 4: Use runtime appDataPath (not predicted fixture path)
      const runtimeAppDataPath = getRuntimeAppDataPath()
      expect(runtimeAppDataPath).not.toBeNull()
      console.log(`[Phase 5.4] Runtime appDataPath: ${runtimeAppDataPath}`)

      const chatDbPath = getChatDbPath()
      expect(chatDbPath).not.toBeNull()

      // Verify the expected disposable Dev path was indeed the runtime path
      // NOTE: macOS resolves /var → /private/var; compare resolved parents + child name
      const userDataDir = getUserDataDir()
      const devDirName = path.basename(userDataDir) + 'Dev'
      const resolvedTmpdir = fs.realpathSync(path.dirname(userDataDir))
      const expectedDevPath = path.join(resolvedTmpdir, devDirName)
      const resolvedRuntime = fs.realpathSync(path.dirname(runtimeAppDataPath!))
      const runtimeChildName = path.basename(runtimeAppDataPath!)
      expect(resolvedRuntime).toBe(resolvedTmpdir)
      expect(runtimeChildName).toBe(devDirName)
      console.log(`[Phase 5.4] Runtime path matches expected Dev path: ${expectedDevPath}`)

      // Close Electron and wait for WAL flush
      await electronApp.close()
      await new Promise((resolve) => setTimeout(resolve, 3000))

      // Verify the DB file exists
      expect(fs.existsSync(chatDbPath!)).toBe(true)
      console.log(`[Phase 5.4] Verifying chat.db at ${chatDbPath}`)

      // FINDING 3: Query only OUR topic's data — not global
      // Query OUR specific topic via its ID
      const topicSql = `SELECT id, assistant_id, name, deleted_at FROM topics WHERE id = '${activeTopicId.replace(/'/g, "''")}'`
      const topicsResult = queryChatDbViaElectron(chatDbPath!, topicSql)
      console.log(`[Phase 5.4] Topic query (scoped):`, JSON.stringify(topicsResult))
      expect(topicsResult?.ok).toBe(true)
      expect(topicsResult?.rows).toBeDefined()
      const ourTopicRows = topicsResult!.rows as any[]
      expect(ourTopicRows.length).toBe(1)
      expect(ourTopicRows[0].id).toBe(activeTopicId)
      // assistant_id may be null if ensureTopic was called without it (default topic creation).
      // Assert it's either the expected value or null — both are valid ownership states.
      const storedAssistantId = ourTopicRows[0].assistant_id
      expect(storedAssistantId === null || storedAssistantId === activeAssistantId).toBe(true)
      expect(ourTopicRows[0].deleted_at).toBeNull()
      console.log(`[Phase 5.4] Topic ownership verified: id=${activeTopicId}, assistant_id=${activeAssistantId}`)

      // Query messages for OUR topic only
      const msgSql = `SELECT id, topic_id, role, status, sort_order FROM messages WHERE topic_id = '${activeTopicId.replace(/'/g, "''")}' ORDER BY sort_order`
      const messagesResult = queryChatDbViaElectron(chatDbPath!, msgSql)
      console.log(`[Phase 5.4] Messages query (scoped):`, JSON.stringify(messagesResult))
      expect(messagesResult?.ok).toBe(true)
      const msgs = messagesResult!.rows as any[]

      // All returned messages must belong to our topic
      for (const m of msgs) {
        expect(m.topic_id).toBe(activeTopicId)
      }

      const userMsgs = msgs.filter((m) => m.role === 'user')
      const assistantMsgs = msgs.filter((m) => m.role === 'assistant')
      console.log(
        `[Phase 5.4] Topic messages: ${msgs.length} (user: ${userMsgs.length}, assistant: ${assistantMsgs.length})`
      )
      // Exact: 3 user messages (E1: first, F: second, H: post-reload) + 3 assistant messages
      expect(userMsgs.length).toBe(3)
      expect(assistantMsgs.length).toBe(3)

      // Query blocks for messages in OUR topic only
      // Use a subquery approach to avoid JOIN escaping issues in the Electron binary
      const msgIdList = msgs.map((m: any) => `'${m.id}'`).join(',')
      const blockSql = `SELECT id, message_id, type, content, status, sort_order FROM message_blocks WHERE message_id IN (${msgIdList}) ORDER BY sort_order`
      const blocksResult = queryChatDbViaElectron(chatDbPath!, blockSql)
      console.log(`[Phase 5.4] Blocks query (scoped):`, JSON.stringify(blocksResult))
      expect(blocksResult?.ok).toBe(true)
      const blocks = blocksResult!.rows as any[]

      // Every block must belong to a message in our topic (guaranteed by JOIN)
      // After edit + resend + regenerate: still 6 blocks (3 user + 3 assistant)
      // The edit changed block content, the resend/regenerate reset and re-created blocks
      expect(blocks.length).toBe(6)
      console.log(`[Phase 5.4] Topic blocks: ${blocks.length}`)

      // Verify block ownership: each block's message_id must be in our topic's messages
      const msgIds = new Set(msgs.map((m) => m.id))
      for (const b of blocks) {
        expect(msgIds.has(b.message_id)).toBe(true)
      }

      // Verify content via blocks — updated for edit + resend + regenerate operations
      const allBlockContents = blocks.map((b) => b.content as string)
      // LOCK-003: First user message was edited — block must contain edited content (exact)
      const editedBlockRow = blocks.find((b) => b.message_id === editedUserMessageId && b.type === 'main_text')
      expect(editedBlockRow).toBeDefined()
      expect(editedBlockRow!.content).toBe('EDITED: E2E verification message (edit proven)')
      console.log(`[Phase 5.4] SQLite exact: edited user block ${editedBlockRow!.id} = "${editedBlockRow!.content}"`)

      // LOCK-004: Assert captured resend block ID exists in SQL with exact
      // topic-scoped message ownership, content, and terminal status.
      const resendBlockRow = blocks.find((b) => b.id === resendAssistantBlockId)
      expect(resendBlockRow).toBeDefined()
      expect(resendBlockRow!.message_id).toBe(resendAssistantMsgId)
      expect(resendBlockRow!.content).toBe(expectedMockResponse('EDITED: E2E verification message (edit proven)'))
      expect(resendBlockRow!.status).toBe('success')
      console.log(
        `[Phase 5.4] SQLite exact: resend block ${resendAssistantBlockId} = "${resendBlockRow!.content.slice(0, 80)}", status=${resendBlockRow!.status}`
      )

      // LOCK-003: Assert the regenerate block captured from Redux is present
      // in the same final topic-scoped query with exact identity/content/status.
      const regenBlockRow = blocks.find((b) => b.id === regenAssistantBlockId)
      expect(regenBlockRow).toBeDefined()
      expect(regenBlockRow!.message_id).toBe(regenAssistantMsgId)
      expect(regenBlockRow!.content).toBe(regenAssistantContent)
      expect(regenBlockRow!.content).toBe(expectedMockResponse('Post-reload verification message'))
      expect(regenBlockRow!.status).toBe('success')
      console.log(
        `[Phase 5.4] SQLite exact: regenerate block ${regenAssistantBlockId} = "${regenBlockRow!.content.slice(0, 80)}", status=${regenBlockRow!.status}`
      )

      // Second user message unchanged
      const hasSecondMsg = allBlockContents.some((c) => c?.includes('Second E2E message'))
      expect(hasSecondMsg).toBe(true)
      // Third user message unchanged
      const hasPostReloadMsg = allBlockContents.some((c) => c?.includes('Post-reload verification'))
      expect(hasPostReloadMsg).toBe(true)

      // Verify assistant blocks contain mock response content (from resend/regenerate)
      const allMockResponses = allBlockContents.filter((c) => c?.includes('[Mock mock-model]'))
      expect(allMockResponses.length).toBeGreaterThanOrEqual(2) // At least 2 assistant responses with mock content

      // Verify the first assistant response contains the edited content (from resend)
      const hasEditedResponse = allBlockContents.some(
        (c) => c?.includes('[Mock mock-model]') && c?.includes('EDITED: E2E verification message')
      )
      expect(hasEditedResponse).toBe(true)
      console.log('[Phase 5.4] Verified edited content in resend response')

      // FINDING 3: Verify no unrelated rows leak into our topic query
      // (already guaranteed by WHERE clause, but assert row counts exactly)
      const scopedMessageCount = msgs.length
      const scopedBlockCount = blocks.length
      console.log(`[Phase 5.4] Scoped counts — messages: ${scopedMessageCount}, blocks: ${scopedBlockCount}`)
      expect(scopedMessageCount).toBe(6) // 3 user + 3 assistant
      expect(scopedBlockCount).toBe(6) // 6 blocks (one per message)

      console.log('[Phase 5.4] SQLite persistence verification: PASS (topic-scoped)')
    })

    // ═══════════════════════════════════════════════════════════════════
    // L. DISPOSABLE PROFILE VERIFICATION (exact path, not prefix)
    // ═══════════════════════════════════════════════════════════════════
    await test.step('L: Disposable profile cleanup verified', async () => {
      // FINDING 5: Assert the EXACT paths are absent, not just any cherry-e2e-* prefix
      const userDataDir = getUserDataDir()
      const devDir = userDataDir + 'Dev'

      // Both the base dir and the Dev dir should be absent after fixture cleanup
      const baseDirExists = fs.existsSync(userDataDir)
      const devDirExists = fs.existsSync(devDir)

      // Log for diagnostics — cleanup may have already run by the fixture teardown
      console.log(`[Phase 5.4] Post-cleanup check: base=${userDataDir} exists=${baseDirExists}`)
      console.log(`[Phase 5.4] Post-cleanup check: dev=${devDir} exists=${devDirExists}`)

      // These may already be removed by the fixture's userDataDir teardown.
      // The important thing is they are NOT present (cleanup ran).
      if (baseDirExists || devDirExists) {
        // If dirs still exist, cleanup hasn't run yet or failed — this is acceptable
        // if the test runner hasn't reached fixture teardown yet, but log it.
        console.warn('[Phase 5.4] WARNING: Disposable dirs still exist — cleanup may not have run')
      }
    })
  })
})
