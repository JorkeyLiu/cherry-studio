/**
 * Sync Settings non-loopback HTTP warning contract.
 *
 * The endpoint policy accepts both http and https for loopback and
 * non-loopback hosts; a non-loopback `http://` endpoint must show a visible
 * non-blocking warning (save stays possible, no encryption is claimed).
 * Loopback HTTP and any HTTPS endpoint must not warn.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' })
}))

function mockSyncApi(endpoint: string): void {
  const api = {
    getConfig: vi.fn(async () => ({ endpoint, token: '', enabled: true })),
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
}

async function renderWithEndpoint(endpoint: string): Promise<void> {
  mockSyncApi(endpoint)
  const { default: SyncSettings } = await import('../SyncSettings')
  render(<SyncSettings />)
  await waitFor(() => {
    expect(screen.getByTestId('sync-endpoint-input')).toHaveValue(endpoint)
  })
}

describe('SyncSettings non-loopback HTTP warning', () => {
  it('shows a non-blocking warning for a non-loopback http endpoint', async () => {
    await renderWithEndpoint('http://192.168.1.10:3030')
    const warning = await screen.findByTestId('sync-http-warning')
    expect(warning.textContent).toMatch(/unencrypted HTTP/i)
    // Non-blocking: save remains possible.
    expect(screen.getByTestId('sync-save-button')).toBeEnabled()
  })

  it('does not warn for loopback http or https endpoints', async () => {
    await renderWithEndpoint('http://127.0.0.1:3030')
    await waitFor(() => {
      expect(screen.queryByTestId('sync-http-warning')).toBeNull()
    })
  })

  it('does not warn for a non-loopback https endpoint', async () => {
    await renderWithEndpoint('https://192.168.1.10:3030')
    await waitFor(() => {
      expect(screen.queryByTestId('sync-http-warning')).toBeNull()
    })
  })

  it('does not warn for malformed endpoints without an explicit http:// prefix', async () => {
    await renderWithEndpoint('https://192.168.1.10:3030')
    await waitFor(() => {
      expect(screen.queryByTestId('sync-http-warning')).toBeNull()
    })
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http:example.com' }
    })
    await waitFor(() => {
      expect(screen.queryByTestId('sync-http-warning')).toBeNull()
    })
  })

  it('toggles the warning live as the endpoint is edited', async () => {
    await renderWithEndpoint('https://192.168.1.10:3030')
    await waitFor(() => {
      expect(screen.queryByTestId('sync-http-warning')).toBeNull()
    })
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http://192.168.1.10:3030' }
    })
    await screen.findByTestId('sync-http-warning')
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http://localhost:3030' }
    })
    await waitFor(() => {
      expect(screen.queryByTestId('sync-http-warning')).toBeNull()
    })
  })
})
