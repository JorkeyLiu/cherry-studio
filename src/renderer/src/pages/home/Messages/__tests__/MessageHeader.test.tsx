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

const bubbleStyleState = vi.hoisted(() => ({ isBubbleStyle: false }))
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ userName: 'TestUser' }),
  useMessageStyle: () => ({ isBubbleStyle: bubbleStyleState.isBubbleStyle })
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

vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k })
  }
})

const { isMessageInSegmentMock } = vi.hoisted(() => ({
  isMessageInSegmentMock: vi.fn()
}))

// The hook's store chain (redux + catalog convergence) is not this
// component's contract: the header only reads group membership for the
// indent, so tests drive that one function directly.
vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({ isMessageInSegment: isMessageInSegmentMock })
}))

import { UserAvatar } from '@renderer/config/env'
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { useLayoutEffect, useRef } from 'react'

import MessageHeader from '../MessageHeader'
import { SegmentGroupPresentationProvider, useSegmentGroupLayoutManager } from '../SegmentGroupPresentation'

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
    isMessageInSegmentMock.mockReset().mockReturnValue(null)
    bubbleStyleState.isBubbleStyle = false
  })

  /**
   * Rules the component CSS declares for a given element's own classes: the
   * indent is a generated-class rule (a CSS-variable margin), so the assertion
   * reads the stylesheet exactly like the group-boundary tests do.
   */
  function ownRules(element: HTMLElement): string[] {
    const css = Array.from(document.querySelectorAll('style'))
      .map((node) => node.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')
    return (css.match(/[^{}]+\{[^}]*\}/g) ?? []).filter((rule) =>
      Array.from(element.classList).some((name) => rule.includes(`.${name}`))
    )
  }

  /**
   * A mounted slot run for the group: the header-registered host whose first
   * rendered message the pill shares its band with. Registration happens in a
   * child layout effect, so the provider's own commit-time pass measures it
   * before paint — the same ordering as production.
   */
  function SlotRegistrar({ groupId, messageId }: { groupId: string; messageId: string | null }) {
    const manager = useSegmentGroupLayoutManager()
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      if (!manager || !ref.current) return
      return manager.registerRun(groupId, ref.current, { runId: 'run-header', isHeader: true, endsGroup: true })
    }, [manager, groupId])
    return <div ref={ref}>{messageId ? <div data-message-id={messageId} /> : null}</div>
  }

  it('renders ModelAvatar with model/provider when model present (assistant message)', () => {
    const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model, modelId: 'gpt-4o' } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const avatar = screen.getByTestId('model-avatar')
    expect(avatar).toBeInTheDocument()
    expect(avatar.getAttribute('data-model-id')).toBe('gpt-4o')
  })

  it('title is name-only when trimmed id != trimmed name (no ID in tooltip)', () => {
    const model = { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el as HTMLElement).getAttribute('title') === 'GPT-4o'
    ) as HTMLElement | null
    expect(titleEl).not.toBeNull()
    expect(titleEl?.getAttribute('title')).toBe('GPT-4o')
    expect(titleEl?.getAttribute('title')).not.toContain('gpt-4o-2024-08-06')
  })

  it('does not duplicate id when trimmed id == trimmed name (name-only)', () => {
    const model = { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find((el) =>
      (el as HTMLElement).getAttribute('title')?.includes('gpt-4o')
    ) as HTMLElement | null
    expect(titleEl).not.toBeNull()
    expect(titleEl?.getAttribute('title')).toBe('gpt-4o')
    expect(titleEl?.getAttribute('title')).not.toContain('(')
  })

  it('trims whitespace for comparison: name-only still trims', () => {
    const model = { id: '  gpt-4o  ', name: 'gpt-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el as HTMLElement).getAttribute('title') === 'gpt-4o'
    )
    expect(titleEl).not.toBeNull()
  })

  it('different after trim still name-only (no ID)', () => {
    const model = { id: ' gpt-4o-1 ', name: ' GPT-4o ', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el as HTMLElement).getAttribute('title') === 'GPT-4o'
    ) as HTMLElement | null
    expect(titleEl).not.toBeNull()
    expect(titleEl?.getAttribute('title')).not.toContain('gpt-4o-1')
  })

  it('falls back to assistant Avatar when no model (assistant message, non-local)', () => {
    const message = makeMessage('assistant')
    render(<MessageHeader assistant={assistant} message={message} topic={topic} />)
    expect(screen.queryByTestId('model-avatar')).toBeNull()
    // should render an Avatar with initial J (assistant name first letter)
    expect(document.body.textContent).toContain('J')
  })

  it('missing assistant falls back to message model id initial instead of throwing', () => {
    const message = makeMessage('assistant', { modelId: 'gpt-4o' } as any)
    render(<MessageHeader assistant={undefined} message={message} topic={topic} />)
    expect(screen.queryByTestId('model-avatar')).toBeNull()
    expect(document.body.textContent).toContain('g')
  })

  it('indents the headed-first message by the pill width with an ellipsis name (the group shares its band)', () => {
    isMessageInSegmentMock.mockReturnValue({ id: 'seg-1' })
    const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    const { container } = render(
      <SegmentGroupPresentationProvider>
        <SlotRegistrar groupId="seg-1" messageId="m1" />
        <MessageHeader assistant={assistant} model={model} message={message} topic={topic} />
      </SegmentGroupPresentationProvider>
    )
    // The header starts past the pill's own measured box (a CSS variable the
    // run host publishes); every other header keeps a zero margin.
    const header = container.querySelector('.message-header') as HTMLElement
    expect(ownRules(header).some((rule) => rule.includes('var(--seg-head-pill-w'))).toBe(true)
    // The reserved room narrows this row: the name stays on one line
    // (ellipsis, full name on `title`) instead of wrapping into a taller
    // header — the band height never changes with or without a group.
    const name = container.querySelector('.message-header-username') as HTMLElement
    expect(name).not.toBeNull()
    expect(ownRules(name).some((rule) => rule.includes('text-overflow:ellipsis'))).toBe(true)
  })
  it('leaves a headed-first USER bubble header untouched (absolute avatar reserves nothing; the label clamps instead)', () => {
    bubbleStyleState.isBubbleStyle = true
    isMessageInSegmentMock.mockReturnValue({ id: 'seg-1' })
    const message = makeMessage('user', { id: 'm1' } as any)
    const { container } = render(
      <SegmentGroupPresentationProvider>
        <SlotRegistrar groupId="seg-1" messageId="m1" />
        <MessageHeader assistant={assistant} message={message} topic={topic} />
      </SegmentGroupPresentationProvider>
    )
    // Even as the slot run's first message, a user bubble header keeps a zero
    // indent: its avatar is absolutely positioned and reserves no room — the
    // bubble body never shrinks for the group (the label clamps to the free
    // gap instead). Only the in-flow assistant header indents.
    const header = container.querySelector('.message-header') as HTMLElement
    expect(header.classList.contains('user-bubble-header')).toBe(true)
    expect(ownRules(header).some((rule) => rule.includes('var(--seg-head-pill-w'))).toBe(false)
  })

  it('leaves a non-headed message untouched (no indent, no ellipsis rules)', () => {
    isMessageInSegmentMock.mockReturnValue({ id: 'seg-1' })
    // The slot run's first rendered message is m1; this message is m2, so it
    // is not the pill's band partner even inside the same headed group.
    const message = makeMessage('user', { id: 'm2' } as any)
    const { container } = render(
      <SegmentGroupPresentationProvider>
        <SlotRegistrar groupId="seg-1" messageId="m1" />
        <MessageHeader assistant={assistant} message={message} topic={topic} />
      </SegmentGroupPresentationProvider>
    )
    const header = container.querySelector('.message-header') as HTMLElement
    expect(ownRules(header).some((rule) => rule.includes('var(--seg-head-pill-w'))).toBe(false)
  })
  it('case-sensitive: "GPT-4o" vs "gpt-4o" still name-only', () => {
    const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
    const message = makeMessage('assistant', { model } as any)
    render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
    const titleEl = Array.from(document.querySelectorAll('[title]')).find(
      (el) => (el as HTMLElement).getAttribute('title') === 'GPT-4o'
    )
    expect(titleEl).not.toBeNull()
    expect(titleEl?.getAttribute('title')).not.toContain('gpt-4o')
  })

  it('renders the neutral default avatar for a user message without a custom avatar', () => {
    const previous = mocks.avatar
    mocks.avatar = ''
    try {
      const message = makeMessage('user')
      const { container } = render(<MessageHeader assistant={assistant} message={message} topic={topic} />)
      expect(screen.getByTestId('message-user-default-avatar')).toBeInTheDocument()
      expect(container.querySelector('img')).toBeNull()
    } finally {
      mocks.avatar = previous
    }
  })

  it('renders the neutral default avatar for the bundled default asset (user message)', () => {
    const previous = mocks.avatar
    mocks.avatar = UserAvatar as unknown as string
    try {
      const message = makeMessage('user')
      const { container } = render(<MessageHeader assistant={assistant} message={message} topic={topic} />)
      expect(screen.getByTestId('message-user-default-avatar')).toBeInTheDocument()
      expect(container.querySelector(`img[src="${UserAvatar}"]`)).toBeNull()
    } finally {
      mocks.avatar = previous
    }
  })

  it('keeps a custom user avatar image on the image path', () => {
    const message = makeMessage('user')
    const { container } = render(<MessageHeader assistant={assistant} message={message} topic={topic} />)
    expect(screen.queryByTestId('message-user-default-avatar')).toBeNull()
    expect(container.querySelector('img[src="https://avatar.example/1.png"]')).not.toBeNull()
  })

  it('leaves assistant avatars untouched when the user avatar is the default', () => {
    const previous = mocks.avatar
    mocks.avatar = ''
    try {
      const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
      const message = makeMessage('assistant', { model } as any)
      render(<MessageHeader assistant={assistant} model={model} message={message} topic={topic} />)
      expect(screen.getByTestId('model-avatar')).toBeInTheDocument()
      expect(screen.queryByTestId('message-user-default-avatar')).toBeNull()
    } finally {
      mocks.avatar = previous
    }
  })
})
