import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FC } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
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
        'route.error.back_to_home': 'Back to Home'
      }
      return map[key] ?? key
    },
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@renderer/databases', () => ({}))
vi.mock('@renderer/components/app/Sidebar', () => ({ default: () => <div data-testid="sidebar">Sidebar</div> }))
vi.mock('@renderer/handler/NavigationHandler', () => ({ default: () => null }))

// Representative Home effect inventory for the activation-boundary proof: the
// stub mirrors HomePage's real hidden-relevant effects (native minimum-size
// with reset cleanup + a global keydown listener standing in for the shortcut
// overlap) so the test proves the Activity boundary deactivates them while
// hidden and reactivates them on return — naturally via effect cleanup, with
// no per-handler gating.
const homeEffects = vi.hoisted(() => ({
  setMinimumSize: vi.fn(),
  resetMinimumSize: vi.fn(),
  keyHandler: vi.fn()
}))

vi.mock('@renderer/pages/home/HomePage', async () => {
  const React = await import('react')
  const HomeStub: FC = () => {
    React.useEffect(() => {
      void (window as any).api?.window?.setMinimumSize?.(800, 600)
      const onKey = () => {
        homeEffects.keyHandler()
      }
      window.addEventListener('keydown', onKey)
      return () => {
        void (window as any).api?.window?.resetMinimumSize?.()
        window.removeEventListener('keydown', onKey)
      }
    }, [])
    return (
      <div data-testid="home-page" id="home-page">
        <input data-testid="home-draft" defaultValue="" />
      </div>
    )
  }
  return { default: HomeStub }
})
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

let navigateFn: ((path: string) => void) | null = null

const NavProbe: FC = () => {
  navigateFn = useNavigate()
  return null
}

const renderAt = (entry: string) => {
  navigateFn = null
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <NavProbe />
      <AppRoutes />
    </MemoryRouter>
  )
}

const go = (path: string) => {
  act(() => {
    navigateFn?.(path)
  })
}

const fireHiddenKey = () => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
  })
}

beforeEach(() => {
  homeEffects.setMinimumSize.mockClear()
  homeEffects.resetMinimumSize.mockClear()
  homeEffects.keyHandler.mockClear()
  ;(window as any).api = {
    window: {
      setMinimumSize: (...args: unknown[]) => {
        homeEffects.setMinimumSize(...args)
        return Promise.resolve()
      },
      resetMinimumSize: (...args: unknown[]) => {
        homeEffects.resetMinimumSize(...args)
        return Promise.resolve()
      }
    }
  }
})

describe('Chat route session — Chat -> Settings -> Chat preserves component identity', () => {
  it('keeps the same Home DOM session hidden while on Settings and restores it with state on return', async () => {
    renderAt('/')

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    const homeEl = screen.getByTestId('home-page')
    fireEvent.change(screen.getByTestId('home-draft'), { target: { value: 'draft-kept' } })
    expect(screen.getByTestId('home-draft')).toHaveValue('draft-kept')

    go('/settings/provider')
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())

    // Same session persists hidden (not unmounted): identical node, inert to AT.
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-page')).not.toBeVisible()
    // Activity owns hidden semantics: no manual CSS/inert mechanics remain.
    expect(screen.getByTestId('chat-workspace')).not.toHaveAttribute('aria-hidden')
    expect(screen.getByTestId('chat-workspace')).not.toHaveAttribute('inert')

    go('/')
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeVisible())

    // No remount: identical node, uncontrolled draft state intact.
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-draft')).toHaveValue('draft-kept')
  })

  it('deactivates Home effects while hidden (min-size reset, shortcuts detached) and reactivates on return', async () => {
    renderAt('/')

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    expect(homeEffects.setMinimumSize).toHaveBeenCalledTimes(1)

    // Active Home shortcut fires while visible.
    fireHiddenKey()
    expect(homeEffects.keyHandler).toHaveBeenCalledTimes(1)

    go('/settings/provider')
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())
    expect(screen.getByTestId('home-page')).not.toBeVisible()

    // Hidden-subtree effects cleaned up: native min-size reset, no fresh
    // setMinimumSize while hidden.
    expect(homeEffects.resetMinimumSize).toHaveBeenCalledTimes(1)
    expect(homeEffects.setMinimumSize).toHaveBeenCalledTimes(1)

    // Hidden Home cannot fire global shortcuts: the listener is detached, so
    // no duplicate/overlapping shortcut handling from the hidden subtree.
    fireHiddenKey()
    expect(homeEffects.keyHandler).toHaveBeenCalledTimes(1)

    go('/')
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeVisible())

    // Reactivated on return: min-size re-applied, shortcut listener re-attached.
    expect(homeEffects.setMinimumSize).toHaveBeenCalledTimes(2)
    fireHiddenKey()
    expect(homeEffects.keyHandler).toHaveBeenCalledTimes(2)
  })

  it('does not eagerly mount Chat on a direct secondary entry, then preserves the session once visited', async () => {
    renderAt('/settings/provider')

    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())
    // No eager Chat data loading surface: Chat workspace stays unmounted.
    expect(screen.queryByTestId('chat-workspace')).not.toBeInTheDocument()
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument()
    expect(homeEffects.setMinimumSize).not.toHaveBeenCalled()

    go('/')
    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    const homeEl = screen.getByTestId('home-page')
    fireEvent.change(screen.getByTestId('home-draft'), { target: { value: 'after-first-visit' } })

    go('/settings/provider')
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-page')).not.toBeVisible()

    go('/')
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeVisible())
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-draft')).toHaveValue('after-first-visit')
  })

  it('renders the resolved Settings module synchronously on revisit (no fresh fallback)', async () => {
    renderAt('/')

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()

    go('/settings/provider')
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())

    go('/')
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeVisible())

    go('/settings/provider')
    // Stable lazy identity: the already-resolved module renders without
    // suspending again, so no fresh route fallback appears.
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeVisible())
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
  })
})

describe('LazyRoute — stable resolved identity across remounts', () => {
  it('reuses the resolved module on remount without re-invoking the importer or flashing fallback', async () => {
    let calls = 0
    const Page = () => <div data-testid="cached-page">Cached</div>
    const importer = () => {
      calls += 1
      return Promise.resolve({ default: Page })
    }

    const { unmount } = render(
      <MemoryRouter>
        <LazyRoute importer={importer} />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByTestId('cached-page')).toBeInTheDocument())
    expect(calls).toBe(1)
    unmount()
    document.body.innerHTML = ''

    render(
      <MemoryRouter>
        <LazyRoute importer={importer} />
      </MemoryRouter>
    )
    // Already resolved: synchronous render, no fallback, no second import.
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    expect(screen.getByTestId('cached-page')).toBeInTheDocument()
    expect(calls).toBe(1)
    document.body.innerHTML = ''
  })
})
