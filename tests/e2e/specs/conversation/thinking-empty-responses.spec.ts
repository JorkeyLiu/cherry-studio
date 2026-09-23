/**
 * Empty-Responses-reasoning regression — no empty thinking block, no running timer.
 *
 * Scenario: "OpenAI Responses 无摘要文本，仅 reasoning item start/end，随后回答完成".
 * Real Responses wire end to end: the spec switches the seeded mock provider
 * to `provider.type=openai-response` (same `mock-openai` entry, same
 * `mock-model` id, same mock `apiHost`), so the production chain resolves
 * the pinned `@ai-sdk/openai` 3.0.53 Responses language model
 * (`AiProvider` → `providerToAiSdkConfig` → `createExecutor('openai')` →
 * default Responses model → `POST {baseURL}/responses`) against the
 * in-process mock `/v1/responses` SSE. The SSE emits
 * `response.output_item.added[type=reasoning]` → `reasoning-start`, zero
 * `response.reasoning_summary_text.delta` (no summary text),
 * `response.output_item.done[type=reasoning]` → `reasoning-end`, then the
 * message item + `response.output_text.delta` answer and
 * `response.completed` (see `buildResponsesEvents` in
 * `fixtures/mock-openai-server.ts` for the exact pinned-schema events).
 * The AiSdkToChunkAdapter fix delays THINKING_START until visible thinking
 * text appears, so this sequence must produce NO thinking block at all — no
 * empty shell, no ticking timer — while the answer still renders and
 * completes. ThinkingBlock additionally renders null for empty/
 * whitespace-only content as defense in depth.
 *
 * No transport-equivalence claim: the spec asserts the mock received
 * `POST /v1/responses` and that NO `POST /v1/chat/completions` was sent for
 * this marker turn. Part-level unit coverage for the exact
 * `reasoning-start → reasoning-end → text → finish` sequence already exists
 * in `AiSdkToChunkAdapter.reasoningFallback.test.ts`.
 *
 * LOCK-001 disposable profile, LOCK-002 mock only, LOCK-003 no i18n changes.
 */
import { clearRequestLog, expect, getRequestLog, getRequestSequence, test } from '../../fixtures/electron.fixture'
import {
  findChatRequestsAfter,
  findResponsesRequestAfter,
  RESPONSES_EMPTY_REASONING_MARKER
} from '../../fixtures/mock-openai-server'
import { waitForAppReady } from '../../utils/wait-helpers'

const EMPTY_REASONING_TEXT = `E2E empty responses reasoning ${RESPONSES_EMPTY_REASONING_MARKER}`
const ANSWER_TAIL = 'verified-END'

async function getActiveTopicId(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return assistant?.topics?.[0]?.id ?? ''
  })
}

async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const popover = page.getByTestId('thinking-popover')
  try {
    if (await popover.isVisible({ timeout: 1500 }).catch(() => false)) {
      await page.keyboard.press('Escape')
      await expect(popover)
        .toBeHidden({ timeout: 5000 })
        .catch(() => {})
    }
  } catch {}
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

async function snapshotThinkingState(page: import('@playwright/test').Page, topicId: string) {
  return page.evaluate((tid: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[tid] || []
    let latest: string | null = null
    for (let i = msgIds.length - 1; i >= 0; i--) {
      if (s.messages.entities[msgIds[i]]?.role === 'assistant') {
        latest = msgIds[i]
        break
      }
    }
    const entities = s.messageBlocks.entities as Record<string, any>
    const msgBlocks = latest ? ((s.messages.entities[latest]?.blocks || []) as string[]) : []
    const thinkingInMessage = msgBlocks.filter((id) => entities[id]?.type === 'thinking')
    const allThinking = Object.values(entities).filter((b: any) => b.type === 'thinking')
    const streaming = Object.values(entities).filter((b: any) => b.status === 'streaming')
    return {
      latest,
      blockCount: msgBlocks.length,
      thinkingInMessage: thinkingInMessage.length,
      allThinking: allThinking.map((b: any) => ({ id: b.id, status: b.status, content: b.content ?? '' })),
      streamingCount: streaming.length,
      mainTexts: msgBlocks
        .filter((id) => entities[id]?.type === 'main_text')
        .map((id) => ({ id, status: entities[id]?.status, content: entities[id]?.content ?? '' }))
    }
  }, topicId)
}

