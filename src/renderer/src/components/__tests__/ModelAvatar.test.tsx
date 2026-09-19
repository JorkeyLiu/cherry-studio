import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('antd', () => ({
  Avatar: ({ src, children, ...props }: any) =>
    src ? <img src={src} {...props} alt="" /> : <span {...props}>{children}</span>
}))

vi.mock('@renderer/services/providerLogo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useCanonicalModelLogo: () => null }
})

import ModelAvatar from '../Avatar/ModelAvatar'

const MODELS_DEV_SRC = 'data:image/svg+xml;utf8,%3Csvg%3E'

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
})
