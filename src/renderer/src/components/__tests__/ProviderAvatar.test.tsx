import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('antd', () => ({
  Avatar: ({ src, children, ...props }: any) =>
    src ? <img src={src} {...props} alt="" /> : <span {...props}>{children}</span>
}))

import type { Provider } from '@renderer/types'

import { ProviderAvatar, ProviderAvatarPrimitive } from '../ProviderAvatar'

const makeProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'conn-1',
    type: 'openai',
    name: 'My Connection',
    apiKey: '',
    apiHost: 'https://api.example.com',
    models: [],
    ...overrides
  }) as Provider

describe('ProviderAvatar (custom-connection product)', () => {
  it('renders the user-uploaded custom image first', () => {
    const provider = makeProvider({ id: 'conn-1', name: 'My Connection' })
    const { container } = render(
      <ProviderAvatar provider={provider} customLogos={{ 'conn-1': 'data:image/png;base64,AAA' }} />
    )

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAA')
  })

  it('falls back to a deterministic generic avatar with the connection initial', () => {
    // Historical brand id without a custom logo must NOT render a brand logo.
    const provider = makeProvider({ id: 'openai', name: 'Work OpenAI' })
    const { container } = render(<ProviderAvatar provider={provider} customLogos={{}} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('W')
  })

  it('falls back to a generic placeholder when the stored name is blank', () => {
    const provider = makeProvider({ id: 'conn-xyz', name: '' })
    const { container } = render(<ProviderAvatar provider={provider} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('P')
  })

  it('primitive renders logoSrc when given, generic initial otherwise', () => {
    const withLogo = render(
      <ProviderAvatarPrimitive providerId="conn-1" providerName="Alpha" logoSrc="data:image/png;base64,BBB" />
    )
    expect(withLogo.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBB')

    const generic = render(<ProviderAvatarPrimitive providerId="conn-1" providerName="Alpha" />)
    expect(generic.container.querySelector('img')).toBeNull()
    expect(generic.container.textContent).toContain('A')
  })

  it('falls back safely for empty and non-BMP (emoji) names', () => {
    const blank = render(<ProviderAvatarPrimitive providerId="conn-1" providerName="" />)
    expect(blank.container.querySelector('img')).toBeNull()
    expect(blank.container.textContent).toContain('P')

    const whitespace = render(<ProviderAvatarPrimitive providerId="conn-1" providerName="   " />)
    expect(whitespace.container.querySelector('img')).toBeNull()
    expect(whitespace.container.textContent).toContain('P')

    // Non-BMP emoji must render as a single code-point initial, never a lone surrogate.
    const emoji = render(<ProviderAvatarPrimitive providerId="conn-1" providerName="😀 Connection" />)
    expect(emoji.container.querySelector('img')).toBeNull()
    expect(emoji.container.textContent).toContain('😀')
  })
})
