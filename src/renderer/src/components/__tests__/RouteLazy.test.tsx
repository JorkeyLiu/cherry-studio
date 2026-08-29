import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ErrorBoundary as ReactErrorBoundary } from 'react-error-boundary'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { LazyRoute } from '../LazyRoute'
import { RouteChunkLoadError } from '../RouteChunkLoadError'
import RouteErrorFallback from '../RouteErrorFallback'
import RouteLoadingFallback from '../RouteLoadingFallback'

// Mock i18n
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

describe('S7.1 RouteLoadingFallback', () => {
  it('renders bounded localized loading state', () => {
    render(
      <MemoryRouter>
        <RouteLoadingFallback />
      </MemoryRouter>
    )
    const fallback = screen.getByTestId('route-loading-fallback')
    expect(fallback).toBeInTheDocument()
    expect(fallback.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('is localized and not full-app blank (bounded container)', () => {
    const { container } = render(
      <MemoryRouter>
        <RouteLoadingFallback />
      </MemoryRouter>
    )
    // Bounded: container has flex centered, min-height, not blank
    expect(container.textContent).not.toBe('')
    expect(screen.getByTestId('route-loading-fallback')).toBeInTheDocument()
  })
})

describe('S7.1 RouteErrorFallback - only tagged chunk load errors', () => {
  it('renders recoverable localized error state with retry and home for tagged chunk error', () => {
    const resetMock = vi.fn()
    const tagged = new RouteChunkLoadError('ChunkLoadError')
    render(
      <MemoryRouter>
        <RouteErrorFallback error={tagged} resetErrorBoundary={resetMock} />
      </MemoryRouter>
    )
    const fallback = screen.getByTestId('route-error-fallback')
    expect(fallback).toBeInTheDocument()
    expect(screen.getByText('Failed to load page')).toBeInTheDocument()
    expect(screen.getByText('The page failed to load. Please try again or return home.')).toBeInTheDocument()
    expect(screen.getByTestId('route-error-retry')).toBeInTheDocument()
    expect(screen.getByTestId('route-error-home')).toBeInTheDocument()
    expect(screen.getByText('Retry')).toBeInTheDocument()
    expect(screen.getByText('Back to Home')).toBeInTheDocument()
  })

  it('retry calls resetErrorBoundary without full reload', async () => {
    const resetMock = vi.fn()
    const tagged = new RouteChunkLoadError('chunk')
    render(
      <MemoryRouter>
        <RouteErrorFallback error={tagged} resetErrorBoundary={resetMock} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByTestId('route-error-retry'))
    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock).not.toHaveBeenCalledWith(expect.objectContaining({ reload: expect.anything() }))
  })

  it('home navigates to / without reload for tagged error', async () => {
    const resetMock = vi.fn()
    const tagged = new RouteChunkLoadError('chunk')
    render(
      <MemoryRouter initialEntries={['/files']}>
        <Routes>
          <Route path="/files" element={<RouteErrorFallback error={tagged} resetErrorBoundary={resetMock} />} />
          <Route path="/" element={<div data-testid="home-page">Home</div>} />
        </Routes>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByTestId('route-error-home'))
    expect(resetMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument())
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
  })

  it('rethrows untagged error so outer boundary handles it (not route-local fallback)', async () => {
    const untagged = new Error('render boom')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryRouter>
        <ReactErrorBoundary fallback={<div data-testid="outer-fallback">Outer</div>}>
          <RouteErrorFallback error={untagged} resetErrorBoundary={vi.fn()} />
        </ReactErrorBoundary>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('outer-fallback')).toBeInTheDocument())
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    spy.mockRestore()
  })
})

