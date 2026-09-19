import { fireEvent, render } from '@testing-library/react'
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

const MODELS_DEV_SRC = 'data:image/svg+xml;utf8,%3Csvg%3E'

describe('ProviderAvatar models.dev priority', () => {
  it('prefers the user-uploaded image over the models.dev logo (custom stays full-color img)', () => {
    const provider = makeProvider()
    const { container } = render(
      <ProviderAvatar
        provider={provider}
        customLogos={{ 'conn-1': 'data:image/png;base64,AAA' }}
        modelsDevLogoSrc={MODELS_DEV_SRC}
      />
    )
    // Custom path: visible full-color <img>, never a theme mask.
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect((img as HTMLElement | null)?.style.display).not.toBe('none')
  })

  it('renders the exact cached models.dev logo as a monochrome theme mask', () => {
    const provider = makeProvider()
    const { container } = render(<ProviderAvatar provider={provider} modelsDevLogoSrc={MODELS_DEV_SRC} />)
    const mark = container.querySelector('[data-testid="models-dev-logo-mark"]') as HTMLElement | null
    expect(mark).not.toBeNull()
    // Theme token: high-contrast text token (dark in light theme, light in dark theme).
    expect(mark?.style.backgroundColor).toBe('var(--color-text-1)')
    expect(mark?.style.maskImage).toContain(MODELS_DEV_SRC)
    const webkitMask = mark ? ((mark.style as any).webkitMaskImage ?? (mark.style as any).WebkitMaskImage) : undefined
    expect(webkitMask).toContain(MODELS_DEV_SRC)
    // Transparent avatar circle, no white backing, no filter invert.
    const circle = container.querySelector('[data-testid="models-dev-logo-avatar"]') as HTMLElement | null
    expect(circle).not.toBeNull()
    expect(circle?.getAttribute('style') ?? '').not.toContain('#fff')
    expect(circle?.getAttribute('style') ?? '').not.toContain('#ffffff')
    // Only the hidden decode probe renders an <img>; no visible logo image.
    const imgs = [...container.querySelectorAll('img')]
    expect(imgs.length).toBe(1)
    expect((imgs[0] as HTMLElement).style.display).toBe('none')
    expect(imgs[0].getAttribute('src')).toBe(MODELS_DEV_SRC)
  })

  it('primitive renders models.dev as mask and custom as img', () => {
    const custom = render(
      <ProviderAvatarPrimitive providerId="conn-1" providerName="Alpha" logoSrc="data:image/png;base64,BBB" />
    )
    expect(custom.container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
    expect(custom.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBB')

    const masked = render(
      <ProviderAvatarPrimitive
        providerId="conn-1"
        providerName="Alpha"
        logoSrc={MODELS_DEV_SRC}
        logoKind="models-dev"
      />
    )
    expect(masked.container.querySelector('[data-testid="models-dev-logo-mark"]')).not.toBeNull()
  })

  it('falls back to the deterministic initial when the enhancement is unavailable', () => {
    const provider = makeProvider({ name: 'Work OpenAI' })
    const { container } = render(<ProviderAvatar provider={provider} modelsDevLogoSrc={null} />)
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('W')
  })

  it('closes a failed models.dev mask to the deterministic initial', () => {
    const provider = makeProvider({ name: 'Work OpenAI' })
    const { container } = render(<ProviderAvatar provider={provider} modelsDevLogoSrc={MODELS_DEV_SRC} />)
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).not.toBeNull()
    const probe = container.querySelector('[data-testid="models-dev-logo-probe"]')
    expect(probe).not.toBeNull()
    fireEvent.error(probe!)
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
    expect(container.textContent).toContain('W')
  })
})
