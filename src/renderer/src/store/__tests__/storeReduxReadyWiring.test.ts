/**
 * Direct coverage for the `store/index.ts` rehydration callback: Main must be
 * notified as soon as the store is selectable, and fresh-profile topic
 * bootstrapping must use the real store/persistor lifecycle independently of
 * that notification.
 *
 * The tests import the real store module (real reducers, real redux-persist,
 * real rehydration). Only the SQLite topic-ensure module is mocked so the
 * fresh-boot outcome is deterministic and no real IPC bridge is touched.
 */

import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnsureOrdinaryTopicOwnership } = vi.hoisted(() => ({
  mockEnsureOrdinaryTopicOwnership: vi.fn()
}))

vi.mock('../../services/db/topicTrashLifecycle', () => ({
  ensureOrdinaryTopicOwnership: (...args: unknown[]) => mockEnsureOrdinaryTopicOwnership(...args)
}))

const EXISTING_PERSIST_SENTINEL = '{"_persist":{"version":225,"rehydrated":true}}'
const FRESH_BOOTSTRAP_PENDING_KEY = 'cherry-chat:fresh-bootstrap-pending'

/**
 * Installs a fresh per-test localStorage identity on both the Node global
 * and the jsdom window (redux-persist binds `self.localStorage` when its
 * storage module evaluates inside the store import below).
 */
function installFreshLocalStorage(): void {
  const backing = new Map<string, string>()
  const mock = {
    getItem: (key: string): string | null => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      backing.set(key, String(value))
    },
    removeItem: (key: string): void => {
      backing.delete(key)
    },
    clear: (): void => {
      backing.clear()
    },
    key: (index: number): string | null => [...backing.keys()][index] ?? null,
    get length(): number {
      return backing.size
    }
  }
  vi.stubGlobal('localStorage', mock)
  try {
    Object.defineProperty(window, 'localStorage', { value: mock, configurable: true, writable: true })
  } catch {}
}

