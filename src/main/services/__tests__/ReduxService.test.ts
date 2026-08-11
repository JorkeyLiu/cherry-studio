import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCacheRemove, mockExecuteJavaScript, mockGetMainWindow, mockIpcHandlers } = vi.hoisted(() => {
  const mockCacheRemove = vi.fn()
  const mockExecuteJavaScript = vi.fn().mockResolvedValue(undefined)
  const mockGetMainWindow = vi.fn(() => ({
    webContents: {
      executeJavaScript: mockExecuteJavaScript
    }
  }))
  // ipcMain.handle records handlers instead of invoking them immediately so
  // each test controls when ReduxStoreReady is signaled.
  const mockIpcHandlers: Record<string, () => void> = {}
  return { mockCacheRemove, mockExecuteJavaScript, mockGetMainWindow, mockIpcHandlers }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: () => void) => {
      mockIpcHandlers[channel] = handler
    })
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('../CacheService', () => ({
  CacheService: {
    remove: (...args: unknown[]) => mockCacheRemove(...args)
  }
}))

vi.mock('../WindowService', () => ({
  windowService: {
    getMainWindow: () => mockGetMainWindow()
  }
}))

import { invalidateApiServerProvidersCacheForAction } from '../ReduxService'

/** Signal ReduxStoreReady (LOCK-003: rehydrated store is safely selectable). */
const signalReduxStoreReady = (): void => {
  mockIpcHandlers[IpcChannel.ReduxStoreReady]?.()
}

describe('ReduxService provider cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('clears the API server provider cache for provider mutations', async () => {
    const { reduxService } = await import('../ReduxService')
    signalReduxStoreReady()
    await reduxService.dispatch({ type: 'llm/updateProvider', payload: { id: 'openai', apiKey: 'new-key' } })

    expect(mockExecuteJavaScript).toHaveBeenCalled()
    expect(mockCacheRemove).toHaveBeenCalledWith('api-server:providers')
  })

  it('does not clear the API server provider cache for unrelated actions', () => {
    invalidateApiServerProvidersCacheForAction('llm/setDefaultModel')

    expect(mockCacheRemove).not.toHaveBeenCalled()
  })
})

describe('ReduxService readiness wait (LOCK-003/LOCK-005)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waitForReady has no fixed timeout and resolves when ReduxStoreReady is signaled', async () => {
    const { reduxService } = await import('../ReduxService')
    let settled = false
    const ready = reduxService.waitForReady().then(() => {
      settled = true
    })

    // Unresolved readiness must not resolve even far beyond the ordinary
    // STORE_READY_TIMEOUT bound (LOCK-005: startup wait has no arbitrary
    // timeout).
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(120000)
    expect(settled).toBe(false)

    signalReduxStoreReady()
    await ready
    expect(settled).toBe(true)
  })

  it('waitForReady is idempotent — later callers resolve immediately', async () => {
    const { reduxService } = await import('../ReduxService')
    signalReduxStoreReady()
    await expect(reduxService.waitForReady()).resolves.toBeUndefined()
    await expect(reduxService.waitForReady()).resolves.toBeUndefined()
  })

  it('normal select() still fails bounded by STORE_READY_TIMEOUT when ReduxStoreReady never arrives (LOCK-002)', async () => {
    vi.useFakeTimers()
    const { reduxService } = await import('../ReduxService')

    const selectPromise = reduxService.select('state.settings')

    // Within the bounded wait: still pending.
    let settled = false
    selectPromise
      .then(() => {
        settled = true
      })
      .catch(() => {
        settled = true
      })
    await vi.advanceTimersByTimeAsync(9000)
    expect(settled).toBe(false)

    // Past the 10s bound: the ordinary select path fails bounded (LOCK-002).
    await vi.advanceTimersByTimeAsync(1001)
    await expect(selectPromise).rejects.toThrow('Timeout waiting for Redux store to be ready')
  })
})
