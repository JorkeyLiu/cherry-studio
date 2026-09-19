import { useModelMetadataStatus } from '@renderer/hooks/useModelMetadataStatus'
import {
  initModelMetadataRegistry,
  setModelMetadataSnapshotForTests,
  setModelMetadataStatusForTests
} from '@renderer/services/modelMetadata'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }
}))

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  models: {
    'anthropic/claude-sonnet-4-6': { id: 'anthropic/claude-sonnet-4-6', modalities: { input: [], output: [] } }
  },
  providers: {
    anthropic: { api: '', name: 'Anthropic' }
  }
}

describe('useModelMetadataStatus', () => {
  beforeEach(() => {
    setModelMetadataSnapshotForTests(null)
    vi.clearAllMocks()
  })

  it('reads the loading status with a stable reference across rerenders', () => {
    const { result, rerender } = renderHook(() => useModelMetadataStatus())
    expect(result.current).toEqual({ kind: 'loading', snapshot: null })
    const first = result.current
    rerender()
    // useSyncExternalStore returns the cached reference: no fresh objects
    expect(result.current).toBe(first)
  })

  it('re-renders an open subscriber when the async init round completes', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot } }
    try {
      const { result } = renderHook(() => useModelMetadataStatus())
      expect(result.current.kind).toBe('loading')

      await act(async () => {
        await initModelMetadataRegistry()
      })

      expect(result.current.kind).toBe('ready')
      expect(result.current.snapshot).toEqual(SNAPSHOT)
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('re-renders through all three empty states without remounting', () => {
    const { result, rerender } = renderHook(() => useModelMetadataStatus())
    expect(result.current.kind).toBe('loading')

    act(() => {
      setModelMetadataStatusForTests({ kind: 'unavailable', snapshot: null, reason: 'timeout' })
    })
    expect(result.current).toEqual({ kind: 'unavailable', snapshot: null, reason: 'timeout' })

    act(() => {
      setModelMetadataSnapshotForTests(SNAPSHOT)
    })
    expect(result.current.kind).toBe('ready')

    rerender()
    expect(result.current.kind).toBe('ready')
  })
})
