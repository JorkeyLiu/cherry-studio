import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import { APP_NAME, AppLogo } from '../../config/env'
import {
  configureFreshChatBootstrapFinalizer,
  finalizeFreshChatBootstrap,
  FRESH_CHAT_BOOTSTRAP_PENDING_KEY,
  markFreshBootstrapPendingIfFreshProfile,
  PERSIST_COMPAT_KEY,
  runFreshChatBootstrap
} from '../../services/freshChatBootstrap'
import FreshChatBootstrapGate from '../FreshChatBootstrapGate'

function configureFinalizer(ensureTopic: (target: { id: string }) => Promise<void>): void {
  configureFreshChatBootstrapFinalizer(() =>
    finalizeFreshChatBootstrap({
      collectTargets: () => [{ id: 't-1', assistantId: 'default', name: 'Topic' }],
      ensureTopic
    })
  )
}

function renderGate() {
  return render(
    <FreshChatBootstrapGate>
      <div data-testid="ordinary-tree">ordinary chat</div>
    </FreshChatBootstrapGate>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY)
  localStorage.removeItem(PERSIST_COMPAT_KEY)
})

describe('FreshChatBootstrapGate', () => {
  it('existing profile renders the ordinary tree immediately without a loading frame', () => {
    const ensureTopic = vi.fn()
    configureFinalizer(ensureTopic)

    renderGate()

    expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('startup-readiness-loading')).not.toBeInTheDocument()
    expect(ensureTopic).not.toHaveBeenCalled()
  })

  it('keeps the ordinary tree unmounted until fresh-topic ensure completes', async () => {
    markFreshBootstrapPendingIfFreshProfile()
    let resolveEnsure!: () => void
    const ensureTopic = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEnsure = resolve
        })
    )
    configureFinalizer(ensureTopic)
    const bootstrap = runFreshChatBootstrap()

    renderGate()

    const loading = screen.getByTestId('startup-readiness-loading')
    expect(loading).toHaveAttribute('aria-busy', 'true')
    expect(loading.querySelector('.ant-spin')).toBeNull()
    expect(screen.getByRole('img', { name: APP_NAME })).toHaveAttribute('src', AppLogo)
    expect(screen.getByRole('heading', { name: APP_NAME })).toBeVisible()
    expect(screen.getByText('startup.readiness.loading')).toBeVisible()
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    await waitFor(() => expect(ensureTopic).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY)).not.toBeNull()

    resolveEnsure()
    await act(async () => {
      await bootstrap
    })

    expect(screen.getByTestId('ordinary-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('startup-readiness-loading')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: APP_NAME })).not.toBeInTheDocument()
    expect(localStorage.getItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY)).toBeNull()
  })

  it('shows a localized error and retries successfully in the same session', async () => {
    markFreshBootstrapPendingIfFreshProfile()
    let resolveRetry!: () => void
    const ensureTopic = vi
      .fn()
      .mockRejectedValueOnce(new Error('ensureTopic IPC failed'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRetry = resolve
          })
      )
    configureFinalizer(ensureTopic)
    await act(async () => {
      await expect(runFreshChatBootstrap()).rejects.toThrow('ensureTopic IPC failed')
    })

    renderGate()

    expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument()
    expect(screen.getByText('startup.readiness.error.title')).toBeInTheDocument()
    expect(screen.getByText('startup.readiness.error.description')).toBeInTheDocument()
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    expect(localStorage.getItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY)).not.toBeNull()

    fireEvent.click(screen.getByTestId('startup-readiness-retry'))

    const retryPending = await screen.findByTestId('startup-readiness-loading')
    expect(retryPending.querySelector('.ant-spin')).toBeNull()
    expect(screen.queryByTestId('startup-readiness-error')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ordinary-tree')).not.toBeInTheDocument()
    await waitFor(() => expect(ensureTopic).toHaveBeenCalledTimes(2))

    resolveRetry()

    expect(await screen.findByTestId('ordinary-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('startup-readiness-error')).not.toBeInTheDocument()
    expect(ensureTopic).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY)).toBeNull()
  })
})