describe('store/index.ts rehydration callback wiring', () => {
  let invokeSpy: ReturnType<typeof vi.fn>
  let createdPersistors: Array<{ pause: () => void }> = []

  function trackStoreModule<T extends { persistor: { pause: () => void } }>(storeModule: T): T {
    createdPersistors.push(storeModule.persistor)
    return storeModule
  }

  beforeEach(() => {
    vi.resetModules()
    // Per-test storage identity: redux-persist captures `self.localStorage`
    // at its module evaluation, so prior persistors cannot write into this
    // test's fresh-profile capture window.
    installFreshLocalStorage()
    mockEnsureOrdinaryTopicOwnership.mockReset()
    mockEnsureOrdinaryTopicOwnership.mockResolvedValue(undefined)
    ;(window.api as { getAppInfo?: unknown }).getAppInfo = vi.fn().mockResolvedValue({ notesPath: '/mock/notes' })
    invokeSpy = vi.mocked(window.electron.ipcRenderer.invoke)
    invokeSpy.mockClear()
  })

  afterEach(() => {
    // Stop prior store instances so their throttled writes cannot land in the
    // next test's storage between reset and the fresh-profile capture.
    for (const persistor of createdPersistors) {
      try {
        persistor.pause()
      } catch {}
    }
    createdPersistors = []
    localStorage.clear()
  })

  it('notifies Main once at rehydration and bootstraps the real persistor', async () => {
    const storeModule = trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith(IpcChannel.ReduxStoreReady)
    })
    expect(storeModule.persistor.getState().bootstrapped).toBe(true)
    expect(invokeSpy).toHaveBeenCalledTimes(1)
  })

  it('fresh profile ensures the initial topic and clears the marker', async () => {
    expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).toBeNull()

    trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).toBeNull()
    })
    const { getFreshChatBootstrapReadinessState } = await import('../../services/freshChatBootstrap')
    expect(getFreshChatBootstrapReadinessState()).toBe('ready')
    const firstCall = mockEnsureOrdinaryTopicOwnership.mock.calls[0] as [string, string, unknown]
    expect(typeof firstCall[0]).toBe('string')
    expect(firstCall[0].length).toBeGreaterThan(0)
    expect(firstCall[1]).toBe('default')
  })

  it('notifies Main once while fresh ensure is still pending', async () => {
    let resolveEnsure!: () => void
    mockEnsureOrdinaryTopicOwnership.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEnsure = resolve
        })
    )

    trackStoreModule(await import('../index'))

    await vi.waitFor(() => expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalledTimes(1))
    const { getFreshChatBootstrapReadinessState } = await import('../../services/freshChatBootstrap')
    expect(getFreshChatBootstrapReadinessState()).toBe('pending')
    expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).not.toBeNull()
    expect(invokeSpy).toHaveBeenCalledExactlyOnceWith(IpcChannel.ReduxStoreReady)

    resolveEnsure()
    await vi.waitFor(() => expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).toBeNull())
    expect(getFreshChatBootstrapReadinessState()).toBe('ready')
    expect(invokeSpy).toHaveBeenCalledTimes(1)
  })

  it('existing persist profile is ready immediately and never ensures or marks', async () => {
    localStorage.setItem('persist:cherry-studio', EXISTING_PERSIST_SENTINEL)

    trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith(IpcChannel.ReduxStoreReady)
    })
    const { getFreshChatBootstrapReadinessState } = await import('../../services/freshChatBootstrap')
    expect(getFreshChatBootstrapReadinessState()).toBe('ready')
    expect(mockEnsureOrdinaryTopicOwnership).not.toHaveBeenCalled()
    expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).toBeNull()
  })

  it('ensure failure exposes failed readiness and retains the marker while Main is notified once', async () => {
    mockEnsureOrdinaryTopicOwnership.mockRejectedValue(new Error('ensureTopic IPC failed'))

    trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalled()
    })
    const { getFreshChatBootstrapReadinessState } = await import('../../services/freshChatBootstrap')
    await vi.waitFor(() => expect(getFreshChatBootstrapReadinessState()).toBe('failed'))
    expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).not.toBeNull()
    expect(invokeSpy).toHaveBeenCalledExactlyOnceWith(IpcChannel.ReduxStoreReady)
  })

  it('in-session retry ensures SQLite topics, clears the marker, and does not renotify Main', async () => {
    mockEnsureOrdinaryTopicOwnership
      .mockRejectedValueOnce(new Error('ensureTopic IPC failed'))
      .mockResolvedValue(undefined)

    trackStoreModule(await import('../index'))

    const { getFreshChatBootstrapReadinessState, runFreshChatBootstrap } = await import(
      '../../services/freshChatBootstrap'
    )
    await vi.waitFor(() => expect(getFreshChatBootstrapReadinessState()).toBe('failed'))
    expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).not.toBeNull()

    await expect(runFreshChatBootstrap()).resolves.toBe('ensured')
    expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).toBeNull()
    expect(getFreshChatBootstrapReadinessState()).toBe('ready')
    expect(invokeSpy).toHaveBeenCalledExactlyOnceWith(IpcChannel.ReduxStoreReady)
  })

  it('relaunch with persist present and a retained marker retries the ensure', async () => {
    mockEnsureOrdinaryTopicOwnership.mockRejectedValue(new Error('ensureTopic IPC failed'))
    const firstModule = trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalled()
    })
    const { getFreshChatBootstrapReadinessState } = await import('../../services/freshChatBootstrap')
    await vi.waitFor(() => expect(getFreshChatBootstrapReadinessState()).toBe('failed'))
    expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).not.toBeNull()
    try {
      firstModule.persistor.pause()
    } catch {}

    // Same profile store plus the retained marker on the next renderer boot.
    localStorage.setItem('persist:cherry-studio', EXISTING_PERSIST_SENTINEL)
    invokeSpy.mockClear()
    mockEnsureOrdinaryTopicOwnership.mockReset()
    mockEnsureOrdinaryTopicOwnership.mockResolvedValue(undefined)
    vi.resetModules()

    trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(localStorage.getItem(FRESH_BOOTSTRAP_PENDING_KEY)).toBeNull()
    })
    expect(invokeSpy).toHaveBeenCalledWith(IpcChannel.ReduxStoreReady)

    const { getFreshChatBootstrapReadinessState: getRelaunchedReadiness } = await import(
      '../../services/freshChatBootstrap'
    )
    expect(getRelaunchedReadiness()).toBe('ready')
    expect(invokeSpy).toHaveBeenCalledTimes(1)
  })
})
