import type { ErrorMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression: ErrorBlock must render without a react-router-dom Router
 * wrapper. It previously used useNavigate() and <Link> which throw
 * "useNavigate() may be used only in the context of a <Router> component"
 * when no Router is in the tree.
 *
 * This test verifies:
 *  1. ErrorBlock renders error.message without crashing (no Router).
 *  2. "Go to Settings" button renders whenever navTarget is set (stable),
 *     regardless of NavigationService.navigate availability at render time.
 *  3. ProviderLink always renders a semantic <button> (not a clickable <span>).
 *  4. ProviderLink reads NavigationService.navigate at click time (not render
 *     time), so setting navigate after render still works.
 *  5. ProviderLink click passes full provider state from getProviderById.
 *
 * If useNavigate or <Link> from react-router-dom are reintroduced,
 * these tests will fail with a Router context error.
 */

// ── Controllable i18n mock ──────────────────────────────────────────────────

/** Set to true in tests that need the i18n/provider branch to reach ProviderLink. */
let mockI18nExists = false

// ── Mocks (hoisted) ────────────────────────────────────────────────────────

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: vi.fn() })
}))

vi.mock('@renderer/components/ErrorDetailModal', () => ({
  showErrorDetailPopup: vi.fn()
}))

vi.mock('@renderer/services/ErrorDiagnosisService', () => ({
  classifyErrorByAI: vi.fn().mockResolvedValue(null)
}))

const mockProvider = { id: 'openai', name: 'OpenAI' }

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn(() => mockProvider)
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  removeBlocksThunk: vi.fn()
}))

vi.mock('@renderer/utils/errorClassifier', () => ({
  classifyError: vi.fn((error: unknown) => {
    const msg = (error as { message?: string })?.message || ''
    if (msg.includes('auth')) {
      return { category: 'auth', i18nKey: 'error.diagnosis.auth', navTarget: '/settings/provider' }
    }
    return { category: 'unknown', i18nKey: 'error.diagnosis.unknown', navTarget: null }
  })
}))

vi.mock('antd', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props} type="button">
      {children}
    </button>
  )
}))

vi.mock('lucide-react', () => ({
  AlertTriangle: () => <span>alert</span>,
  ChevronRight: () => <span>chevron</span>,
  X: () => <span>x</span>
}))

vi.mock('@ant-design/icons', () => ({
  SettingOutlined: () => <span>settings</span>
}))

vi.mock('@renderer/i18n/label', () => ({
  getHttpMessageLabel: (code: string) => `HTTP ${code}`,
  getProviderLabel: (id: string) => id
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { exists: () => mockI18nExists, language: 'en' }
  }),
  /**
   * Minimal Trans mock that renders the `provider` component from the
   * components map with visible text so the ProviderLink button can be
   * located precisely via getByRole('button', { name: ... }).
   */
  Trans: ({ children, components, values }: any) => {
    if (components?.provider) {
      // Re-render the provider element with the provider label as visible
      // children — avoids React.cloneElement (React not in scope here).
      const Provider = components.provider.type
      return <Provider {...components.provider.props}>{values?.provider ?? 'provider'}</Provider>
    }
    return <span>{children}</span>
  },
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

// ── NavigationService mock — controllable per test ─────────────────────────

const mockNavigate = vi.fn()

vi.mock('@renderer/services/NavigationService', () => ({
  default: { navigate: null as ReturnType<typeof vi.fn> | null }
}))

const NavigationService = (await import('@renderer/services/NavigationService')).default

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { default: ErrorBlock } = await import('../ErrorBlock')

// ── Helpers ────────────────────────────────────────────────────────────────

const makeErrorMessageBlock = (message: string, overrides?: Partial<ErrorMessageBlock>): ErrorMessageBlock =>
  ({
    id: 'block-1',
    type: MessageBlockType.ERROR,
    messageId: 'msg-1',
    status: 'error',
    error: { message },
    ...overrides
  }) as unknown as ErrorMessageBlock

const makeMessage = (overrides?: Partial<Message>): Message =>
  ({
    id: 'msg-1',
    topicId: 'topic-1',
    role: 'assistant',
    model: { provider: 'openai', id: 'gpt-4' },
    ...overrides
  }) as unknown as Message

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ErrorBlock without Router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockI18nExists = false
    NavigationService.navigate = null
  })

  it('renders error.message without crashing when no Router is present', () => {
    const block = makeErrorMessageBlock('Something went wrong')
    const message = makeMessage()

    const { container } = render(<ErrorBlock block={block} message={message} />)

    expect(container.textContent).toContain('Something went wrong')
  })

  it('renders "Go to Settings" button whenever navTarget is set, even when navigate is null', () => {
    const block = makeErrorMessageBlock('auth failed')
    const message = makeMessage()

    const { getByText } = render(<ErrorBlock block={block} message={message} />)

    // Button is always rendered when navTarget is present — navigate availability
    // does not gate the render.
    expect(getByText('error.diagnosis.go_to_settings')).toBeTruthy()
  })

  it('"Go to Settings" click is a no-op when navigate is null (no crash)', async () => {
    const block = makeErrorMessageBlock('auth failed')
    const message = makeMessage()

    const { getByText } = render(<ErrorBlock block={block} message={message} />)
    const btn = getByText('error.diagnosis.go_to_settings').closest('button')!

    // Should not throw
    await userEvent.click(btn)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('"Go to Settings" uses latest navigate after late initialization', async () => {
    const block = makeErrorMessageBlock('auth failed')
    const message = makeMessage()

    const { getByText } = render(<ErrorBlock block={block} message={message} />)
    const btn = getByText('error.diagnosis.go_to_settings').closest('button')!

    // Set navigate AFTER render
    NavigationService.navigate = mockNavigate

    await userEvent.click(btn)
    expect(mockNavigate).toHaveBeenCalledWith('/settings/provider')
  })
})

