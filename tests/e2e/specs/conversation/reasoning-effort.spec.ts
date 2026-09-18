/**
 * Reasoning effort flow — deterministic chat E2E over the mock provider.
 *
 * Covers the unified reasoning resolver through real UI + real send path:
 *   - seed a heuristic reasoning model (grok-3-mini) on the mock provider.
 *     grok-3-mini is chosen deliberately: its resolved options are
 *     ['default','low','high'] and its `high` level maps to the generic
 *     `reasoningEffort` shape, which the pinned AI SDK openai-compatible
 *     provider deterministically serializes as `reasoning_effort` in the
 *     chat-completions HTTP body (thinking-token-only families such as Qwen
 *     emit a `thinking` providerOption the SDK lane does not serialize, so
 *     they cannot prove the request-shape class through the mock log).
 *   - real Thinking menu select of a sendable option (High)
 *   - assert assistant store/UI setting (two evidence classes: Redux state +
 *     rendered Thinking control state)
 *   - send via the mock provider and assert the captured outbound request
 *     shape (model + messages + reasoning_effort)
 *   - one deterministic normalization case: switching to the non-reasoning
 *     mock-model normalizes the active effort to an explicit off state
 *
 * LOCK-001: disposable profile. LOCK-002: mock endpoint only, no live APIs.
 */
import {
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const REASONING_MODEL_ID = 'grok-3-mini'
const REASONING_TEXT = 'E2E reasoning effort verification'

async function seedReasoningModel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate((modelId: string) => {
    const store = (window as any).store
    const state = store.getState()
    const provider = state.llm.providers.find((p: any) => p.id === 'mock-openai')
    if (!provider) throw new Error('mock-openai provider missing')
    if (!provider.models.some((m: any) => m.id === modelId)) {
      store.dispatch({
        type: 'llm/updateProvider',
        payload: {
          id: 'mock-openai',
          models: [
            ...provider.models,
            { id: modelId, provider: 'mock-openai', name: modelId, group: 'e2e', description: 'E2E reasoning model' }
          ]
        }
      })
    }
    const assistant = state.assistants.assistants[0]
    if (!assistant) throw new Error('no assistant')
    store.dispatch({
      type: 'assistants/setModel',
      payload: {
        assistantId: assistant.id,
        model: { id: modelId, provider: 'mock-openai', name: modelId, group: 'e2e' }
      }
    })
    store.dispatch({
      type: 'assistants/updateAssistantSettings',
      payload: { assistantId: assistant.id, settings: { reasoning_effort: 'default' } }
    })
  }, REASONING_MODEL_ID)
  await page.waitForFunction(
    ({ modelId }) => {
      const s = (window as any).store?.getState()
      const assistant = s?.assistants?.assistants?.[0]
      return assistant?.model?.id === modelId
    },
    { modelId: REASONING_MODEL_ID },
    { timeout: 15000 }
  )
}

async function getAssistantState(
  page: import('@playwright/test').Page
): Promise<{ id: string; effort: string; topicId: string }> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return {
      id: assistant.id,
      effort: assistant.settings?.reasoning_effort ?? 'default',
      topicId: assistant.topics?.[0]?.id ?? ''
    }
  })
}

/** Type into the real chat textarea and submit via Enter (production send path). */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const textarea = page.locator('.inputbar textarea, textarea[placeholder]').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.click()
  await page.evaluate(
    ({ text }) => {
      const el = document.querySelector('.inputbar textarea, textarea[placeholder]') as HTMLTextAreaElement
      if (!el) throw new Error('Textarea not found')
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSetter) throw new Error('No native textarea setter')
      nativeSetter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { text }
  )
  await expect(textarea).toHaveValue(text, { timeout: 5000 })
  await textarea.press('Enter')
}

async function waitForAssistantResponseComplete(
  page: import('@playwright/test').Page,
  topicId: string,
  previousAssistantCount: number,
  timeout = 60000
): Promise<void> {
  await page.waitForFunction(
    ({ topicId, prevCount }: { topicId: string; prevCount: number }) => {
      const s = (window as any).store?.getState()
      if (!s) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let count = 0
      for (const id of msgIds) {
        if (s.messages.entities?.[id]?.role === 'assistant') count++
      }
      return count > prevCount
    },
    { topicId, prevCount: previousAssistantCount },
    { timeout }
  )
  await page.waitForFunction(
    ({ topicId }: { topicId: string }) => {
      const s = (window as any).store?.getState()
      if (!s || s.messages?.loadingByTopic?.[topicId]) return false
      const msgIds = s.messages?.messageIdsByTopic?.[topicId] || []
      let latest: string | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        if (s.messages.entities?.[msgIds[i]]?.role === 'assistant') {
          latest = msgIds[i]
          break
        }
      }
      if (!latest) return false
      const msg = s.messages.entities[latest]
      if (msg.status !== 'success' && msg.status !== 'error') return false
      const blocks = msg.blocks || []
      if (blocks.length === 0) return false
      return blocks.every((blockId: string) => {
        const block = s.messageBlocks?.entities?.[blockId]
        return block && (block.status === 'success' || block.status === 'error')
      })
    },
    { topicId },
    { timeout }
  )
}

