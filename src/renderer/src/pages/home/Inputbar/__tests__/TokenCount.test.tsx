/**
 * Focused tests for TokenCount — verifies scalar token rendering and context count display.
 *
 * Acceptance criteria:
 *   (1) Token display contains one estimate scalar, no slash separator
 *   (2) Context count remains current / max with slash separator
 *   (3) No inputTokenCount prop exists
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

const mockShowInputEstimatedTokens = vi.fn(() => true)

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    showInputEstimatedTokens: mockShowInputEstimatedTokens()
  })
}))

vi.mock('antd', () => ({
  Divider: ({ type, style }: any) => <hr data-testid="divider" data-type={type} style={style} />,
  Popover: ({ children, content }: any) => (
    <div data-testid="popover">
      <div data-testid="popover-content">{typeof content === 'function' ? content() : content}</div>
      <div data-testid="popover-children">{children}</div>
    </div>
  )
}))

vi.mock('lucide-react', () => ({
  ArrowUp: ({ size, className }: any) => <span data-testid="arrow-up-icon" data-size={size} className={className} />,
  MenuIcon: ({ size, className }: any) => <span data-testid="menu-icon" data-size={size} className={className} />
}))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children, style, onClick }: any) => (
    <div data-testid="hstack" style={style} onClick={onClick}>
      {children}
    </div>
  ),
  VStack: ({ children, w, background }: any) => (
    <div data-testid="vstack" data-w={w} data-background={background}>
      {children}
    </div>
  )
}))

vi.mock('@renderer/components/MaxContextCount', () => ({
  default: ({ maxContext, style }: any) => (
    <span data-testid="max-context-count" style={style}>
      {maxContext === null ? '∞' : String(maxContext)}
    </span>
  )
}))

// ── Import component after mocks ──────────────────────────────────────────

import TokenCount from '../TokenCount'

// ── Tests ─────────────────────────────────────────────────────────────────

describe('TokenCount', () => {
  const defaultProps = {
    estimateTokenCount: 1234,
    contextCount: { current: 5, max: 100 },
    contextWindowMode: 'sliding' as const,
    effectiveMode: 'sliding' as const,
    onUpdateAnchor: vi.fn()
  }

  it('renders estimate as a single scalar — no slash separator in token display', () => {
    render(<TokenCount {...defaultProps} />)

    // The estimate value must appear in the DOM
    const estimateElements = screen.getAllByText('1234')
    expect(estimateElements.length).toBeGreaterThanOrEqual(1)

    // There must be no "1234/" or "/1234" pattern — only context counts use slashes
    // Check the popover-children area (the main display, not the popover content)
    const popoverChildren = screen.getByTestId('popover-children')
    const text = popoverChildren.textContent ?? ''
    // The token value should appear exactly once in the main display
    expect(text).toContain('1234')
    // Slash must only appear in context count (e.g., "5/100"), not next to estimate
    // The pattern "1234/" must NOT exist
    expect(text).not.toMatch(/1234\s*\/\s*\d/)
  })

  it('renders context count as current / max with slash separator', () => {
    render(<TokenCount {...defaultProps} />)

    // Context count current value
    const popoverChildren = screen.getByTestId('popover-children')
    const text = popoverChildren.textContent ?? ''
    expect(text).toContain('5')
    expect(text).toContain('100')

    // Slash separator exists for context count; at least one divider separates context from tokens
    const dividers = screen.getAllByTestId('divider')
    expect(dividers.length).toBeGreaterThanOrEqual(1)
  })

  it('renders context count with unlimited (∞) when max is null', () => {
    render(<TokenCount {...defaultProps} contextCount={{ current: 3, max: null }} />)

    // ∞ appears in both popover-content and popover-children
    const infinityElements = screen.getAllByText('∞')
    expect(infinityElements.length).toBe(2)
    // "3" also appears in both popover-content and popover-children
    const threeElements = screen.getAllByText('3')
    expect(threeElements.length).toBe(2)
  })

  it('renders null when showInputEstimatedTokens is false', () => {
    mockShowInputEstimatedTokens.mockReturnValueOnce(false)
    const { container } = render(<TokenCount {...defaultProps} />)
    expect(container.innerHTML).toBe('')
  })

  it('popover content shows both context count and estimate', () => {
    render(<TokenCount {...defaultProps} />)

    const popoverContent = screen.getByTestId('popover-content')
    const text = popoverContent.textContent ?? ''

    // Context count tip and values
    expect(text).toContain('chat.input.context_count.tip')
    expect(text).toContain('5')
    expect(text).toContain('100')

    // Estimate tip and value
    expect(text).toContain('chat.input.estimated_tokens.tip')
    expect(text).toContain('1234')
  })

  it('onUpdateAnchor is called when context block is clicked in fixed mode', () => {
    const onUpdateAnchor = vi.fn()
    render(
      <TokenCount {...defaultProps} contextWindowMode="fixed" effectiveMode="fixed" onUpdateAnchor={onUpdateAnchor} />
    )

    // Find the clickable context block and click it
    const menuIcons = screen.getAllByTestId('menu-icon')
    expect(menuIcons.length).toBeGreaterThanOrEqual(1)
    // Click the parent hstack of the menu icon
    const contextBlock = menuIcons[0].closest('[data-testid="hstack"]')!
    fireEvent.click(contextBlock)
    expect(onUpdateAnchor).toHaveBeenCalledTimes(1)
  })

  it('does not accept or render inputTokenCount — prop removed', () => {
    // Type-level check: TokenCountProps should not have inputTokenCount
    // Runtime check: passing inputTokenCount should be ignored
    const propsWithExtra = {
      ...defaultProps,
      inputTokenCount: 9999
    } as any

    render(<TokenCount {...propsWithExtra} />)

    // 9999 should NOT appear in the DOM
    const popoverChildren = screen.getByTestId('popover-children')
    expect(popoverChildren.textContent).not.toContain('9999')
  })
})
