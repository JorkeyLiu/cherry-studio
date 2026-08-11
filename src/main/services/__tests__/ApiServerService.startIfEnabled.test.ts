/**
 * ApiServerService.startIfEnabled (LOCK-005 startup auto-start) tests.
 *
 * Auto-start must: (1) await Redux readiness with NO fixed timeout before
 * querying the API config — so a slow renderer/projection can no longer
 * force the disabled fallback for the whole run; (2) load the real config
 * only after readiness; (3) start only when `config.enabled` is true; and
 * (4) remain fire-and-forget relative to global startup (the caller logs
 * rejections, the helper never silently swallows a start failure).
 */

import type { ApiServerConfig } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockWaitForReady,
  mockConfigGet,
  mockApiServerStart,
  mockApiServerStop,
  mockApiServerRestart,
  mockApiServerIsRunning
} = vi.hoisted(() => ({
  mockWaitForReady: vi.fn(),
  mockConfigGet: vi.fn(),
  mockApiServerStart: vi.fn(),
  mockApiServerStop: vi.fn(),
  mockApiServerRestart: vi.fn(),
  mockApiServerIsRunning: vi.fn()
}))

vi.mock('@main/services/ReduxService', () => ({
  reduxService: {
    waitForReady: mockWaitForReady
  }
}))

vi.mock('@main/apiServer', () => ({
  apiServer: {
    start: mockApiServerStart,
    stop: mockApiServerStop,
    restart: mockApiServerRestart,
    isRunning: mockApiServerIsRunning
  }
}))

vi.mock('@main/apiServer/config', () => ({
  config: {
    get: mockConfigGet
  }
}))

const enabledConfig: ApiServerConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 4242,
  apiKey: 'cs-sk-test'
}

describe('ApiServerService.startIfEnabled (LOCK-005 startup auto-start)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('awaits Redux readiness before loading the API config — nothing runs before ready', async () => {
    const { apiServerService } = await import('../ApiServerService')
    let resolveReady!: () => void
    mockWaitForReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve
      })
    )
    mockConfigGet.mockResolvedValue(enabledConfig)
    mockApiServerStart.mockResolvedValue(undefined)

    const autoStart = apiServerService.startIfEnabled()

    // Readiness is unresolved — the config must NOT be queried and the
    // server must NOT start while the rehydrated store is not yet selectable.
    await Promise.resolve()
    await Promise.resolve()
    expect(mockConfigGet).not.toHaveBeenCalled()
    expect(mockApiServerStart).not.toHaveBeenCalled()

    resolveReady()
    await autoStart
    expect(mockConfigGet).toHaveBeenCalledTimes(1)
    expect(mockApiServerStart).toHaveBeenCalledTimes(1)
  })

  it('starts when the loaded config has enabled=true', async () => {
    const { apiServerService } = await import('../ApiServerService')
    mockWaitForReady.mockResolvedValue(undefined)
    mockConfigGet.mockResolvedValue(enabledConfig)
    mockApiServerStart.mockResolvedValue(undefined)

    await apiServerService.startIfEnabled()

    expect(mockConfigGet).toHaveBeenCalledTimes(1)
    expect(mockApiServerStart).toHaveBeenCalledTimes(1)
  })

  it('does NOT start when the loaded config has enabled=false', async () => {
    const { apiServerService } = await import('../ApiServerService')
    mockWaitForReady.mockResolvedValue(undefined)
    mockConfigGet.mockResolvedValue({ ...enabledConfig, enabled: false })

    await apiServerService.startIfEnabled()

    expect(mockConfigGet).toHaveBeenCalledTimes(1)
    expect(mockApiServerStart).not.toHaveBeenCalled()
  })

  it('propagates config load failure so the fire-and-forget caller can log it', async () => {
    const { apiServerService } = await import('../ApiServerService')
    mockWaitForReady.mockResolvedValue(undefined)
    mockConfigGet.mockRejectedValue(new Error('redux select failed'))

    await expect(apiServerService.startIfEnabled()).rejects.toThrow('redux select failed')
    expect(mockApiServerStart).not.toHaveBeenCalled()
  })

  it('propagates a realistic apiServer.start rejection so the fire-and-forget caller can log it', async () => {
    const { apiServerService } = await import('../ApiServerService')
    mockWaitForReady.mockResolvedValue(undefined)
    mockConfigGet.mockResolvedValue(enabledConfig)
    // A realistic runtime failure — the port is already in use.
    mockApiServerStart.mockRejectedValue(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4242'))

    await expect(apiServerService.startIfEnabled()).rejects.toThrow('EADDRINUSE')
    // The config was loaded and the start attempted — only then did it fail.
    expect(mockConfigGet).toHaveBeenCalledTimes(1)
    expect(mockApiServerStart).toHaveBeenCalledTimes(1)
  })
})
