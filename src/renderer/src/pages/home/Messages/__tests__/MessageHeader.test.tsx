import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

const mocks = vi.hoisted(() => ({
  avatar: 'https://avatar.example/1.png'
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model }: { model?: { id?: string; name?: string } }) => (
    <div data-testid="model-avatar" data-model-id={model?.id ?? ''} data-model-name={model?.name ?? ''} />
  )
}))

vi.mock('@renderer/components/Avatar/EmojiAvatar', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="emoji-avatar">{children}</div>
}))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/Popups/UserPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/hooks/useAvatar', () => ({
  default: () => mocks.avatar
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' })
}))

vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => ({ isMultiSelectMode: false, selectedMessageIds: [], handleSelectMessage: vi.fn() })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ userName: 'TestUser' }),
  useMessageStyle: () => ({ isBubbleStyle: false })
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getMessageModelId: (m: { model?: { id?: string }; modelId?: string }) => m?.model?.id ?? m?.modelId ?? ''
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelName: (model?: { name?: string; id?: string }) => model?.name ?? model?.id ?? ''
}))

vi.mock('@renderer/utils', () => ({
  firstLetter: (s: string) => s?.charAt(0) ?? '',
  isEmoji: () => false,
  removeLeadingEmoji: (s: string) => s
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'

import MessageHeader from '../MessageHeader'

const assistant = { id: 'a1', name: 'Jarvis' } as Assistant
const topic = { id: 't1' } as Topic

function makeMessage(role: Message['role'], overrides?: Partial<Message>): Message {
  return {
    id: 'm1',
    role,
    topicId: 't1',
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
    blocks: [],
    status: 'success',
    ...overrides
  } as unknown as Message
}

describe('MessageHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders ModelAvatar with model/provider when model present (assistant message)', () => {
    const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model, modelId: 'gpt-4o' } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const avatar = screen.getByTestId('model-avatar')
    expect(avatar).toBeInTheDocument()
    expect(avatar.getAttribute('data-model-id')).toBe('gpt-4o')
  })

  it('title includes serving id when trimmed id != trimmed name', () => {
    const model = { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    // find the UserName span with title containing id
    const titleEl = Array.from(document.querySelectorAll('[title]')).find((el) =>
      (el as HTMLElement).getAttribute('title')?.includes('gpt-4o-2024-08-06')
    ) as HTMLElement | null
    expect(titleEl).not.toBeNull()
    expect(titleEl?.getAttribute('title')).toBe('GPT-4o (gpt-4o-2024-08-06)')
  })

  it('does not duplicate id when trimmed id == trimmed name', () => {
    const model = { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find((el) =>
      (el as HTMLElement).getAttribute('title')?.includes('gpt-4o')
    ) as HTMLElement | null
    expect(titleEl).not.toBeNull()
    // should be just name without parentheses duplication
    expect(titleEl?.getAttribute('title')).toBe('gpt-4o')
    expect(titleEl?.getAttribute('title')).not.toContain('(gpt-4o) (gpt-4o)')
  })

  it('trims whitespace for comparison: " gpt-4o " vs "gpt-4o" does not show id', () => {
    const model = { id: '  gpt-4o  ', name: 'gpt-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el as HTMLElement).getAttribute('title') === 'gpt-4o'
    )
    expect(titleEl).not.toBeNull()
  })

  it('trims whitespace for comparison: different after trim shows id', () => {
    const model = { id: ' gpt-4o-1 ', name: ' GPT-4o ', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find((el) =>
      (el as HTMLElement).getAttribute('title')?.includes('gpt-4o-1')
    ) as HTMLElement | null
    expect(titleEl).not.toBeNull()
  })

  it('falls back to assistant Avatar when no model (assistant message, non-local)', () => {
    const message = makeMessage('assistant')
    render(<MessageHeader assistant={assistant} message={message} topic={topic} />)
    expect(screen.queryByTestId('model-avatar')).toBeNull()
    // should render an Avatar with initial J (assistant name first letter)
    expect(document.body.textContent).toContain('J')
  })

  it('case-sensitive: "GPT-4o" vs "gpt-4o" considered different and shows id', () => {
    const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el as HTMLElement).getAttribute('title') === 'GPT-4o (gpt-4o)'
    )
    expect(titleEl).not.toBeNull()
  })
})
