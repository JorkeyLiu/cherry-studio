import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn() }) }
}))
vi.mock('@renderer/components/Layout', () => ({
  Center: ({ children }: any) => <div>{children}</div>,
  VStack: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/components/ProviderAvatar', () => ({
  ProviderAvatarPrimitive: () => <div data-testid="avatar-primitive" />
}))
vi.mock('@renderer/services/ImageStorage', () => ({
  default: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), remove: vi.fn() }
}))
vi.mock('@renderer/utils', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    compressImage: vi.fn(),
    generateColorFromChar: () => '#000000',
    getForegroundColor: () => 'white'
  }
})
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

const makeProvider = (overrides: Record<string, unknown> = {}): any => ({
  id: 'conn-1',
  name: 'My Connection',
  type: 'openai',
  apiKey: 'sk-original',
  apiHost: 'https://api.example.com/v1',
  anthropicApiHost: 'https://claude.example.com',
  models: [{ id: 'm1' }],
  enabled: true,
  isSystem: false,
  ...overrides
})

import { PopupContainer } from '../AddProviderPopup'

// jsdom shims for Ant Design Modal/Select (house pattern): matchMedia for
// responsive observer, single-arg getComputedStyle for scrollbar measurement.
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
{
  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: ((elt: Element) => originalGetComputedStyle(elt)) as typeof window.getComputedStyle
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('AddProviderPopup endpoint mode', () => {
  it('creation defaults to OpenAI-compatible Chat Completions with a visible endpoint mode', () => {
    const resolve = vi.fn()
    render(<PopupContainer resolve={resolve} />)
    // Top-level protocols remain the three approved choices.
    expect(screen.getByText('settings.provider.add.type')).toBeInTheDocument()
    // Endpoint mode is shown for the default openai protocol.
    expect(screen.getByText('settings.provider.add.endpoint_mode')).toBeInTheDocument()
    expect(screen.getByText('settings.provider.add.endpoint_chat_completions')).toBeInTheDocument()
  })

  it('editing an openai-response connection shows Responses through the openai protocol and stays editable', () => {
    const resolve = vi.fn()
    render(<PopupContainer provider={makeProvider({ type: 'openai-response' })} resolve={resolve} />)
    expect(screen.getByText('settings.provider.add.endpoint_mode')).toBeInTheDocument()
    expect(screen.getByText('settings.provider.add.endpoint_responses')).toBeInTheDocument()
    // Protocol select shows OpenAI Compatible and is NOT disabled for endpoint modes.
    // Ant Design Modal renders in a body portal, so query the document, not the container.
    expect(screen.getByText('settings.provider.add.type_openai_compatible')).toBeInTheDocument()
    const protocolCombobox = document.body.querySelectorAll('.ant-select')[0]
    expect(protocolCombobox?.className).not.toMatch(/ant-select-disabled/)
  })

  it('hides the endpoint mode for non-OpenAI protocols', () => {
    const resolve = vi.fn()
    render(<PopupContainer provider={makeProvider({ type: 'anthropic' })} resolve={resolve} />)
    expect(screen.queryByText('settings.provider.add.endpoint_mode')).not.toBeInTheDocument()
  })

  it('keeps retained legacy entries read-only', () => {
    const resolve = vi.fn()
    render(<PopupContainer provider={makeProvider({ type: 'ollama' } as any)} resolve={resolve} />)
    expect(screen.queryByText('settings.provider.add.endpoint_mode')).not.toBeInTheDocument()
    const protocolCombobox = document.body.querySelectorAll('.ant-select')[0]
    expect(protocolCombobox?.className).toMatch(/ant-select-disabled/)
  })

  it('creation OK resolves to openai by default and preserves the entered name', async () => {
    const user = userEvent.setup()
    const resolve = vi.fn()
    render(<PopupContainer resolve={resolve} />)
    const nameInput = screen.getByPlaceholderText('settings.provider.add.name.placeholder')
    await user.type(nameInput, 'New Conn')
    const okButton = screen.getByRole('button', { name: 'OK' })
    await user.click(okButton)
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    const firstCall = resolve.mock.calls[0][0]
    expect(firstCall.name).toBe('New Conn')
    expect(firstCall.type).toBe('openai')
  })

  it('editing openai without changes resolves back to openai (Chat Completions direction)', async () => {
    const user = userEvent.setup()
    const resolve = vi.fn()
    render(<PopupContainer provider={makeProvider({ type: 'openai' })} resolve={resolve} />)
    const okButton = screen.getByRole('button', { name: 'OK' })
    await user.click(okButton)
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    // onOk + afterClose both resolve with the same payload; every call keeps the mode.
    for (const call of resolve.mock.calls) {
      expect(call[0].type).toBe('openai')
      expect(call[0].name).toBe('My Connection')
    }
  })

  it('editing openai-response without changes resolves back to openai-response (Responses direction)', async () => {
    const user = userEvent.setup()
    const resolve = vi.fn()
    render(<PopupContainer provider={makeProvider({ type: 'openai-response' })} resolve={resolve} />)
    const okButton = screen.getByRole('button', { name: 'OK' })
    await user.click(okButton)
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    for (const call of resolve.mock.calls) {
      expect(call[0].type).toBe('openai-response')
      expect(call[0].name).toBe('My Connection')
    }
  })

  it('selecting Responses via the endpoint dropdown resolves to openai-response', async () => {
    const user = userEvent.setup()
    const resolve = vi.fn()
    render(<PopupContainer resolve={resolve} />)
    const nameInput = screen.getByPlaceholderText('settings.provider.add.name.placeholder')
    await user.type(nameInput, 'Resp Conn')
    // Second Select is the endpoint mode (first is the protocol).
    // Ant Design Modal renders in a body portal, so query the document.
    // Ant Design Select opens on mousedown of the selector, not click on the root.
    const selects = document.body.querySelectorAll('.ant-select')
    expect(selects.length).toBe(2)
    const endpointSelector = selects[1].querySelector('.ant-select-selector') ?? selects[1]
    fireEvent.mouseDown(endpointSelector)
    const option = await screen.findByText('settings.provider.add.endpoint_responses')
    await user.click(option)
    // Dropdown selection updates the displayed endpoint value.
    await waitFor(() =>
      expect(screen.getAllByText('settings.provider.add.endpoint_responses').length).toBeGreaterThan(0)
    )
    const okButton = screen.getByRole('button', { name: 'OK' })
    await user.click(okButton)
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    expect(resolve.mock.calls[0][0]).toMatchObject({ name: 'Resp Conn', type: 'openai-response' })
  })
})
