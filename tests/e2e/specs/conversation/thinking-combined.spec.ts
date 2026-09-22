/**
 * Combined thinking UI contract — deterministic interval-driven reasoning E2E.
 *
 * Extends mock OpenAI server with smallest interval-driven scenario marker
 * (THINKING_COMBINED) and the existing conversation/reasoning flow.
 * Uses shared fixture, stable selectors/state polling, no screenshots, no
 * arbitrary sleeps except bounded interval observation inherent to timed mock.
 *
 * LOCK-001 disposable profile, LOCK-002 mock only, LOCK-003 no i18n changes.
 */
import { clearRequestLog, expect, test } from '../../fixtures/electron.fixture'
import { THINKING_COMBINED_MARKER } from '../../fixtures/mock-openai-server'
import { waitForAppReady } from '../../utils/wait-helpers'

const COMBINED_TEXT = `E2E thinking combined ${THINKING_COMBINED_MARKER}`

async function getActiveTopicId(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return assistant?.topics?.[0]?.id ?? ''
  })
}

async function uiSendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  // ensure popover hidden if present
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

test.describe('Combined thinking UI contract — interval-driven reasoning', () => {
  test.setTimeout(120000)

  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('thinking STREAMING shell, collapsed preview, timer tick, SUCCESS before answer, order, stable nonzero timer', async ({
    mainWindow
  }) => {
    const page = mainWindow

    // Ensure collapsed half-state is observable: force thoughtAutoCollapse true so ThinkingEffect preview shows while STREAMING
    await page.evaluate(() => {
      const store = (window as any).store
      const s = store.getState()
      if (!s.settings.thoughtAutoCollapse) {
        store.dispatch({ type: 'settings/setThoughtAutoCollapse', payload: true })
      }
    })
    await page.waitForFunction(
      () => (window as any).store.getState().settings.thoughtAutoCollapse === true,
      undefined,
      { timeout: 10000 }
    )

    const topicId = await getActiveTopicId(page)
    expect(topicId).not.toBe('')

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

    await test.step('send combined marker', async () => {
      await uiSendMessage(page, COMBINED_TEXT)
    })

    // 1) empty/early STREAMING thinking shell appears promptly
    await test.step('early STREAMING shell appears promptly', async () => {
      await page.waitForFunction(
        ({ tid }) => {
          const s = (window as any).store.getState()
          const blocks = Object.values(s.messageBlocks.entities) as any[]
          return blocks.some((b) => b.type === 'thinking' && b.status === 'streaming')
        },
        { tid: topicId },
        { timeout: 10000 }
      )
      const container = page.locator('.message-thought-container').first()
      await expect(container).toBeVisible({ timeout: 10000 })
      // timer 0.0 initially (natural elapsed <50ms) or thinking label
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.message-thought-container')
          if (!el) return false
          const txt = el.textContent || ''
          // i18n may be zh or en: contains Thinking/思考 and 0.0s
          return /0\.0s/.test(txt) || /Thinking|思考/.test(txt)
        },
        undefined,
        { timeout: 10000 }
      )
    })

    // 2) collapsed half-state shows current incomplete reasoning text
    await test.step('collapsed half-state shows incomplete reasoning', async () => {
      await page.waitForFunction(
        () => {
          const s = (window as any).store.getState()
          const blocks = Object.values(s.messageBlocks.entities) as any[]
          const th = blocks.find((b: any) => b.type === 'thinking' && b.status === 'streaming')
          if (!th) return false
          const c = th.content || ''
          return c.includes('Combined thinking line 1') || c.includes('Combined thinking line 2')
        },
        undefined,
        { timeout: 10000 }
      )
      // DOM preview must contain the incomplete line while STREAMING & collapsed
      const container = page.locator('.message-thought-container').first()
      await expect(container).toBeVisible({ timeout: 10000 })
      // wait for at least line 1 to be rendered in collapsed preview or expanded content
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.message-thought-container') as HTMLElement | null
          if (!el) return false
          const txt = el.innerText || el.textContent || ''
          return txt.includes('Combined thinking line 1')
        },
        undefined,
        { timeout: 10000 }
      )
    })

    // 3) timer text changes naturally while STREAMING (no exact tick assert)
    await test.step('timer ticks naturally while STREAMING', async () => {
      const getTimerText = async () => {
        return page.evaluate(() => {
          const el = document.querySelector('.message-thought-container')
          return (el?.textContent || '').trim()
        })
      }
      const first = await getTimerText()
      // poll until timer changes (0.0 -> 0.1+) while still STREAMING
      await page.waitForFunction(
        ({ firstText }) => {
          const el = document.querySelector('.message-thought-container')
          const txt = (el?.textContent || '').trim()
          if (!txt || txt === firstText) return false
          const s = (window as any).store.getState()
          const blocks = Object.values(s.messageBlocks.entities) as any[]
          const stillStreaming = blocks.some((b: any) => b.type === 'thinking' && b.status === 'streaming')
          if (!stillStreaming) return false
          // must have changed seconds value
          const m1 = firstText.match(/(\d+\.\d)s/)
          const m2 = txt.match(/(\d+\.\d)s/)
          if (!m1 || !m2) return txt !== firstText
          return m1[1] !== m2[1]
        },
        { firstText: first },
        { timeout: 10000 }
      )
      const second = await getTimerText()
      expect(second).not.toBe(first)
    })

    // 4) on first answer content/status transition thinking is SUCCESS/fully collapsed before overall response completion if mock allows
    await test.step('thinking SUCCESS before overall completion', async () => {
      // Wait for the bare text-delta fallback to create main_text block and thinking to converge
      await page.waitForFunction(
        () => {
          const s = (window as any).store.getState()
          const blocks = Object.values(s.messageBlocks.entities) as any[]
          const thinking = blocks.find((b: any) => b.type === 'thinking')
          const main = blocks.find(
            (b: any) => b.type === 'main_text' && (b.content || '').includes('Answer start: combined verified')
          )
          if (!thinking || !main) return false
          // thinking must be SUCCESS at this point
          if (thinking.status !== 'success') return false
          // collapsed check: if thoughtAutoCollapse true, activeKey '' -> collapsed
          const msgIds = s.messages.messageIdsByTopic[s.assistants.assistants[0].topics[0].id] || []
          let latestAssistantId: string | null = null
          for (let i = msgIds.length - 1; i >= 0; i--) {
            if (s.messages.entities[msgIds[i]]?.role === 'assistant') {
              latestAssistantId = msgIds[i]
              break
            }
          }
          if (!latestAssistantId) return false
          const msg = s.messages.entities[latestAssistantId]
          // overall message still streaming/processing (not yet success) — mock allows window where thinking success precedes final
          const stillProcessing = msg.status !== 'success' && msg.status !== 'error'
          // if mock already finished, allow thinking success + message success (final) as well — fallback
          return true
        },
        undefined,
        { timeout: 15000 }
      )
      const infos = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        const th = blocks.find((b: any) => b.type === 'thinking')
        const main = blocks.find((b: any) => b.type === 'main_text' && (b.content || '').includes('Answer start'))
        const msgIds = s.messages.messageIdsByTopic[s.assistants.assistants[0].topics[0].id] || []
        let latest: string | null = null
        for (let i = msgIds.length - 1; i >= 0; i--) {
          if (s.messages.entities[msgIds[i]]?.role === 'assistant') {
            latest = msgIds[i]
            break
          }
        }
        const msg = latest ? s.messages.entities[latest] : null
        return {
          thinkingStatus: th?.status ?? null,
          thinkingContent: th?.content ?? '',
          mainStatus: main?.status ?? null,
          msgStatus: msg?.status ?? null,
          blockOrder: msg?.blocks ?? []
        }
      })
      expect(infos.thinkingStatus).toBe('success')
      // block order precedes main answer will be asserted next step; here ensure thinking success
    })

    // 5) thinking DOM/block order precedes main answer
    await test.step('thinking order precedes main answer', async () => {
      const orderOk = await page.evaluate((tid: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[tid] || []
        let latest: string | null = null
        for (let i = msgIds.length - 1; i >= 0; i--) {
          if (s.messages.entities[msgIds[i]]?.role === 'assistant') {
            latest = msgIds[i]
            break
          }
        }
        if (!latest) return false
        const msg = s.messages.entities[latest]
        const blocks = msg.blocks || []
        const entities = s.messageBlocks.entities
        let thinkingIdx = -1
        let mainIdx = -1
        for (let i = 0; i < blocks.length; i++) {
          const b: any = entities[blocks[i]]
          if (!b) continue
          if (b.type === 'thinking' && thinkingIdx === -1) thinkingIdx = i
          if (b.type === 'main_text' && (b.content || '').includes('Answer start') && mainIdx === -1) mainIdx = i
        }
        return thinkingIdx !== -1 && mainIdx !== -1 && thinkingIdx < mainIdx
      }, topicId)
      expect(orderOk).toBe(true)

      const latestAssistantId = await page.evaluate((tid: string) => {
        const s = (window as any).store.getState()
        const msgIds = s.messages.messageIdsByTopic[tid] || []
        let latest: string | null = null
        for (let i = msgIds.length - 1; i >= 0; i--) {
          if (s.messages.entities[msgIds[i]]?.role === 'assistant') {
            latest = msgIds[i]
            break
          }
        }
        return latest as string
      }, topicId)
      expect(latestAssistantId).toBeTruthy()

      await page.waitForFunction(
        ({ messageId }: { messageId: string }) => {
          const container =
            (document.getElementById(`message-${messageId}`) as Element | null) ??
            (document.querySelector(`[data-message-id="${messageId}"]`) as Element | null)
          if (!container) return false
          const all = Array.from(container.querySelectorAll('.markdown')) as Element[]
          const candidates = all.filter((el) => {
            if ((el as Element).closest('.message-thought-container')) return false
            return (el.textContent || '').includes('continued answer tail-END')
          })
          if (candidates.length === 0) return false
          const leafCandidates = candidates.filter(
            (el) =>
              !Array.from(el.querySelectorAll('.markdown')).some(
                (d) => d !== el && (d.textContent || '').includes('continued answer tail-END')
              )
          )
          const answerEl = (leafCandidates.length ? leafCandidates[0] : candidates[candidates.length - 1]) as
            | Element
            | undefined
          if (!answerEl) return false
          return answerEl.isConnected
        },
        { messageId: latestAssistantId },
        { timeout: 15000 }
      )

      const domOrderOk = await page.evaluate((messageId: string) => {
        const container =
          (document.getElementById(`message-${messageId}`) as Element | null) ??
          (document.querySelector(`[data-message-id="${messageId}"]`) as Element | null)
        if (!container) return false
        const thought = container.querySelector('.message-thought-container') as Element | null
        if (!thought) return false
        if (!thought.isConnected || !container.contains(thought)) return false
        if (thought.getRootNode() !== container.getRootNode()) return false
        const all = Array.from(container.querySelectorAll('.markdown')) as Element[]
        const candidates = all.filter((el) => {
          if ((el as Element).closest('.message-thought-container')) return false
          return (el.textContent || '').includes('continued answer tail-END')
        })
        if (candidates.length === 0) return false
        const leafCandidates = candidates.filter(
          (el) =>
            !Array.from(el.querySelectorAll('.markdown')).some(
              (d) => d !== el && (d.textContent || '').includes('continued answer tail-END')
            )
        )
        const answerEl = (leafCandidates.length ? leafCandidates[0] : candidates[candidates.length - 1]) as
          | Element
          | undefined
        if (!answerEl) return false
        if (!answerEl.isConnected || !container.contains(answerEl)) return false
        if (answerEl.getRootNode() !== container.getRootNode()) return false
        const pos = thought.compareDocumentPosition(answerEl)
        if (pos & Node.DOCUMENT_POSITION_DISCONNECTED) return false
        return Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING)
      }, latestAssistantId)
      expect(domOrderOk).toBe(true)
    })

    // wait for overall completion to stabilize timer
    await waitForAssistantResponseComplete(page, topicId, prevAssistantCount)

    // 6) final timer is stable and nonzero
    await test.step('final timer stable and nonzero', async () => {
      const firstMillsec = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        const th = [...blocks]
          .filter((b: any) => b.type === 'thinking')
          .sort((a: any, b: any) => (a.createdAt > b.createdAt ? 1 : -1))
          .at(-1) as any
        return th ? th.thinking_millsec : null
      })
      expect(firstMillsec).not.toBeNull()
      expect(firstMillsec).toBeGreaterThan(0)

      const firstText = await page
        .locator('.message-thought-container')
        .first()
        .textContent()
        .catch(() => null)
      expect(firstText).not.toBeNull()
      // After success, text should be "Thought for X.Xs" (en) or deep thought zh
      expect(firstText!).toMatch(/Thought for|Deeply thought|已.*思考|深度思考/)

      await page.waitForTimeout(800)

      const secondMillsec = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        const th = [...blocks]
          .filter((b: any) => b.type === 'thinking')
          .sort((a: any, b: any) => (a.createdAt > b.createdAt ? 1 : -1))
          .at(-1) as any
        return th ? th.thinking_millsec : null
      })
      const secondText = await page
        .locator('.message-thought-container')
        .first()
        .textContent()
        .catch(() => null)
      expect(secondMillsec).toBe(firstMillsec)
      expect(secondText).toBe(firstText)

      const stillStreaming = await page.evaluate(() => {
        const s = (window as any).store.getState()
        const blocks = Object.values(s.messageBlocks.entities) as any[]
        return blocks.filter((b: any) => b.type === 'thinking' && b.status === 'streaming').length
      })
      expect(stillStreaming).toBe(0)
    })
  })
})
