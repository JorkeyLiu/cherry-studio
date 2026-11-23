/**
 * Sync Settings non-loopback HTTP warning contract.
 *
 * The endpoint policy accepts both http and https for loopback and
 * non-loopback hosts; a non-loopback `http://` endpoint must show a visible
 * non-blocking warning (save stays possible, no encryption is claimed).
 * Loopback HTTP and any HTTPS endpoint must not warn.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' })
}))

// Ownership tracking mirrors SyncSettingsAutosave.test.tsx: every render is
// unmounted in afterEach (clearing the component's 5s poll interval), RTL
// state is cleaned, and window.api/window.toast are restored so a
// timeout/failure never leaks intervals, DOM, or globals into the next case.
const mounted: Array<{ unmount: () => void }> = []
let origApiDescriptor: PropertyDescriptor | undefined
let origToastDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  origApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  origToastDescriptor = Object.getOwnPropertyDescriptor(window, 'toast')
})

afterEach(() => {
  for (const m of mounted.splice(0)) {
    try {
      m.unmount()
    } catch {}
  }
  cleanup()
  vi.clearAllMocks()
  if (origApiDescriptor) {
    Object.defineProperty(window, 'api', origApiDescriptor)
  } else {
    try {
      // @ts-ignore
      delete (window as any).api
    } catch {}
  }
  if (origToastDescriptor) {
    Object.defineProperty(window, 'toast', origToastDescriptor)
  } else {
    try {
      // @ts-ignore
      delete (window as any).toast
    } catch {}
  }
  origApiDescriptor = undefined
  origToastDescriptor = undefined
})

function mockSyncApi(endpoint: string): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getConfig: vi.fn(async () => ({ endpoint, token: '', enabled: true })),
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
  mounted.push(render(<SyncSettings />))
  await waitFor(() => {
    expect(screen.getByTestId('sync-endpoint-input')).toHaveValue(endpoint)
  })
  return api
}

describe('SyncSettings non-loopback HTTP warning', () => {
  it('shows a non-blocking warning for a non-loopback http endpoint', async () => {
    const api = await renderWithEndpoint('http://192.168.1.10:3030')
    const warning = await screen.findByTestId('sync-http-warning')
    expect(warning.textContent).toMatch(/unencrypted HTTP/i)
    // Non-blocking: blur auto-save remains possible with the warning visible.
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http://192.168.1.11:3030' }
    })
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledWith({
        endpoint: 'http://192.168.1.11:3030',
        token: '',
        enabled: true
      })
    })
    expect(screen.getByTestId('sync-http-warning')).toBeInTheDocument()
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
