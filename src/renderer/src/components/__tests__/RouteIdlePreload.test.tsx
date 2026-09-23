import { render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { LazyRoute } from '../LazyRoute'
import { getRouteResource } from '../routeResource'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'route.loading': 'Loading...',
        'route.error.title': 'Failed to load page',
        'route.error.description': 'The page failed to load. Please try again or return home.',
        'route.error.retry': 'Retry',
        'route.error.back_to_home': 'Back to Home'
      }
      return map[key] ?? key
    },
    i18n: { language: 'en-US' }
  })
}))

describe('route-resource idle preload semantics', () => {
  it('renders synchronously without fallback after successful preload', async () => {
    const Page = () => <div data-testid="preloaded-page">Preloaded</div>
    const importer = vi.fn(() => Promise.resolve({ default: Page }))
    const resource = getRouteResource(importer)

    await resource.preload()
    expect(importer).toHaveBeenCalledTimes(1)
    expect(resource.getResolvedComponent()).toBe(Page)

    render(
      <MemoryRouter>
        <LazyRoute importer={importer} />
      </MemoryRouter>
    )

    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    expect(screen.getByTestId('preloaded-page')).toBeInTheDocument()
    expect(importer).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
  })

  it('drops silent preload failure so later navigation retries fresh and succeeds', async () => {
    const Page = () => <div data-testid="recovered-page">Recovered</div>
    let attempts = 0
    const importer = vi.fn(() => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(new Error('ChunkLoadError'))
      }
      return Promise.resolve({ default: Page })
    })
    const resource = getRouteResource(importer)

    await resource.preload()
    expect(attempts).toBe(1)
    expect(resource.getResolvedComponent()).toBeNull()

    const { unmount } = render(
      <MemoryRouter>
        <LazyRoute importer={importer} />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByTestId('recovered-page')).toBeInTheDocument())
    expect(attempts).toBe(2)
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    unmount()
    document.body.innerHTML = ''
  })

  it('coalesces concurrent preload and render into a single import', async () => {
    const Page = () => <div data-testid="coalesced-page">Coalesced</div>
    let resolveImport!: (v: { default: typeof Page }) => void
    const importer = vi.fn(
      () =>
        new Promise<{ default: typeof Page }>((resolve) => {
          resolveImport = resolve
        })
    )
    const resource = getRouteResource(importer)

    const preloadPromise = resource.preload()
    render(
      <MemoryRouter>
        <LazyRoute importer={importer} />
      </MemoryRouter>
    )

    expect(screen.getByTestId('route-loading-fallback')).toBeInTheDocument()

    resolveImport({ default: Page })
    await preloadPromise
    await waitFor(() => expect(screen.getByTestId('coalesced-page')).toBeInTheDocument())
    expect(importer).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
  })

  it('retry after render failure performs a fresh load', async () => {
    const Page = () => <div data-testid="fresh-page">Fresh</div>
    let attempts = 0
    const importer = vi.fn(() => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(new Error('ChunkLoadError'))
      }
      return Promise.resolve({ default: Page })
    })

    render(
      <MemoryRouter>
        <LazyRoute importer={importer} />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByTestId('route-error-fallback')).toBeInTheDocument())
    expect(attempts).toBe(1)

    fireEvent.click(screen.getByTestId('route-error-retry'))

    await waitFor(() => expect(screen.getByTestId('fresh-page')).toBeInTheDocument())
    expect(attempts).toBe(2)
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    document.body.innerHTML = ''
  })
})
