import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const onScrollToBottom = vi.fn()
  return { onScrollToBottom }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('lucide-react', () => ({
  ChevronDown: () => <span data-testid="bottom-icon" />
}))

import BackToBottomButton from '../BackToBottomButton'

const setScrollTop = (el: HTMLElement, value: number): void => {
  Object.defineProperty(el, 'scrollTop', { value, configurable: true })
}

/**
 * Stable-mount contract (keyboard-paging root fix): the button node is
 * ALWAYS mounted. First scroll away from the bottom must not insert a new
 * sibling of `#messages` (layout-tree rebuild aborts the in-flight native
 * paging). Hidden state is visual/interactive/assistive only — never DOM
 * absence, never `display:none`.
 */
const expectHidden = (button: HTMLElement): void => {
  expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(button.getAttribute('aria-hidden')).toBe('true')
  expect(button.tabIndex).toBe(-1)
}

const expectShown = (button: HTMLElement): void => {
  expect((button as HTMLButtonElement).disabled).toBe(false)
  expect(button.getAttribute('aria-hidden')).toBe('false')
  expect(button.tabIndex).toBe(0)
}

describe('BackToBottomButton genuine-bottom visibility + explicit callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('stays mounted but hidden at the genuine physical bottom (scrollTop ~= 0)', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    const button = screen.getByTestId('conversation-back-to-bottom')
    expectHidden(button)
  })

  it('stays hidden within the 1px subpixel tolerance but shows for the 50px vicinity', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 1)

    const ref = { current: container as unknown as HTMLElement | null }
    const { unmount } = render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    // 1px tolerance is still the genuine bottom — mounted but hidden.
    expectHidden(screen.getByTestId('conversation-back-to-bottom'))
    unmount()

    setScrollTop(container, -50)
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    fireEvent.scroll(container)
    // 50px away is only snapshot vicinity, never the physical bottom — visible.
    expectShown(screen.getByTestId('conversation-back-to-bottom'))
  })

  it('becomes visible when scrolled away and calls the canonical callback on click', async () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    const before = screen.getByTestId('conversation-back-to-bottom')
    expectHidden(before)

    setScrollTop(container, -240)
    fireEvent.scroll(container)
    const button = await screen.findByTestId('conversation-back-to-bottom')
    // Same DOM node across the hidden -> shown transition (no insert/remove).
    expect(button).toBe(before)
    expectShown(button)
    expect(button.getAttribute('aria-label')).toBe('chat.navigation.bottom')

    fireEvent.click(button)
    expect(mocks.onScrollToBottom).toHaveBeenCalledTimes(1)
  })

  it('hides again after returning to the genuine bottom on the same node', async () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, -240)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    const shown = await screen.findByTestId('conversation-back-to-bottom')
    expectShown(shown)

    setScrollTop(container, 0)
    fireEvent.scroll(container)
    await waitFor(() => {
      expectHidden(screen.getByTestId('conversation-back-to-bottom'))
    })
    // Same node across shown -> hidden (no unmount).
    expect(screen.getByTestId('conversation-back-to-bottom')).toBe(shown)
  })

  it('stays visible at the physical bottom when newer messages exist beyond the projection', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={true} />)
    // Historical window parked at scrollTop 0 with hasMoreNewer=true: the
    // physical bottom is the window lower edge, not the newest bottom.
    expectShown(screen.getByTestId('conversation-back-to-bottom'))
  })

  it('toggles hidden/shown on completeness transitions without remounting', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    const { rerender } = render(
      <BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={false} />
    )
    const node = screen.getByTestId('conversation-back-to-bottom')
    expectHidden(node)

    // Completeness transition false -> true reveals without any scroll.
    rerender(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={true} />)
    expect(screen.getByTestId('conversation-back-to-bottom')).toBe(node)
    expectShown(screen.getByTestId('conversation-back-to-bottom'))

    // Completeness transition true -> false hides again at the same scrollTop.
    rerender(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={false} />)
    expect(screen.getByTestId('conversation-back-to-bottom')).toBe(node)
    expectHidden(screen.getByTestId('conversation-back-to-bottom'))
  })

  it('stays visible while reading away regardless of newer completeness', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, -240)

    const ref = { current: container as unknown as HTMLElement | null }
    const { rerender } = render(
      <BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={false} />
    )
    expectShown(screen.getByTestId('conversation-back-to-bottom'))

    rerender(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={true} />)
    const button = screen.getByTestId('conversation-back-to-bottom')
    expectShown(button)
    fireEvent.click(button)
    expect(mocks.onScrollToBottom).toHaveBeenCalledTimes(1)
  })

  it('hidden button cannot activate or take tab focus', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    const button = screen.getByTestId('conversation-back-to-bottom') as HTMLButtonElement
    expectHidden(button)

    fireEvent.click(button)
    expect(mocks.onScrollToBottom).not.toHaveBeenCalled()

    // Tab order exclusion: disabled + tabIndex -1 removes the hidden node
    // from sequential keyboard focus (jsdom still allows programmatic
    // .focus() on disabled nodes, so tabbability — not activeElement — is
    // the meaningful contract here).
    expect(button.tabIndex).toBe(-1)
    expect(button.disabled).toBe(true)
  })
})
