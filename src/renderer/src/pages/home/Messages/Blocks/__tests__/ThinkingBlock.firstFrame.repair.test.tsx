import type { ThinkingMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ThinkingBlock from '../ThinkingBlock'

const mockUseSettings = vi.fn()
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mockUseSettings()
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
  Collapse: ({ activeKey, items }: any) => (
    <div data-testid="collapse-container" data-active-key={activeKey}>
      {items.map((item: any) => (
        <div key={item.key}>
          <div>{item.label}</div>
          {activeKey === item.key && <div>{item.children}</div>}
        </div>
      ))}
    </div>
  ),
  Tooltip: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/components/ThinkingEffect', () => ({
  __esModule: true,
  default: ({ content, isThinking, thinkingTimeText }: any) => (
    <div data-testid="thinking-effect" data-is-thinking={String(isThinking)} data-content={content}>
      {thinkingTimeText}
    </div>
  )
}))
vi.mock('@renderer/pages/home/Markdown/Markdown', () => ({
  __esModule: true,
  default: ({ block }: any) => <div>Markdown:{block.content}</div>
}))
vi.mock('@ant-design/icons', () => ({
  CheckOutlined: () => <span>✓</span>
}))
vi.mock('lucide-react', () => ({
  Lightbulb: () => <span>💡</span>,
  ChevronRight: () => <svg />
}))
vi.mock('motion/react', () => ({
  motion: { div: (props: any) => <div {...props} /> }
}))
vi.mock('@renderer/utils/motionVariants', () => ({ lightbulbVariants: {} }))

const mk = (overrides: Partial<ThinkingMessageBlock> = {}): ThinkingMessageBlock => ({
  id: 'tb1',
  messageId: 'm1',
  type: MessageBlockType.THINKING,
  status: MessageBlockStatus.STREAMING,
  createdAt: new Date().toISOString(),
  content: '',
  thinking_millsec: 0,
  ...overrides
})

describe('ThinkingBlock first-frame/half-collapsed repair', () => {
  beforeEach(() => {
    mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: false })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders empty STREAMING shell (collapsed thinking shell appears as soon as THINKING_START)', () => {
    const { container } = render(<ThinkingBlock block={mk({ content: '', status: MessageBlockStatus.STREAMING })} />)
    expect(container.firstChild).not.toBeNull()
    // shell should contain ThinkingEffect even with empty content
    const effect = container.querySelector('[data-testid="thinking-effect"]')
    expect(effect).not.toBeNull()
    expect(effect?.getAttribute('data-is-thinking')).toBe('true')
  })

  it('continues hiding empty SUCCESS block', () => {
    const { container } = render(<ThinkingBlock block={mk({ content: '', status: MessageBlockStatus.SUCCESS })} />)
    expect(container.firstChild).toBeNull()
  })

  it('continues hiding empty non-streaming statuses (empty PAUSED hidden)', () => {
    const { container } = render(
      <ThinkingBlock block={mk({ content: '', status: MessageBlockStatus.PAUSED as any })} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders non-empty content normally', () => {
    const { container } = render(
      <ThinkingBlock block={mk({ content: 'hello', status: MessageBlockStatus.STREAMING })} />
    )
    expect(container.firstChild).not.toBeNull()
  })
})