test.describe('Reasoning effort flow', () => {
  test.setTimeout(240000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('real Thinking menu select + mock send asserts store/UI and request shape, switch normalizes', async ({
    mainWindow
  }) => {
    const page = mainWindow

    await test.step('seed heuristic reasoning model on mock provider', async () => {
      await seedReasoningModel(page)
      const state = await getAssistantState(page)
      expect(state.effort).toBe('default')
    })

    await test.step('real Thinking menu select High', async () => {
      // Locale-independent Thinking button lookup: the accessible label is
      // translated (Reasoning effort / 思维链长度 / 思維鏈長度).
      const thinkingButton = page.getByRole('button', { name: /Reasoning effort|思维链长度|思維鏈長度/i }).first()
      await expect(thinkingButton).toBeVisible({ timeout: 20000 })
      await thinkingButton.click()
      // QuickPanel opens with the resolver options; High is sendable for grok.
      // Option labels are translated (High / 沉思 / 盡力思考). The panel
      // container uses generated classes, so match the option text globally —
      // it only appears in the open panel.
      const highOption = page.getByText(/^(High|沉思|盡力思考)$/, { exact: true }).first()
      await expect(highOption).toBeVisible({ timeout: 10000 })
      await highOption.click()
      await page.waitForFunction(
        () => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'high'
        },
        undefined,
        { timeout: 15000 }
      )
    })

    await test.step('assert store and rendered Thinking control state', async () => {
      const state = await getAssistantState(page)
      expect(state.effort).toBe('high')
      // UI evidence: reopen the real Thinking menu and prove the High option
      // renders the selected Check mark (QuickPanel item.isSelected).
      const thinkingButton = page.getByRole('button', { name: /Reasoning effort|思维链长度|思維鏈長度/i }).first()
      await thinkingButton.click()
      const panel = page.getByTestId('quick-panel')
      await expect(panel).toBeVisible({ timeout: 10000 })
      const highLabel = panel.getByText(/^(High|沉思|盡力思考)$/, { exact: true }).first()
      await expect(highLabel).toBeVisible({ timeout: 10000 })
      const highRow = highLabel.locator('xpath=ancestor::div[@data-id][1]')
      await expect(highRow.locator('svg.lucide-check')).toBeVisible({ timeout: 10000 })
      // Dismiss the panel with Escape before sending.
      await page.keyboard.press('Escape')
      await expect(panel).not.toBeVisible({ timeout: 10000 })
    })

    await test.step('send via mock and assert captured request shape', async () => {
      clearRequestLog()
      const before = getRequestSequence()
      const state = await getAssistantState(page)
      const prevAssistantCount = await page.evaluate((topicId: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[topicId] || []
        let count = 0
        for (const id of msgIds) {
          if (s.messages.entities[id]?.role === 'assistant') count++
        }
        return count
      }, state.topicId)
      await uiSendMessage(page, REASONING_TEXT)
      await waitForAssistantResponseComplete(page, state.topicId, prevAssistantCount)
      const request = findProductRequestAfter(before)
      expect(request).not.toBeNull()
      expect(request!.method).toBe('POST')
      expect(request!.url).toBe('/v1/chat/completions')
      const parsed = request!.parsed as any
      expect(parsed?.model).toBe(REASONING_MODEL_ID)
      expect(parsed?.stream).toBe(true)
      const messages = parsed?.messages as Array<{ role: string; content: string }>
      expect(Array.isArray(messages)).toBe(true)
      expect(messages.filter((m) => m.role === 'user').at(-1)?.content).toBe(REASONING_TEXT)
      // Reasoning signal: the generic lane emits `reasoningEffort`, which the
      // pinned AI SDK openai-compatible provider serializes as the
      // `reasoning_effort` chat-completions field.
      expect(parsed?.reasoning_effort).toBe('high')
    })

    await test.step('model switch to non-reasoning normalizes effort deterministically', async () => {
      await page.evaluate(() => {
        const store = (window as any).store
        const assistant = store.getState().assistants.assistants[0]
        store.dispatch({
          type: 'assistants/setModel',
          payload: {
            assistantId: assistant.id,
            model: { id: 'mock-model', provider: 'mock-openai', name: 'Mock Model', group: 'mock' }
          }
        })
      })
      // Production normalization moves a non-reasoning model to explicit off.
      await page.waitForFunction(
        () => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'none'
        },
        undefined,
        { timeout: 15000 }
      )
      const normalized = await getAssistantState(page)
      expect(normalized.effort).toBe('none')
    })
  })
})
