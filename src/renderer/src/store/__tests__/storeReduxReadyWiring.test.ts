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
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApplyProjection } = vi.hoisted(() => ({
  mockApplyProjection: vi.fn()
}))

// The store module statically imports `applyPendingImportProjection` from
// '../services/importProjection'. Mock that module (resolved to the same
// absolute file from this __tests__ directory) so each test controls the
// projection outcome deterministically.
vi.mock('../../services/importProjection', () => ({
  applyPendingImportProjection: (...args: unknown[]) => mockApplyProjection(...args)
}))

describe('store/index.ts persistStore callback wiring (LOCK-003)', () => {
  let invokeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    mockApplyProjection.mockReset()
    ;(window.api as { getAppInfo?: unknown }).getAppInfo = vi.fn().mockResolvedValue({ notesPath: '/mock/notes' })
    // The renderer setup stubs `window.electron.ipcRenderer.invoke`; spy on
    // the same fn so the real callback's invoke is observable per test.
    invokeSpy = vi.mocked(window.electron.ipcRenderer.invoke)
    invokeSpy.mockClear()
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
    await import('../index')

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
    const storeModule = await import('../index')

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
    await import('../index')

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
})