describe('S7.1 LazyRoute - bounded loading and recoverable chunk error', () => {
  const TestPage = () => <div data-testid="test-page">Test Page</div>

  it('shows bounded loading fallback while lazy chunk pending then renders page', async () => {
    let triggerResolve!: (v: any) => void
    const importer = () =>
      new Promise<{ default: typeof TestPage }>((resolve) => {
        triggerResolve = resolve
      })

    render(
      <MemoryRouter>
        <LazyRoute importer={importer} />
      </MemoryRouter>
    )

    expect(screen.getByTestId('route-loading-fallback')).toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByTestId('test-page')).not.toBeInTheDocument()

    triggerResolve({ default: TestPage })

    await waitFor(() => expect(screen.getByTestId('test-page')).toBeInTheDocument())
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
  })

  it('chunk import failure renders recoverable localized error state (no blank)', async () => {
    const failingImporter = () => Promise.reject(new Error('ChunkLoadError: Loading chunk failed'))

    render(
      <MemoryRouter>
        <LazyRoute importer={failingImporter} />
      </MemoryRouter>
    )

    // Initially loading
    expect(screen.getByTestId('route-loading-fallback')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByTestId('route-error-fallback')).toBeInTheDocument())
    expect(screen.getByText('Failed to load page')).toBeInTheDocument()
    expect(screen.getByTestId('route-error-retry')).toBeInTheDocument()
    expect(screen.getByTestId('route-error-home')).toBeInTheDocument()
    // No indefinite blank - error is explicit
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('test-page')).not.toBeInTheDocument()
  })

  it('retry remounts and re-attempts chunk load', async () => {
    let attempts = 0
    const flakyImporter = () => {
      attempts++
      if (attempts === 1) return Promise.reject(new Error('ChunkLoadError'))
      return Promise.resolve({ default: TestPage })
    }

    render(
      <MemoryRouter>
        <LazyRoute importer={flakyImporter} />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByTestId('route-error-fallback')).toBeInTheDocument())
    expect(attempts).toBe(1)

    fireEvent.click(screen.getByTestId('route-error-retry'))

    await waitFor(() => expect(screen.getByTestId('test-page')).toBeInTheDocument())
    expect(attempts).toBe(2)
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
  })

  it('navigation to home recovers without app restart after chunk failure', async () => {
    const failingImporter = () => Promise.reject(new Error('ChunkLoadError'))

    render(
      <MemoryRouter initialEntries={['/files']}>
        <Routes>
          <Route path="/" element={<div data-testid="home-page">Home Page</div>} />
          <Route path="/files" element={<LazyRoute importer={failingImporter} />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByTestId('route-error-fallback')).toBeInTheDocument())
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('route-error-home'))

    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument())
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
  })

  it('navigation to another route after failure works (route-local, no full reload)', async () => {
    const failingImporter = () => Promise.reject(new Error('ChunkLoadError'))
    const OtherPage = () => <div data-testid="other-page">Other</div>
    const goodImporter = () => Promise.resolve({ default: OtherPage })

    // First, prove files route fails in isolation
    const { unmount } = render(
      <MemoryRouter initialEntries={['/files']}>
        <Routes>
          <Route path="/files" element={<LazyRoute importer={failingImporter} />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('route-error-fallback')).toBeInTheDocument())
    unmount()
    document.body.innerHTML = ''

    // Then prove notes route still loads independently (route-local isolation)
    render(
      <MemoryRouter initialEntries={['/notes']}>
        <Routes>
          <Route path="/notes" element={<LazyRoute importer={goodImporter} />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('other-page')).toBeInTheDocument())
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
  })
})

describe('S7.1 LazyRoute - untagged page render error bubbles to outer boundary', () => {
  it('lazy module resolves to throwing component does not show route fallback; outer boundary handles it', async () => {
    const ThrowingPage = () => {
      throw new Error('render boom')
    }
    const goodImporter = () => Promise.resolve({ default: ThrowingPage })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <MemoryRouter>
        <ReactErrorBoundary fallback={<div data-testid="outer-fallback">Outer Error</div>}>
          <LazyRoute importer={goodImporter} />
        </ReactErrorBoundary>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByTestId('outer-fallback')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()

    spy.mockRestore()
  })

  it('outer global boundary still catches Home-style eager render errors (not route-local)', async () => {
    const ThrowingHome = () => {
      throw new Error('home render boom')
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryRouter>
        <ReactErrorBoundary fallback={<div data-testid="outer-home-fallback">Outer Home Error</div>}>
          <ThrowingHome />
        </ReactErrorBoundary>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('outer-home-fallback')).toBeInTheDocument())
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    spy.mockRestore()
  })
})
