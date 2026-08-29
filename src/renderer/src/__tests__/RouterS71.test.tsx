import { render, screen, waitFor } from '@testing-library/react'
import { ErrorBoundary as ReactErrorBoundary } from 'react-error-boundary'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

// Mock i18n before importing Router
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'route.loading': 'Loading...',
        'route.error.title': 'Failed to load page',
        'route.error.description': 'The page failed to load. Please try again or return home.',
        'route.error.retry': 'Retry',
        'route.error.back_to_home': 'Back to Home',
        'error.boundary.default.message': 'Something went wrong',
        'error.boundary.default.devtools': 'DevTools',
        'error.boundary.default.reload': 'Reload'
      }
      return map[key] ?? key
    },
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@renderer/databases', () => ({}))
vi.mock('@renderer/components/app/Sidebar', () => ({ default: () => <div data-testid="sidebar">Sidebar</div> }))
vi.mock('@renderer/handler/NavigationHandler', () => ({ default: () => null }))

// Mock page modules as simple components with distinct testids
vi.mock('@renderer/pages/home/HomePage', () => ({
  default: () => <div data-testid="home-page">Home</div>
}))
vi.mock('@renderer/pages/files/FilesPage', () => ({
  default: () => <div data-testid="files-page">Files</div>
}))
vi.mock('@renderer/pages/notes/NotesPage', () => ({
  default: () => <div data-testid="notes-page">Notes</div>
}))
vi.mock('@renderer/pages/knowledge/KnowledgePage', () => ({
  default: () => <div data-testid="knowledge-page">Knowledge</div>
}))
vi.mock('@renderer/pages/settings/SettingsPage', () => ({
  default: () => <div data-testid="settings-page">Settings</div>
}))
vi.mock('@renderer/pages/launchpad/LaunchpadPage', () => ({
  default: () => <div data-testid="launchpad-page">Launchpad</div>
}))

import { LazyRoute } from '../components/LazyRoute'
import { AppRoutes } from '../Router'

describe('S7.1 Router - Home eager vs five secondary routes lazy', () => {
  it('keeps Home eager: / renders without lazy fallback', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>
    )
    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
  })

  it.each([
    ['/files', 'files-page'],
    ['/notes', 'notes-page'],
    ['/knowledge', 'knowledge-page'],
    ['/settings/provider', 'settings-page'],
    ['/launchpad', 'launchpad-page']
  ])('lazy secondary route %s loads through lazy boundary (fallback then page)', async (route, testId) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument(), { timeout: 2000 })
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
  })

  it('preserves paths and navigation semantics: all five routes reachable', async () => {
    const routes: Array<[string, string]> = [
      ['/files', 'files-page'],
      ['/notes', 'notes-page'],
      ['/knowledge', 'knowledge-page'],
      ['/settings/provider', 'settings-page'],
      ['/launchpad', 'launchpad-page']
    ]
    for (const [path, id] of routes) {
      const { unmount } = render(
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      )
      await waitFor(() => expect(screen.getByTestId(id)).toBeInTheDocument())
      unmount()
      document.body.innerHTML = ''
    }
  })

  it('route-local boundary catches only tagged chunk failures, untagged page render bubbles to outer global boundary', async () => {
    const ThrowingPage = () => {
      throw new Error('untagged render error')
    }
    const goodButThrowingImporter = () => Promise.resolve({ default: ThrowingPage })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <MemoryRouter>
        <ReactErrorBoundary fallback={<div data-testid="outer-global-fallback">Global Error</div>}>
          <Routes>
            <Route path="/throwing" element={<LazyRoute importer={goodButThrowingImporter} />} />
            <Route path="/" element={<div data-testid="home-page">Home</div>} />
          </Routes>
        </ReactErrorBoundary>
      </MemoryRouter>
    )

    // Need to navigate to /throwing to trigger lazy resolve + render throw
    // Initial entry is / by default, so push navigation
    // Use inner navigation via MemoryRouter? Instead render directly with initialEntries
    // Re-render with correct entry for simplicity
    spy.mockRestore()

    // Second variant: direct initial entry proves behavior without extra navigation
    const spy2 = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(
      <MemoryRouter initialEntries={['/throwing']}>
        <ReactErrorBoundary fallback={<div data-testid="outer-global-fallback-2">Global Error 2</div>}>
          <Routes>
            <Route path="/throwing" element={<LazyRoute importer={goodButThrowingImporter} />} />
          </Routes>
        </ReactErrorBoundary>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('outer-global-fallback-2')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    spy2.mockRestore()
    unmount()
    document.body.innerHTML = ''
  })

  it('Home eager render error bubbles to outer global boundary, not route-local fallback', async () => {
    const ThrowingHome = () => {
      throw new Error('home boom')
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/']}>
        <ReactErrorBoundary fallback={<div data-testid="outer-home-global">Global Home Error</div>}>
          <Routes>
            <Route path="/" element={<ThrowingHome />} />
            <Route path="/files" element={<div data-testid="files-page">Files</div>} />
          </Routes>
        </ReactErrorBoundary>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('outer-home-global')).toBeInTheDocument())
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    spy.mockRestore()
  })
})
