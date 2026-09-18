import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('antd', () => ({
  Avatar: ({ src, children, ...props }: any) =>
    src ? <img src={src} {...props} alt="" /> : <span {...props}>{children}</span>
}))

vi.mock('@renderer/services/providerLogo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useModelProviderLogo: () => null }
})

import ModelAvatar from '../Avatar/ModelAvatar'

describe('ModelAvatar models.dev priority', () => {
  it('uses the owning provider logo when available', () => {
    const { container } = render(
      <ModelAvatar
        model={{ id: 'm', name: 'Claude' } as any}
        size={20}
        modelsDevLogoSrc="data:image/svg+xml;utf8,%3Csvg%3E"
      />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml;utf8,%3Csvg%3E')
  })

  it('falls back to the deterministic model initial without a logo', () => {
    const { container } = render(
      <ModelAvatar model={{ id: 'm', name: 'Claude' } as any} size={20} modelsDevLogoSrc={null} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('C')
  })

  it('fails closed to the initial when the enhancement is unavailable', () => {
    const { container } = render(<ModelAvatar model={undefined} size={20} modelsDevLogoSrc={null} />)
    expect(container.querySelector('img')).toBeNull()
  })
})
