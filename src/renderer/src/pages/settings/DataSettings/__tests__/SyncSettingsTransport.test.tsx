/**
 * Sync Settings transport presentation regression.
 *
 * HTTP and HTTPS endpoints are accepted identically: no Alert/banner and no
 * encryption-warning prose is rendered for any endpoint (loopback or
 * non-loopback, http or https). Editing the endpoint still autosaves via
 * the existing setConfig contract.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' })
}))

function mockSyncApi(endpoint: string): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getConfig: vi.fn(async () => ({ endpoint, enabled: true })),
    setConfig: vi.fn(async (cfg: unknown) => cfg),
    getStatus: vi.fn(async () => ({
      enabled: true,
      endpoint,
      lastSyncAt: null,
      lastError: null,
      lastCaptureError: null,
      pendingCount: 0,
      cursor: 0,
      syncing: false,
      conflictCount: 0
    })),
    getServiceStatus: vi.fn(async () => ({ state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false })),
    getPairState: vi.fn(async () => ({ deviceCode: 'ABCD2345', state: 'paired', outgoing: null, incoming: [] }))
  }
  Object.defineProperty(window, 'api', { value: { sync: api }, configurable: true, writable: true })
  Object.defineProperty(window, 'toast', {
    value: { success: vi.fn(), error: vi.fn() },
    configurable: true,
    writable: true
  })
  return api
}

async function renderWithEndpoint(endpoint: string): Promise<Record<string, ReturnType<typeof vi.fn>>> {
  const api = mockSyncApi(endpoint)
  const { default: SyncSettings } = await import('../SyncSettings')
  render(<SyncSettings />)
  await waitFor(() => {
    expect(screen.getByTestId('sync-endpoint-input')).toHaveValue(endpoint)
  })
  return api
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.resetModules()
})

describe('SyncSettings transport presentation', () => {
  it.each(['http://192.168.1.10:3030', 'http://127.0.0.1:3030', 'https://192.168.1.10:3030', 'http:example.com'])(
    'renders no HTTP banner for %s',
    async (endpoint) => {
      await renderWithEndpoint(endpoint)
      expect(screen.queryByTestId('sync-http-warning')).toBeNull()
      expect(document.body.innerHTML).not.toMatch(/unencrypted HTTP/i)
    }
  )

  it('keeps endpoint editing and autosave functional without a banner', async () => {
    const api = await renderWithEndpoint('http://192.168.1.10:3030')
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http://192.168.1.11:3030' }
    })
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledWith({
        endpoint: 'http://192.168.1.11:3030',
        enabled: true
      })
    })
    expect(screen.queryByTestId('sync-http-warning')).toBeNull()
  })
})
