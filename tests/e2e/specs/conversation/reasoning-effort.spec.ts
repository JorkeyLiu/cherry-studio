/**
 * Reasoning effort flow — deterministic chat E2E over the mock provider.
 *
 * Covers the anchored Thinking Popover (ToolPopover):
 *   - seed heuristic reasoning model (grok-3-mini) + plain mock-model on mock provider.
 *     grok-3-mini is chosen deliberately: its resolved options include `high` and its
 *     `high` level maps to generic `reasoningEffort` shape, which pinned AI SDK
 *     serializes as `reasoning_effort` in chat-completions HTTP body.
 *   - real Thinking Popover select via data-testid `thinking-option-*`
 *   - assert assistant store/UI setting (Redux + rendered popover state)
 *   - send via mock and assert captured outbound request shape
 *   - per-model contract: A=grok-3-mini high does NOT leak to unset B=mock-model;
 *     B's unset default (usually `default` for mock-model's generic resolver
 *     ['default','none','low','medium','high']) is used and A high is not
 *     incorrectly displayed; B selects low/none; switch back restores A high
 *   - anchored popover: show-all per provider:modelId independent persistence,
 *     toggle show-all does not change reasoning_effort,
 *     switching model restores each one's setting
 *   - restart persistence limitation is explicitly documented (no fake proof)
 *
 * LOCK-001: disposable profile. LOCK-002: mock endpoint only, no live APIs.
 */
import {
  clearMockAnthropicThinkingBehaviors,
  clearRequestLog,
  expect,
  findAnthropicRequestsAfter,
  findProductRequestAfter,
  getRequestSequence,
  setMockAnthropicThinkingBehavior,
  test
} from '../../fixtures/electron.fixture'
import { REASONING_LEAK_MARKER } from '../../fixtures/mock-openai-server'
import { waitForAppReady } from '../../utils/wait-helpers'

const MODEL_A_ID = 'grok-3-mini'
const MODEL_B_ID = 'mock-model'
const MODEL_C_ID = 'grok-3-mini-2'
const MODEL_A_KEY = `mock-openai:${MODEL_A_ID}`
const MODEL_B_KEY = `mock-openai:${MODEL_B_ID}`
const MODEL_C_KEY = `mock-openai:${MODEL_C_ID}`
const REASONING_TEXT = 'E2E reasoning effort verification'
const REASONING_TEXT_B = 'E2E reasoning effort B low verification'

const MODEL_D_ID = 'deepseek-v4'
const MODEL_D_KEY = `mock-openai:${MODEL_D_ID}`
const REASONING_TEXT_D_NONE = 'E2E deepseek v4 none wire verification'
const REASONING_TEXT_D_LEAK = `E2E deepseek leak ${REASONING_LEAK_MARKER}`

// Anthropic adaptive-first default (explicit thinking starts adaptive+effort).
// Opaque IDs carry no vendor substring: modern (adaptive-only) succeeds first
// try adaptive direct; legacy (enabled-only) rejects that first adaptive with
// the bare 400 `adaptive thinking is not supported on this model`, retries
// once enabled+budget, then persists per connection+model. Same endpoint
// proves model-scope separation. Default sends no override, none sends
// disabled — each exactly 1, never retried, never overridden by the cache.
const ANTHROPIC_PROVIDER_ID = 'mock-anthropic'
const LEARN_MODEL_ID = 'mock-thinking-route'
const LEARN_MODEL_KEY = `${ANTHROPIC_PROVIDER_ID}:${LEARN_MODEL_ID}`
const LEGACY_MODEL_ID = 'mock-thinking-legacy'
const LEGACY_MODEL_KEY = `${ANTHROPIC_PROVIDER_ID}:${LEGACY_MODEL_ID}`
const REASONING_TEXT_LEARN_T1 = 'E2E adaptive-first modern high __TURN_MODERN_HIGH__ verification'
const REASONING_TEXT_LEARN_T2_LOW = 'E2E adaptive-first legacy low __TURN_LEGACY_LOW__ verification'
const REASONING_TEXT_LEARN_DEFAULT = 'E2E adaptive-first legacy default __TURN_DEFAULT__ verification'
const REASONING_TEXT_LEARN_NONE = 'E2E adaptive-first legacy none __TURN_NONE__ verification'
const REASONING_TEXT_LEGACY = 'E2E adaptive-first legacy high __TURN_LEGACY_HIGH__ verification'
const REASONING_TEXT_LEARN_RELOAD = 'E2E adaptive-first legacy reload low __TURN_RELOAD__ verification'
const REASONING_TEXT_MODERN_AGAIN = 'E2E adaptive-first modern again high __TURN_MODERN_AGAIN__ verification'

async function seedMockAnthropicThinking(page: import('@playwright/test').Page, mockPort: number): Promise<void> {
  const apiHost = `http://127.0.0.1:${mockPort}/v1/`
  await page.evaluate(
    ({
      providerId,
      apiHost,
      learnId,
      legacyId
    }: {
      providerId: string
      apiHost: string
      learnId: string
      legacyId: string
    }) => {
      const store = (window as any).store
      const state = store.getState()
      const existing = state.llm.providers.find((p: any) => p.id === providerId)
      const models = [
        { id: learnId, provider: providerId, name: learnId, group: 'e2e', description: 'E2E generic learn route' },
        { id: legacyId, provider: providerId, name: legacyId, group: 'e2e', description: 'E2E generic legacy route' }
      ]
      if (existing) {
        store.dispatch({
          type: 'llm/updateProvider',
          payload: { id: providerId, apiKey: 'test-key', apiHost, enabled: true, models }
        })
      } else {
        store.dispatch({
          type: 'llm/addProvider',
          payload: {
            id: providerId,
            type: 'anthropic',
            name: 'Mock Anthropic',
            apiKey: 'test-key',
            apiHost,
            models,
            enabled: true,
            isSystem: false
          }
        })
      }
      const assistant = store.getState().assistants.assistants[0]
      if (!assistant) throw new Error('no assistant')
      store.dispatch({
        type: 'assistants/setModel',
        payload: {
          assistantId: assistant.id,
          model: { id: learnId, provider: providerId, name: learnId, group: 'e2e' }
        }
      })
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId: assistant.id,
          settings: {
            reasoning_effort: 'default',
            reasoning_effort_by_model: {},
            reasoning_effort_show_all_by_model: {}
          }
        }
      })
    },
    { providerId: ANTHROPIC_PROVIDER_ID, apiHost, learnId: LEARN_MODEL_ID, legacyId: LEGACY_MODEL_ID }
  )
  await page.waitForFunction(
    ({ modelId, providerId }) => {
      const s = (window as any).store?.getState()
      const assistant = s?.assistants?.assistants?.[0]
      return (
        assistant?.model?.id === modelId &&
        assistant?.model?.provider === providerId &&
        (assistant?.settings?.reasoning_effort ?? 'default') === 'default' &&
        Object.keys(assistant?.settings?.reasoning_effort_by_model ?? {}).length === 0
      )
    },
    { modelId: LEARN_MODEL_ID, providerId: ANTHROPIC_PROVIDER_ID },
    { timeout: 15000 }
  )
}