describe('ProviderLink through i18n provider branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockI18nExists = true
    NavigationService.navigate = null
  })

  const makeI18nBlock = (): ErrorMessageBlock =>
    ({
      id: 'block-1',
      type: MessageBlockType.ERROR,
      messageId: 'msg-1',
      status: 'error',
      // No `message` on the error object so that MessageErrorInfo renders
      // <ErrorMessage> which hits the i18n/ProviderLink branch.
      error: { i18nKey: 'auth_error', providerId: 'openai' }
    }) as unknown as ErrorMessageBlock

  it('renders a semantic <button> element, not a clickable <span>', () => {
    const block = makeI18nBlock()
    const message = makeMessage()

    const { getByRole } = render(<ErrorBlock block={block} message={message} />)

    // Precisely target ProviderLink by its visible label; if it were a <span>
    // getByRole('button', …) would throw, proving the element is a button.
    const btn = getByRole('button', { name: /openai/i })
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('renders the interactive button even when NavigationService.navigate is null at render time', () => {
    const block = makeI18nBlock()
    const message = makeMessage()

    const { getByRole } = render(<ErrorBlock block={block} message={message} />)

    // Must not fall back to a plain non-interactive span — getByRole('button')
    // enforces semantic correctness and would fail on a <span>.
    const btn = getByRole('button', { name: /openai/i })
    expect(btn.tagName).toBe('BUTTON')
  })

  /**
   * ProviderLink renders inside the description area via the Trans mock.
   * The outer ErrorBlock also has a close button and a "Go to Settings"
   * button, so we use getByRole with the provider label injected by the
   * Trans mock to precisely target the ProviderLink button.
   */
  const findProviderLinkButton = (container: HTMLElement): HTMLButtonElement => {
    // The Trans mock renders the provider label ("OpenAI") as children
    // of the ProviderLink button. Use getByRole to locate it precisely.
    const btn = container.querySelector('button[style*="var(--color-link)"]') as HTMLButtonElement | null
    if (!btn) throw new Error('ProviderLink button not found — has the style or element changed?')
    return btn
  }

  it('clicks through to NavigationService.navigate with full provider state', async () => {
    NavigationService.navigate = mockNavigate
    const block = makeI18nBlock()
    const message = makeMessage()

    const { container } = render(<ErrorBlock block={block} message={message} />)
    const btn = findProviderLinkButton(container)

    await userEvent.click(btn)

    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/settings/provider', {
      state: { provider: mockProvider }
    })
  })

  it('reads the latest navigate when it is set after render', async () => {
    const block = makeI18nBlock()
    const message = makeMessage()

    const { container } = render(<ErrorBlock block={block} message={message} />)
    const btn = findProviderLinkButton(container)

    // navigate is null at render; set it before click
    NavigationService.navigate = mockNavigate

    await userEvent.click(btn)

    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/settings/provider', {
      state: { provider: mockProvider }
    })
  })

  it('click is a safe no-op when navigate is still null at click time', async () => {
    const block = makeI18nBlock()
    const message = makeMessage()

    const { container } = render(<ErrorBlock block={block} message={message} />)
    const btn = findProviderLinkButton(container)

    // navigate remains null — should not throw
    await userEvent.click(btn)
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
