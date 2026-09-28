/**
 * PROJ-13 MessageGroupModelList permission gating.
 *
 * - `disabled` (group-immutable/incomplete): selectors are inert
 *   (aria-disabled, clicks never reach selection) and Sortable is not
 *   rendered (no drag reorder through shared prefixes).
 * - enabled: selector clicks reach `setSelectedMessage`.
 */
import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => <span data-testid="model-avatar" />
}))

vi.mock('@renderer/components/dnd', () => ({
  Sortable: ({ items, renderItem }: { items: { id: string }[]; renderItem: (item: any) => React.ReactNode }) => (
    <div data-testid="sortable-mock">
      {items.map((item) => (
        <span key={item.id}>{renderItem(item)}</span>
      ))}
    </div>
  )
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ foldDisplayMode: 'compact' })
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

const { default: MessageGroupModelList } = await import('../MessageGroupModelList')

const makeAssistant = (id: string, askId: string): Message =>
  ({ id, topicId: 'topic-1', role: 'assistant', assistantId: 'asst-1', askId, status: 'success' }) as unknown as Message

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
})
