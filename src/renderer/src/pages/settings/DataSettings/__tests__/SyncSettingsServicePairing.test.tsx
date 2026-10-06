/**
 * Sync Settings service/pairing action matrix (SYNC-CC-003/006/010).
 *
 * - API Server-style service indicator reflects the observed service state;
 *   pairing state is shown separately with fixed action labels
 *   (Connect/Disconnect, Request pairing/Unpair, Cancel/Accept/Reject).
 * - Request/Accept/Reject/Unpair are disabled while the service is
 *   disconnected; a disconnected registered service offers Connect only.
 * - The public device code is displayable; the durable secret is never
 *   rendered and never passes through the component.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

type ServiceState = 'unregistered' | 'connected' | 'disconnected'
type PairingState = 'unpaired' | 'outgoing' | 'incoming' | 'paired'

interface MockSetup {
  service: { state: ServiceState; deviceCode: string | null; explicitDisconnect: boolean }
  pairing: {
    deviceCode: string
    state: PairingState
    outgoing: { id: string; targetCode: string; createdAt: string } | null
    incoming: Array<{ id: string; requesterCode: string; createdAt: string }>
  } | null
}

function mockSyncApi(setup: MockSetup): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getConfig: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3030', enabled: true })),
    setConfig: vi.fn(async (cfg: unknown) => cfg),
    getStatus: vi.fn(async () => ({
      enabled: true,
      endpoint: 'http://127.0.0.1:3030',
      lastSyncAt: null,
      lastError: null,
      lastCaptureError: null,
      pendingCount: 0,
      cursor: 0,
      syncing: false,
      conflictCount: 0
    })),
    sync: vi.fn(async () => ({})),
    connect: vi.fn(async () => setup.service),
    disconnect: vi.fn(async () => ({ ...setup.service, state: 'disconnected', explicitDisconnect: true })),
    getServiceStatus: vi.fn(async () => setup.service),
    getDeviceCode: vi.fn(async () => ({ deviceCode: setup.service.deviceCode })),
    getPairState: vi.fn(async () => {
      if (!setup.pairing) throw new Error('service disconnected (explicit disconnect; Connect to resume)')
      return setup.pairing
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

async function renderSettings(setup: MockSetup): Promise<Record<string, ReturnType<typeof vi.fn>>> {
  const api = mockSyncApi(setup)
  const { default: SyncSettings } = await import('../SyncSettings')
  render(<SyncSettings />)
  await waitFor(() => {
    expect(screen.getByTestId('sync-service-status')).toBeInTheDocument()
  })
  return api
}

const unpaired: MockSetup = {
  service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false },
  pairing: { deviceCode: 'ABCD2345', state: 'unpaired', outgoing: null, incoming: [] }
}

describe('SyncSettings service indicator and pairing matrix', () => {
  it('shows a green connected service with the public device code', async () => {
    await renderSettings(unpaired)
    const indicator = screen.getByTestId('sync-service-indicator')
    expect(indicator.getAttribute('data-state')).toBe('connected')
    expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Connected/)
    expect(screen.getByTestId('sync-device-code').textContent).toContain('ABCD2345')
    expect(screen.getByTestId('sync-disconnect')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-connect')).toBeNull()
  })

  it('shows a red disconnected service with Connect only and disabled pairing', async () => {
    await renderSettings({
      service: { state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: true },
      pairing: null
    })
    expect(screen.getByTestId('sync-service-indicator').getAttribute('data-state')).toBe('disconnected')
    expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Disconnected/)
    expect(screen.getByTestId('sync-connect')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-disconnect')).toBeNull()
    // Registered but disconnected: the code stays visible, re-attach needs
    // no repair flow.
    expect(screen.getByTestId('sync-device-code').textContent).toContain('ABCD2345')
    expect(screen.queryByTestId('sync-request-pairing')).toBeNull()
    expect(screen.queryByTestId('sync-unpair')).toBeNull()
  })

  it('unregistered service shows Not connected with Connect', async () => {
    await renderSettings({
      service: { state: 'unregistered', deviceCode: null, explicitDisconnect: false },
      pairing: null
    })
    expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Not connected/)
    expect(screen.getByTestId('sync-connect')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-device-code')).toBeNull()
  })

  it('unpaired offers Request pairing and wires the target code', async () => {
    const api = await renderSettings(unpaired)
    expect(screen.getByTestId('sync-pairing-status').textContent).toMatch(/Not paired/)
    fireEvent.change(screen.getByTestId('sync-target-code-input'), { target: { value: 'wxyz5678' } })
    fireEvent.click(screen.getByTestId('sync-request-pairing'))
    await waitFor(() => {
      expect(api.requestPairing).toHaveBeenCalledWith({ targetCode: 'wxyz5678' })
    })
  })

  it('outgoing pending offers Cancel only', async () => {
    const api = await renderSettings({
      service: unpaired.service,
      pairing: {
        deviceCode: 'ABCD2345',
        state: 'outgoing',
        outgoing: { id: 'req-1', targetCode: 'WXYZ5678', createdAt: new Date().toISOString() },
        incoming: []
      }
    })
    expect(screen.getByTestId('sync-outgoing-request').textContent).toContain('WXYZ5678')
    fireEvent.click(screen.getByTestId('sync-cancel-request'))
    await waitFor(() => {
      expect(api.cancelPairing).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('sync-request-pairing')).toBeNull()
    expect(screen.queryByTestId('sync-unpair')).toBeNull()
  })

  it('incoming pending offers Accept and Reject per request', async () => {
    const api = await renderSettings({
      service: unpaired.service,
      pairing: {
        deviceCode: 'ABCD2345',
        state: 'incoming',
        outgoing: null,
        incoming: [{ id: 'req-9', requesterCode: 'QWER5678', createdAt: new Date().toISOString() }]
      }
    })
    expect(screen.getByTestId('sync-incoming-req-9').textContent).toContain('QWER5678')
    fireEvent.click(screen.getByTestId('sync-accept-req-9'))
    await waitFor(() => {
      expect(api.acceptPairing).toHaveBeenCalledWith('req-9')
    })
  })

  it('paired offers Unpair (service stays connected after unpair)', async () => {
    const api = await renderSettings({
      service: unpaired.service,
      pairing: { deviceCode: 'ABCD2345', state: 'paired', outgoing: null, incoming: [] }
    })
    expect(screen.getByTestId('sync-pairing-status').textContent).toMatch(/Paired/)
    fireEvent.click(screen.getByTestId('sync-unpair'))
    await waitFor(() => {
      expect(api.unpair).toHaveBeenCalled()
    })
  })

  it('connect and disconnect wire the service actions', async () => {
    const api = await renderSettings({
      service: { state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: true },
      pairing: null
    })
    fireEvent.click(screen.getByTestId('sync-connect'))
    await waitFor(() => {
      expect(api.connect).toHaveBeenCalled()
    })
  })

  it('never renders secret material even when a response carries a decoy secret', async () => {
    const decoy = 'ab'.repeat(32)
    const api = mockSyncApi(unpaired)
    // Decoy secret smuggled through an extended pair-state shape: the UI must
    // never render it even though the transport carried it.
    api.getPairState.mockResolvedValueOnce({
      deviceCode: 'ABCD2345',
      state: 'unpaired',
      outgoing: null,
      incoming: [],
      deviceSecret: decoy,
      extra: { deviceSecret: decoy }
    } as unknown as Awaited<ReturnType<typeof api.getPairState>>)
    api.getServiceStatus.mockResolvedValueOnce({
      state: 'connected',
      deviceCode: 'ABCD2345',
      explicitDisconnect: false,
      deviceSecret: decoy
    } as unknown as Awaited<ReturnType<typeof api.getServiceStatus>>)
    const { default: SyncSettings } = await import('../SyncSettings')
    render(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(api.getPairState).toHaveBeenCalled()
    })
    // Real DOM negative assertion: no element text contains the decoy.
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      expect(el.textContent ?? '').not.toContain(decoy)
    }
    expect(document.body.innerHTML).not.toContain(decoy)
  })

  it('network-disconnected registered service shows Connect + Disconnect', async () => {
    await renderSettings({
      service: { state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairing: { deviceCode: 'ABCD2345', state: 'unpaired', outgoing: null, incoming: [] }
    })
    expect(screen.getByTestId('sync-connect')).toBeInTheDocument()
    expect(screen.getByTestId('sync-disconnect')).toBeInTheDocument()
  })

  it('explicit-disconnected registered service shows Connect only', async () => {
    await renderSettings({
      service: { state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: true },
      pairing: { deviceCode: 'ABCD2345', state: 'unpaired', outgoing: null, incoming: [] }
    })
    expect(screen.getByTestId('sync-connect')).toBeInTheDocument()
    expect(screen.queryByTestId('sync-disconnect')).toBeNull()
  })

  it('disconnected retains last-known pairing but disables online actions', async () => {
    const outgoing = {
      service: { state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false } as const,
      pairing: {
        deviceCode: 'ABCD2345',
        state: 'outgoing' as const,
        outgoing: { id: 'req-1', targetCode: 'WXYZ5678', createdAt: new Date().toISOString() },
        incoming: []
      }
    }
    const api = mockSyncApi(outgoing)
    const { default: SyncSettings } = await import('../SyncSettings')
    render(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-outgoing-request')).toBeInTheDocument()
    })
    // Service drops to network-disconnected; pairing fetch now fails but the
    // last-known outgoing observation stays visible (not unknown) with Cancel
    // disabled.
    api.getServiceStatus.mockResolvedValue({
      state: 'disconnected',
      deviceCode: 'ABCD2345',
      explicitDisconnect: false
    })
    api.getPairState.mockRejectedValue(new Error('fetch failed'))
    api.disconnect.mockResolvedValue({ state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: true })
    fireEvent.click(screen.getByTestId('sync-disconnect'))
    await waitFor(() => {
      expect(api.disconnect).toHaveBeenCalled()
    })
    expect(screen.getByTestId('sync-outgoing-request').textContent).toContain('WXYZ5678')
    expect(screen.getByTestId('sync-cancel-request')).toBeDisabled()
  })

  it('stale refresh never overwrites a newer Connect observation', async () => {
    const api = mockSyncApi({
      service: { state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: false },
      pairing: null
    })
    let resolveStale!: (v: { state: 'disconnected'; deviceCode: string; explicitDisconnect: boolean }) => void
    const staleGate = new Promise<{ state: 'disconnected'; deviceCode: string; explicitDisconnect: boolean }>((res) => {
      resolveStale = res
    })
    api.getServiceStatus.mockReturnValueOnce(staleGate)
    const { default: SyncSettings } = await import('../SyncSettings')
    render(<SyncSettings />)
    // Let mount observations settle first: only the pairing refresh holds the
    // stale gate, so the config load completes disconnected and the Connect
    // button is a stable live node (not an initial-paint node a re-render
    // could detach before the click lands).
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status').textContent).toMatch(/Disconnected/)
    })
    expect(screen.getByTestId('sync-service-indicator').getAttribute('data-state')).toBe('disconnected')
    // Newer Connect resolves first with connected state.
    api.getServiceStatus.mockResolvedValue({ state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false })
    api.connect.mockResolvedValue({ state: 'connected', deviceCode: 'ABCD2345', explicitDisconnect: false })
    api.getPairState.mockResolvedValue({
      deviceCode: 'ABCD2345',
      state: 'unpaired',
      outgoing: null,
      incoming: []
    })
    fireEvent.click(screen.getByTestId('sync-connect'))
    await waitFor(() => {
      expect(api.connect).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-indicator').getAttribute('data-state')).toBe('connected')
    })
    // The stale disconnected response resolves late and must be dropped.
    resolveStale({ state: 'disconnected', deviceCode: 'ABCD2345', explicitDisconnect: false })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByTestId('sync-service-indicator').getAttribute('data-state')).toBe('connected')
  })

  it('pairing failures surface truthfully', async () => {
    const api = mockSyncApi(unpaired)
    api.requestPairing.mockRejectedValueOnce(new Error('sync request failed 409: {"error":"pairing-already-paired"}'))
    const { default: SyncSettings } = await import('../SyncSettings')
    render(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-request-pairing')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('sync-target-code-input'), { target: { value: 'WXYZ5678' } })
    fireEvent.click(screen.getByTestId('sync-request-pairing'))
    await waitFor(() => {
      expect(screen.getByTestId('sync-pairing-error').textContent).toMatch(/pairing-already-paired/)
    })
  })
})

describe('SyncSettings device code copy (plain text plus independent copy button)', () => {
  const writeText = vi.fn()
  let successToast: ReturnType<typeof vi.fn>
  let errorToast: ReturnType<typeof vi.fn>
  let origClipboardDescriptor: PropertyDescriptor | undefined
  let clipboardDescriptorCaptured = false

  beforeEach(() => {
    // jsdom exposes navigator.clipboard as a getter-only accessor (and
    // user-event may restub it), so assignment throws: always define an own
    // property instead.
    if (!clipboardDescriptorCaptured) {
      origClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      clipboardDescriptorCaptured = true
    }
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true
    })
  })

  afterEach(() => {
    cleanup()
    if (origClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', origClipboardDescriptor)
    } else {
      try {
        delete (navigator as unknown as Record<string, unknown>).clipboard
      } catch {}
    }
    clipboardDescriptorCaptured = false
    vi.clearAllMocks()
  })

  async function renderCopyable(): Promise<void> {
    mockSyncApi(unpaired)
    successToast = vi.fn()
    errorToast = vi.fn()
    Object.defineProperty(window, 'toast', {
      value: { success: successToast, error: errorToast },
      configurable: true,
      writable: true
    })
    const { default: SyncSettings } = await import('../SyncSettings')
    render(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-device-code')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByTestId('sync-device-code-copy')).toBeInTheDocument()
    })
  }

  it('renders the code as plain text with an independent neutral copy button', async () => {
    await renderCopyable()
    const code = screen.getByTestId('sync-device-code')
    expect(code.tagName).toBe('SPAN')
    expect(code.textContent).toContain('ABCD2345')
    // Plain text carries no interactive role, no click target, and no
    // hover tooltip: no button/link role, no tabindex, no title.
    expect(code.getAttribute('role')).toBeNull()
    expect(code.getAttribute('tabindex')).toBeNull()
    expect(code.getAttribute('title')).toBeNull()
    expect(code.getAttribute('aria-label')).toBeNull()
    const copyButton = screen.getByTestId('sync-device-code-copy')
    expect(copyButton.tagName).toBe('BUTTON')
    // Localized accessible label reuses the existing house key, never a
    // hand-coded string: the mock t returns its fallback argument.
    expect(copyButton.getAttribute('aria-label')).toBe('Copy')
  })

  it('clicking the code text copies nothing', async () => {
    await renderCopyable()
    fireEvent.click(screen.getByTestId('sync-device-code'))
    await new Promise((r) => setTimeout(r, 50))
    expect(writeText).not.toHaveBeenCalled()
    expect(successToast).not.toHaveBeenCalled()
    expect(errorToast).not.toHaveBeenCalled()
  })

  it('clicking the independent copy button copies the exact public code', async () => {
    await renderCopyable()
    fireEvent.click(screen.getByTestId('sync-device-code-copy'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
    })
    expect(writeText).toHaveBeenCalledWith('ABCD2345')
    await waitFor(() => {
      expect(successToast).toHaveBeenCalledTimes(1)
    })
    expect(errorToast).not.toHaveBeenCalled()
  })

  it('keyboard activation on the copy button copies the exact public code', async () => {
    await renderCopyable()
    const user = userEvent.setup()
    // user-event setup replaces navigator.clipboard with its own stub:
    // re-apply the test spy afterwards so the exact copied code is observed.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true
    })
    const copyButton = screen.getByTestId('sync-device-code-copy')
    copyButton.focus()
    expect(document.activeElement).toBe(copyButton)
    // Native button activation: Space fires click on key-up in real browsers
    // (Enter on key-down); user-event reproduces the keyboard path.
    await user.keyboard(' ')
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('ABCD2345')
    })
    expect(successToast).toHaveBeenCalledTimes(1)
  })

  it('shows the failure toast when the clipboard write fails', async () => {
    await renderCopyable()
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByTestId('sync-device-code-copy'))
    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledTimes(1)
    })
    expect(successToast).not.toHaveBeenCalled()
  })

  it('removes the device-code help icon while other sync help stays', async () => {
    await renderCopyable()
    // Scoped to the device-code row only: no question-mark help trigger
    // lives beside the code or its copy button.
    const rowHasHelp = (() => {
      const code = document.querySelector('[data-testid="sync-device-code"]')
      const row = code?.parentElement
      return row ? row.querySelector('[role="img"]') !== null : false
    })()
    expect(rowHasHelp).toBe(false)
    // Other sync help tooltips are unaffected (pairing help still present).
    expect(document.body.textContent).toMatch(/Device pairing|pairing/i)
  })

  it('copies only the public code even when a response carries a decoy secret', async () => {
    const decoy = 'cd'.repeat(32)
    const api = mockSyncApi(unpaired)
    successToast = vi.fn()
    errorToast = vi.fn()
    Object.defineProperty(window, 'toast', {
      value: { success: successToast, error: errorToast },
      configurable: true,
      writable: true
    })
    api.getPairState.mockResolvedValueOnce({
      deviceCode: 'ABCD2345',
      state: 'unpaired',
      outgoing: null,
      incoming: [],
      deviceSecret: decoy
    } as unknown as Awaited<ReturnType<typeof api.getPairState>>)
    api.getServiceStatus.mockResolvedValueOnce({
      state: 'connected',
      deviceCode: 'ABCD2345',
      explicitDisconnect: false,
      deviceSecret: decoy
    } as unknown as Awaited<ReturnType<typeof api.getServiceStatus>>)
    const { default: SyncSettings } = await import('../SyncSettings')
    render(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-device-code-copy')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('sync-device-code-copy'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('ABCD2345')
    })
    for (const call of writeText.mock.calls) {
      expect(String(call[0] ?? '')).not.toContain(decoy)
    }
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      expect(el.textContent ?? '').not.toContain(decoy)
    }
    expect(document.body.innerHTML).not.toContain(decoy)
  })

  it('renders nothing copyable when no code is available', async () => {
    mockSyncApi({
      service: { state: 'unregistered', deviceCode: null, explicitDisconnect: false },
      pairing: null
    })
    const { default: SyncSettings } = await import('../SyncSettings')
    render(<SyncSettings />)
    await waitFor(() => {
      expect(screen.getByTestId('sync-service-status')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('sync-device-code')).toBeNull()
    expect(screen.queryByTestId('sync-device-code-copy')).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })
})
