import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('antd', () => ({
  Avatar: ({ src, children, ...props }: any) =>
    src ? <img src={src} {...props} alt="" /> : <span {...props}>{children}</span>
}))

vi.mock('@renderer/services/providerLogo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useProviderModelsDevLogo: () => null }
})

import type { Provider } from '@renderer/types'

import { ProviderAvatar } from '../ProviderAvatar'

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

describe('ProviderAvatar models.dev priority', () => {
  it('prefers the user-uploaded image over the models.dev logo', () => {
    const provider = makeProvider()
    const { container } = render(
      <ProviderAvatar
        provider={provider}
        customLogos={{ 'conn-1': 'data:image/png;base64,AAA' }}
        modelsDevLogoSrc="data:image/svg+xml;utf8,%3Csvg%3E"
      />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA')
  })

  it('uses the exact cached models.dev logo when no custom image exists', () => {
    const provider = makeProvider()
    const { container } = render(
      <ProviderAvatar provider={provider} modelsDevLogoSrc="data:image/svg+xml;utf8,%3Csvg%3E" />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml;utf8,%3Csvg%3E')
  })

  it('falls back to the deterministic initial when the enhancement is unavailable', () => {
    const provider = makeProvider({ name: 'Work OpenAI' })
    const { container } = render(<ProviderAvatar provider={provider} modelsDevLogoSrc={null} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('W')
  })
})