test.describe('Empty Responses reasoning — no empty thinking block, no running timer', () => {
  test.setTimeout(120000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('summary-less reasoning start/end then answer completes with answer only', async ({ mainWindow }) => {
    const page = mainWindow
    const topicId = await getActiveTopicId(page)
    expect(topicId).not.toBe('')

    await test.step('switch mock provider to the Responses lane (type openai-response)', async () => {
      await page.evaluate(() => {
        const store = (window as any).store
        store.dispatch({ type: 'llm/updateProvider', payload: { id: 'mock-openai', type: 'openai-response' } })
      })
      await page.waitForFunction(
        () =>
          (window as any).store.getState().llm.providers.find((p: any) => p.id === 'mock-openai')?.type ===
          'openai-response',
        undefined,
        { timeout: 10000 }
      )
      const binding = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const provider = s.llm.providers.find((p: any) => p.id === 'mock-openai')
        return {
          providerType: provider?.type ?? null,
          apiHost: provider?.apiHost ?? null,
          defaultModel: s.llm.defaultModel ?? null
        }
      })
      expect(binding.providerType).toBe('openai-response')
      expect(binding.defaultModel?.id).toBe('mock-model')
      expect(binding.defaultModel?.provider).toBe('mock-openai')
    })

    const prevAssistantCount = await page.evaluate((tid: string) => {
      const s = (window as any).store.getState()
      const msgIds = s.messages.messageIdsByTopic[tid] || []
      let count = 0
      for (const id of msgIds) {
        if (s.messages.entities[id]?.role === 'assistant') count++
      }
      return count
    }, topicId)

    clearRequestLog()
    const before = getRequestSequence()

    await test.step('send empty-reasoning marker through the real UI', async () => {
      await uiSendMessage(page, EMPTY_REASONING_TEXT)
    })

    await test.step('mid-stream: thinking block never appears while the Responses stream is open', async () => {
      // Wait until the app actually issued the Responses request, so the
      // absence assertions below run against the live stream — not before it.
      await expect.poll(() => findResponsesRequestAfter(before) !== null, { timeout: 30000 }).toBe(true)
      // Controlled SSE delay between reasoning-done and the answer keeps the
      // stream open here: assert absence twice across the gap.
      const first = await snapshotThinkingState(page, topicId)
      expect(first.thinkingInMessage).toBe(0)
      expect(first.allThinking).toHaveLength(0)
      await expect(page.locator('.message-thought-container')).toHaveCount(0, { timeout: 10000 })
      await page.waitForTimeout(400)
      const second = await snapshotThinkingState(page, topicId)
      expect(second.thinkingInMessage).toBe(0)
      expect(second.allThinking).toHaveLength(0)
      await expect(page.locator('.message-thought-container')).toHaveCount(0, { timeout: 10000 })
      // Keep the raw request-log size for diagnostics without asserting on it.
      expect(getRequestLog().length).toBeGreaterThan(0)
    })

    await test.step('wait for the answer to fully complete (positive gate before absence asserts)', async () => {
      await waitForAssistantResponseComplete(page, topicId, prevAssistantCount)
      // Answer text must be rendered in the DOM — proves the stream was not swallowed.
      await expect(page.getByText(ANSWER_TAIL).first()).toBeVisible({ timeout: 15000 })
    })

    await test.step('product request went through POST /v1/responses, never chat/completions', async () => {
      const request = findResponsesRequestAfter(before)
      expect(request).not.toBeNull()
      expect(request!.method).toBe('POST')
      expect(request!.url).toBe('/v1/responses')
      expect(String(request!.parsed?.model ?? '')).toBe('mock-model')
      const chatRequests = findChatRequestsAfter(before)
      expect(chatRequests).toHaveLength(0)
    })

    await test.step('no thinking block for the new assistant message, no STREAMING left', async () => {
      const snapshot = await snapshotThinkingState(page, topicId)
      expect(snapshot.latest).toBeTruthy()
      expect(snapshot.blockCount).toBeGreaterThan(0)
      // The regression: pending-only reasoning must not materialize a thinking block.
      expect(snapshot.thinkingInMessage).toBe(0)
      expect(snapshot.allThinking).toHaveLength(0)
      // No stuck STREAMING anywhere — nothing left to tick.
      expect(snapshot.streamingCount).toBe(0)
      // The answer block itself completed with the expected tail.
      expect(snapshot.mainTexts.length).toBeGreaterThan(0)
      expect(snapshot.mainTexts.some((b) => b.status === 'success' && b.content.includes(ANSWER_TAIL))).toBe(true)
    })

    await test.step('no thinking shell in the DOM (no empty block, no timer)', async () => {
      await expect(page.locator('.message-thought-container')).toHaveCount(0, { timeout: 10000 })
    })

    await test.step('final state is stable — still no thinking shell or timer after settle (recheck)', async () => {
      await page.waitForTimeout(800)
      await expect(page.locator('.message-thought-container')).toHaveCount(0, { timeout: 10000 })
      const after = await page.evaluate(() => {
        const entities = (window as any).store.getState().messageBlocks.entities as Record<string, any>
        const thinking = Object.values(entities).filter((b: any) => b.type === 'thinking')
        const streaming = Object.values(entities).filter((b: any) => b.status === 'streaming')
        return { thinkingCount: thinking.length, streamingCount: streaming.length }
      })
      expect(after.thinkingCount).toBe(0)
      expect(after.streamingCount).toBe(0)
      // Recheck once more: nothing materializes late.
      await page.waitForTimeout(800)
      await expect(page.locator('.message-thought-container')).toHaveCount(0, { timeout: 10000 })
      const recheck = await page.evaluate(() => {
        const entities = (window as any).store.getState().messageBlocks.entities as Record<string, any>
        return Object.values(entities).filter((b: any) => b.type === 'thinking').length
      })
      expect(recheck).toBe(0)
    })
  })
})
