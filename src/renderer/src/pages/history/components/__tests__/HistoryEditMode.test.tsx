import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression: TopicMessages and SearchMessage must render MessageItem
 * WITHOUT an EditModeProvider wrapper, because MessageItem now uses
 * useOptionalEditMode() which gracefully returns null when no Provider
 * is present (defaulting selectedGroupIds to []).
 *
 * This is a structural integration test — it verifies that the history
 * entry components do not crash at render time when EditModeProvider is
 * absent. Hook-level contracts (useEditMode throws, useOptionalEditMode
 * returns null) are covered in EditModeContext.test.tsx.
 *
 * Strategy:
 *  - Mock MessageItem as a thin div (no hook calls) to isolate the
 *    parent component structure from MessageItem's internal dependencies.
 *  - DO NOT mock EditModeContext — if a parent accidentally requires
 *    EditModeProvider, the test will catch it via render errors.
 *  - Verify that TopicMessages and SearchMessage render their content
 *    without wrapping with EditModeProvider.
 */

// ── Mocks (hoisted) ────────────────────────────────────────────────────────

// Mock MessageItem as a simple stub — we are testing the parent structure,
// not MessageItem internals. MessageItem's own useOptionalEditMode behavior
// is tested in EditModeContext.test.tsx.
vi.mock('@renderer/pages/home/Messages/Message', () => ({
  default: function StubMessageItem({ message }: { message: Message }) {
    return <div data-testid={`msg-${message.id}`} />
  }
}))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/Popups/SearchPopup', () => ({
  default: { hide: vi.fn() }
}))

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ handleScroll: vi.fn(), containerRef: { current: null } })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({})
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: vi.fn() })
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  getTopicById: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantById: vi.fn(),
  getDefaultAssistant: vi.fn(() => ({ id: 'default', name: 'Default', model: null })),
  getAssistantByIdSelector: vi.fn()
}))

vi.mock('@renderer/utils', () => ({
  classNames: (v: unknown) => (Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v ?? '')),
  cn: (...v: unknown[]) => v.filter(Boolean).join(' '),
  runAsyncFunction: async (fn: () => Promise<void>) => fn()
}))

vi.mock('@renderer/store', () => ({
  default: { dispatch: vi.fn(), getState: vi.fn() },
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => undefined,
  useAppStore: () => ({ dispatch: vi.fn(), getState: vi.fn() })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { SHOW_TOPIC_SIDEBAR: 'show-topic-sidebar' },
  EventEmitter: { emit: vi.fn() }
}))

vi.mock('@renderer/services/MessagesService', () => ({
  isGenerating: vi.fn().mockResolvedValue(undefined),
  locateToMessage: vi.fn()
}))

vi.mock('@renderer/services/NavigationService', () => ({
  default: { navigate: vi.fn() }
}))

vi.mock('antd', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props} type="button">
      {children}
    </button>
  ),
  Divider: () => <hr />,
  Empty: { PRESENTED_IMAGE_SIMPLE: 'simple' }
}))

vi.mock('@ant-design/icons', () => ({
  MessageOutlined: () => null
}))

vi.mock('lucide-react', () => ({
  Forward: () => null
}))

vi.mock('i18next', () => ({
  t: (key: string) => key
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { default: TopicMessages } = await import('../TopicMessages')
const { default: SearchMessage } = await import('../SearchMessage')
const { getTopicById } = await import('@renderer/hooks/useTopic')

// ── Helpers ────────────────────────────────────────────────────────────────

const makeTopic = (id: string, messageCount: number): Topic =>
  ({
    id,
    name: `Topic ${id}`,
    assistantId: 'assistant-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `${id}-msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      topicId: id,
      createdAt: new Date().toISOString(),
      status: 'success',
      blocks: []
    }))
  }) as unknown as Topic

const makeMessage = (id: string, topicId: string): Message =>
  ({
    id,
    role: 'user',
    content: 'Test',
    topicId,
    createdAt: new Date().toISOString(),
    status: 'success',
    blocks: []
  }) as unknown as Message

// ── Tests ──────────────────────────────────────────────────────────────────

describe('History entry rendering without EditModeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TopicMessages renders MessageItem without EditModeProvider', async () => {
    const topic = makeTopic('tp1', 2)
    vi.mocked(getTopicById).mockResolvedValue(topic)

    const { getByTestId } = render(<TopicMessages topic={topic} />)

    await waitFor(() => {
      expect(getByTestId('msg-tp1-msg-0')).toBeTruthy()
      expect(getByTestId('msg-tp1-msg-1')).toBeTruthy()
    })
  })

  it('SearchMessage renders MessageItem without EditModeProvider', async () => {
    const topic = makeTopic('tp2', 1)
    const message = makeMessage('m-search', 'tp2')
    vi.mocked(getTopicById).mockResolvedValue(topic)

    const { getByTestId } = render(<SearchMessage message={message} />)

    await waitFor(() => {
      expect(getByTestId('msg-m-search')).toBeTruthy()
    })
  })
})
