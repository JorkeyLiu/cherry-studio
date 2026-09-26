import { describe, expect, it, vi } from 'vitest'

import type * as ModelMetadataModule from '../modelMetadata'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }
}))

const { mockRetry } = vi.hoisted(() => ({ mockRetry: vi.fn() }))

vi.mock('../modelMetadata', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelMetadataModule>()
  return { ...actual, retryModelMetadataAfterProxyApplied: mockRetry }
})

import { applyProxyAndRetryModelMetadata } from '../proxyMetadataRetry'

describe('applyProxyAndRetryModelMetadata — proxy apply then one bounded retry', () => {
  it('retries once after the App_Proxy promise resolves', async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined)
    ;(window as any).api = { ...(window as any).api, setProxy }
    mockRetry.mockClear()
    mockRetry.mockResolvedValue(null)
    try {
      await applyProxyAndRetryModelMetadata({ proxyMode: 'none' })
      expect(setProxy).toHaveBeenCalledTimes(1)
      expect(setProxy).toHaveBeenCalledWith('', undefined)
      expect(mockRetry).toHaveBeenCalledTimes(1)
    } finally {
      delete (window as any).api.setProxy
    }
  })

  it('passes system and custom proxy args through', async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined)
    ;(window as any).api = { ...(window as any).api, setProxy }
    mockRetry.mockClear()
    mockRetry.mockResolvedValue(null)
    try {
      await applyProxyAndRetryModelMetadata({ proxyMode: 'system' })
      expect(setProxy).toHaveBeenCalledWith('system', undefined)

      setProxy.mockClear()
      mockRetry.mockClear()
      await applyProxyAndRetryModelMetadata({
        proxyMode: 'custom',
        proxyUrl: 'http://proxy.example:8080',
        proxyBypassRules: '<local>'
      })
      expect(setProxy).toHaveBeenCalledWith('http://proxy.example:8080', '<local>')
      expect(mockRetry).toHaveBeenCalledTimes(1)
    } finally {
      delete (window as any).api.setProxy
    }
  })

  it('skips the retry when setProxy rejects (best-effort)', async () => {
    const setProxy = vi.fn().mockRejectedValue(new Error('proxy down'))
    ;(window as any).api = { ...(window as any).api, setProxy }
    mockRetry.mockClear()
    try {
      await applyProxyAndRetryModelMetadata({ proxyMode: 'system' })
      expect(setProxy).toHaveBeenCalledTimes(1)
      expect(mockRetry).not.toHaveBeenCalled()
    } finally {
      delete (window as any).api.setProxy
    }
  })

  it('skips both setProxy and retry for custom mode without a URL', async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined)
    ;(window as any).api = { ...(window as any).api, setProxy }
    mockRetry.mockClear()
    try {
      await applyProxyAndRetryModelMetadata({ proxyMode: 'custom', proxyUrl: '' })
      expect(setProxy).not.toHaveBeenCalled()
      expect(mockRetry).not.toHaveBeenCalled()
    } finally {
      delete (window as any).api.setProxy
    }
  })
})
