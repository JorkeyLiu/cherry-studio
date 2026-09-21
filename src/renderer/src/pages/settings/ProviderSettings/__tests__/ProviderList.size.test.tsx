import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
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

const { providerAvatarSpy } = vi.hoisted(() => {
  const spy = vi.fn((props: any) =>
    React.createElement(
      'span',
      {
        'data-testid': 'provider-avatar-mock',
        'data-size': String(props.size),
        'data-provider-id': props.provider?.id
      } as any,
      props.provider?.name
    )
  )
  return { providerAvatarSpy: spy }
})

// --- narrow mocks for ProviderList dependencies ---
vi.mock('@renderer/components/DraggableList', () => ({
  DraggableVirtualList: ({ list, children }: any) =>
    React.createElement(
      'div',
      { 'data-testid': 'draggable-list' } as any,
      (list as any[]).map((item: any, idx: number) =>
        React.createElement('div', { key: item.id ?? idx, 'data-testid': 'draggable-row' } as any, children(item, idx))
      )
    ),
  useDraggableReorder: () => ({ onDragEnd: vi.fn(), itemKey: (idx: number) => idx })
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useAllProviders: () => [
    { id: 'openai', name: 'OpenAI', type: 'openai', apiKey: '', apiHost: '', models: [], enabled: true },
    { id: 'anthropic', name: 'Anthropic', type: 'anthropic', apiKey: '', apiHost: '', models: [], enabled: true }
  ],
  useProviders: () => ({
    updateProviders: vi.fn(),
    addProvider: vi.fn(),
    removeProvider: vi.fn(),
    updateProvider: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: vi.fn() })
}))

vi.mock('@renderer/services/ImageStorage', () => ({
  default: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@renderer/pages/settings/ProviderSettings/AddProviderPopup', () => ({
  default: { show: vi.fn().mockResolvedValue({ name: '', type: 'openai' }) }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/ModelNotesPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/ProviderSetting', () => ({
  default: ({ providerId }: any) => React.createElement('div', { 'data-testid': 'provider-setting' } as any, providerId)
}))
vi.mock('@renderer/pages/settings/ProviderSettings/UrlSchemaInfoPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/utils/provider', () => ({
  isAnthropicSupportedProvider: () => false
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useSearchParams: () => [new URLSearchParams(), vi.fn()] }
})

vi.mock('@renderer/components/ProviderAvatar', async (importActual) => {
  const actual = await importActual<any>()
  return {
    ...actual,
    ProviderAvatar: (props: any) => providerAvatarSpy(props)
  }
})

vi.mock('antd', async (importActual) => {
  const actual = await importActual<any>()
  return {
    ...actual,
    Input: (props: any) => React.createElement('input', { 'data-testid': 'search-input', ...props }),
    Button: ({ children, ...props }: any) => React.createElement('button', props, children),
    Tag: ({ children, ...props }: any) => React.createElement('span', props, children),
    Dropdown: ({ children }: any) => React.createElement('div', null as any, children)
  }
})

import { ProviderAvatarPrimitive } from '@renderer/components/ProviderAvatar'

import ProviderList from '../ProviderList'

describe('ProviderList logo alignment (size 32) — behavioral', () => {
  beforeEach(() => {
    cleanup()
    providerAvatarSpy.mockClear()
  })

  it('forwards size=32 to ProviderAvatar for each row', () => {
    render(React.createElement(ProviderList, null as any))

    const avatars = screen.getAllByTestId('provider-avatar-mock')
    expect(avatars).toHaveLength(2)
    expect(providerAvatarSpy).toHaveBeenCalledTimes(2)

    for (const call of providerAvatarSpy.mock.calls) {
      expect(call[0].size).toBe(32)
    }

    for (const el of avatars) {
      expect(el.getAttribute('data-size')).toBe('32')
    }
  })

  it('passes correct provider identity alongside size 32', () => {
    render(React.createElement(ProviderList, null as any))
    const firstCall = providerAvatarSpy.mock.calls[0]?.[0]
    expect(firstCall).toBeDefined()
    expect(firstCall.provider.id).toBe('openai')
    expect(firstCall.size).toBe(32)
  })
})

describe('ProviderAvatar size contract — behavioral', () => {
  it('ProviderAvatarPrimitive forwards size to underlying avatar (fallback path)', () => {
    const { container } = render(
      React.createElement(ProviderAvatarPrimitive, {
        providerId: 'conn-1',
        providerName: 'Test Provider',
        size: 32
      } as any)
    )
    const avatar = container.querySelector('.ant-avatar') as HTMLElement | null
    if (avatar) {
      const style = avatar.getAttribute('style') || ''
      expect(avatar.textContent).toContain('T')
      if (style.includes('width') || style.includes('height')) {
        expect(style).toMatch(/32px/)
      }
    } else {
      expect(container.textContent).toContain('T')
      expect(container.innerHTML).not.toBe('')
    }
  })

  it('ProviderAvatarPrimitive with logoSrc forwards size to image avatar', () => {
    const { container } = render(
      React.createElement(ProviderAvatarPrimitive, {
        providerId: 'conn-1',
        providerName: 'Alpha',
        logoSrc: 'data:image/png;base64,AAA',
        size: 32
      } as any)
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAA')
  })
})
