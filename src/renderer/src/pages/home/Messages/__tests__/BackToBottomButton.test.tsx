import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const onScrollToBottom = vi.fn()
  return { onScrollToBottom }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@ant-design/icons', () => ({
  VerticalAlignBottomOutlined: () => <span data-testid="bottom-icon" />
}))

import BackToBottomButton from '../BackToBottomButton'

const setScrollTop = (el: HTMLElement, value: number): void => {
  Object.defineProperty(el, 'scrollTop', { value, configurable: true })
}

describe('BackToBottomButton genuine-bottom visibility + explicit callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('stays hidden at the genuine physical bottom (scrollTop ~= 0)', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    expect(screen.queryByTestId('conversation-back-to-bottom')).toBeNull()
  })

  it('stays hidden within the 1px subpixel tolerance but shows for the 50px vicinity', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 1)

    const ref = { current: container as unknown as HTMLElement | null }
    const { unmount } = render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    // 1px tolerance is still the genuine bottom — no button.
    expect(screen.queryByTestId('conversation-back-to-bottom')).toBeNull()
    unmount()

    setScrollTop(container, -50)
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    fireEvent.scroll(container)
    // 50px away is only snapshot vicinity, never the physical bottom — visible.
    expect(screen.getByTestId('conversation-back-to-bottom')).toBeTruthy()
  })

  it('becomes visible when scrolled away and calls the canonical callback on click', async () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    expect(screen.queryByTestId('conversation-back-to-bottom')).toBeNull()

    setScrollTop(container, -240)
    fireEvent.scroll(container)
    const button = await screen.findByTestId('conversation-back-to-bottom')
    expect(button.getAttribute('aria-label')).toBe('chat.navigation.bottom')

    fireEvent.click(button)
    expect(mocks.onScrollToBottom).toHaveBeenCalledTimes(1)
  })

  it('hides again after returning to the genuine bottom', async () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, -240)

    const ref = { current: container as unknown as HTMLElement | null }
    render(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} />)
    expect(await screen.findByTestId('conversation-back-to-bottom')).toBeTruthy()

    setScrollTop(container, 0)
    fireEvent.scroll(container)
    await waitFor(() => {
      expect(screen.queryByTestId('conversation-back-to-bottom')).toBeNull()
    })
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
    expect(screen.getByTestId('conversation-back-to-bottom')).toBeTruthy()
  })

  it('hides at the physical bottom only when the projection is complete through newest', () => {
    const container = document.createElement('div')
    container.id = 'messages'
    document.body.appendChild(container)
    setScrollTop(container, 0)

    const ref = { current: container as unknown as HTMLElement | null }
    const { rerender } = render(
      <BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={false} />
    )
    expect(screen.queryByTestId('conversation-back-to-bottom')).toBeNull()

    // Completeness transition false -> true reveals without any scroll.
    rerender(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={true} />)
    expect(screen.getByTestId('conversation-back-to-bottom')).toBeTruthy()

    // Completeness transition true -> false hides again at the same scrollTop.
    rerender(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={false} />)
    expect(screen.queryByTestId('conversation-back-to-bottom')).toBeNull()
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
    expect(screen.getByTestId('conversation-back-to-bottom')).toBeTruthy()

    rerender(<BackToBottomButton onScrollToBottom={mocks.onScrollToBottom} containerRef={ref} hasMoreNewer={true} />)
    const button = screen.getByTestId('conversation-back-to-bottom')
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(mocks.onScrollToBottom).toHaveBeenCalledTimes(1)
  })
})
