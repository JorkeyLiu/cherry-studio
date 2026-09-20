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
  clearRequestLog,
  expect,
  findProductRequestAfter,
  getRequestSequence,
  test
} from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const MODEL_A_ID = 'grok-3-mini'
const MODEL_B_ID = 'mock-model'
const MODEL_C_ID = 'grok-3-mini-2'
const MODEL_A_KEY = `mock-openai:${MODEL_A_ID}`
const MODEL_B_KEY = `mock-openai:${MODEL_B_ID}`
const MODEL_C_KEY = `mock-openai:${MODEL_C_ID}`
const REASONING_TEXT = 'E2E reasoning effort verification'
const REASONING_TEXT_B = 'E2E reasoning effort B low verification'

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
      await expect(page.getByRole('switch').first()).toBeVisible({ timeout: 10000 })
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
      await expect(page.getByTestId('thinking-popover')).toBeVisible()
      await closeThinkingPopover(page)
    })

    await test.step('toggle C back to false keeps A true', async () => {
      await openThinkingPopover(page)
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
})
