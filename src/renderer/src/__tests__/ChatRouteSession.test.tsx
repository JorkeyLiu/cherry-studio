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
        'route.error.back_to_home': 'Back to Home',
        'title.files': 'Files',
        'title.knowledge': 'Knowledge Base',
        'settings.title': 'Settings'
      }
      return map[key] ?? key
    },
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@renderer/databases', () => ({}))
vi.mock('@renderer/handler/NavigationHandler', () => ({ default: () => null }))

// Representative Home effect inventory for the dialog-overlay proof: the stub
// mirrors HomePage's real hidden-relevant effects (native minimum-size with
// reset cleanup + a global keydown listener standing in for the shortcut
// overlap) so the test proves the overlay keeps them active — with no
// detach/reattach cycle — while a task dialog is open.
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
vi.mock('@renderer/pages/knowledge/KnowledgePage', () => ({
  default: () => <div data-testid="knowledge-page">Knowledge</div>
}))
vi.mock('@renderer/pages/settings/SettingsPage', () => ({
  default: () => <div data-testid="settings-page">Settings</div>
}))

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

const fireVisibleKey = () => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
  })
}

beforeEach(() => {
  homeEffects.setMinimumSize.mockClear()
  homeEffects.resetMinimumSize.mockClear()
  homeEffects.keyHandler.mockClear()
  document.body.innerHTML = ''
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

describe('Chat base session — task dialogs never hide or remount Chat', () => {
  it('keeps the same Home DOM session visible with state while a task dialog is open', async () => {
    renderAt('/')

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    const homeEl = screen.getByTestId('home-page')
    fireEvent.change(screen.getByTestId('home-draft'), { target: { value: 'draft-kept' } })
    expect(screen.getByTestId('home-draft')).toHaveValue('draft-kept')

    go('/settings/provider')
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())

    // Same session stays visible (attached, never hidden) behind the dialog.
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-page')).toBeVisible()
    // Awaited: the shell's appear motion is scheduler-timed; visibility is
    // still required, but not that the animation already finished.
    await waitFor(() => expect(screen.getByTestId('task-dialog')).toBeVisible())

    go('/')
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())

    // No remount: identical node, uncontrolled draft state intact.
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-draft')).toHaveValue('draft-kept')
  })

  it('keeps Home effects active under the dialog (no min-size reset, no shortcut detach)', async () => {
    renderAt('/')

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    expect(homeEffects.setMinimumSize).toHaveBeenCalledTimes(1)

    // Home shortcut fires while visible.
    fireVisibleKey()
    expect(homeEffects.keyHandler).toHaveBeenCalledTimes(1)

    go('/settings/provider')
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())
    expect(screen.getByTestId('home-page')).toBeVisible()

    // No hidden-subtree effect cleanup: no min-size reset, no fresh
    // setMinimumSize, listener still attached.
    expect(homeEffects.resetMinimumSize).not.toHaveBeenCalled()
    expect(homeEffects.setMinimumSize).toHaveBeenCalledTimes(1)

    // Home still receives global shortcuts: the listener was never detached.
    fireVisibleKey()
    expect(homeEffects.keyHandler).toHaveBeenCalledTimes(2)

    go('/')
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())

    // Closing the dialog is not a remount: still no reset, still one setup.
    expect(homeEffects.resetMinimumSize).not.toHaveBeenCalled()
    expect(homeEffects.setMinimumSize).toHaveBeenCalledTimes(1)
    fireVisibleKey()
    expect(homeEffects.keyHandler).toHaveBeenCalledTimes(3)
  })

  it('initializes chat on a direct secondary entry, then treats dialog close as explicit / navigation', async () => {
    renderAt('/settings/provider')

    // No eager Chat data loading gate: the chat workspace mounts with the
    // dialog on a direct secondary entry.
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())
    expect(screen.getByTestId('chat-workspace')).toBeInTheDocument()
    expect(screen.getByTestId('home-page')).toBeInTheDocument()
    expect(homeEffects.setMinimumSize).toHaveBeenCalled()

    const homeEl = screen.getByTestId('home-page')
    fireEvent.change(screen.getByTestId('home-draft'), { target: { value: 'after-first-visit' } })

    go('/knowledge')
    await waitFor(() => expect(screen.getByTestId('knowledge-page')).toBeInTheDocument())
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-page')).toBeVisible()

    go('/')
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-draft')).toHaveValue('after-first-visit')
  })

  it('closes the top task dialog with Escape and lands explicitly on /', async () => {
    renderAt('/files')

    expect(await screen.findByTestId('files-page')).toBeInTheDocument()
    const homeEl = screen.getByTestId('home-page')

    const wrap = document.querySelector('.ant-modal-wrap')
    expect(wrap).not.toBeNull()
    fireEvent.keyDown(wrap!, { key: 'Escape', keyCode: 27, which: 27 })

    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('home-page')).toBe(homeEl)
    expect(screen.getByTestId('home-page')).toBeVisible()
  })

  it('renders the resolved Settings module synchronously on revisit (no fresh fallback)', async () => {
    renderAt('/')

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()

    go('/settings/provider')
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument())

    go('/')
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())

    go('/settings/provider')
    // Stable lazy identity: the already-resolved module renders without
    // suspending again, so no fresh route fallback appears.
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('settings-page')).toBeVisible())
    expect(screen.queryByTestId('route-loading-fallback')).not.toBeInTheDocument()
  })
})
