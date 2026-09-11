/**
 * Sync Settings auto-save contract (renderer refinement unit).
 *
 * - Endpoint/token persist on blur via the existing setConfig contract with
 *   the full normalized config (partial-field saves never overwrite another
 *   current form value); Enabled persists immediately on toggle.
 * - Blurring an unchanged value is a no-op; ordinary auto-save emits no
 *   success toast; failures preserve local edits and surface visibly.
 * - No explicit Save / Refresh controls remain.
 * - The five-second live poll never overwrites active local form values.
 * - A disconnected initial pairing fetch (expected getPairState inability)
 *   shows no raw IPC error and keeps the last-known pairing observation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Minimal i18next stand-in: returns the fallback with {{var}}
    // placeholders interpolated, mirroring real template rendering.
    t: (key: string, fallback?: string, opts?: Record<string, unknown>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [name, value] of Object.entries(opts)) {
          text = text.replaceAll(`{{${name}}}`, String(value))
        }
      }
      return text
    },
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' })
}))

interface MockOptions {
  endpoint?: string
  token?: string
  enabled?: boolean
  service?: {
    state: 'unregistered' | 'connected' | 'disconnected'
    deviceCode: string | null
    explicitDisconnect: boolean
  }
  pairState?: { deviceCode: string; state: 'unpaired'; outgoing: null; incoming: [] } | null
  pairError?: string | null
}

// Ownership tracking: every render is unmounted in afterEach (clearing the
// component's 5s poll interval and pending saves), RTL state is cleaned, and
// window.api/window.toast are restored to their pre-test state so a
// timeout/failure never leaks intervals, spies or globals.
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

function mockSyncApi(options: MockOptions = {}): Record<string, ReturnType<typeof vi.fn>> {
  const {
    endpoint = 'http://127.0.0.1:3030',
    token = '',
    enabled = true,
    service = { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
    pairState = { deviceCode: 'ABCD2345', state: 'unpaired', outgoing: null, incoming: [] },
    pairError = null
  } = options
  const api = {
    getConfig: vi.fn(async () => ({ endpoint, token, enabled })),
    setConfig: vi.fn(async (cfg: unknown) => cfg),
    getStatus: vi.fn(async () => ({
      enabled,
      endpoint,
      lastSyncAt: null,
      lastError: null,
      lastCaptureError: null,
      pendingCount: 0,
      cursor: 0,
      syncing: false,
      conflictCount: 0
    })),
    sync: vi.fn(async () => ({})),
    connect: vi.fn(async () => service),
    disconnect: vi.fn(async () => service),
    getServiceStatus: vi.fn(async () => service),
    getPairState: vi.fn(async () => {
      if (pairError) throw new Error(pairError)
      if (!pairState) throw new Error('service disconnected (explicit disconnect; Connect to resume)')
      return pairState
    }),
    requestPairing: vi.fn(async () => ({ requestId: 'req-1', status: 'pending' })),
    cancelPairing: vi.fn(async () => ({ requestId: 'req-1' })),
    acceptPairing: vi.fn(async () => ({ channelId: 'ch-1' })),
    rejectPairing: vi.fn(async () => ({ ok: true })),
    unpair: vi.fn(async () => ({ ok: true }))
  }
  Object.defineProperty(window, 'api', { value: { sync: api }, configurable: true, writable: true })
  Object.defineProperty(window, 'toast', {
    value: { success: vi.fn(), error: vi.fn() },
    configurable: true,
    writable: true
  })
  return api
}

function renderTracked(ui: React.ReactElement) {
  const result = render(ui)
  mounted.push(result)
  return result
}

async function renderSettings(options: MockOptions = {}): Promise<{ api: Record<string, ReturnType<typeof vi.fn>> }> {
  const api = mockSyncApi(options)
  const { default: SyncSettings } = await import('../SyncSettings')
  renderTracked(<SyncSettings />)
  // Single stable hydration predicate (was three sequential waitFors):
  // input mounted + initial getConfig issued + form hydrated with the
  // authoritative endpoint and enabled for editing.
  const expectedEndpoint = options.endpoint ?? 'http://127.0.0.1:3030'
  await waitFor(() => {
    expect(screen.getByTestId('sync-endpoint-input')).toBeInTheDocument()
    expect(api.getConfig).toHaveBeenCalled()
    expect(screen.getByTestId('sync-endpoint-input')).toHaveValue(expectedEndpoint)
    expect(screen.getByTestId('sync-endpoint-input')).not.toBeDisabled()
  })
  return { api }
}

describe('SyncSettings auto-save', () => {
  it('saves the endpoint on blur with the full normalized config', async () => {
    const { api } = await renderSettings({ token: 'tok-1', enabled: true })
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: '  http://192.168.1.20:3030  ' }
    })
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledTimes(1)
    })
    // Atomic full config: trimmed endpoint plus the other current form values.
    expect(api.setConfig).toHaveBeenCalledWith({
      endpoint: 'http://192.168.1.20:3030',
      token: 'tok-1',
      enabled: true
    })
    expect(screen.getByTestId('sync-endpoint-input')).toHaveValue('http://192.168.1.20:3030')
    // No success-toast spam for ordinary auto-save.
    expect(window.toast.success as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('saves the token on blur without overwriting the current endpoint', async () => {
    const { api } = await renderSettings({ endpoint: 'http://127.0.0.1:3030', enabled: true })
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http://10.0.0.5:3030' }
    })
    fireEvent.change(screen.getByTestId('sync-token-input'), { target: { value: '  secret-2  ' } })
    fireEvent.blur(screen.getByTestId('sync-token-input'))
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalled()
    })
    const last = api.setConfig.mock.calls.at(-1)?.[0] as { endpoint: string; token: string; enabled: boolean }
    expect(last).toEqual({ endpoint: 'http://10.0.0.5:3030', token: 'secret-2', enabled: true })
  })

  it('persists Enabled immediately on toggle', async () => {
    const { api } = await renderSettings({ enabled: false })
    fireEvent.click(screen.getByTestId('sync-enabled-switch'))
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledWith({
        endpoint: 'http://127.0.0.1:3030',
        token: '',
        enabled: true
      })
    })
  })

  it('does not save unchanged values on blur', async () => {
    const { api } = await renderSettings()
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    fireEvent.blur(screen.getByTestId('sync-token-input'))
    // Real settlement: drain the blur-triggered persistConfig microtask chain
    // plus every in-flight status observation, then flush React effects. A
    // buggy save would have called setConfig by the time these settle (the
    // mocked backend resolves immediately, so no wall-time wait is needed).
    await act(async () => {
      const pending = api.getStatus.mock.results
        .map((r) => r.value)
        .filter((v): v is Promise<unknown> => v instanceof Promise)
      await Promise.allSettled(pending)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.setConfig).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sync-config-error')).toBeNull()
  })

  it('preserves local edits and surfaces save failures truthfully', async () => {
    const { api } = await renderSettings()
    api.setConfig.mockRejectedValueOnce(new Error('relay unreachable'))
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http://10.9.9.9:3030' }
    })
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    await waitFor(() => {
      expect(screen.getByTestId('sync-config-error').textContent).toMatch(/relay unreachable/)
    })
    // Local edits are preserved, not replaced with old persisted values.
    expect(screen.getByTestId('sync-endpoint-input')).toHaveValue('http://10.9.9.9:3030')
    expect(window.toast.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('relay unreachable')
    expect(window.toast.success as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    // A later retry with a healthy backend persists the preserved edits.
    api.setConfig.mockResolvedValueOnce({ ok: true })
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenLastCalledWith({
        endpoint: 'http://10.9.9.9:3030',
        token: '',
        enabled: true
      })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('sync-config-error')).toBeNull()
    })
  })

  it('coalesces overlapping saves so the latest edit wins without reverting the form', async () => {
    const { api } = await renderSettings({ enabled: false })
    let release!: (v: unknown) => void
    const gate = new Promise((res) => {
      release = res
    })
    api.setConfig.mockReturnValueOnce(gate)
    fireEvent.click(screen.getByTestId('sync-enabled-switch'))
    // Second toggle lands while the first save is still in flight.
    fireEvent.click(screen.getByTestId('sync-enabled-switch'))
    release({ ok: true })
    await waitFor(() => {
      expect(api.setConfig.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    const last = api.setConfig.mock.calls.at(-1)?.[0] as { enabled: boolean }
    expect(last.enabled).toBe(false)
    expect(screen.queryByTestId('sync-config-error')).toBeNull()
  })

  it('has no explicit Save or Refresh controls', async () => {
    await renderSettings()
    expect(screen.queryByTestId('sync-save-button')).toBeNull()
    expect(screen.queryByText('Save')).toBeNull()
    expect(screen.queryByText('Refresh')).toBeNull()
    // Sync Now remains the sole manual sync action.
    expect(screen.getByTestId('sync-now-button')).toBeInTheDocument()
  })

  it('live polling never overwrites active local form values', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      const { api } = await renderSettings()
      const polls = intervalSpy.mock.calls.filter((call) => call[1] === 5000)
      expect(polls.length).toBeGreaterThan(0)
      const poll = polls.at(-1)?.[0] as () => Promise<void>
      fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
        target: { value: 'http://192.168.77.77:3030' }
      })
      const callsBefore = api.getStatus.mock.calls.length
      await act(async () => {
        await poll()
      })
      await waitFor(() => {
        expect(api.getStatus.mock.calls.length).toBeGreaterThan(callsBefore)
      })
      expect(screen.getByTestId('sync-endpoint-input')).toHaveValue('http://192.168.77.77:3030')
      // Typing alone (no blur/toggle) persists nothing.
      expect(api.setConfig).not.toHaveBeenCalled()
    } finally {
      intervalSpy.mockRestore()
    }
  })

  it('disconnected initial pairing fetch shows no raw IPC error', async () => {
    const { api } = await renderSettings({
      service: { state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: true },
      pairState: null
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Disconnected/)
    })
    await waitFor(() => {
      expect(api.getPairState).toHaveBeenCalled()
    })
    // Real settlement: the initial pairing fetch rejects while disconnected
    // and is swallowed silently (no observable UI change), so await the
    // observed getPairState promises to complete and flush React effects
    // before asserting the negative claims.
    await act(async () => {
      const pending = api.getPairState.mock.results
        .map((r) => r.value)
        .filter((v): v is Promise<unknown> => v instanceof Promise)
      await Promise.allSettled(pending)
    })
    expect(screen.getByTestId('sync-pairing-status').textContent).toMatch(/Pairing status/)
    expect(screen.queryByTestId('sync-pairing-error')).toBeNull()
    expect(document.body.textContent ?? '').not.toMatch(/explicit disconnect; Connect to resume/)
  })

  it('unregistered service shows no raw IPC error on initial load', async () => {
    const { api } = await renderSettings({
      service: { state: 'unregistered', deviceCode: null, explicitDisconnect: false },
      pairState: null
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Not connected/)
    })
    await waitFor(() => {
      expect(api.getPairState).toHaveBeenCalled()
    })
    // Real settlement: same silent-rejection path as the disconnected case —
    // await the observed getPairState promises, then flush effects.
    await act(async () => {
      const pending = api.getPairState.mock.results
        .map((r) => r.value)
        .filter((v): v is Promise<unknown> => v instanceof Promise)
      await Promise.allSettled(pending)
    })
    expect(screen.getByTestId('sync-pairing-status').textContent).toMatch(/Pairing status/)
    expect(screen.queryByTestId('sync-pairing-error')).toBeNull()
  })

  it('config controls are unavailable and persist nothing before hydration', async () => {
    let resolveConfig!: (v: { endpoint: string; token: string; enabled: boolean }) => void
    const configGate = new Promise<{ endpoint: string; token: string; enabled: boolean }>((res) => {
      resolveConfig = res
    })
    const api = mockSyncApi()
    api.getConfig.mockReturnValueOnce(configGate)
    const { default: SyncSettings } = await import('../SyncSettings')
    renderTracked(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-endpoint-input')).toBeInTheDocument()
    })
    // Hydration pending: endpoint/token/Enabled are disabled so defaults can
    // never be persisted as authoritative; blurring persists nothing.
    expect(screen.getByTestId('sync-endpoint-input')).toBeDisabled()
    expect(screen.getByTestId('sync-token-input')).toBeDisabled()
    expect(screen.getByTestId('sync-enabled-switch')).toBeDisabled()
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    // Service observation proceeds independently of hydration (no fixed sleep).
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Connected/)
    })
    expect(api.setConfig).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sync-config-error')).toBeNull()
    // Hydration enables the controls with the authoritative values.
    await act(async () => {
      resolveConfig({ endpoint: 'http://127.0.0.1:3030', token: '', enabled: true })
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-endpoint-input')).toHaveValue('http://127.0.0.1:3030')
    })
    expect(screen.getByTestId('sync-endpoint-input')).not.toBeDisabled()
    expect(screen.getByTestId('sync-token-input')).not.toBeDisabled()
    expect(screen.getByTestId('sync-enabled-switch')).not.toBeDisabled()
  })

  it('stale overlapping initial hydration cannot overwrite a newer edit', async () => {
    // StrictMode double-mounts the load effect, producing two overlapping
    // initial config requests: the first hydrates, the user edits, then the
    // stale second response resolves and must not clobber the edit.
    let resolveFirst!: (v: { endpoint: string; token: string; enabled: boolean }) => void
    let resolveSecond!: (v: { endpoint: string; token: string; enabled: boolean }) => void
    const firstGate = new Promise<{ endpoint: string; token: string; enabled: boolean }>((res) => {
      resolveFirst = res
    })
    const secondGate = new Promise<{ endpoint: string; token: string; enabled: boolean }>((res) => {
      resolveSecond = res
    })
    const api = mockSyncApi()
    api.getConfig.mockReturnValueOnce(firstGate).mockReturnValueOnce(secondGate)
    const { default: SyncSettings } = await import('../SyncSettings')
    renderTracked(
      <StrictMode>
        <SyncSettings />
      </StrictMode>
    )
    await waitFor(() => {
      expect(screen.getByTestId('sync-endpoint-input')).toBeInTheDocument()
    })
    await act(async () => {
      resolveFirst({ endpoint: 'http://127.0.0.1:3030', token: '', enabled: true })
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-endpoint-input')).toHaveValue('http://127.0.0.1:3030')
    })
    fireEvent.change(screen.getByTestId('sync-endpoint-input'), {
      target: { value: 'http://10.3.3.3:3030' }
    })
    await act(async () => {
      resolveSecond({ endpoint: 'http://192.168.0.1:3030', token: 'stale', enabled: false })
    })
    // No fixed sleep: the stale response has resolved inside act, so the
    // preserved edit is asserted as final state.
    await waitFor(() => {
      expect(screen.getByTestId('sync-endpoint-input')).toHaveValue('http://10.3.3.3:3030')
    })
    // The preserved edit still saves atomically against the hydrated snapshot.
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledWith({
        endpoint: 'http://10.3.3.3:3030',
        token: '',
        enabled: true
      })
    })
  })

  it('getConfig failure shows a truthful error and keeps persistence unavailable', async () => {
    const api = mockSyncApi()
    api.getConfig.mockRejectedValueOnce(new Error('main store offline'))
    const { default: SyncSettings } = await import('../SyncSettings')
    renderTracked(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-config-error').textContent).toMatch(/main store offline/)
    })
    // Config controls stay disabled; defaults are not treated as authoritative.
    expect(screen.getByTestId('sync-endpoint-input')).toBeDisabled()
    expect(screen.getByTestId('sync-token-input')).toBeDisabled()
    expect(screen.getByTestId('sync-enabled-switch')).toBeDisabled()
    fireEvent.blur(screen.getByTestId('sync-endpoint-input'))
    // Service observation still proceeds independently of the config failure.
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Connected/)
    })
    expect(api.setConfig).not.toHaveBeenCalled()
    expect(window.toast.success as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('connected service with failing pairing fetch surfaces a truthful error', async () => {
    await renderSettings({ pairState: null, pairError: 'relay pairing read failed 500' })
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Connected/)
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-pairing-error').textContent).toMatch(/relay pairing read failed/)
    })
    expect(screen.getByTestId('sync-pairing-status').textContent).toMatch(/Pairing status/)
  })

  it('pairing refresh failure while connected surfaces an error and retains last-known pairing', async () => {
    const { api } = await renderSettings()
    await waitFor(() => {
      expect(screen.getByTestId('sync-request-pairing')).toBeInTheDocument()
    })
    api.getPairState.mockRejectedValue(new Error('relay pairing read failed 500'))
    fireEvent.change(screen.getByTestId('sync-target-code-input'), { target: { value: 'WXYZ5678' } })
    fireEvent.click(screen.getByTestId('sync-request-pairing'))
    await waitFor(() => {
      expect(api.requestPairing).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-pairing-error').textContent).toMatch(/relay pairing read failed/)
    })
    // Last-known unpaired observation is retained, not reset to unknown.
    expect(screen.getByTestId('sync-request-pairing')).toBeInTheDocument()
  })

  it('actual pairing-action failures still surface truthfully', async () => {
    const { api } = await renderSettings()
    api.requestPairing.mockRejectedValueOnce(new Error('sync request failed 409: {"error":"pairing-already-paired"}'))
    await waitFor(() => {
      expect(screen.getByTestId('sync-request-pairing')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('sync-target-code-input'), { target: { value: 'WXYZ5678' } })
    fireEvent.click(screen.getByTestId('sync-request-pairing'))
    await waitFor(() => {
      expect(screen.getByTestId('sync-pairing-error').textContent).toMatch(/pairing-already-paired/)
    })
  })

  it('renders concise experimental copy with semantic section groups', async () => {
    await renderSettings()
    expect(screen.getByText(/Automatic personal-device sync/)).toBeInTheDocument()
    // The dense operation enumeration no longer lives in the page header.
    expect(screen.queryByText(/stable checkpoints/)).toBeNull()
    expect(screen.getByRole('group', { name: 'Relay service' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Device pairing' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Status' })).toBeInTheDocument()
  })

  it('uses a neutral indicator while service status is unknown', async () => {
    const api = mockSyncApi()
    let resolveService!: (v: { state: 'connected'; deviceCode: string; explicitDisconnect: boolean }) => void
    const serviceGate = new Promise<{
      state: 'connected'
      deviceCode: string
      explicitDisconnect: boolean
    }>((res) => {
      resolveService = res
    })
    api.getServiceStatus.mockReturnValue(serviceGate)
    const { default: SyncSettings } = await import('../SyncSettings')
    renderTracked(<SyncSettings />)
    const indicator = await screen.findByTestId('sync-service-indicator')
    expect(indicator.getAttribute('data-state')).toBe('unknown')
    // Neutral pending color: neither success green nor error red.
    expect(indicator.style.backgroundColor).toContain('text-3')
    expect(indicator.style.backgroundColor).not.toContain('ff4d4f')
    await act(async () => {
      resolveService({ state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false })
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-indicator').getAttribute('data-state')).toBe('connected')
    })
  })

  it('renders full sync error text inline without hover-only truncation', async () => {
    const tailMarker = `TAIL-${'x'.repeat(40)}`
    const longError = `relay push failed 500: ${'e'.repeat(260)}${tailMarker}`
    const api = mockSyncApi()
    api.getStatus.mockResolvedValue({
      enabled: true,
      endpoint: 'http://127.0.0.1:3030',
      lastSyncAt: null,
      lastError: longError,
      lastCaptureError: null,
      pendingCount: 0,
      cursor: 0,
      syncing: false,
      conflictCount: 0
    })
    const { default: SyncSettings } = await import('../SyncSettings')
    renderTracked(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-last-error').textContent).toContain(tailMarker)
    })
    // Beyond the old 200-character truncation: the complete error is present
    // as wrapped text, readable by keyboard users with no hover required.
    expect(screen.getByTestId('sync-last-error').textContent).toContain(longError)
    expect(screen.getByTestId('sync-last-error')).toHaveStyle('overflow-wrap: break-word')
  })

  it('keeps endpoint/token inputs within a bounded responsive width', async () => {
    await renderSettings()
    expect(screen.getByTestId('sync-endpoint-input')).toHaveStyle('max-width: 320px')
    // Input.Password carries the test id on the inner input; the bounded
    // width lives on its affix wrapper flex child.
    expect(screen.getByTestId('sync-token-input').closest('.ant-input-affix-wrapper')).toHaveStyle('max-width: 320px')
  })
})
