import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FC } from 'react'
import { ErrorBoundary as ReactErrorBoundary } from 'react-error-boundary'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
        'title.files': 'Files',
        'title.knowledge': 'Knowledge Base',
        'settings.title': 'Settings',
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
vi.mock('@renderer/handler/NavigationHandler', () => ({ default: () => null }))

// Mock page modules as simple components with distinct testids
vi.mock('@renderer/pages/home/HomePage', () => ({
  default: () => (
    <div data-testid="home-page" id="home-page">
      <input data-testid="home-draft" defaultValue="" />
    </div>
  )
}))
vi.mock('@renderer/pages/files/FilesPage', () => ({
  default: () => <div data-testid="files-page">Files</div>
}))
vi.mock('@renderer/pages/knowledge/KnowledgePage', () => ({
  default: () => <div data-testid="knowledge-page">Knowledge</div>
}))
vi.mock('@renderer/pages/settings/SettingsPage', () => ({
  default: () => <div data-testid="settings-page">Settings</div>
}))

import { LazyRoute } from '../components/LazyRoute'
import { AppRoutes } from '../Router'

let currentPath = ''
const PathProbe: FC = () => {
  const location = useLocation()
  currentPath = location.pathname
  return null
}

const NavSwitch: FC<{ to: string; testId: string }> = ({ to, testId }) => {
  const navigate = useNavigate()
  return <button data-testid={testId} onClick={() => navigate(to)} />
}

const renderAt = (entry: string) => {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <PathProbe />
      <AppRoutes />
    </MemoryRouter>
  )
}

/**
 * The global task shell renders no visible chrome: no header, no title, no
 * close control. Scoped to the shell's own native dialog node — a nested child
 * dialog legitimately owns a header and a close button of its own.
 */
const expectNoVisibleChrome = (panel: Element) => {
  const chrome = panel.querySelectorAll(
    '.ant-modal-header, .ant-modal-title, .ant-modal-close, [data-testid="task-dialog-close"]'
  )
  for (const element of Array.from(chrome)) {
    expect(element).not.toBeVisible()
  }
}

/**
 * Dismiss the shell the user's way: click the backdrop, i.e. the shell's own
 * native parent `.ant-modal-wrap`, outside the panel. Impacts the root by
 * cancelling, which is the shell's close path now that it renders no close
 * control of its own.
 */
const dismissByBackdrop = () => {
  const wrap = screen.getByTestId('task-dialog').closest('.ant-modal-wrap')
  expect(wrap).not.toBeNull()
  fireEvent.click(wrap as Element)
}

beforeEach(() => {
  currentPath = ''
  document.body.innerHTML = ''
})

describe('Chat-only base — Home eager and always visible, tasks as modal dialogs', () => {
  it('keeps Home eager: / renders without lazy fallback and without a task dialog', async () => {
    renderAt('/')

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument()
  })

  it.each([
    ['/files', 'files-page', 'Files'],
    ['/knowledge', 'knowledge-page', 'Knowledge Base'],
    ['/settings/provider', 'settings-page', 'Settings']
  ])('task route %s renders Home visible behind a headerless task dialog', async (route, pageId, title) => {
    renderAt(route)

    expect(await screen.findByTestId(pageId)).toBeInTheDocument()
    const dialog = await screen.findByTestId('task-dialog')
    // Style-only seam: no dialog semantics of its own; antd owns the single native dialog.
    expect(dialog).not.toHaveAttribute('role')
    expect(dialog).not.toHaveAttribute('aria-modal')
    const dialogs = document.querySelectorAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    // The accessible name lives on the native dialog itself (aria-label), so it
    // survives the visual header/title removal; the shell stays an addressable
    // dialog with no close control of its own.
    expect(dialogs[0]).toHaveAccessibleName(title)
    expectNoVisibleChrome(dialogs[0])
    // Home stays mounted and visible behind the dialog — never hidden.
    expect(screen.getByTestId('home-page')).toBeInTheDocument()
    expect(screen.getByTestId('home-page')).toBeVisible()
    expect(screen.queryByTestId('route-error-fallback')).not.toBeInTheDocument()
  })

  it.each([['/launchpad'], ['/notes'], ['/notes/abc'], ['/unknown-route']])(
    'retired route %s lands on chat with no task dialog',
    async (route) => {
      renderAt(route)

      expect(await screen.findByTestId('home-page')).toBeInTheDocument()
      expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument()
      await waitFor(() => expect(currentPath).toBe('/'))
    }
  )

  it('closing the task dialog navigates explicitly to / and keeps Home mounted', async () => {
    renderAt('/files')

    expect(await screen.findByTestId('files-page')).toBeInTheDocument()
    const homeEl = screen.getByTestId('home-page')
    fireEvent.change(screen.getByTestId('home-draft'), { target: { value: 'draft-kept' } })

    // Backdrop dismissal is the user's close path: there is no in-shell close
    // control to click any more.
    dismissByBackdrop()

    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())
    expect(currentPath).toBe('/')
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-page')).toBeVisible()
    expect(screen.getByTestId('home-draft')).toHaveValue('draft-kept')
  })

  it('returns focus to the chat field that opened the task after the route closes it', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <PathProbe />
        <NavSwitch to="/settings/provider" testId="go-settings" />
        <AppRoutes />
      </MemoryRouter>
    )

    // Keyboard/shortcut entry: the chat composer owns focus when the task opens.
    const draft = await screen.findByTestId('home-draft')
    draft.focus()
    expect(document.activeElement).toBe(draft)

    fireEvent.click(screen.getByTestId('go-settings'))
    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()

    // Backdrop-driven close (unmount, no leave-motion restore): the chat
    // composer gets its focus back instead of leaving it on body.
    dismissByBackdrop()
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())
    expect(currentPath).toBe('/')
    await waitFor(() => expect(document.activeElement).toBe(draft))
  })

  it('switching tasks never stacks dialogs and never remounts Home', async () => {
    render(
      <MemoryRouter initialEntries={['/files']}>
        <PathProbe />
        <NavSwitch to="/knowledge" testId="go-knowledge" />
        <AppRoutes />
      </MemoryRouter>
    )

    expect(await screen.findByTestId('files-page')).toBeInTheDocument()
    const homeEl = screen.getByTestId('home-page')

    fireEvent.click(screen.getByTestId('go-knowledge'))

    expect(await screen.findByTestId('knowledge-page')).toBeInTheDocument()
    expect(screen.queryByTestId('files-page')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('task-dialog')).toHaveLength(1)
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(homeEl).toBeVisible()
  })

  it('uses bounded dialog widths: settings 1000px, management pages 1100px', async () => {
    const { unmount } = renderAt('/settings/provider')
    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('task-dialog').closest('.ant-modal')).toHaveStyle({ width: '1000px' })
    unmount()
    document.body.innerHTML = ''

    renderAt('/files')
    expect(await screen.findByTestId('files-page')).toBeInTheDocument()
    expect(screen.getByTestId('task-dialog').closest('.ant-modal')).toHaveStyle({ width: '1100px' })
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
