/**
 * Direct test for the `store/index.ts` persistStore rehydration callback
 * wiring (LOCK-003).
 *
 * The accepted audit gap: the readiness repair changed the real persistStore
 * callback to invoke ReduxStoreReady via `runReduxStoreBoot` IMMEDIATELY at
 * rehydration — before and independently of the one-shot L2 navigation
 * projection. The `runReduxStoreBoot` seam is unit-tested in
 * `services/__tests__/importProjectionReadiness.test.ts`, but the ACTUAL
 * `store/index.ts` wiring (that the real callback fires the notification
 * through the real preload invoke, wiring the projection apply to the real
 * store dispatch + persistor flush) had no direct coverage.
 *
 * These tests import the real store module (real reducers, real
 * redux-persist, real rehydration) with ONLY the projection apply module
 * mocked to a controllable deferred — the smallest seam that keeps the
 * production callback honest without touching the real cherryImport IPC
 * bridge.
 *
 * Regression contract: if `notifyMain` is ever moved back behind the
 * projection apply (the pre-fix ordering), the deferred-apply test below
 * fails because ReduxStoreReady would not fire until the apply settles.
 */

import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApplyProjection, mockEnsureOrdinaryTopicOwnership } = vi.hoisted(() => ({
  mockApplyProjection: vi.fn(),
  mockEnsureOrdinaryTopicOwnership: vi.fn()
}))

// The store module statically imports `applyPendingImportProjection` from
// '../services/importProjection'. Mock that module (resolved to the same
// absolute file from this __tests__ directory) so each test controls the
// projection outcome deterministically.
vi.mock('../../services/importProjection', () => ({
  applyPendingImportProjection: (...args: unknown[]) => mockApplyProjection(...args)
}))

// The fresh-boot ensure reaches SQLite through a dynamic import of
// `../services/db/topicTrashLifecycle`. Mock it so wiring tests never touch
// the real IPC bridge; each test controls ensure success/failure.
vi.mock('../../services/db/topicTrashLifecycle', () => ({
  ensureOrdinaryTopicOwnership: (...args: unknown[]) => mockEnsureOrdinaryTopicOwnership(...args)
}))

const EXISTING_PERSIST_SENTINEL = '{"_persist":{"version":225,"rehydrated":true}}'

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

