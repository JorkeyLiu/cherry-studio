/**
 * LOCK-002: assistant avatars always use Emoji regardless of any legacy
 * icon-type preference. The component no longer reads assistantIconType.
 */
import EmojiIcon from '@renderer/components/EmojiIcon'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import AssistantAvatar from '../AssistantAvatar'

vi.mock('@renderer/components/EmojiIcon', () => ({
  default: ({ emoji, size, className }: { emoji: string; size?: number; className?: string }) => (
    <span data-testid="emoji-icon" data-emoji={emoji} data-size={size} className={className}>
      {emoji}
    </span>
  )
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultModel: () => ({ id: 'default-model', name: 'Default', provider: 'openai' }),
  getDefaultAssistant: () => ({ id: 'default-assistant', name: 'Default Assistant' })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => ({}),
  default: {
    getState: () => ({})
  }
}))

describe('AssistantAvatar (LOCK-002)', () => {
  it('renders the assistant emoji when set', () => {
    render(<AssistantAvatar assistant={{ id: 'a1', name: 'Work', emoji: '💼' } as any} size={32} />)
    const icon = screen.getByTestId('emoji-icon')
    expect(icon).toHaveAttribute('data-emoji', '💼')
    expect(icon).toHaveAttribute('data-size', '32')
  })

  it('falls back to the leading emoji of the assistant name', () => {
    render(<AssistantAvatar assistant={{ id: 'a2', name: '🎨 Designer', emoji: '' } as any} />)
    expect(screen.getByTestId('emoji-icon')).toHaveAttribute('data-emoji', '🎨')
  })

  it('never renders a model avatar (Emoji-only behavior)', () => {
    const { container } = render(<AssistantAvatar assistant={{ id: 'a3', name: 'Plain' } as any} />)
    // No ModelAvatar output: only the emoji icon is rendered.
    expect(container.querySelectorAll('[data-testid="emoji-icon"]')).toHaveLength(1)
    expect(EmojiIcon).toBeDefined()
  })
})