async function setAnthropicModel(page: import('@playwright/test').Page, modelId: string): Promise<void> {
  await page.evaluate(
    ({ mid, providerId }: { mid: string; providerId: string }) => {
      const store = (window as any).store
      const assistant = store.getState().assistants.assistants[0]
      store.dispatch({
        type: 'assistants/setModel',
        payload: {
          assistantId: assistant.id,
          model: { id: mid, provider: providerId, name: mid, group: 'e2e' }
        }
      })
    },
    { mid: modelId, providerId: ANTHROPIC_PROVIDER_ID }
  )
  await page.waitForFunction(
    (mid: string) => {
      const s = (window as any).store?.getState()
      return s?.assistants?.assistants?.[0]?.model?.id === mid
    },
    modelId,
    { timeout: 15000 }
  )
}

/** Recursively detect any budget-token key (snake/camel) anywhere in the wire body. */
function wireHasBudgetTokens(parsed: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some(visit)
    return Object.entries(value as Record<string, unknown>).some(([key, v]) => {
      if (key === 'budget_tokens' || key === 'budgetTokens') return true
      return visit(v)
    })
  }
  return visit(parsed)
}

function lastAnthropicUserText(parsed: any): string | null {
  const messages = parsed?.messages
  if (!Array.isArray(messages)) return null
  const users = messages.filter((m: any) => m?.role === 'user')
  const last = users.at(-1)
  if (!last) return null
  if (typeof last.content === 'string') return last.content
  if (Array.isArray(last.content)) {
    const texts = (last.content as any[]).filter((p) => p?.type === 'text' && typeof p.text === 'string')
    return texts.length > 0 ? texts.map((p) => p.text).join('\n') : null
  }
  return null
}

async function seedReasoningModels(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    ({ modelA, modelC }: { modelA: string; modelC: string }) => {
      const store = (window as any).store
      const state = store.getState()
      const provider = state.llm.providers.find((p: any) => p.id === 'mock-openai')
      if (!provider) throw new Error('mock-openai provider missing')
      const models = [...provider.models]
      for (const id of [modelA, modelC]) {
        if (!models.some((m: any) => m.id === id)) {
          models.push({ id, provider: 'mock-openai', name: id, group: 'e2e', description: 'E2E reasoning model' })
        }
      }
      store.dispatch({
        type: 'llm/updateProvider',
        payload: {
          id: 'mock-openai',
          models
        }
      })
      const assistant = state.assistants.assistants[0]
      if (!assistant) throw new Error('no assistant')
      store.dispatch({
        type: 'assistants/setModel',
        payload: {
          assistantId: assistant.id,
          model: { id: modelA, provider: 'mock-openai', name: modelA, group: 'e2e' }
        }
      })
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId: assistant.id,
          settings: {
            reasoning_effort: 'default',
            reasoning_effort_by_model: {},
            reasoning_effort_show_all_by_model: {}
          }
        }
      })
    },
    { modelA: MODEL_A_ID, modelC: MODEL_C_ID }
  )
  await page.waitForFunction(
    ({ modelId }) => {
      const s = (window as any).store?.getState()
      const assistant = s?.assistants?.assistants?.[0]
      return (
        assistant?.model?.id === modelId &&
        (assistant?.settings?.reasoning_effort ?? 'default') === 'default' &&
        Object.keys(assistant?.settings?.reasoning_effort_by_model ?? {}).length === 0 &&
        Object.keys(assistant?.settings?.reasoning_effort_show_all_by_model ?? {}).length === 0
      )
    },
    { modelId: MODEL_A_ID },
    { timeout: 15000 }
  )
}

async function seedPerModelContractModels(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    ({ modelA, modelB }: { modelA: string; modelB: string }) => {
      const store = (window as any).store
      const state = store.getState()
      const provider = state.llm.providers.find((p: any) => p.id === 'mock-openai')
      if (!provider) throw new Error('mock-openai provider missing')
      const models = [...provider.models]
      for (const id of [modelA, modelB]) {
        if (!models.some((m: any) => m.id === id)) {
          models.push({ id, provider: 'mock-openai', name: id, group: 'e2e', description: 'E2E reasoning model' })
        }
      }
      store.dispatch({
        type: 'llm/updateProvider',
        payload: {
          id: 'mock-openai',
          models
        }
      })
      const assistant = state.assistants.assistants[0]
      if (!assistant) throw new Error('no assistant')
      store.dispatch({
        type: 'assistants/setModel',
        payload: {
          assistantId: assistant.id,
          model: { id: modelA, provider: 'mock-openai', name: modelA, group: 'e2e' }
        }
      })
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId: assistant.id,
          settings: {
            reasoning_effort: 'default',
            reasoning_effort_by_model: {},
            reasoning_effort_show_all_by_model: {}
          }
        }
      })
    },
    { modelA: MODEL_A_ID, modelB: MODEL_B_ID }
  )
  await page.waitForFunction(
    ({ modelId }) => {
      const s = (window as any).store?.getState()
      const assistant = s?.assistants?.assistants?.[0]
      return (
        assistant?.model?.id === modelId &&
        (assistant?.settings?.reasoning_effort ?? 'default') === 'default' &&
        Object.keys(assistant?.settings?.reasoning_effort_by_model ?? {}).length === 0 &&
        Object.keys(assistant?.settings?.reasoning_effort_show_all_by_model ?? {}).length === 0
      )
    },
    { modelId: MODEL_A_ID },
    { timeout: 15000 }
  )
}

async function seedDeepSeekV4Models(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    ({ modelD }: { modelD: string }) => {
      const store = (window as any).store
      const state = store.getState()
      const provider = state.llm.providers.find((p: any) => p.id === 'mock-openai')
      if (!provider) throw new Error('mock-openai provider missing')
      const models = [...provider.models]
      if (!models.some((m: any) => m.id === modelD)) {
        models.push({ id: modelD, provider: 'mock-openai', name: modelD, group: 'e2e', description: 'E2E deepseek v4' })
      }
      // keep mock-model as well for per-model isolation check
      if (!models.some((m: any) => m.id === 'mock-model')) {
        models.push({ id: 'mock-model', provider: 'mock-openai', name: 'mock-model', group: 'mock' })
      }
      store.dispatch({
        type: 'llm/updateProvider',
        payload: {
          id: 'mock-openai',
          models
        }
      })
      const assistant = state.assistants.assistants[0]
      if (!assistant) throw new Error('no assistant')
      store.dispatch({
        type: 'assistants/setModel',
        payload: {
          assistantId: assistant.id,
          model: { id: modelD, provider: 'mock-openai', name: modelD, group: 'e2e' }
        }
      })
      store.dispatch({
        type: 'assistants/updateAssistantSettings',
        payload: {
          assistantId: assistant.id,
          settings: {
            reasoning_effort: 'default',
            reasoning_effort_by_model: {},
            reasoning_effort_show_all_by_model: {}
          }
        }
      })
    },
    { modelD: MODEL_D_ID }
  )
  await page.waitForFunction(
    ({ modelId }) => {
      const s = (window as any).store?.getState()
      const assistant = s?.assistants?.assistants?.[0]
      return (
        assistant?.model?.id === modelId &&
        (assistant?.settings?.reasoning_effort ?? 'default') === 'default' &&
        Object.keys(assistant?.settings?.reasoning_effort_by_model ?? {}).length === 0
      )
    },
    { modelId: MODEL_D_ID },
    { timeout: 15000 }
  )
}

