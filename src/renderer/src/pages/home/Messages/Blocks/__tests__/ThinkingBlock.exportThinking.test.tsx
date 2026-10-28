import type { ThinkingMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExportThinkingExpansionProvider } from '../exportThinkingExpansion'
import ThinkingBlock from '../ThinkingBlock'

/**
 * Thinking-block expansion ownership.
 *
 * Live chat: the user's automatic-collapse setting plus the streaming state
 * decide, exactly as before. Image export: a frozen export-local option decides
 * and wins over both, so the exported image follows the export option instead of
 * whatever the chat toggle currently says — without the export ever writing the
 * live setting or the live chat inheriting the export choice.
 */

const mockUseSettings = vi.fn()

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mockUseSettings()
}))

vi.mock('@renderer/hooks/useTemporaryValue', () => ({
  useTemporaryValue: (initial: unknown) => [initial, vi.fn()]
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { seconds?: string }) => (params?.seconds ? `${key}:${params.seconds}` : key)
  })
}))

vi.mock('antd', () => ({
  Collapse: ({ activeKey, onChange, items, className, size }: any) => (
    <div data-testid="collapse-container" className={className} data-active-key={activeKey} data-size={size}>
      {items.map((item: any) => (
        <div key={item.key} data-testid={`collapse-item-${item.key}`}>
          <div data-testid={`collapse-header-${item.key}`} onClick={() => onChange()}>
            {item.label}
          </div>
          {activeKey === item.key && <div data-testid={`collapse-content-${item.key}`}>{item.children}</div>}
        </div>
      ))}
    </div>
  ),
  Tooltip: ({ children }: any) => <div data-testid="tooltip">{children}</div>
}))

vi.mock('@ant-design/icons', () => ({
  CheckOutlined: () => <span data-testid="check-icon" />
}))

vi.mock('lucide-react', () => ({
  Lightbulb: () => <span data-testid="lightbulb-icon" />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right-icon" {...props} />
}))

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: any) => <div data-testid="animate-presence">{children}</div>,
  motion: {
    div: (props: any) => <div {...props} />,
    span: ({ children, ...rest }: any) => <span {...rest}>{children}</span>
  }
}))

vi.mock('@renderer/utils/motionVariants', () => ({
  thinkingTextVariants: {}
}))

vi.mock('@renderer/pages/home/Markdown/Markdown', () => ({
  __esModule: true,
  default: ({ block }: any) => <div data-testid="mock-markdown">{block.content}</div>
}))

vi.mock('@renderer/components/ThinkingEffect', () => ({
  __esModule: true,
  default: ({ expanded, content }: any) => (
    <div data-testid="mock-thinking-effect" data-expanded={String(expanded)} data-content={content} />
  )
}))

const makeBlock = (status: MessageBlockStatus = MessageBlockStatus.SUCCESS): ThinkingMessageBlock =>
  ({
    id: 'block-thought',
    messageId: 'msg-1',
    type: MessageBlockType.THINKING,
    content: 'reasoning body',
    createdAt: '0',
    status
  }) as unknown as ThinkingMessageBlock

/** `''` = collapsed (header only), `'thought'` = expanded body. */
const activeKey = (): string | null | undefined =>
  screen.getByTestId('collapse-container').getAttribute('data-active-key')

const bodyRendered = (): boolean => screen.queryByTestId('collapse-content-thought') !== null

beforeEach(() => {
  mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: true })
})

afterEach(() => {
  mockUseSettings.mockReset()
})

describe('ThinkingBlock live chat behavior', () => {
  it('stays collapsed when the user auto-collapses thinking', () => {
    mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: true })

    render(<ThinkingBlock block={makeBlock()} />)

    expect(activeKey()).toBe('')
    expect(bodyRendered()).toBe(false)
  })

  it('stays expanded when the user keeps thinking expanded', () => {
    mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: false })

    render(<ThinkingBlock block={makeBlock()} />)

    expect(activeKey()).toBe('thought')
    expect(bodyRendered()).toBe(true)
  })
})

describe('ThinkingBlock export override', () => {
  it('forces expanded in an export tree even when the live setting auto-collapses', () => {
    mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: true })

    render(
      <ExportThinkingExpansionProvider value={true}>
        <ThinkingBlock block={makeBlock()} />
      </ExportThinkingExpansionProvider>
    )

    expect(activeKey()).toBe('thought')
    expect(bodyRendered()).toBe(true)
    // The override is presentation-only: the live setting is read, never rewritten.
    expect(mockUseSettings).toHaveBeenCalled()
  })

  it('forces collapsed in an export tree even when the live setting keeps thinking expanded', () => {
    mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: false })

    render(
      <ExportThinkingExpansionProvider value={false}>
        <ThinkingBlock block={makeBlock()} />
      </ExportThinkingExpansionProvider>
    )

    expect(activeKey()).toBe('')
    expect(bodyRendered()).toBe(false)
    // The collapsed block keeps its header instead of hiding the whole block.
    expect(screen.getByTestId('collapse-header-thought')).toBeTruthy()
  })

  it('wins over a streaming block in an export tree', () => {
    mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: false })

    render(
      <ExportThinkingExpansionProvider value={false}>
        <ThinkingBlock block={makeBlock(MessageBlockStatus.STREAMING)} />
      </ExportThinkingExpansionProvider>
    )

    expect(activeKey()).toBe('')
    expect(bodyRendered()).toBe(false)
  })

  it('does not leak the export choice into a live chat block', () => {
    mockUseSettings.mockReturnValue({ fontSize: 14, thoughtAutoCollapse: true })

    const exported = render(
      <ExportThinkingExpansionProvider value={true}>
        <ThinkingBlock block={makeBlock()} />
      </ExportThinkingExpansionProvider>
    )
    expect(activeKey()).toBe('thought')
    exported.unmount()

    render(<ThinkingBlock block={makeBlock()} />)

    // Live chat still follows the user setting, not the previous export.
    expect(activeKey()).toBe('')
    expect(bodyRendered()).toBe(false)
  })
})
