import type { ThinkingMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ThinkingBlock from '../ThinkingBlock'

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ fontSize: 14, thoughtAutoCollapse: false })
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, p?: any) => {
      if (k === 'chat.thinking') return `Thinking... ${p?.seconds}s`
      if (k === 'chat.deeply_thought') return `Thought for ${p?.seconds}s`
      return k
    }
  })
}))
vi.mock('antd', () => ({
  Collapse: ({ activeKey, onChange, items }: any) => (
    <div>
      {items.map((item: any) => (
        <div key={item.key}>
          <div onClick={() => onChange()}>{item.label}</div>
          {activeKey === item.key && <div>{item.children}</div>}
        </div>
      ))}
    </div>
  ),
  Tooltip: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/pages/home/Markdown/Markdown', () => ({
  __esModule: true,
  default: ({ block }: any) => <div>Markdown: {block.content}</div>
}))
vi.mock('@renderer/components/ThinkingEffect', () => ({
  __esModule: true,
  default: ({ thinkingTimeText }: any) => <div data-testid="thinking-time-text">{thinkingTimeText}</div>
}))

const mk = (overrides: Partial<ThinkingMessageBlock> = {}): ThinkingMessageBlock => ({
  id: 'tb1',
  messageId: 'm1',
  type: MessageBlockType.THINKING,
  status: MessageBlockStatus.STREAMING,
  createdAt: new Date().toISOString(),
  content: 'thinking content',
  thinking_millsec: 0,
  ...overrides
})

describe('ThinkingBlock timer lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('increments while STREAMING and stops after SUCCESS with fixed time', async () => {
    const { rerender } = render(
      <ThinkingBlock block={mk({ status: MessageBlockStatus.STREAMING, thinking_millsec: 0 })} />
    )
    const timeEl = screen.getByTestId('thinking-time-text')
    expect(timeEl.textContent).toContain('Thinking...')
    // advance enough to exceed 1s threshold (starts at 0, +100 per 100ms) inside act
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    const whileThinking = timeEl.textContent
    // should have increased from initial 0.1s to >=1.1s
    expect(whileThinking).not.toBe('Thinking... 0.1s')
    expect(whileThinking).toMatch(/1\.\d+s/)

    // switch to SUCCESS with concrete thinking_millsec
    await act(async () => {
      rerender(<ThinkingBlock block={mk({ status: MessageBlockStatus.SUCCESS, thinking_millsec: 3200 })} />)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('Thought for')
    expect(screen.getByTestId('thinking-time-text').textContent).toContain('3.2s')
    const afterSuccess = screen.getByTestId('thinking-time-text').textContent
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    // must stay same, not continue incrementing
    expect(screen.getByTestId('thinking-time-text').textContent).toBe(afterSuccess)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByTestId('thinking-time-text').textContent).toBe(afterSuccess)
  })
})
