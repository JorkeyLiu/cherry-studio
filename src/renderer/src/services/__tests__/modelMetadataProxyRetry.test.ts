import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }
}))

import {
  getModelMetadataStatus,
  initModelMetadataRegistry,
  retryModelMetadataAfterProxyApplied,
  setModelMetadataSnapshotForTests,
  subscribeModelMetadataStatus
} from '../modelMetadata'

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  models: {
    'moonshotai/kimi-k3': {
      id: 'moonshotai/kimi-k3',
      modalities: { input: ['text'], output: ['text'] },
      reasoning: true
    }
  },
  providers: {
    openai: { api: '', name: 'OpenAI' }
  }
}

function setSurface(surface: Record<string, unknown>): void {
  ;(window as any).api = { ...(window as any).api, modelMetadata: surface }
}

function clearSurface(): void {
  try {
    delete (window as any).api.modelMetadata
  } catch {}
  setModelMetadataSnapshotForTests(null)
}

describe('retryModelMetadataAfterProxyApplied — bounded post-proxy recovery', () => {
  it('retries once after a cold first-load failure and reaches ready', async () => {
    // Cold boot before proxy: Main reports a completed failure, no snapshot.
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
      .mockResolvedValue({ kind: 'ready', snapshot: SNAPSHOT })
    const getSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
    const refresh = vi.fn().mockResolvedValue({ ok: true, fetchedAt: 1_000_000 })
    setSurface({ getSnapshot, getStatus, refresh })
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toBeNull()
      expect(getModelMetadataStatus().kind).toBe('unavailable')

      const kinds: string[] = []
      const unsubscribe = subscribeModelMetadataStatus(() => {
        kinds.push(getModelMetadataStatus().kind)
      })
      try {
        // Proxy is now applied (App_Proxy resolved): one bounded retry.
        await expect(retryModelMetadataAfterProxyApplied()).resolves.toEqual(SNAPSHOT)
      } finally {
        unsubscribe()
      }

      expect(refresh).toHaveBeenCalledTimes(1)
      expect(getModelMetadataStatus().kind).toBe('ready')
      expect(getModelMetadataStatus().snapshot).toEqual(SNAPSHOT)
      // An open subscriber (e.g. Edit Model modal) re-renders on the transition.
      expect(kinds[kinds.length - 1]).toBe('ready')
    } finally {
      clearSurface()
    }
  })

  it('does not force a refresh when a cached snapshot is already ready', async () => {
    const getStatus = vi.fn().mockResolvedValue({ kind: 'ready', snapshot: SNAPSHOT })
    const getSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
    const refresh = vi.fn().mockResolvedValue({ ok: true, fetchedAt: 1_000_000 })
    setSurface({ getSnapshot, getStatus, refresh })
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toEqual(SNAPSHOT)
      expect(getModelMetadataStatus().kind).toBe('ready')

      // Reset call counts but keep implementations: the retry must not add network.
      getStatus.mockClear()
      getSnapshot.mockClear()
      refresh.mockClear()

      await expect(retryModelMetadataAfterProxyApplied()).resolves.toEqual(SNAPSHOT)
      expect(refresh).not.toHaveBeenCalled()
      expect(getStatus).not.toHaveBeenCalled()
      expect(getSnapshot).not.toHaveBeenCalled()
      expect(getModelMetadataStatus().kind).toBe('ready')
    } finally {
      clearSurface()
    }
  })

  it('awaits an in-flight initial fetch before the single conditional retry', async () => {
    const order: string[] = []
    let resolveFirstRead!: (value: null) => void
    const firstRead = new Promise<null>((resolve) => {
      resolveFirstRead = resolve
    })
    const getSnapshot = vi.fn().mockImplementation(() => {
      order.push('getSnapshot')
      if (getSnapshot.mock.calls.length === 1) return firstRead
      return Promise.resolve(SNAPSHOT)
    })
    const refresh = vi.fn().mockImplementation(() => {
      order.push('refresh')
      return Promise.resolve({ ok: true, fetchedAt: 1_000_000 })
    })
    // Compat surface (no getStatus): null read means a completed empty round.
    setSurface({ getSnapshot, refresh })
    try {
      setModelMetadataSnapshotForTests(null)
      const initStarted = initModelMetadataRegistry()
      // The proxy resolves while the first read is still in flight: the retry
      // must await that round instead of joining it as the retry itself.
      const retryStarted = retryModelMetadataAfterProxyApplied()
      expect(getSnapshot).toHaveBeenCalledTimes(1)

      resolveFirstRead(null)
      await expect(initStarted).resolves.toBeNull()
      await expect(retryStarted).resolves.toEqual(SNAPSHOT)

      // Exactly one refresh, and it ran after the first read completed.
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['getSnapshot', 'refresh', 'getSnapshot'])
      expect(getModelMetadataStatus().kind).toBe('ready')
    } finally {
      clearSurface()
    }
  })

  it('stays unavailable (best-effort) when the bounded retry also fails', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(null)
    const refresh = vi.fn().mockRejectedValue(new Error('still down'))
    setSurface({ getSnapshot, refresh })
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toBeNull()
      expect(getModelMetadataStatus().kind).toBe('unavailable')

      await expect(retryModelMetadataAfterProxyApplied()).resolves.toBeNull()
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(getModelMetadataStatus().kind).toBe('unavailable')
    } finally {
      clearSurface()
    }
  })

  it('never throws without a preload surface', async () => {
    try {
      delete (window as any).api?.modelMetadata
      setModelMetadataSnapshotForTests(null)
      await expect(retryModelMetadataAfterProxyApplied()).resolves.toBeNull()
    } finally {
      clearSurface()
    }
  })
})
