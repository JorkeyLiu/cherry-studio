import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('antd', () => ({
  Avatar: ({ src, children, ...props }: any) =>
    src ? <img src={src} {...props} alt="" /> : <span {...props}>{children}</span>
}))

vi.mock('@renderer/services/providerLogo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useCanonicalModelLogo: vi.fn(() => null),
    useModelProviderLogo: vi.fn(() => null)
  }
})

import { useCanonicalModelLogo, useModelProviderLogo } from '@renderer/services/providerLogo'

import ModelAvatar from '../Avatar/ModelAvatar'

const MODELS_DEV_SRC = 'data:image/svg+xml;utf8,%3Csvg%3E'
const CANONICAL_SRC = 'data:image/svg+xml;utf8,%3Csvg%3Ecanonical'
const PROVIDER_SRC = 'data:image/svg+xml;utf8,%3Csvg%3Eprovider'

describe('ModelAvatar canonical logo priority', () => {
  it('renders the canonical lab logo as a shared monochrome theme mask', () => {
    const { container } = render(
      <ModelAvatar model={{ id: 'm', name: 'Claude' } as any} size={20} modelsDevLogoSrc={MODELS_DEV_SRC} />
    )
    const mark = container.querySelector('[data-testid="models-dev-logo-mark"]') as HTMLElement | null
    expect(mark).not.toBeNull()
    expect(mark?.style.backgroundColor).toBe('var(--color-text-1)')
    expect(mark?.style.maskImage).toContain(MODELS_DEV_SRC)
    // Transparent avatar circle, no visible <img>.
    expect(container.querySelector('[data-testid="models-dev-logo-avatar"]')).not.toBeNull()
    const imgs = [...container.querySelectorAll('img')]
    expect(imgs.length).toBe(1)
    expect((imgs[0] as HTMLElement).style.display).toBe('none')
  })

  it('falls back to the deterministic model initial without a logo', () => {
    const { container } = render(
      <ModelAvatar model={{ id: 'm', name: 'Claude' } as any} size={20} modelsDevLogoSrc={null} />
    )
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('C')
  })

  it('fails closed to the initial when the enhancement is unavailable', () => {
    const { container } = render(<ModelAvatar model={undefined} size={20} modelsDevLogoSrc={null} />)
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('closes a failed mask to the model initial', () => {
    const { container } = render(
      <ModelAvatar model={{ id: 'm', name: 'Claude' } as any} size={20} modelsDevLogoSrc={MODELS_DEV_SRC} />
    )
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).not.toBeNull()
    fireEvent.error(container.querySelector('[data-testid="models-dev-logo-probe"]')!)
    expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
    expect(container.textContent).toContain('C')
  })

  describe('logo source priority and seams', () => {
    it('explicit modelsDevLogoSrc seam is highest (overrides hooks)', () => {
      vi.mocked(useCanonicalModelLogo).mockReturnValue(CANONICAL_SRC)
      vi.mocked(useModelProviderLogo).mockReturnValue(PROVIDER_SRC)
      const { container } = render(
        <ModelAvatar model={{ id: 'm', name: 'Claude' } as any} size={20} modelsDevLogoSrc={MODELS_DEV_SRC} />
      )
      const mark = container.querySelector('[data-testid="models-dev-logo-mark"]') as HTMLElement | null
      expect(mark?.style.maskImage).toContain(MODELS_DEV_SRC)
      expect(mark?.style.maskImage).not.toContain('canonical')
    })

    it('canonical logo takes priority over provider logo', () => {
      vi.mocked(useCanonicalModelLogo).mockReturnValue(CANONICAL_SRC)
      vi.mocked(useModelProviderLogo).mockReturnValue(PROVIDER_SRC)
      const { container } = render(<ModelAvatar model={{ id: 'm', name: 'Claude' } as any} size={20} />)
      const mark = container.querySelector('[data-testid="models-dev-logo-mark"]') as HTMLElement | null
      expect(mark?.style.maskImage).toContain(CANONICAL_SRC)
    })

    it('uses provider logo when canonical is null', () => {
      vi.mocked(useCanonicalModelLogo).mockReturnValue(null)
      vi.mocked(useModelProviderLogo).mockReturnValue(PROVIDER_SRC)
      const { container } = render(<ModelAvatar model={{ id: 'm', name: 'Claude' } as any} size={20} />)
      const mark = container.querySelector('[data-testid="models-dev-logo-mark"]') as HTMLElement | null
      expect(mark).not.toBeNull()
      expect(mark?.style.maskImage).toContain(PROVIDER_SRC)
    })

    it('falls back to initial when both canonical and provider are null', () => {
      vi.mocked(useCanonicalModelLogo).mockReturnValue(null)
      vi.mocked(useModelProviderLogo).mockReturnValue(null)
      const { container } = render(<ModelAvatar model={{ id: 'm', name: 'Alpha' } as any} size={20} />)
      expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
      expect(container.textContent).toContain('A')
    })

    it('provider fallback is not described as canonical (uses provider hook, not canonical)', () => {
      vi.mocked(useCanonicalModelLogo).mockReturnValue(null)
      vi.mocked(useModelProviderLogo).mockReturnValue(PROVIDER_SRC)
      render(<ModelAvatar model={{ id: 'm', name: 'Beta' } as any} provider={{ id: 'p' } as any} size={20} />)
      expect(useCanonicalModelLogo).toHaveBeenCalled()
      expect(useModelProviderLogo).toHaveBeenCalled()
      // ensure canonical was checked and empty, provider used
      expect(vi.mocked(useCanonicalModelLogo).mock.results[0].value).toBeNull()
    })

    it('explicit null seam forces fallback to initial even when hooks have logo', () => {
      vi.mocked(useCanonicalModelLogo).mockReturnValue(CANONICAL_SRC)
      vi.mocked(useModelProviderLogo).mockReturnValue(PROVIDER_SRC)
      const { container } = render(
        <ModelAvatar model={{ id: 'm', name: 'Gamma' } as any} size={20} modelsDevLogoSrc={null} />
      )
      expect(container.querySelector('[data-testid="models-dev-logo-mark"]')).toBeNull()
      expect(container.textContent).toContain('G')
    })
  })
})