async function getAssistantState(page: import('@playwright/test').Page): Promise<{
  id: string
  effort: string
  effortByModel: Record<string, string>
  showAllByModel: Record<string, boolean>
  modelId: string
  topicId: string
}> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return {
      id: assistant.id,
      effort: assistant.settings?.reasoning_effort ?? 'default',
      effortByModel: assistant.settings?.reasoning_effort_by_model ?? {},
      showAllByModel: assistant.settings?.reasoning_effort_show_all_by_model ?? {},
      modelId: assistant.model?.id ?? '',
      topicId: assistant.topics?.[0]?.id ?? ''
    }
  })
}

async function setModel(page: import('@playwright/test').Page, modelId: string): Promise<void> {
  await page.evaluate((mid: string) => {
    const store = (window as any).store
    const assistant = store.getState().assistants.assistants[0]
    store.dispatch({
      type: 'assistants/setModel',
      payload: {
        assistantId: assistant.id,
        model: { id: mid, provider: 'mock-openai', name: mid, group: 'e2e' }
      }
    })
  }, modelId)
  await page.waitForFunction(
    (mid: string) => {
      const s = (window as any).store?.getState()
      return s?.assistants?.assistants?.[0]?.model?.id === mid
    },
    modelId,
    { timeout: 15000 }
  )
}

async function openThinkingPopover(page: import('@playwright/test').Page): Promise<void> {
  const thinkingButton = page.getByRole('button', { name: /Reasoning effort|思维链长度|思維鏈長度/i }).first()
  await expect(thinkingButton).toBeVisible({ timeout: 20000 })
  const popover = page.getByTestId('thinking-popover')
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden({ timeout: 10000 })
  await thinkingButton.click()
  await expect(popover).toBeVisible({ timeout: 10000 })
}

async function closeThinkingPopover(page: import('@playwright/test').Page): Promise<void> {
  const popover = page.getByTestId('thinking-popover')
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden({ timeout: 10000 })
}

