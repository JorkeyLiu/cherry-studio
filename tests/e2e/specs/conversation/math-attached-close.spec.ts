/**
 * Attached block-math close rendering contract.
 *
 * Regression coverage for the screenshot bug where a multiline `$$` block
 * formula whose closing `$$` is attached to the last formula line
 * (e.g. `\end{aligned}$$`) swallowed the closing delimiter and all following
 * prose into one unclosed math node, rendering the formula source plus the
 * trailing paragraph (including `**bold**`) as red `span.katex-error`.
 *
 * The renderer now normalizes an attached multiline close onto its own line
 * (presentation preprocessing only — stored/raw messages are untouched), so
 * the formula renders as bounded KaTeX and the following bold prose renders
 * as ordinary Markdown outside any `.katex-error`.
 *
 * Evidence classes:
 *   - UI interaction: real textarea fill + Enter key → production send path.
 *   - Product request: mock server log confirms the AI SDK HTTP request.
 *   - Rendered DOM: assistant `.markdown` shows `.katex` for the formula and
 *     a `strong` element outside `.katex-error` for the trailing prose.
 *
 * The mock echo replies `[Mock mock-model] You said: "<first 100 chars>"`,
 * so the synthetic probe is kept compact enough to survive the echo intact.
 * The probe starts with a newline before `$$` so the mock prefix stays on
 * the preceding line and the echoed assistant response still contains a
 * standalone `$$` display-block opener (prefixed `[Mock ...] "$$` would be
 * inline prose and must not be split by the presentation normalization).
 * No user content or data is used anywhere in this spec.
 */
import { expect, findProductRequestAfter, getRequestSequence, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

// Synthetic probe: valid single-row aligned block with the closing $$ attached
// to the last formula line, followed by ordinary prose with bold. The leading
// newline keeps the mock `You said: "` prefix off the `$$` opener line so the
// echoed assistant reply contains a standalone display-block opener (<100 chars).
const PROBE_USER_MESSAGE = '\n$$\n\\begin{aligned}\na&=1\n\\end{aligned}$$\n\nok **b7**'

async function getActiveTopicId(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s.assistants.assistants[0]
    return assistant?.topics?.[0]?.id || ''
  })
}

async function getAssistantCount(page: import('@playwright/test').Page, topicId: string): Promise<number> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    let count = 0
    for (const id of msgIds) {
      if (s.messages.entities[id]?.role === 'assistant') count++
    }
    return count
  }, topicId)
}

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
      let latestAssistantId: string | null = null
      for (let i = msgIds.length - 1; i >= 0; i--) {
        if (s.messages.entities?.[msgIds[i]]?.role === 'assistant') {
          latestAssistantId = msgIds[i]
          break
        }
      }
      if (!latestAssistantId) return false
      const assistantMsg = s.messages.entities[latestAssistantId]
      if (assistantMsg.status !== 'success' && assistantMsg.status !== 'error') return false
      const blocks = assistantMsg.blocks || []
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

async function getLastAssistantMessageId(page: import('@playwright/test').Page, topicId: string): Promise<string> {
  return page.evaluate((topicId: string) => {
    const s = (window as any).store.getState()
    const msgIds = s.messages.messageIdsByTopic[topicId] || []
    for (let i = msgIds.length - 1; i >= 0; i--) {
      if (s.messages.entities[msgIds[i]]?.role === 'assistant') return msgIds[i]
    }
    return ''
  }, topicId)
}

test.describe('Attached block-math close rendering contract', () => {
  test.setTimeout(120000)

  test('attached $$ close renders bounded formula with trailing bold outside katex-error', async ({ mainWindow }) => {
    const page = mainWindow
    await waitForAppReady(page)

    const topicId = await getActiveTopicId(page)
    expect(topicId).not.toBe('')
    const prevCount = await getAssistantCount(page, topicId)
    const preSequence = getRequestSequence()

    await uiSendMessage(page, PROBE_USER_MESSAGE)
    await waitForAssistantResponseComplete(page, topicId, prevCount)

    // Request-path evidence: the product request reached the mock endpoint.
    const productReq = findProductRequestAfter(preSequence)
    expect(productReq).not.toBeNull()

    // The probe was sent with a leading newline so the mock prefix stays off
    // the $$ opener line in the echoed assistant reply.
    const sentText = (() => {
      const parsed = (productReq as unknown as { parsed?: unknown }).parsed as
        | { messages?: Array<{ role?: string; content?: unknown }> }
        | null
        | undefined
      const messages = parsed?.messages ?? []
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const content = lastUser?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return (content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('\n')
      }
      return ''
    })()
    expect(sentText.startsWith('\n$$')).toBe(true)

    const assistantMsgId = await getLastAssistantMessageId(page, topicId)
    expect(assistantMsgId).not.toBe('')
    const assistantContainer = page.locator(`[data-message-id="${assistantMsgId}"]`)
    await assistantContainer.scrollIntoViewIfNeeded()

    // Raw generated response is intact (presentation-only normalization).
    const rawAssistant = await page.evaluate((msgId: string) => {
      const s = (window as any).store.getState()
      const msg = s.messages.entities[msgId]
      const blockId = msg?.blocks?.[0]
      return (s.messageBlocks.entities[blockId]?.content ?? '') as string
    }, assistantMsgId)
    expect(rawAssistant).toContain('$$')
    expect(rawAssistant).toContain('a&=1')
    expect(rawAssistant).toContain('ok **b7**')

    // The formula renders as real KaTeX output for the actual formula content.
    const markdown = assistantContainer.locator('.markdown')
    await expect(markdown.locator('.katex').first()).toBeVisible({ timeout: 15000 })
    const katexTexts = await markdown.locator('.katex').allTextContents()
    expect(katexTexts.some((text) => text.includes('a') && text.includes('1'))).toBe(true)

    // The trailing prose renders as ordinary Markdown: a real <strong> element.
    const bold = markdown.locator('strong', { hasText: 'b7' })
    await expect(bold).toBeVisible({ timeout: 10000 })
    await expect(bold).toHaveText('b7')

    // The bold prose must not be swallowed into any math/error container.
    const swallowed = await bold.evaluate((el) => el.closest('.katex-error, .katex, .katex-display, .math') !== null)
    expect(swallowed).toBe(false)
    const errorTexts = await markdown.locator('.katex-error').allTextContents()
    expect(errorTexts.every((text) => !text.includes('b7'))).toBe(true)
    await expect(markdown.locator('.katex-error', { hasText: 'b7' })).toHaveCount(0)
  })
})
