/**
 * BRANCH-12 MessageGroupModelList permission gating.
 *
 * - `disabled` (non-owned/incomplete): selectors are inert
 *   (aria-disabled, clicks never reach selection) and Sortable is not
 *   rendered (no drag reorder through read-only ancestor references).
 * - enabled: selector clicks reach `setSelectedMessage`.
 */
import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { displayMode } = vi.hoisted(() => ({ displayMode: { value: 'compact' } }))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => <span data-testid="model-avatar" />
}))

vi.mock('@renderer/components/dnd', () => ({
  Sortable: ({
    items,
    renderItem,
    className,
    listStyle
  }: {
    items: { id: string }[]
    renderItem: (item: any) => React.ReactNode
    className?: string
    listStyle?: React.CSSProperties
  }) => (
    <div data-testid="sortable-mock" className={className} style={listStyle}>
      {items.map((item) => (
        <span key={item.id}>{renderItem(item)}</span>
      ))}
    </div>
  )
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ foldDisplayMode: displayMode.value })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/settings', () => ({
  setFoldDisplayMode: vi.fn((mode: string) => ({ type: 'setFoldDisplayMode', mode }))
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const { default: MessageGroupModelList, answerGroupStripLayout } = await import('../MessageGroupModelList')

const makeAssistant = (id: string, askId: string): Message =>
  ({ id, topicId: 'topic-1', role: 'assistant', assistantId: 'asst-1', askId, status: 'success' }) as unknown as Message

/**
 * Static layout-contract assertion (jsdom cannot compute geometry).
 *
 * The enabled Sortable list and the inert disabled list must share ONE
 * horizontal strip layout primitive: a non-owned group (reference prefix,
 * inherited branch/fold group) must present model tabs side by side exactly
 * like an owned group, never stacked full-width rows.
 */
function expectHorizontalStripLayout(el: HTMLElement | null): void {
  expect(el, 'answer strip container must exist').not.toBeNull()
  const style = (el as HTMLElement).style
  expect(style.display).toBe(answerGroupStripLayout.display)
  expect(style.flexDirection).toBe(answerGroupStripLayout.flexDirection)
  expect(style.alignItems).toBe(answerGroupStripLayout.alignItems)
  expect(style.flexWrap).toBe(answerGroupStripLayout.flexWrap)
  // Explicit contract (guards against a shared-constant regression).
  expect(style.display).toBe('flex')
  expect(style.flexDirection).toBe('row')
}

describe('MessageGroupModelList permission gating', () => {
  it('disabled groups render inert selectors and no Sortable', () => {
    const messages = [makeAssistant('a1', 'u1'), makeAssistant('a2', 'u1')]
    const setSelectedMessage = vi.fn()
    render(
      <MessageGroupModelList
        messages={messages}
        selectMessageId="a1"
        setSelectedMessage={setSelectedMessage}
        disabled
      />
    )
    expect(screen.queryByTestId('sortable-mock')).toBeNull()
    const selectors = screen.getAllByTestId('answer-group-selector')
    expect(selectors).toHaveLength(2)
    for (const el of selectors) {
      expect(el.getAttribute('aria-disabled')).toBe('true')
    }
    fireEvent.click(selectors[0])
    expect(setSelectedMessage).not.toHaveBeenCalled()
  })

  it('enabled groups select on click through Sortable', () => {
    const messages = [makeAssistant('a1', 'u1'), makeAssistant('a2', 'u1')]
    const setSelectedMessage = vi.fn()
    render(<MessageGroupModelList messages={messages} selectMessageId="a1" setSelectedMessage={setSelectedMessage} />)
    expect(screen.queryByTestId('sortable-mock')).not.toBeNull()
    const selectors = screen.getAllByTestId('answer-group-selector')
    expect(selectors).toHaveLength(2)
    fireEvent.click(selectors[1])
    expect(setSelectedMessage).toHaveBeenCalledExactlyOnceWith(messages[1])
  })

  it.each([
    { mode: 'compact', containerSelector: '.avatar-group.ant-avatar-group' },
    { mode: 'expanded', containerSelector: '.segmented-list' }
  ])(
    'disabled $mode keeps selectors as direct children of the layout container (no nested wrapper)',
    ({ mode, containerSelector }) => {
      displayMode.value = mode
      try {
        const messages = [makeAssistant('a1', 'u1'), makeAssistant('a2', 'u1')]
        const setSelectedMessage = vi.fn()
        const { container } = render(
          <MessageGroupModelList
            messages={messages}
            selectMessageId="a1"
            setSelectedMessage={setSelectedMessage}
            disabled
          />
        )
        // No drag reorder in read-only state.
        expect(screen.queryByTestId('sortable-mock')).toBeNull()
        const layout = container.querySelector(containerSelector)
        expect(layout).not.toBeNull()
        expect(layout?.getAttribute('aria-disabled')).toBe('true')
        const selectors = screen.getAllByTestId('answer-group-selector')
        expect(selectors).toHaveLength(2)
        for (const el of selectors) {
          // Fails on the old `div > span > selector` structure: the extra
          // span broke the avatar-group/segmented-list direct-child layout.
          expect(el.parentElement).toBe(layout)
          expect(el.getAttribute('aria-disabled')).toBe('true')
        }
        fireEvent.click(selectors[0])
        expect(setSelectedMessage).not.toHaveBeenCalled()
      } finally {
        displayMode.value = 'compact'
      }
    }
  )
})

/**
 * Layout regression: a read-only group must keep the SAME horizontal model-tab
 * strip as an owned group. Before the shared primitive, the inert expanded
 * list was a plain block div, so `.segmented-list` children stacked as
 * full-width thin rows (the reported Reference-clone regression).
 */
describe('MessageGroupModelList shared strip layout', () => {
  it.each([
    { mode: 'expanded', containerSelector: '.segmented-list' },
    { mode: 'compact', containerSelector: '.avatar-group.ant-avatar-group' }
  ])(
    'disabled $mode list applies the shared horizontal strip layout and exposes no mutation path',
    ({ mode, containerSelector }) => {
      displayMode.value = mode
      try {
        const messages = [makeAssistant('a1', 'u1'), makeAssistant('a2', 'u1')]
        const setSelectedMessage = vi.fn()
        const onReorderMessages = vi.fn()
        const { container } = render(
          <MessageGroupModelList
            messages={messages}
            selectMessageId="a1"
            setSelectedMessage={setSelectedMessage}
            onReorderMessages={onReorderMessages}
            disabled
          />
        )
        expectHorizontalStripLayout(container.querySelector(containerSelector) as HTMLElement | null)
        // Read-only contract preserved: no sortable surface, and neither the
        // selection nor the reorder path fires from the inert list.
        expect(screen.queryByTestId('sortable-mock')).toBeNull()
        fireEvent.click(screen.getAllByTestId('answer-group-selector')[0])
        expect(setSelectedMessage).not.toHaveBeenCalled()
        expect(onReorderMessages).not.toHaveBeenCalled()
      } finally {
        displayMode.value = 'compact'
      }
    }
  )

  it('enabled Sortable list receives the identical shared strip layout primitive', () => {
    displayMode.value = 'expanded'
    try {
      const messages = [makeAssistant('a1', 'u1'), makeAssistant('a2', 'u1')]
      const setSelectedMessage = vi.fn()
      render(<MessageGroupModelList messages={messages} selectMessageId="a1" setSelectedMessage={setSelectedMessage} />)
      const list = screen.getByTestId('sortable-mock')
      expectHorizontalStripLayout(list)
      // Same mode class as the disabled branch (the layout primitive is shared).
      expect(list.className).toContain('segmented-list')
    } finally {
      displayMode.value = 'compact'
    }
  })
})