describe('store/index.ts persistStore callback wiring (LOCK-003)', () => {
  let invokeSpy: ReturnType<typeof vi.fn>
  let createdPersistors: Array<{ pause: () => void }> = []

  function trackStoreModule<T extends { persistor: { pause: () => void } }>(storeModule: T): T {
    createdPersistors.push(storeModule.persistor)
    return storeModule
  }

  beforeEach(() => {
    vi.resetModules()
    // Per-test storage identity: redux-persist captures `self.localStorage`
    // at ITS module evaluation (inside the store import below), so each test
    // installs a fresh map first. Prior tests' persistors keep writing to
    // their own maps and can never land in this test's fresh-profile capture
    // window during the async store module evaluation.
    installFreshLocalStorage()
    mockApplyProjection.mockReset()
    mockEnsureOrdinaryTopicOwnership.mockReset()
    mockEnsureOrdinaryTopicOwnership.mockResolvedValue(undefined)
    ;(window.api as { getAppInfo?: unknown }).getAppInfo = vi.fn().mockResolvedValue({ notesPath: '/mock/notes' })
    // The renderer setup stubs `window.electron.ipcRenderer.invoke`; spy on
    // the same fn so the real callback's invoke is observable per test.
    invokeSpy = vi.mocked(window.electron.ipcRenderer.invoke)
    invokeSpy.mockClear()
  })

  afterEach(() => {
    // Stop prior store instances' persistors so their throttled writes cannot
    // land between the next test's localStorage.clear() and its fresh-profile
    // capture during the async store module evaluation window.
    for (const persistor of createdPersistors) {
      try {
        persistor.pause()
      } catch {}
    }
    createdPersistors = []
    localStorage.clear()
  })

  it('fires ReduxStoreReady at rehydration — before the projection apply settles (LOCK-003)', async () => {
    let resolveApply!: (value: boolean) => void
    mockApplyProjection.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveApply = resolve
        })
    )

    // Import the REAL store module — rehydration runs on its own.
    trackStoreModule(await import('../index'))

    // The notification must fire while the projection apply is still pending.
    await vi.waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith(IpcChannel.ReduxStoreReady)
    })

    // The apply was wired with the store deps but its promise is unresolved —
    // the notify already happened, so it is NOT gated on projection.
    expect(mockApplyProjection).toHaveBeenCalledTimes(1)

    // The ordinary chat tree gate stays pending while the apply is deferred.
    const { getImportProjectionReadinessState } = await import('../../services/importProjectionReadiness')
    expect(getImportProjectionReadinessState()).toBe('pending')

    // Complete the projection: the gate settles ready.
    resolveApply(false)
    await vi.waitFor(() => {
      expect(getImportProjectionReadinessState()).toBe('ready')
    })
    expect(invokeSpy).toHaveBeenCalledTimes(1)
  })

  it('wires the projection apply with the real store dispatch and persistor flush', async () => {
    mockApplyProjection.mockResolvedValue(false)
    const storeModule = trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(mockApplyProjection).toHaveBeenCalled()
    })

    // The callback passes the REAL store.dispatch and handleSaveData flush —
    // a no-op action goes through the real middleware and the flush resolves.
    const deps = mockApplyProjection.mock.calls[0][0] as {
      dispatch: (action: { type: string }) => unknown
      flush: () => Promise<void>
    }
    expect(() => deps.dispatch({ type: '@@storeReduxReadyWiring/noop' })).not.toThrow()
    await expect(deps.flush()).resolves.toBeUndefined()

    // Rehydration really completed — the real persistor is bootstrapped.
    expect(storeModule.persistor.getState().bootstrapped).toBe(true)
  })

  it('still fires ReduxStoreReady when the projection apply fails — notify independent of outcome', async () => {
    mockApplyProjection.mockRejectedValue(new Error('Navigation projection read failed'))
    trackStoreModule(await import('../index'))

    await vi.waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith(IpcChannel.ReduxStoreReady)
    })

    // The boot settles the gate to failed (tree stays gated) but the notify
    // already fired independently (LOCK-003).
    const { getImportProjectionReadinessState } = await import('../../services/importProjectionReadiness')
    await vi.waitFor(() => {
      expect(getImportProjectionReadinessState()).toBe('failed')
    })
    expect(invokeSpy).toHaveBeenCalledTimes(1)
  })

  it('fresh profile with verified no-pending ensures the initial topic and clears the marker', async () => {
    // Fresh per-test storage => truly-fresh profile, no marker yet.
    expect(localStorage.getItem('cherry-chat:fresh-bootstrap-pending')).toBeNull()
    mockApplyProjection.mockResolvedValue(false)
    trackStoreModule(await import('../index'))

    const { getImportProjectionReadinessState } = await import('../../services/importProjectionReadiness')
    await vi.waitFor(() => {
      expect(getImportProjectionReadinessState()).toBe('ready')
    })
    expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalled()
    const firstCall = mockEnsureOrdinaryTopicOwnership.mock.calls[0] as [string, string, unknown]
    expect(typeof firstCall[0]).toBe('string')
    expect(firstCall[0].length).toBeGreaterThan(0)
    expect(firstCall[1]).toBe('default')
    // Finalize cleared the durable marker (applied-false + ensured).
    expect(localStorage.getItem('cherry-chat:fresh-bootstrap-pending')).toBeNull()
  })

  it('applied import clears the marker without ensuring', async () => {
    mockApplyProjection.mockResolvedValue(true)
    trackStoreModule(await import('../index'))

    const { getImportProjectionReadinessState } = await import('../../services/importProjectionReadiness')
    await vi.waitFor(() => {
      expect(getImportProjectionReadinessState()).toBe('ready')
    })
    expect(mockEnsureOrdinaryTopicOwnership).not.toHaveBeenCalled()
    expect(localStorage.getItem('cherry-chat:fresh-bootstrap-pending')).toBeNull()
  })

  it('existing persist profile with no marker never ensures and never marks', async () => {
    localStorage.setItem('persist:cherry-studio', EXISTING_PERSIST_SENTINEL)
    mockApplyProjection.mockResolvedValue(false)
    trackStoreModule(await import('../index'))

    const { getImportProjectionReadinessState } = await import('../../services/importProjectionReadiness')
    await vi.waitFor(() => {
      expect(getImportProjectionReadinessState()).toBe('ready')
    })
    expect(mockEnsureOrdinaryTopicOwnership).not.toHaveBeenCalled()
    expect(localStorage.getItem('cherry-chat:fresh-bootstrap-pending')).toBeNull()
  })

  it('fresh ensure failure keeps the tree gated and retains the marker', async () => {
    mockApplyProjection.mockResolvedValue(false)
    mockEnsureOrdinaryTopicOwnership.mockRejectedValue(new Error('ensureTopic IPC failed'))
    trackStoreModule(await import('../index'))

    const { getImportProjectionReadinessState } = await import('../../services/importProjectionReadiness')
    await vi.waitFor(() => {
      expect(getImportProjectionReadinessState()).toBe('failed')
    })
    expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalled()
    // Marker retained for next-boot/retry — not cleared on failure.
    expect(localStorage.getItem('cherry-chat:fresh-bootstrap-pending')).not.toBeNull()
    // Notify still fired independently of the gated tree.
    expect(invokeSpy).toHaveBeenCalledWith(IpcChannel.ReduxStoreReady)
  })

  it('simulated relaunch with persist present + marker pending retries the ensure', async () => {
    // First boot: fresh profile, verified no-pending, ensure fails.
    mockApplyProjection.mockResolvedValue(false)
    mockEnsureOrdinaryTopicOwnership.mockRejectedValue(new Error('ensureTopic IPC failed'))
    const firstModule = trackStoreModule(await import('../index'))
    try {
      firstModule.persistor.pause()
    } catch {}
    const { getImportProjectionReadinessState: getStateAfterFirst } = await import(
      '../../services/importProjectionReadiness'
    )
    await vi.waitFor(() => {
      expect(getStateAfterFirst()).toBe('failed')
    })
    expect(localStorage.getItem('cherry-chat:fresh-bootstrap-pending')).not.toBeNull()

    // Relaunch: same storage now has the persist payload AND the retained
    // marker. Fresh module instances must retry the ensure and clear it.
    mockEnsureOrdinaryTopicOwnership.mockResolvedValue(undefined)
    vi.resetModules()
    trackStoreModule(await import('../index'))
    const { getImportProjectionReadinessState } = await import('../../services/importProjectionReadiness')
    await vi.waitFor(() => {
      expect(getImportProjectionReadinessState()).toBe('ready')
    })
    expect(mockEnsureOrdinaryTopicOwnership).toHaveBeenCalled()
    expect(localStorage.getItem('cherry-chat:fresh-bootstrap-pending')).toBeNull()
  })
})