/** Type into the real chat textarea and submit via Enter (production send path). */
async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  await closeThinkingPopover(page)
  await expect(page.getByTestId('thinking-popover')).toBeHidden({ timeout: 10000 })
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

  test('per-model reasoning effort — A high independent from unset B default, B selection does not leak to A', async ({
    mainWindow
  }) => {
    const page = mainWindow

    await test.step('seed A=grok-3-mini and B=mock-model', async () => {
      await seedPerModelContractModels(page)
      const state = await getAssistantState(page)
      expect(state.modelId).toBe(MODEL_A_ID)
      expect(state.effort).toBe('default')
      expect(Object.keys(state.effortByModel).length).toBe(0)
    })

    await test.step('A selects high via real Thinking Popover', async () => {
      await openThinkingPopover(page)
      const highOption = page.getByTestId('thinking-option-high')
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
      await expect(page.getByTestId('thinking-popover')).toBeHidden({ timeout: 10000 })
    })

    await test.step('assert store and rendered Thinking control state high for A', async () => {
      const state = await getAssistantState(page)
      expect(state.effort).toBe('high')
      expect(state.effortByModel[MODEL_A_KEY]).toBe('high')
      await openThinkingPopover(page)
      const highOption = page.getByTestId('thinking-option-high')
      await expect(highOption).toBeVisible({ timeout: 10000 })
      await expect(highOption).toHaveAttribute('data-selected', 'true')
      await closeThinkingPopover(page)
    })

    await test.step('send via mock and assert captured request shape high for A', async () => {
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
      expect(parsed?.model).toBe(MODEL_A_ID)
      expect(parsed?.stream).toBe(true)
      const messages = parsed?.messages as Array<{ role: string; content: string }>
      expect(Array.isArray(messages)).toBe(true)
      expect(messages.filter((m) => m.role === 'user').at(-1)?.content).toBe(REASONING_TEXT)
      expect(parsed?.reasoning_effort).toBe('high')
    })

    await test.step('switch to B and verify B uses own unset default and A high not incorrectly displayed', async () => {
      await setModel(page, MODEL_B_ID)
      await page.waitForFunction(
        ({ keyA, keyB }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return (
            a?.settings?.reasoning_effort === 'default' && a?.settings?.reasoning_effort_by_model?.[keyA] === 'high'
          )
        },
        { keyA: MODEL_A_KEY, keyB: MODEL_B_KEY },
        { timeout: 15000 }
      )
      const stateB = await getAssistantState(page)
      expect(stateB.modelId).toBe(MODEL_B_ID)
      expect(stateB.effort).toBe('default')
      expect(stateB.effortByModel[MODEL_A_KEY]).toBe('high')
      expect(stateB.effortByModel[MODEL_B_KEY] ?? 'default').toBe('default')
      await openThinkingPopover(page)
      const defaultOption = page.getByTestId('thinking-option-default')
      const highOption = page.getByTestId('thinking-option-high')
      await expect(defaultOption).toBeVisible({ timeout: 10000 })
      await expect(defaultOption).toHaveAttribute('data-selected', 'true')
      await expect(highOption).toBeVisible({ timeout: 10000 })
      await expect(highOption).not.toHaveAttribute('data-selected', 'true')
      await closeThinkingPopover(page)
    })

    await test.step('B selects low and verify B choice', async () => {
      await openThinkingPopover(page)
      const lowOption = page.getByTestId('thinking-option-low')
      await expect(lowOption).toBeVisible({ timeout: 10000 })
      await lowOption.click()
      await page.waitForFunction(
        () => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'low'
        },
        undefined,
        { timeout: 15000 }
      )
      await expect(page.getByTestId('thinking-popover')).toBeHidden({ timeout: 10000 })
      await page.waitForFunction(
        ({ keyB }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return a?.settings?.reasoning_effort === 'low' && a?.settings?.reasoning_effort_by_model?.[keyB] === 'low'
        },
        { keyB: MODEL_B_KEY },
        { timeout: 15000 }
      )
      const after = await getAssistantState(page)
      expect(after.modelId).toBe(MODEL_B_ID)
      expect(after.effort).toBe('low')
      expect(after.effortByModel[MODEL_B_KEY]).toBe('low')
      expect(after.effortByModel[MODEL_A_KEY]).toBe('high')
      await openThinkingPopover(page)
      const lowSelected = page.getByTestId('thinking-option-low')
      await expect(lowSelected).toBeVisible({ timeout: 10000 })
      await expect(lowSelected).toHaveAttribute('data-selected', 'true')
      await closeThinkingPopover(page)
    })

    await test.step('B low request shape verification', async () => {
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
      await uiSendMessage(page, REASONING_TEXT_B)
      await waitForAssistantResponseComplete(page, state.topicId, prevAssistantCount)
      const request = findProductRequestAfter(before)
      expect(request).not.toBeNull()
      expect(request!.method).toBe('POST')
      expect(request!.url).toBe('/v1/chat/completions')
      const parsed = request!.parsed as any
      expect(parsed?.model).toBe(MODEL_B_ID)
      expect(parsed?.reasoning_effort).toBe('low')
    })

    await test.step('switch back to A and verify A restores high', async () => {
      await setModel(page, MODEL_A_ID)
      await page.waitForFunction(
        ({ keyA, keyB }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return (
            a?.model?.id === keyA.split(':')[1] &&
            a?.settings?.reasoning_effort === 'high' &&
            a?.settings?.reasoning_effort_by_model?.[keyB] === 'low'
          )
        },
        { keyA: MODEL_A_KEY, keyB: MODEL_B_KEY },
        { timeout: 15000 }
      )
      const stateA = await getAssistantState(page)
      expect(stateA.modelId).toBe(MODEL_A_ID)
      expect(stateA.effort).toBe('high')
      expect(stateA.effortByModel[MODEL_A_KEY]).toBe('high')
      expect(stateA.effortByModel[MODEL_B_KEY]).toBe('low')
      await openThinkingPopover(page)
      const highOption = page.getByTestId('thinking-option-high')
      await expect(highOption).toBeVisible({ timeout: 10000 })
      await expect(highOption).toHaveAttribute('data-selected', 'true')
      await closeThinkingPopover(page)
    })
  })

  test('anchored thinking popover show-all per provider:modelId independent persistence, toggle does not change reasoning_effort, switch restores', async ({
    mainWindow
  }) => {
    const page = mainWindow

    await test.step('seed two reasoning models and reset state', async () => {
      await seedReasoningModels(page)
      const state = await getAssistantState(page)
      expect(state.modelId).toBe(MODEL_A_ID)
      expect(state.effort).toBe('default')
      expect(Object.keys(state.showAllByModel).length).toBe(0)
    })

    await test.step('toggle show-all for model A does not change reasoning_effort and persists per key', async () => {
      const before = await getAssistantState(page)
      const beforeEffort = before.effort
      await openThinkingPopover(page)
      await expect(page.getByTestId('thinking-option-default')).toBeVisible({ timeout: 10000 })
      await expect(page.getByTestId('thinking-option-low')).toBeVisible()
      await expect(page.getByTestId('thinking-option-high')).toBeVisible()
      await expect(page.getByTestId('thinking-option-xhigh')).toBeHidden({ timeout: 5000 })
      const showAllSwitch = page.getByTestId('thinking-show-all-switch')
      await expect(showAllSwitch).toBeVisible({ timeout: 10000 })
      await expect(showAllSwitch).toHaveAttribute('aria-pressed', 'false')
      await showAllSwitch.click()
      await page.waitForFunction(
        ({ key }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return a.settings?.reasoning_effort_show_all_by_model?.[key] === true
        },
        { key: MODEL_A_KEY },
        { timeout: 15000 }
      )
      const after = await getAssistantState(page)
      expect(after.showAllByModel[MODEL_A_KEY]).toBe(true)
      expect(after.effort).toBe(beforeEffort)
      await expect(showAllSwitch).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('thinking-popover')).toBeVisible({ timeout: 10000 })
      for (const opt of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto'] as const) {
        await expect(page.getByTestId(`thinking-option-${opt}`)).toBeVisible({ timeout: 10000 })
      }
      await closeThinkingPopover(page)
    })

    await test.step('switching to model C has independent show-all false and does not carry A state', async () => {
      await setModel(page, MODEL_C_ID)
      await page.waitForFunction(
        ({ keyA }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return a?.settings?.reasoning_effort_show_all_by_model?.[keyA] === true
        },
        { keyA: MODEL_A_KEY },
        { timeout: 15000 }
      )
      const stateB = await getAssistantState(page)
      expect(stateB.modelId).toBe(MODEL_C_ID)
      expect(stateB.showAllByModel[MODEL_C_KEY] ?? false).toBe(false)
      expect(stateB.showAllByModel[MODEL_A_KEY]).toBe(true)
      await openThinkingPopover(page)
      await expect(page.getByTestId('thinking-show-all-switch')).toBeVisible()
      await expect(page.getByTestId('thinking-show-all-switch')).toHaveAttribute('aria-pressed', 'false')
      await expect(page.getByTestId('thinking-option-xhigh')).toBeHidden({ timeout: 5000 })
      await page.getByTestId('thinking-show-all-switch').click()
      await page.waitForFunction(
        ({ key }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return a.settings?.reasoning_effort_show_all_by_model?.[key] === true
        },
        { key: MODEL_C_KEY },
        { timeout: 15000 }
      )
      const afterB = await getAssistantState(page)
      expect(afterB.showAllByModel[MODEL_C_KEY]).toBe(true)
      expect(afterB.showAllByModel[MODEL_A_KEY]).toBe(true)
      expect(afterB.effort).toBe('default')
      await expect(page.getByTestId('thinking-show-all-switch')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('thinking-popover')).toBeVisible()
      await closeThinkingPopover(page)
    })

    await test.step('toggle C back to false keeps A true', async () => {
      await openThinkingPopover(page)
      await expect(page.getByTestId('thinking-show-all-switch')).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('thinking-show-all-switch').click()
      await page.waitForFunction(
        ({ key }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return a.settings?.reasoning_effort_show_all_by_model?.[key] === false
        },
        { key: MODEL_C_KEY },
        { timeout: 15000 }
      )
      const after = await getAssistantState(page)
      expect(after.showAllByModel[MODEL_C_KEY]).toBe(false)
      expect(after.showAllByModel[MODEL_A_KEY]).toBe(true)
      await expect(page.getByTestId('thinking-show-all-switch')).toHaveAttribute('aria-pressed', 'false')
      await closeThinkingPopover(page)
    })

    await test.step('switching back to model A restores its show-all and effort independently', async () => {
      await openThinkingPopover(page)
      await closeThinkingPopover(page)
      await page.evaluate(
        ({ keyC }) => {
          const store = (window as any).store
          const a = store.getState().assistants.assistants[0]
          store.dispatch({
            type: 'assistants/updateAssistantSettings',
            payload: {
              assistantId: a.id,
              settings: {
                reasoning_effort: 'low',
                reasoning_effort_by_model: { ...a.settings.reasoning_effort_by_model, [keyC]: 'low' }
              }
            }
          })
        },
        { keyC: MODEL_C_KEY }
      )
      await page.waitForFunction(
        () => (window as any).store.getState().assistants.assistants[0].settings.reasoning_effort === 'low',
        undefined,
        { timeout: 10000 }
      )
      await setModel(page, MODEL_A_ID)
      await page.evaluate(
        ({ keyA }) => {
          const store = (window as any).store
          const a = store.getState().assistants.assistants[0]
          store.dispatch({
            type: 'assistants/updateAssistantSettings',
            payload: {
              assistantId: a.id,
              settings: {
                reasoning_effort: 'high',
                reasoning_effort_by_model: { ...a.settings.reasoning_effort_by_model, [keyA]: 'high' }
              }
            }
          })
        },
        { keyA: MODEL_A_KEY }
      )
      await page.waitForFunction(
        () => (window as any).store.getState().assistants.assistants[0].settings.reasoning_effort === 'high',
        undefined,
        { timeout: 10000 }
      )
      await openThinkingPopover(page)
      await expect(page.getByTestId('thinking-option-xhigh')).toBeVisible({ timeout: 10000 })
      await expect(page.getByTestId('thinking-show-all-switch')).toBeVisible()
      await expect(page.getByTestId('thinking-show-all-switch')).toHaveAttribute('aria-pressed', 'true')
      const showAllChecked = await page.evaluate(
        ({ key }) => {
          const s = (window as any).store.getState()
          const a = s.assistants.assistants[0]
          return s.assistants.assistants[0].settings.reasoning_effort_show_all_by_model[key]
        },
        { key: MODEL_A_KEY }
      )
      expect(showAllChecked).toBe(true)
      await closeThinkingPopover(page)
      await setModel(page, MODEL_C_ID)
      await page.waitForFunction(
        ({ keyC }) => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'low'
        },
        { keyC: MODEL_C_KEY },
        { timeout: 15000 }
      )
      const stateB2 = await getAssistantState(page)
      expect(stateB2.effort).toBe('low')
      expect(stateB2.showAllByModel[MODEL_C_KEY]).toBe(false)
      await openThinkingPopover(page)
      await expect(page.getByTestId('thinking-show-all-switch')).toHaveAttribute('aria-pressed', 'false')
      await expect(page.getByTestId('thinking-option-xhigh')).toBeHidden({ timeout: 5000 })
      await closeThinkingPopover(page)
      await setModel(page, MODEL_A_ID)
      await page.waitForFunction(
        () => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'high'
        },
        undefined,
        { timeout: 15000 }
      )
      const stateA2 = await getAssistantState(page)
      expect(stateA2.effort).toBe('high')
      expect(stateA2.showAllByModel[MODEL_A_KEY]).toBe(true)
    })

    await test.step('verify localStorage persistence for show-all (no fake restart proof)', async () => {
      await page.waitForFunction(
        ({ keyA, keyC }) => {
          const wire = localStorage.getItem('persist:cherry-studio')
          if (!wire) return false
          try {
            const outer = JSON.parse(wire)
            const sliceStr = outer.assistants
            if (typeof sliceStr !== 'string') return false
            const slice = JSON.parse(sliceStr)
            const a = slice.assistants?.[0]
            return (
              a?.settings?.reasoning_effort_show_all_by_model?.[keyA] === true &&
              a?.settings?.reasoning_effort_show_all_by_model?.[keyC] === false
            )
          } catch {
            return false
          }
        },
        { keyA: MODEL_A_KEY, keyC: MODEL_C_KEY },
        { timeout: 15000 }
      )
      const wire = await page.evaluate(() => localStorage.getItem('persist:cherry-studio'))
      expect(wire).not.toBeNull()
      const outer = JSON.parse(wire!)
      const assistantsSliceStr = outer.assistants
      expect(typeof assistantsSliceStr).toBe('string')
      const assistantsSlice = JSON.parse(assistantsSliceStr)
      const assistant = assistantsSlice.assistants?.[0]
      expect(assistant?.settings?.reasoning_effort_show_all_by_model?.[MODEL_A_KEY]).toBe(true)
      expect(assistant?.settings?.reasoning_effort_show_all_by_model?.[MODEL_C_KEY]).toBe(false)
      console.log('[E2E] localStorage persist:cherry-studio proves show_all map durability')
    })
  })

  test('DeepSeek V4 none via Thinking popover — default dialect reasoning_effort none and per-model persistence', async ({
    mainWindow
  }) => {
    const page = mainWindow

    await test.step('seed deepseek-v4 and reset state', async () => {
      await seedDeepSeekV4Models(page)
      const state = await getAssistantState(page)
      expect(state.modelId).toBe(MODEL_D_ID)
      expect(state.effort).toBe('default')
      expect(Object.keys(state.effortByModel).length).toBe(0)
    })

    await test.step('select none via real Thinking Popover (anchor: mock provider deepseek-v4)', async () => {
      await openThinkingPopover(page)
      const noneOption = page.getByTestId('thinking-option-none')
      await expect(noneOption).toBeVisible({ timeout: 10000 })
      await noneOption.click()
      await page.waitForFunction(
        () => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'none'
        },
        undefined,
        { timeout: 15000 }
      )
      await expect(page.getByTestId('thinking-popover')).toBeHidden({ timeout: 10000 })
    })

    await test.step('assert store and popover selected none and per-model key', async () => {
      const state = await getAssistantState(page)
      expect(state.effort).toBe('none')
      expect(state.effortByModel[MODEL_D_KEY]).toBe('none')
      await openThinkingPopover(page)
      const noneOption = page.getByTestId('thinking-option-none')
      await expect(noneOption).toBeVisible({ timeout: 10000 })
      await expect(noneOption).toHaveAttribute('data-selected', 'true')
      await closeThinkingPopover(page)
    })

    await test.step('send via mock and assert default dialect wire reasoning_effort none (unknown/mock host)', async () => {
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
      await uiSendMessage(page, REASONING_TEXT_D_NONE)
      await waitForAssistantResponseComplete(page, state.topicId, prevAssistantCount)
      const request = findProductRequestAfter(before)
      expect(request).not.toBeNull()
      expect(request!.method).toBe('POST')
      expect(request!.url).toBe('/v1/chat/completions')
      const parsed = request!.parsed as any
      expect(parsed?.model).toBe(MODEL_D_ID)
      // mock/unknown OpenAI-compatible default dialect: single field reasoning_effort:'none', no thinking/enable_thinking
      expect(parsed?.reasoning_effort).toBe('none')
      expect(parsed?.thinking).toBeUndefined()
      expect(parsed?.enable_thinking).toBeUndefined()
      // AI SDK camel key must not appear on wire
      expect(parsed?.reasoningEffort).toBeUndefined()
    })

    await test.step('per-model persistence: none does not leak to mock-model, switch restores', async () => {
      // switch to plain mock-model -> should be default (not none)
      await setModel(page, MODEL_B_ID)
      await page.waitForFunction(
        ({ keyD }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return (
            a?.settings?.reasoning_effort === 'default' && a?.settings?.reasoning_effort_by_model?.[keyD] === 'none'
          )
        },
        { keyD: MODEL_D_KEY },
        { timeout: 15000 }
      )
      const stateB = await getAssistantState(page)
      expect(stateB.modelId).toBe(MODEL_B_ID)
      expect(stateB.effort).toBe('default')
      expect(stateB.effortByModel[MODEL_D_KEY]).toBe('none')
      await openThinkingPopover(page)
      await expect(page.getByTestId('thinking-option-default')).toHaveAttribute('data-selected', 'true')
      await closeThinkingPopover(page)

      // switch back to deepseek-v4 -> restores none
      await setModel(page, MODEL_D_ID)
      await page.waitForFunction(
        () => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'none'
        },
        undefined,
        { timeout: 15000 }
      )
      const stateD2 = await getAssistantState(page)
      expect(stateD2.modelId).toBe(MODEL_D_ID)
      expect(stateD2.effort).toBe('none')
      expect(stateD2.effortByModel[MODEL_D_KEY]).toBe('none')
    })
  })

  test('thinking lifecycle leak: reasoning-start/delta without reasoning-end must not leave STREAMING and timer stabilizes', async ({
    mainWindow
  }) => {
    const page = mainWindow

    await test.step('seed deepseek-v4 and set high (thinking enabled) for leak', async () => {
      await seedDeepSeekV4Models(page)
      // ensure high is available via popover; toggle showAll if needed to expose high if filtered
      const stateBefore = await getAssistantState(page)
      if (stateBefore.effort !== 'high') {
        await openThinkingPopover(page)
        // if high hidden, toggle showAll
        const highOpt = page.getByTestId('thinking-option-high')
        const highVisible = await highOpt.isVisible().catch(() => false)
        if (!highVisible) {
          await page.getByTestId('thinking-show-all-switch').click()
          await expect(page.getByTestId('thinking-option-high')).toBeVisible({ timeout: 10000 })
        }
        await page.getByTestId('thinking-option-high').click()
        await page.waitForFunction(
          () => {
            const s = (window as any).store?.getState()
            return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === 'high'
          },
          undefined,
          { timeout: 15000 }
        )
        await expect(page.getByTestId('thinking-popover')).toBeHidden({ timeout: 10000 })
      }
    })

    await test.step('send leak marker and wait for completion', async () => {
      clearRequestLog()
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
      await uiSendMessage(page, REASONING_TEXT_D_LEAK)
      await waitForAssistantResponseComplete(page, state.topicId, prevAssistantCount)
      // also ensure at least one product request was captured (wire integrity)
      const req = findProductRequestAfter(0)
      expect(req).not.toBeNull()
    })

    await test.step('assert no STREAMING thinking block remains', async () => {
      const streamingCount = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        return blocks.filter((b) => b.type === 'thinking' && b.status === 'streaming').length
      })
      expect(streamingCount).toBe(0)

      const statuses = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        const thinking = blocks.filter((b) => b.type === 'thinking')
        return thinking.map((b: any) => ({ id: b.id, status: b.status, millsec: b.thinking_millsec }))
      })
      // if a thinking block exists, it must be success (MessageBlockStatus.SUCCESS === 'success')
      for (const th of statuses) {
        expect(th.status).toBe('success')
      }
    })

    await test.step('thinking timer stability: millsec and UI text not growing after SUCCESS', async () => {
      // capture thinking_millsec twice with delay; must be identical after SUCCESS
      const firstMillsec = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        const thinking = [...blocks]
          .filter((b: any) => b.type === 'thinking')
          .sort((a: any, b: any) => (a.createdAt > b.createdAt ? 1 : -1))
          .at(-1) as any
        return thinking ? thinking.thinking_millsec : null
      })

      // also capture UI timer text if present
      const firstText = await page
        .locator('.message-thought-container')
        .first()
        .textContent()
        .catch(() => null)

      await page.waitForTimeout(800)

      const secondMillsec = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        const thinking = [...blocks]
          .filter((b: any) => b.type === 'thinking')
          .sort((a: any, b: any) => (a.createdAt > b.createdAt ? 1 : -1))
          .at(-1) as any
        return thinking ? thinking.thinking_millsec : null
      })
      const secondText = await page
        .locator('.message-thought-container')
        .first()
        .textContent()
        .catch(() => null)

      if (firstMillsec !== null && secondMillsec !== null) {
        expect(secondMillsec).toBe(firstMillsec)
      }
      if (firstText && secondText) {
        expect(secondText).toBe(firstText)
      }
      // explicit invariant: no streaming after completion even after delay
      const stillStreaming = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        return blocks.filter((b: any) => b.type === 'thinking' && b.status === 'streaming').length
      })
      expect(stillStreaming).toBe(0)
    })
  })

  test('Anthropic adaptive-first default — modern direct adaptive, legacy falls back to enabled then persists', async ({
    mainWindow,
    mockPort
  }) => {
    const page = mainWindow

    async function assistantCount(topicId: string): Promise<number> {
      return page.evaluate((tid: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[tid] || []
        let count = 0
        for (const id of msgIds) {
          if (s.messages.entities[id]?.role === 'assistant') count++
        }
        return count
      }, topicId)
    }

    async function selectEffort(option: 'high' | 'low' | 'default' | 'none'): Promise<void> {
      await openThinkingPopover(page)
      const opt = page.getByTestId(`thinking-option-${option}`)
      await expect(opt).toBeVisible({ timeout: 10000 })
      await opt.click()
      await page.waitForFunction(
        (expected: string) => {
          const s = (window as any).store?.getState()
          return s?.assistants?.assistants?.[0]?.settings?.reasoning_effort === expected
        },
        option,
        { timeout: 15000 }
      )
      await expect(page.getByTestId('thinking-popover')).toBeHidden({ timeout: 10000 })
    }

    await test.step('seed modern + legacy on the same mock-anthropic endpoint', async () => {
      clearMockAnthropicThinkingBehaviors()
      await seedMockAnthropicThinking(page, mockPort)
      // Test-owned mock capability: modern accepts adaptive, legacy accepts enabled only.
      // No model-name heuristics in the mock — exact raw strings configured by this test.
      // Default is `both` (permissive); OpenAI chat-completions behavior is untouched.
      setMockAnthropicThinkingBehavior(LEARN_MODEL_ID, 'adaptive-only')
      setMockAnthropicThinkingBehavior(LEGACY_MODEL_ID, 'enabled-only')
      const state = await getAssistantState(page)
      expect(state.modelId).toBe(LEARN_MODEL_ID)
      expect(state.effort).toBe('default')
      expect(Object.keys(state.effortByModel).length).toBe(0)
    })

    await test.step('select high via real Thinking Popover', async () => {
      await selectEffort('high')
      const state = await getAssistantState(page)
      expect(state.effort).toBe('high')
      expect(state.effortByModel[LEARN_MODEL_KEY]).toBe('high')
    })

    await test.step('modern high: 1 adaptive+effort direct, no budget, 1 assistant message', async () => {
      clearRequestLog()
      const before = getRequestSequence()
      const state = await getAssistantState(page)
      const prevCount = await assistantCount(state.topicId)
      await uiSendMessage(page, REASONING_TEXT_LEARN_T1)
      await waitForAssistantResponseComplete(page, state.topicId, prevCount)
      const requests = findAnthropicRequestsAfter(before)
      expect(requests.length).toBe(1)
      const only = requests[0]
      expect(only.method).toBe('POST')
      expect(only.url).toBe('/v1/messages')
      const parsed = only.parsed as any
      // Same endpoint + raw model + turn text.
      expect(parsed?.model).toBe(LEARN_MODEL_ID)
      expect(lastAnthropicUserText(parsed)).toBe(REASONING_TEXT_LEARN_T1)
      // NEW default: explicit strength starts adaptive+effort natively.
      expect(parsed?.thinking?.type).toBe('adaptive')
      expect(parsed?.output_config?.effort).toBe('high')
      expect(wireHasBudgetTokens(parsed)).toBe(false)
      expect(parsed?.thinking?.budget_tokens).toBeUndefined()
      expect(parsed?.thinking?.budgetTokens).toBeUndefined()
      // No OpenAI-protocol request for this Anthropic turn.
      expect(findProductRequestAfter(before)).toBeNull()
      // Single attempt must yield exactly one visible assistant message (history preserved).
      const afterCount = await assistantCount(state.topicId)
      expect(afterCount - prevCount).toBe(1)
    })

    let legacyHighBudgetTokens = -1

    await test.step('legacy high falls back: adaptive 400 → enabled+budget retry (2 requests, 1 assistant message)', async () => {
      await setAnthropicModel(page, LEGACY_MODEL_ID)
      await page.waitForFunction(
        ({ learnKey }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return (
            a?.settings?.reasoning_effort === 'default' && a?.settings?.reasoning_effort_by_model?.[learnKey] === 'high'
          )
        },
        { learnKey: LEARN_MODEL_KEY },
        { timeout: 15000 }
      )
      const legacyDefault = await getAssistantState(page)
      expect(legacyDefault.modelId).toBe(LEGACY_MODEL_ID)
      expect(legacyDefault.effort).toBe('default')
      await selectEffort('high')
      clearRequestLog()
      const before = getRequestSequence()
      const state = await getAssistantState(page)
      expect(state.effortByModel[LEGACY_MODEL_KEY]).toBe('high')
      expect(state.effortByModel[LEARN_MODEL_KEY]).toBe('high')
      const prevCount = await assistantCount(state.topicId)
      await uiSendMessage(page, REASONING_TEXT_LEGACY)
      await waitForAssistantResponseComplete(page, state.topicId, prevCount)
      const requests = findAnthropicRequestsAfter(before)
      expect(requests.length).toBe(2)
      const [first, second] = requests
      expect(first.method).toBe('POST')
      expect(first.url).toBe('/v1/messages')
      expect(second.method).toBe('POST')
      expect(second.url).toBe('/v1/messages')
      const firstParsed = first.parsed as any
      const secondParsed = second.parsed as any
      // Same model / same turn / same messages on both legs; only the thinking body format changes.
      // (Scope headers enter the hashed scope key only; the mock logs method/url/body.)
      expect(firstParsed?.model).toBe(LEGACY_MODEL_ID)
      expect(secondParsed?.model).toBe(LEGACY_MODEL_ID)
      expect(lastAnthropicUserText(firstParsed)).toBe(REASONING_TEXT_LEGACY)
      expect(lastAnthropicUserText(secondParsed)).toBe(REASONING_TEXT_LEGACY)
      expect(JSON.stringify(firstParsed?.messages)).toBe(JSON.stringify(secondParsed?.messages))
      // First leg is the NEW adaptive-first default with native effort.
      expect(firstParsed?.thinking?.type).toBe('adaptive')
      expect(firstParsed?.output_config?.effort).toBe('high')
      expect(wireHasBudgetTokens(firstParsed)).toBe(false)
      // Retry is enabled with an explicit numeric budget, no adaptive effort.
      expect(secondParsed?.thinking?.type).toBe('enabled')
      expect(typeof secondParsed?.thinking?.budget_tokens).toBe('number')
      expect(secondParsed?.thinking?.budget_tokens).toBeGreaterThanOrEqual(1024)
      expect(secondParsed?.output_config).toBeUndefined()
      expect(wireHasBudgetTokens(secondParsed)).toBe(true)
      legacyHighBudgetTokens = secondParsed?.thinking?.budget_tokens as number
      // No OpenAI-protocol request for this Anthropic turn; no duplicate assistant message.
      expect(findProductRequestAfter(before)).toBeNull()
      const afterCount = await assistantCount(state.topicId)
      expect(afterCount - prevCount).toBe(1)
    })

    await test.step('legacy low goes direct enabled with a different budget (strength not cached)', async () => {
      await selectEffort('low')
      clearRequestLog()
      const before = getRequestSequence()
      const state = await getAssistantState(page)
      expect(state.effortByModel[LEGACY_MODEL_KEY]).toBe('low')
      const prevCount = await assistantCount(state.topicId)
      await uiSendMessage(page, REASONING_TEXT_LEARN_T2_LOW)
      await waitForAssistantResponseComplete(page, state.topicId, prevCount)
      const requests = findAnthropicRequestsAfter(before)
      expect(requests.length).toBe(1)
      const parsed = requests[0].parsed as any
      expect(requests[0].method).toBe('POST')
      expect(requests[0].url).toBe('/v1/messages')
      expect(parsed?.model).toBe(LEGACY_MODEL_ID)
      expect(lastAnthropicUserText(parsed)).toBe(REASONING_TEXT_LEARN_T2_LOW)
      expect(parsed?.thinking?.type).toBe('enabled')
      expect(typeof parsed?.thinking?.budget_tokens).toBe('number')
      expect(parsed?.thinking?.budget_tokens).toBeGreaterThanOrEqual(1024)
      expect(parsed?.output_config).toBeUndefined()
      expect(wireHasBudgetTokens(parsed)).toBe(true)
      // Learned format persists but strength is re-read per request: low budget differs from high.
      expect(parsed?.thinking?.budget_tokens).not.toBe(legacyHighBudgetTokens)
      expect(findProductRequestAfter(before)).toBeNull()
      const afterCount = await assistantCount(state.topicId)
      expect(afterCount - prevCount).toBe(1)
    })

    await test.step('learned enabled persists across renderer reload: next legacy send is 1 enabled request', async () => {
      await page.reload()
      await waitForAppReady(page)
      await page.waitForFunction(
        ({ mid, providerId }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return a?.model?.id === mid && a?.model?.provider === providerId
        },
        { mid: LEGACY_MODEL_ID, providerId: ANTHROPIC_PROVIDER_ID },
        { timeout: 60000 }
      )
      const rehydrated = await getAssistantState(page)
      expect(rehydrated.modelId).toBe(LEGACY_MODEL_ID)
      expect(rehydrated.effort).toBe('low')
      expect(rehydrated.effortByModel[LEGACY_MODEL_KEY]).toBe('low')
      // Mock behavior map lives in the test process and survives renderer reload.
      clearRequestLog()
      const before = getRequestSequence()
      const prevCount = await assistantCount(rehydrated.topicId)
      await uiSendMessage(page, REASONING_TEXT_LEARN_RELOAD)
      await waitForAssistantResponseComplete(page, rehydrated.topicId, prevCount)
      const requests = findAnthropicRequestsAfter(before)
      expect(requests.length).toBe(1)
      const parsed = requests[0].parsed as any
      expect(parsed?.model).toBe(LEGACY_MODEL_ID)
      expect(lastAnthropicUserText(parsed)).toBe(REASONING_TEXT_LEARN_RELOAD)
      expect(parsed?.thinking?.type).toBe('enabled')
      expect(typeof parsed?.thinking?.budget_tokens).toBe('number')
      expect(parsed?.thinking?.budget_tokens).toBeGreaterThanOrEqual(1024)
      expect(parsed?.output_config).toBeUndefined()
      expect(findProductRequestAfter(before)).toBeNull()
      const afterCount = await assistantCount(rehydrated.topicId)
      expect(afterCount - prevCount).toBe(1)
    })

    await test.step('legacy default sends no thinking override in a single request (cache never overrides off)', async () => {
      await selectEffort('default')
      clearRequestLog()
      const before = getRequestSequence()
      const state = await getAssistantState(page)
      const prevCount = await assistantCount(state.topicId)
      await uiSendMessage(page, REASONING_TEXT_LEARN_DEFAULT)
      await waitForAssistantResponseComplete(page, state.topicId, prevCount)
      const requests = findAnthropicRequestsAfter(before)
      expect(requests.length).toBe(1)
      const parsed = requests[0].parsed as any
      expect(parsed?.model).toBe(LEGACY_MODEL_ID)
      expect(lastAnthropicUserText(parsed)).toBe(REASONING_TEXT_LEARN_DEFAULT)
      expect(parsed?.thinking).toBeUndefined()
      expect(parsed?.output_config).toBeUndefined()
      expect(wireHasBudgetTokens(parsed)).toBe(false)
      expect(findProductRequestAfter(before)).toBeNull()
      const afterCount = await assistantCount(state.topicId)
      expect(afterCount - prevCount).toBe(1)
    })

    await test.step('legacy none stays exact disabled in a single request (server permits disabled, never negotiates)', async () => {
      await selectEffort('none')
      const stored = await getAssistantState(page)
      expect(stored.effortByModel[LEGACY_MODEL_KEY]).toBe('none')
      clearRequestLog()
      const before = getRequestSequence()
      const prevCount = await assistantCount(stored.topicId)
      await uiSendMessage(page, REASONING_TEXT_LEARN_NONE)
      await waitForAssistantResponseComplete(page, stored.topicId, prevCount)
      const requests = findAnthropicRequestsAfter(before)
      expect(requests.length).toBe(1)
      const parsed = requests[0].parsed as any
      expect(parsed?.model).toBe(LEGACY_MODEL_ID)
      expect(lastAnthropicUserText(parsed)).toBe(REASONING_TEXT_LEARN_NONE)
      expect(parsed?.thinking).toEqual({ type: 'disabled' })
      expect(parsed?.output_config).toBeUndefined()
      expect(wireHasBudgetTokens(parsed)).toBe(false)
      expect(findProductRequestAfter(before)).toBeNull()
      const afterCount = await assistantCount(stored.topicId)
      expect(afterCount - prevCount).toBe(1)
    })

    await test.step('modern again stays adaptive direct on the same endpoint (model-scope separation)', async () => {
      await setAnthropicModel(page, LEARN_MODEL_ID)
      await page.waitForFunction(
        ({ learnKey, legacyKey }) => {
          const s = (window as any).store?.getState()
          const a = s?.assistants?.assistants?.[0]
          return (
            a?.model?.id === learnKey.split(':')[1] &&
            a?.settings?.reasoning_effort === 'high' &&
            a?.settings?.reasoning_effort_by_model?.[legacyKey] === 'none'
          )
        },
        { learnKey: LEARN_MODEL_KEY, legacyKey: LEGACY_MODEL_KEY },
        { timeout: 15000 }
      )
      const state = await getAssistantState(page)
      expect(state.modelId).toBe(LEARN_MODEL_ID)
      expect(state.effort).toBe('high')
      expect(state.effortByModel[LEARN_MODEL_KEY]).toBe('high')
      expect(state.effortByModel[LEGACY_MODEL_KEY]).toBe('none')
      clearRequestLog()
      const before = getRequestSequence()
      const prevCount = await assistantCount(state.topicId)
      await uiSendMessage(page, REASONING_TEXT_MODERN_AGAIN)
      await waitForAssistantResponseComplete(page, state.topicId, prevCount)
      const requests = findAnthropicRequestsAfter(before)
      expect(requests.length).toBe(1)
      const parsed = requests[0].parsed as any
      expect(requests[0].method).toBe('POST')
      expect(requests[0].url).toBe('/v1/messages')
      expect(parsed?.model).toBe(LEARN_MODEL_ID)
      expect(lastAnthropicUserText(parsed)).toBe(REASONING_TEXT_MODERN_AGAIN)
      expect(parsed?.thinking?.type).toBe('adaptive')
      expect(parsed?.output_config?.effort).toBe('high')
      expect(wireHasBudgetTokens(parsed)).toBe(false)
      expect(findProductRequestAfter(before)).toBeNull()
      const afterCount = await assistantCount(state.topicId)
      expect(afterCount - prevCount).toBe(1)
      clearMockAnthropicThinkingBehaviors()
    })
  })
})
